import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { readdirSync } from "node:fs";
import type { ActorRole } from "./types.js";
import { BUILT_IN_ROLES } from "./types.js";
import { readActorMeta } from "./actor-meta.js";
import type {
  Piece,
  PluginContext,
  AIRequestMessage,
  AIStreamMessage,
  SystemEventMessage,
  EventBus,
  SessionManager,
  ManagedSession,
} from "@jarvis/core";

/**
 * ActorRunnerPiece — session lifecycle manager for actor-* sessions.
 *
 * Responsibilities (ONLY):
 *  - Create / configure actor sessions in SessionManager (role, model, tool filter)
 *  - Destroy actor sessions on kill
 *  - Handle autoKill: observe ai.stream/complete for actor-* targets
 *  - Abort actor sessions on request
 *
 * NOT responsible for:
 *  - Intercepting or processing ai.request messages (JarvisCore owns all streams)
 *  - Running tool loops, capability rounds, or sendAndStream
 *  - Broadcasting pending_queue, prompt_dispatched, or state changes
 *  - Routing results via ai.request (JarvisCore handles replyTo natively)
 */

/** Dispatch message — AIRequestMessage with extra role/name data */
interface ActorDispatchMessage extends AIRequestMessage {
  data?: { role: ActorRole; name: string };
}

export class ActorRunnerPiece implements Piece {
  readonly id = "actor-runner";
  readonly name = "Actor Runner";

