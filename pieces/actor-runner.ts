import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ActorRole } from "./types.js";
import { MAX_CAPABILITY_ROUNDS } from "./types.js";
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
          // Lazy-create with generic role — conversation history will be restored from disk
          this.getOrCreateSession(name, { id: "generic", name: "Generic Worker", description: "", systemPrompt: "You are a worker agent for JARVIS. Execute tasks given to you autonomously. Use the available tools as needed. Be thorough and report your results clearly." });
        }
        if (msg.source === "actor-pool" || msg.source === `actor-${name}`) return;
        if (this.running.has(name)) {
          // Queue the message for when the actor finishes
          if (!this.queues.has(name)) this.queues.set(name, []);
          this.queues.get(name)!.push({ text: msg.text, replyTo: msg.replyTo, images: (msg as any).images });
          return;
        }
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
      return;
    }
    this.running.add(name);
    this.runTask(name, task, replyTo, images).finally(() => this.drainQueue(name));
  }

  private async drainQueue(name: string): Promise<void> {
    const queue = this.queues.get(name);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      // Still running — process next queued message
      this.runTask(name, next.text, next.replyTo, next.images).finally(() => this.drainQueue(name));
    } else {
      // Nothing left — mark as not running
      this.running.delete(name);
    }
  }

  private getOrCreateSession(name: string, role: ActorRole): ManagedSession {
    const sessionId = `actor-${name}`;
    this.activeSessions.add(name);
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    return this.sessions.getWithPrompt(sessionId, {
      label: sessionId,
      basePromptOverride: this.actorSystemPrompt,
      roleContext: this.buildRoleContext(role),
    });
  }

  private async runTask(name: string, task: string, replyTo?: string, images?: any[]): Promise<void> {
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

        if (!this.sessions.has(actorSessionId)) return; // killed

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
