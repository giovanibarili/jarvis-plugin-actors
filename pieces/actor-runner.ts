import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ActorRole } from "./types.js";
import { MAX_TOOL_ROUNDS } from "./types.js";

interface EventBus {
  publish<T>(topic: string, data: any): void;
  subscribe<T>(topic: string, handler: (msg: T) => void | Promise<void>): () => void;
}

interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}

interface PluginContext {
  bus: EventBus;
  toolRegistry: any;
  pluginDir: string;
  sessionFactory: any;
}

interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string): AsyncGenerator<any, void>;
  addToolResults(toolCalls: any[], results: any[]): void;
  continueAndStream(): AsyncGenerator<any, void>;
  close(): void;
}

interface ActorSession {
  session: AISession;
  stopped: boolean;
}

export class ActorRunnerPiece implements Piece {
  readonly id = "actor-runner";
  readonly name = "Actor Runner";

  private bus!: EventBus;
  private ctx: PluginContext;
  private sessions = new Map<string, ActorSession>();
  private actorSystemPrompt: string;
  private started = false;
  private unsubDispatch?: () => void;
  private unsubKill?: () => void;
  private unsubDirectMsg?: () => void;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.actorSystemPrompt = this.loadActorSystemPrompt();
  }

  private loadActorSystemPrompt(): string {
    const path = join(this.ctx.pluginDir, "actor-system.md");
    if (existsSync(path)) return readFileSync(path, "utf-8");
    return "You are an autonomous worker agent. Execute tasks using available tools. Report results clearly.";
  }

  private buildActorPrompt(role: ActorRole): string {
    return `${this.actorSystemPrompt}\n\n---\n\n## Your Role: ${role.name}\n\n${role.systemPrompt}`;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    this.unsubDispatch = this.bus.subscribe("actor.dispatch", (msg: any) => {
      this.handleDispatch(msg);
    });

    this.unsubKill = this.bus.subscribe("actor.kill", (msg: any) => {
      this.killSession(msg.name);
    });

    this.unsubDirectMsg = this.bus.subscribe("input.prompt", (msg: any) => {
      if (!msg.sessionId?.startsWith("actor-")) return;
      const name = msg.sessionId.replace("actor-", "");
      const as = this.sessions.get(name);
      if (!as || as.stopped) return;
      if (msg.componentId === "actor-pool" || msg.componentId === name) return;
      this.runTask(name, msg.text, msg.replyTo ?? msg.sessionId);
    });
  }

  async stop(): Promise<void> {
    this.unsubDispatch?.();
    this.unsubKill?.();
    this.unsubDirectMsg?.();
    for (const [, as] of this.sessions) {
      as.stopped = true;
      as.session.close();
    }
    this.sessions.clear();
  }

  private handleDispatch(msg: any): void {
    const { name, role, task, replySessionId } = msg;
    this.getOrCreateSession(name, role);
    this.runTask(name, task, replySessionId);
  }

  private getOrCreateSession(name: string, role: ActorRole): ActorSession {
    let as = this.sessions.get(name);
    if (as && !as.stopped) return as;

    const prompt = this.buildActorPrompt(role);
    const session = this.ctx.sessionFactory.createWithPrompt(prompt, { label: `actor-${name}` });
    as = { session, stopped: false };
    this.sessions.set(name, as);
    return as;
  }

  private async runTask(name: string, task: string, replySessionId: string): Promise<void> {
    const as = this.sessions.get(name);
    if (!as || as.stopped) return;

    const actorSessionId = `actor-${name}`;
    let fullText = "";
    let toolRounds = 0;
    let stream = as.session.sendAndStream(task);

    try {
      while (true) {
        const toolCalls: any[] = [];
        fullText = "";

        for await (const event of stream) {
          if (as.stopped) return;
          switch (event.type) {
            case "text_delta":
              fullText += event.text ?? "";
              this.bus.publish(`core.${actorSessionId}.stream.delta`, {
                sessionId: actorSessionId,
                componentId: "actor-runner",
                text: event.text ?? "",
              });
              break;
            case "tool_use":
              if (event.toolUse) toolCalls.push(event.toolUse);
              break;
            case "error":
              this.bus.publish(`core.${actorSessionId}.error`, {
                sessionId: actorSessionId,
                componentId: "actor-runner",
                error: event.error ?? "Unknown error",
              });
              this.publishResult(name, `Error: ${event.error}`, replySessionId);
              return;
          }
        }

        if (as.stopped) return;

        if (toolCalls.length > 0) {
          toolRounds++;
          if (toolRounds > MAX_TOOL_ROUNDS) {
            fullText += "\n\n[Max tool rounds reached. Stopping.]";
            break;
          }
          const results = await this.ctx.toolRegistry.execute(toolCalls);
          as.session.addToolResults(toolCalls, results);
          stream = as.session.continueAndStream();
          continue;
        }

        break;
      }

      this.bus.publish(`core.${actorSessionId}.stream.complete`, {
        sessionId: actorSessionId,
        componentId: "actor-runner",
        fullText,
        usage: { input_tokens: 0, output_tokens: 0 },
      });

      this.publishResult(name, fullText, replySessionId);
    } catch (err) {
      this.publishResult(name, `Crashed: ${err}`, replySessionId);
    }
  }

  private publishResult(name: string, result: string, replySessionId: string): void {
    this.bus.publish("actor.dispatch.result", {
      sessionId: "system",
      componentId: "actor-runner",
      name,
      result,
      replySessionId,
    });
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