  private bus!: EventBus;
  private ctx: PluginContext;
  private sessions!: SessionManager;
  private activeSessions = new Set<string>(); // actor names with live sessions
  private actorSystemPrompt: string;
  private started = false;
  private unsubDispatch?: () => void;
  private unsubKill?: () => void;
  private unsubComplete?: () => void;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.actorSystemPrompt = this.loadActorSystemPrompt();
  }

  private loadActorSystemPrompt(): string {
    const path = join(this.ctx.pluginDir, "actor-system.md");
    if (existsSync(path)) return readFileSync(path, "utf-8");
    return "You are an autonomous worker agent. Execute tasks using available tools. Report results clearly.";
  }

  private buildRoleContext(role: ActorRole): string {
    return `## Your Role: ${role.name}\n\n${role.systemPrompt}`;
  }

  /**
   * Resolve the role for a persisted actor on lazy-create.
   * Reads sidecar actor-<name>.meta.json → roles/<roleId>.md → BUILT_IN_ROLES → "generic".
   */
  private resolveActorRole(name: string): ActorRole | null {
    const meta = readActorMeta(name);
    const roleId = meta?.roleId ?? "generic";

    const rolesDir = join(process.env.HOME ?? "~", ".jarvis", "roles");
    try {
      const files = readdirSync(rolesDir).filter(f => f.endsWith(".md"));
      const match = files.find(f => basename(f, ".md") === roleId);
      if (match) {
        const content = readFileSync(join(rolesDir, match), "utf-8");
        const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (m) {
          const fm = m[1];
          const body = m[2].trim();
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          if (nameMatch && descMatch && body) {
            const autoKillMatch = fm.match(/^autoKill:\s*(.+)$/m);
            return {
              id: roleId,
              name: nameMatch[1].trim(),
              description: descMatch[1].trim(),
              systemPrompt: body,
              autoKill: autoKillMatch?.[1]?.trim() === "true",
            };
          }
        }
      }
    } catch {
      // dir missing or unreadable — fall through
    }

    const builtin = BUILT_IN_ROLES.find(r => r.id === roleId) ?? BUILT_IN_ROLES.find(r => r.id === "generic");
    return builtin ?? null;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    if (!this.ctx.sessionManager) {
      throw new Error("ActorRunnerPiece requires sessionManager in PluginContext (requires @jarvis/core >= 0.3.0)");
    }
    this.sessions = this.ctx.sessionManager;

    // ── Dispatch listener: create/configure session, then let JarvisCore process ──
    // Only handles messages with data.role (actor_dispatch tool calls).
    // Direct ai.request messages to actor-* targets (e.g. bus_publish from another
    // actor) are processed directly by JarvisCore — no interception needed here.
    this.unsubDispatch = this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (!msg.target?.startsWith("actor-")) return;
      const dispatch = msg as ActorDispatchMessage;
      if (!dispatch.data?.role) {
        // Direct message to an existing actor — ensure session exists for
        // persisted actors that were restored from disk on startup.
        const name = msg.target.replace("actor-", "");
        const sessionId = msg.target;
        if (!this.sessions.has(sessionId)) {
          const savedSessions = this.sessions.listSaved("actor-");
          if (!savedSessions.includes(sessionId)) return;
          const role = this.resolveActorRole(name);
          if (!role) {
            console.error(`[actor-runner] cannot resolve role for "${name}" and no generic fallback available`);
            return;
          }
          this.getOrCreateSession(name, role);
        }
        return; // JarvisCore handles the rest
      }
      // data.role present — this is an actor_dispatch call: create/configure session.
      this.handleDispatch(dispatch);
    });

    // ── System event listener: kill, abort, pre-create, autoKill via ai.stream ──
    this.unsubKill = this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event === "actor.kill") this.killSession(msg.data.name as string);
      if (msg.event === "actor.abort.request") this.abortSession(msg.data.name as string);
      if (msg.event === "actor.session.create") {
        const name = msg.data?.name as string;
        const role = msg.data?.role as ActorRole;
        if (name && role) this.getOrCreateSession(name, role);
      }
    });

    // ── autoKill: observe ai.stream/complete for actor-* targets ──
    // When JarvisCore finishes a turn for an actor session and the role has
    // autoKill:true, destroy the session immediately after delivery.
    this.unsubComplete = this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
      if (msg.event !== "complete") return;
      if (!msg.target?.startsWith("actor-")) return;
      const name = msg.target.replace("actor-", "");
      if (!this.activeSessions.has(name)) return;
      const role = this.resolveActorRole(name);
      if (role?.autoKill) {
        this.killSession(name);
      }
    });
  }

  async stop(): Promise<void> {
    this.unsubDispatch?.();
    this.unsubKill?.();
    this.unsubComplete?.();
    // Close all actor sessions — ephemeral ones should NOT be saved
    for (const name of this.activeSessions) {
      const sessionId = `actor-${name}`;
      if (this.sessions.isEphemeral(sessionId)) {
        this.sessions.clearSaved(sessionId);
      }
      this.sessions.close(sessionId);
    }
    this.activeSessions.clear();
  }

  private abortSession(name: string): void {
    const sessionId = `actor-${name}`;
    if (!this.sessions.has(sessionId)) return;
    const managed = this.sessions.get(sessionId);

    if (managed.state === "waiting_tools" && managed.pendingToolCalls && managed.session.cleanupAbortedTools) {
      managed.session.cleanupAbortedTools(managed.pendingToolCalls);
    }

    this.sessions.abort(sessionId);
    this.bus.publish({
      channel: "ai.stream",
      source: "actor-runner",
      target: sessionId,
      event: "aborted",
    } as any);
  }

  /**
   * Handle actor_dispatch: create/configure session, then return.
   * JarvisCore picks up the ai.request message and drives the stream loop.
   */
  private handleDispatch(msg: ActorDispatchMessage): void {
    const name = msg.target!.replace("actor-", "");
    const role = msg.data!.role;
    this.getOrCreateSession(name, role);
    // No further action — JarvisCore will process the ai.request message
    // (including handlePrompt → dispatchToSession → consumeStream → replyTo routing).
  }

  private getOrCreateSession(name: string, role: ActorRole): ManagedSession {
    const sessionId = `actor-${name}`;
    this.activeSessions.add(name);
    if (this.sessions.has(sessionId)) {
      const managed = this.sessions.get(sessionId);
      this.applyRoleOverrides(managed, role);
      return managed;
    }

    const managed = this.sessions.getWithPrompt(sessionId, {
      label: sessionId,
      basePromptOverride: this.actorSystemPrompt,
      roleContext: this.buildRoleContext(role),
      model: role.model,
    });
    this.applyRoleOverrides(managed, role);
    return managed;
  }

  /**
   * Apply role-derived per-session overrides:
   *  - role.model → sticky model override
   *  - role.tools.allow / role.tools.block → tool filter
   */
  private applyRoleOverrides(managed: ManagedSession, role: ActorRole): void {
    const session = managed.session;

    if (role.model && typeof session.setStickyModelOverride === "function") {
      session.setStickyModelOverride(role.model);
    } else if (!role.model && typeof session.setStickyModelOverride === "function") {
      session.setStickyModelOverride(undefined);
    }

    if (typeof session.setToolFilter === "function") {
      const allow = role.tools?.allow;
      const block = role.tools?.block;
      if ((allow !== undefined) || (block && block.length > 0)) {
        const allowSet = allow !== undefined ? new Set(allow) : null;
        const blockSet = block && block.length > 0 ? new Set(block) : null;
        session.setToolFilter((toolName: string) => {
          if (allowSet && !allowSet.has(toolName)) return false;
          if (blockSet && blockSet.has(toolName)) return false;
          return true;
        });
      } else {
        session.setToolFilter(undefined);
      }
    }
  }

  private killSession(name: string): void {
    const sessionId = `actor-${name}`;
    if (this.sessions.isEphemeral(sessionId)) {
      this.sessions.clearSaved(sessionId);
    }
    this.sessions.close(sessionId);
    this.activeSessions.delete(name);
    this.bus.publish({
      channel: "system.event",
      source: "actor-runner",
      event: "actor.kill.request",
      data: { name },
    } as any);
  }
}
