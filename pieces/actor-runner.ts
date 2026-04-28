import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { readdirSync } from "node:fs";
import type { ActorRole } from "./types.js";
import { BUILT_IN_ROLES, MAX_CAPABILITY_ROUNDS } from "./types.js";
import { readActorMeta } from "./actor-meta.js";
import type {
  Piece,
  PluginContext,
  AIStreamEvent,
  AIRequestMessage,
  SystemEventMessage,
  CapabilityCall,
  CapabilityResult,
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
  private running = new Set<string>();
  private activeSessions = new Set<string>(); // all actor names with live sessions
  private queues = new Map<string, Array<{ text: string; replyTo?: string; images?: any[] }>>();
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
            return { id: roleId, name: nameMatch[1].trim(), description: descMatch[1].trim(), systemPrompt: body };
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

    this.unsubDispatch = this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (!msg.target?.startsWith("actor-")) return;
      const name = msg.target.replace("actor-", "");
      const dispatch = msg as ActorDispatchMessage;
      if (dispatch.data?.role) {
        this.handleDispatch(dispatch);
      } else {
        // Direct message to actor — lazy-create session if it has saved state on disk
        const sessionId = `actor-${name}`;
        if (!this.sessions.has(sessionId)) {
          // Check if there's a saved session on disk (persistent actor restored by pool)
          const savedSessions = this.sessions.listSaved("actor-");
          if (!savedSessions.includes(sessionId)) return;
          // Resolve role from the meta sidecar so we don't silently downgrade
          // persistent actors to the generic role on restart.
          const role = this.resolveActorRole(name);
          if (!role) {
            console.error(`[actor-runner] cannot resolve role for "${name}" and no generic fallback available`);
            return;
          }
          this.getOrCreateSession(name, role);
        }
        if (msg.source === "actor-pool" || msg.source === `actor-${name}`) return;
        if (this.running.has(name)) {
          // Queue the message for when the actor finishes. Emit pending_queue
          // so the chat panel renders a queue card. NEVER emit prompt_dispatched
          // here — that happens later, when drainQueue actually sends it.
          if (!this.queues.has(name)) this.queues.set(name, []);
          this.queues.get(name)!.push({ text: msg.text, replyTo: msg.replyTo, images: (msg as any).images });
          this.broadcastPendingQueue(name);
          return;
        }
        // Idle path — about to dispatch immediately. Emit prompt_dispatched
        // so the chat panel renders the user entry NOW (mirrors
        // JarvisCore's contract for owned sessions).
        this.broadcastPromptDispatched(name, [{
          text: msg.text,
          source: msg.source,
          images: (msg as any).images,
        }]);
        this.running.add(name);
        this.runTask(name, msg.text, msg.replyTo, (msg as any).images).finally(() => this.drainQueue(name));
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
    this.queues.clear();
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
    this.running.clear();
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
    const role = msg.data!.role;
    const replyTo = msg.replyTo;
    const task = msg.text;
    const images = (msg as any).images;
    this.getOrCreateSession(name, role);
    if (this.running.has(name)) {
      if (!this.queues.has(name)) this.queues.set(name, []);
      this.queues.get(name)!.push({ text: task, replyTo, images });
      this.broadcastPendingQueue(name);
      return;
    }
    // Idle path — dispatching immediately. Emit prompt_dispatched so the
    // chat panel renders the user entry NOW.
    this.broadcastPromptDispatched(name, [{
      text: task,
      source: msg.source,
      images,
    }]);
    this.running.add(name);
    this.runTask(name, task, replyTo, images, role).finally(() => this.drainQueue(name));
  }

  private async drainQueue(name: string): Promise<void> {
    const queue = this.queues.get(name);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      // About to dispatch the queued message — emit prompt_dispatched so
      // it migrates from QUEUED card to a `type:"user"` timeline entry,
      // and refresh the pending_queue snapshot (one less item now).
      this.broadcastPromptDispatched(name, [{
        text: next.text,
        source: "chat",
        images: next.images,
      }]);
      this.broadcastPendingQueue(name);
      this.runTask(name, next.text, next.replyTo, next.images).finally(() => this.drainQueue(name));
    } else {
      // Nothing left — mark as not running, broadcast empty queue so
      // ChatPanel clears any lingering cards.
      this.running.delete(name);
      this.broadcastPendingQueue(name);
    }
  }

  /**
   * Emit `ai.stream` event `pending_queue` carrying a snapshot of the
   * actor's queue. Mirrors JarvisCore.broadcastPendingQueue exactly so
   * ChatPanel renders identical cards regardless of who owns the session.
   * Text is truncated to 280 chars to keep the SSE payload small.
   */
  private broadcastPendingQueue(name: string): void {
    const sessionId = `actor-${name}`;
    const queue = this.queues.get(name) ?? [];
    const items = queue.map(q => ({
      text: (q.text ?? "").slice(0, 280),
      source: "chat",
      hasImages: !!q.images?.length,
    }));
    this.bus.publish({
      channel: "ai.stream",
      source: name,
      target: sessionId,
      event: "pending_queue",
      items,
    } as any);
  }

  /**
   * Emit `ai.stream` event `prompt_dispatched` carrying the items that
   * are about to be sent to the AI. ChatPiece expands each item into a
   * `type:"user"` SSE entry. Mirrors JarvisCore.broadcastPromptDispatched
   * — contract: a session owner emits this when a prompt actually goes
   * to the model, which is the UX moment for the timeline entry.
   */
  private broadcastPromptDispatched(
    name: string,
    items: Array<{ text: string; source?: string; images?: any[] }>,
  ): void {
    if (items.length === 0) return;
    const sessionId = `actor-${name}`;
    this.bus.publish({
      channel: "ai.stream",
      source: name,
      target: sessionId,
      event: "prompt_dispatched",
      items: items.map(i => ({ text: i.text, source: i.source, images: i.images })),
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

  private async runTask(name: string, task: string, replyTo?: string, images?: any[], role?: ActorRole): Promise<void> {
    const actorSessionId = `actor-${name}`;
    if (!this.sessions.has(actorSessionId)) return;

    const managed = this.sessions.get(actorSessionId);
    this.sessions.setState(actorSessionId, "processing");
    this.publishStateChange(name, "running");

    let fullText = "";
    let capabilityRounds = 0;
    const imgBlocks = images?.map(i => ({ label: i.label, base64: i.base64, mediaType: i.mediaType }));
    let stream = managed.session.sendAndStream(task, imgBlocks);

    try {
      while (true) {
        const capabilityCalls: CapabilityCall[] = [];
        fullText = "";

        for await (const event of stream) {
          if (!this.sessions.has(actorSessionId)) return; // killed mid-stream
          switch (event.type) {
            case "text_delta":
              fullText += event.text ?? "";
              this.bus.publish({
                channel: "ai.stream",
                source: name,
                target: actorSessionId,
                event: "delta",
                text: event.text ?? "",
              });
              break;
            case "tool_use":
              if (event.toolUse) capabilityCalls.push(event.toolUse as CapabilityCall);
              break;
            case "retry":
              // Transient API error → session is going to retry. Forward
              // the retry banner over ai.stream so the actor's chat panel
              // shows "Retrying (n/10, ~Xs)…" until the next text_delta
              // (success) or terminal event.
              if ((event as any).retry) {
                this.bus.publish({
                  channel: "ai.stream",
                  source: name,
                  target: actorSessionId,
                  event: "retry",
                  retry: (event as any).retry,
                } as any);
              }
              break;
            case "error":
              if (event.error === "aborted") {
                // User-initiated abort — not an error, stop gracefully
                this.bus.publish({
                  channel: "ai.stream",
                  source: name,
                  target: actorSessionId,
                  event: "aborted",
                });
                this.publishStatus(name, "aborted");
                this.sessions.setState(actorSessionId, "idle");
                this.publishStateChange(name, "idle");
                return;
              }
              this.bus.publish({
                channel: "ai.stream",
                source: name,
                target: actorSessionId,
                event: "error",
                text: event.error ?? "Unknown error",
              });
              this.publishResult(name, `Error: ${event.error}`, replyTo);
              this.sessions.setState(actorSessionId, "idle");
              this.publishStateChange(name, "idle");
              return;
          }
        }

        if (!this.sessions.has(actorSessionId)) {
          // Session was killed mid-loop (e.g. actor called actor_kill on itself).
          // Still publish whatever text was accumulated so the result isn't lost.
          if (fullText) this.publishResult(name, fullText, replyTo);
          return;
        }

        if (capabilityCalls.length > 0) {
          capabilityRounds++;
          this.sessions.setState(actorSessionId, "waiting_tools");
          this.publishStateChange(name, "waiting_tools");

          for (const call of capabilityCalls) {
            this.bus.publish({
              channel: "ai.stream",
              source: name,
              target: actorSessionId,
              event: "tool_start",
              toolName: call.name,
              toolId: call.id,
              toolArgs: typeof call.input === "string" ? call.input : JSON.stringify(call.input).slice(0, 300),
            });
          }

          // Inject sessionId so capabilities know the calling actor
          const enrichedCalls = capabilityCalls.map(c => ({
            ...c,
            input: { ...(c.input as Record<string, unknown>), __sessionId: actorSessionId },
          }));
          const results: CapabilityResult[] = await this.ctx.capabilityRegistry.execute(enrichedCalls);

          for (let i = 0; i < capabilityCalls.length; i++) {
            const call = capabilityCalls[i];
            const result = results[i];
            const output = typeof result?.content === "string" ? result.content.slice(0, 300) : JSON.stringify(result).slice(0, 300);
            this.bus.publish({
              channel: "ai.stream",
              source: name,
              target: actorSessionId,
              event: "tool_done",
              toolName: call.name,
              toolId: call.id,
              toolOutput: output,
            });
          }

          managed.session.addToolResults(capabilityCalls, results);
          this.sessions.setState(actorSessionId, "processing");
          this.publishStateChange(name, "running");
          stream = managed.session.continueAndStream();
          continue;
        }

        break;
      }

      // Complete — set idle (triggers auto-save)
      this.sessions.setState(actorSessionId, "idle");
      this.publishStateChange(name, "idle");

      // Complete event for actor chat UI
      this.bus.publish({
        channel: "ai.stream",
        source: name,
        target: actorSessionId,
        event: "complete",
        text: fullText,
      });

      this.publishResult(name, fullText, replyTo);

      // autoKill: one-shot roles (e.g. reader) clean themselves up after delivery.
      if (role.autoKill) this.killSession(name);
    } catch (err) {
      this.sessions.setState(actorSessionId, "idle");
      this.publishStateChange(name, "idle");
      this.publishResult(name, `Crashed: ${err}`, replyTo);
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

  private publishStatus(name: string, status: string): void {
    // Notify actor-pool of status change (for UI tracking) without sending to main
    this.bus.publish({
      channel: "system.event",
      source: "actor-runner",
      event: "actor.dispatch.result",
      data: { name, result: `[${status}]`, replyTo: "" },
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
    // JarvisCore will receive this as a new prompt and process it
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
    this.queues.delete(name);
    this.running.delete(name);
    this.activeSessions.delete(name);
  }
}
