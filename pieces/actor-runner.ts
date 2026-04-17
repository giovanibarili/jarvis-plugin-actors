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
} from "@jarvis/core";

/** Extended AISession — plugin actors need abort() beyond what @jarvis/core defines */
interface ActorAISession {
  readonly sessionId: string;
  sendAndStream(prompt: string): AsyncGenerator<AIStreamEvent, void>;
  addToolResults(toolCalls: CapabilityCall[], results: CapabilityResult[]): void;
  continueAndStream(): AsyncGenerator<AIStreamEvent, void>;
  abort(): void;
  close(): void;
}

interface ActorSession {
  session: ActorAISession;
  stopped: boolean;
}

/** Dispatch message — AIRequestMessage with extra role data */
interface ActorDispatchMessage extends AIRequestMessage {
  data?: { role: ActorRole; name: string };
}

export class ActorRunnerPiece implements Piece {
  readonly id = "actor-runner";
  readonly name = "Actor Runner";

  private bus!: EventBus;
  private ctx: PluginContext;
  private sessions = new Map<string, ActorSession>();
  private running = new Set<string>();
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

    this.unsubDispatch = this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (!msg.target?.startsWith("actor-")) return;
      const name = msg.target.replace("actor-", "");
      const dispatch = msg as ActorDispatchMessage;
      if (dispatch.data?.role) {
        this.handleDispatch(dispatch);
      } else {
        // Direct message to actor
        const as = this.sessions.get(name);
        if (!as || as.stopped) return;
        if (msg.source === "actor-pool" || msg.source === name) return;
        if (this.running.has(name)) return;
        this.running.add(name);
        this.runTask(name, msg.text, msg.replyTo).finally(() => this.running.delete(name));
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
    for (const [, as] of this.sessions) {
      as.stopped = true;
      as.session.close();
    }
    this.sessions.clear();
  }

  private abortSession(name: string): void {
    const as = this.sessions.get(name);
    if (!as || as.stopped) return;
    as.session.abort();
    this.bus.publish({
      channel: "ai.stream",
      source: name,
      target: `actor-${name}`,
      event: "aborted",
    });
  }

  private handleDispatch(msg: ActorDispatchMessage): void {
    const name = msg.target!.replace("actor-", "");
    const role = msg.data!.role;
    const replyTo = msg.replyTo;
    const task = msg.text;
    if (this.running.has(name)) return;
    this.running.add(name);
    this.getOrCreateSession(name, role);
    this.runTask(name, task, replyTo).finally(() => this.running.delete(name));
  }

  private getOrCreateSession(name: string, role: ActorRole): ActorSession {
    let as = this.sessions.get(name);
    if (as && !as.stopped) return as;

    const session = this.ctx.sessionFactory.createWithPrompt({
      label: `actor-${name}`,
      basePromptOverride: this.actorSystemPrompt,
      roleContext: this.buildRoleContext(role),
    }) as ActorAISession;
    as = { session, stopped: false };
    this.sessions.set(name, as);
    return as;
  }

  private async runTask(name: string, task: string, replyTo?: string): Promise<void> {
    const as = this.sessions.get(name);
    if (!as || as.stopped) return;

    const actorSessionId = `actor-${name}`;
    let fullText = "";
    let capabilityRounds = 0;
    let stream = as.session.sendAndStream(task);

    try {
      while (true) {
        const capabilityCalls: CapabilityCall[] = [];
        fullText = "";

        for await (const event of stream) {
          if (as.stopped) return;
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
              return;
          }
        }

        if (as.stopped) return;

        if (capabilityCalls.length > 0) {
          capabilityRounds++;

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

          // Inject sessionId so capabilities (like skill_invoke) know the calling actor
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

          as.session.addToolResults(capabilityCalls, results);
          stream = as.session.continueAndStream();
          continue;
        }

        break;
      }

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
      this.publishResult(name, `Crashed: ${err}`, replyTo);
    }
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
    const as = this.sessions.get(name);
    if (as) {
      as.stopped = true;
      as.session.close();
      this.sessions.delete(name);
    }
  }
}
