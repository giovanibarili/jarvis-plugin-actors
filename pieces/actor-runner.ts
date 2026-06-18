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
  SystemEventMessage,
  EventBus,
  SessionManager,
  ManagedSession,
} from "@jarvis/core";

/** Dispatch message — AIRequestMessage with extra role data */
interface ActorDispatchMessage extends AIRequestMessage {
  data?: { role: ActorRole; name: string };
}

export class ActorRunnerPiece implements Piece {
  readonly id = "actor-runner";
  readonly name = "Actor Runner";

  private bus!: EventBus;
  private ctx: PluginContext;
  private sessions!: SessionManager;
  private activeSessions = new Set<string>(); // all actor names with live sessions
  private actorSystemPrompt: string;
  private started = false;
  private unsubDispatch?: () => void;
  private unsubKill?: () => void;

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
   *
   * Reads the sidecar `actor-<name>.meta.json` to discover the roleId, then:
   *  1. If there's a matching `~/.jarvis/roles/<roleId>.md` file, parses it.
   *  2. Else falls back to BUILT_IN_ROLES by id.
   *  3. Else falls back to the "generic" built-in.
   *
   * Returns null only if there's no generic fallback available (should never happen).
   */
  private resolveActorRole(name: string): ActorRole | null {
    const meta = readActorMeta(name);
    const roleId = meta?.roleId ?? "generic";

    // Try ~/.jarvis/roles/<roleId>.md first
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

    // Fall back to built-ins by id, then to generic
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

    // Subscribe only to actor-dispatch messages (those with data.role).
    // Direct messages to actor-* are handled entirely by SessionDispatcher.
    // We only need to ensure the session exists before the dispatcher processes it.
    this.unsubDispatch = this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (!msg.target?.startsWith("actor-")) return;
      const dispatch = msg as ActorDispatchMessage;
      if (dispatch.data?.role) {
        this.handleDispatch(dispatch);
      } else {
        // Direct message to actor — lazy-create session if it has saved state on disk.
        // SessionDispatcher will handle queuing and execution; we just ensure the session exists.
        const name = msg.target.replace("actor-", "");
        const sessionId = `actor-${name}`;
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
      }
    });

    this.unsubKill = this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event === "actor.kill") this.killSession(msg.data.name as string);
      if (msg.event === "actor.abort.request") this.abortSession(msg.data.name as string);
      if (msg.event === "actor.session.create") {
        const name = msg.data?.name as string;
        const role = msg.data?.role as ActorRole;
        if (name && role) this.getOrCreateSession(name, role);
      }
    });
  }

  async stop(): Promise<void> {
    this.unsubDispatch?.();
    this.unsubKill?.();
    // Close all actor sessions — ephemeral ones should NOT be saved
    for (const name of this.activeSessions) {
      const sessionId = `actor-${name}`;
      if (this.sessions.isEphemeral(sessionId)) {
        // Delete saved file if it exists, then close without saving
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

    // Use cleanupAbortedTools if available (same as JarvisCore)
    if (managed.state === "waiting_tools" && managed.pendingToolCalls && managed.session.cleanupAbortedTools) {
      managed.session.cleanupAbortedTools(managed.pendingToolCalls);
    }

    this.sessions.abort(sessionId);
    this.bus.publish({
      channel: "ai.stream",
      source: name,
      target: sessionId,
      event: "aborted",
    });
  }

  private handleDispatch(msg: ActorDispatchMessage): void {
    const name = msg.target!.replace("actor-", "");
    const role = msg.data!.role as ActorRole;
    const replyTo = msg.replyTo;
    const task = msg.text;
    const images = (msg as any).images;

    this.getOrCreateSession(name, role);

    // SessionDispatcher handles queuing and execution for all sessions including actor-*
    this.bus.publish({
      channel: "ai.request",
      source: msg.source ?? "actor-pool",
      target: msg.target!,
      text: task,
      replyTo,
      images,
      traceId: msg.traceId,
    } as any);
  }

  private getOrCreateSession(name: string, role: ActorRole): ManagedSession {
    const sessionId = `actor-${name}`;
    this.activeSessions.add(name);
    if (this.sessions.has(sessionId)) {
      // Existing session: re-apply role-derived overrides every time we touch
      // it. The role can change between dispatches (caller may pass a different
      // role for the same actor name) and we want the latest to win.
      const managed = this.sessions.get(sessionId);
      this.applyRoleOverrides(managed, role);
      return managed;
    }

    const managed = this.sessions.getWithPrompt(sessionId, {
      label: sessionId,
      basePromptOverride: this.actorSystemPrompt,
      roleContext: this.buildRoleContext(role),
    });
    this.applyRoleOverrides(managed, role);
    return managed;
  }

  /**
   * Apply role-derived per-session overrides:
   *  - `role.model` → sticky model override (full model id only; aliases are
   *    filtered upstream in actor-pool.parseRoleFile).
   *  - `role.tools.allow / role.tools.block` → tool filter installed on the
   *    session. The filter is consulted on every API call.
   *
   * Both overrides are NO-OPs if the underlying provider doesn't support them
   * (the AISession methods are optional). Silent fallback is correct here:
   * roles are advisory — the actor still runs, just with the global model
   * and the full tool surface.
   */
  private applyRoleOverrides(managed: ManagedSession, role: ActorRole): void {
    const session = managed.session;

    if (role.model && typeof session.setStickyModelOverride === "function") {
      session.setStickyModelOverride(role.model);
    } else if (!role.model && typeof session.setStickyModelOverride === "function") {
      // Role has no model — clear any previous override (e.g. from a prior
      // dispatch with a different role).
      session.setStickyModelOverride(undefined);
    }

    if (typeof session.setToolFilter === "function") {
      const allow = role.tools?.allow;
      const block = role.tools?.block;
      if ((allow !== undefined) || (block && block.length > 0)) {
        // allow present (even empty []) = explicit whitelist; null = no restriction.
        // allow:[] means "block everything" — the Set is empty so nothing passes.
        const allowSet = allow !== undefined ? new Set(allow) : null;
        const blockSet = block && block.length > 0 ? new Set(block) : null;
        session.setToolFilter((toolName: string) => {
          if (allowSet && !allowSet.has(toolName)) return false;
          if (blockSet && blockSet.has(toolName)) return false;
          return true;
        });
      } else {
        // No restrictions — ensure any previous filter is cleared.
        session.setToolFilter(undefined);
      }
    }
  }

  private publishStateChange(name: string, state: string): void {
    this.bus.publish({
      channel: "system.event",
      source: "actor-runner",
      event: "actor.state.change",
      data: { name, state },
    });
  }

  private publishResult(name: string, result: string, replyTo?: string): void {
    // Notify actor-pool of completion (for status tracking)
    this.bus.publish({
      channel: "system.event",
      source: "actor-runner",
      event: "actor.dispatch.result",
      data: { name, result, replyTo: replyTo ?? "" },
    });

    // Send result back to whoever requested it via ai.request
    // SessionDispatcher will receive this as a new prompt and process it
    if (replyTo) {
      this.bus.publish({
        channel: "ai.request",
        source: `actor-${name}`,
        target: replyTo,
        text: `[ACTOR:${name}] ${result}`,
      });
    }
  }

  private killSession(name: string): void {
    const sessionId = `actor-${name}`;
    if (this.sessions.isEphemeral(sessionId)) {
      this.sessions.clearSaved(sessionId);
    }
    this.sessions.close(sessionId);
    this.activeSessions.delete(name);
    // Notify actor-pool to remove the actor from its registry
    this.bus.publish({
      channel: "system.event",
      source: "actor-runner",
      event: "actor.kill.request",
      data: { name },
    });
  }
}
