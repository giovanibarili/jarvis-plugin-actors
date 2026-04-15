import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Actor, ActorRole, ActorDispatchResultEvent } from "./types.js";
import { BUILT_IN_ROLES, MAX_ACTORS } from "./types.js";

interface EventBus {
  publish(msg: any): void;
  subscribe(channel: string, handler: (msg: any) => void | Promise<void>): () => void;
}

interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  systemContext?(): string;
}

interface PluginContext {
  bus: EventBus;
  toolRegistry: any;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: any;
  registerRoute: (method: string, path: string, handler: any) => void;
}

export class ActorPoolPiece implements Piece {
  readonly id = "actor-pool";
  readonly name = "Actor Pool";

  private bus!: EventBus;
  private ctx: PluginContext;
  private actors = new Map<string, Actor>();
  private roles: ActorRole[];
  private started = false;
  private unsubDispatchResult?: () => void;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.roles = [...BUILT_IN_ROLES];
  }

  systemContext(): string {
    const actorList = [...this.actors.values()]
      .map(a => `${a.id} (${a.role.id}): ${a.status}, ${a.taskCount} tasks done`)
      .join('; ');
    const roleList = this.roles.map(r => `${r.id}: ${r.description}`).join('\n');
    return `## Actor Pool
Delegate tasks to persistent AI actors. Each actor has its own session with memory.
Max actors: ${MAX_ACTORS}. Active: ${actorList || 'none'}.

Available roles:
${roleList}

Tools: actor_dispatch, actor_list, actor_kill, bus_publish`;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    this.unsubDispatchResult = this.bus.subscribe("system.event", (msg: any) => {
      if (msg.event === "actor.dispatch.result") this.handleDispatchResult(msg);
    });

    this.registerTools();

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: "running",
        data: this.getData(),
        position: { x: 1680, y: 350 },
        size: { width: 240, height: 120 },
      },
    });
  }

  async stop(): Promise<void> {
    this.unsubDispatchResult?.();
    this.actors.clear();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
  }

  private handleDispatchResult(msg: any): void {
    const { name, result, replySessionId } = msg.data as ActorDispatchResultEvent;
    const actor = this.actors.get(name);
    if (actor) {
      actor.status = "idle";
      actor.lastResult = result;
      actor.currentTask = undefined;
      if (result) actor.chatHistory.push({ role: 'actor', text: result });
    }
    // Publish as ai.stream complete so ChatPiece shows it in main chat
    this.bus.publish({
      channel: "ai.stream",
      source: name,
      target: "main",
      event: "complete",
      text: result,
    });
    this.updateHud();
  }

  private registerTools(): void {
    this.ctx.toolRegistry.register({
      name: "actor_dispatch",
      description: "Send a task to a named actor. If the actor exists, reuses its session (keeps memory). If new, creates one. The actor runs autonomously and reports back when done.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Actor name (e.g. 'alice', 'bob'). Same name = same session." },
          role: { type: "string", description: "Role for new actors: generic, researcher, coder, reviewer." },
          task: { type: "string", description: "The task description" },
        },
        required: ["name", "role", "task"],
      },
      handler: async (input: any) => {
        const sessionId = input.__sessionId ? String(input.__sessionId) : "main";
        const name = String(input.name);
        const roleId = String(input.role);
        const task = String(input.task);

        let actor = this.actors.get(name);
        if (actor) {
          if (actor.status === "running" || actor.status === "waiting_tools") {
            return { ok: false, error: `Actor '${name}' is busy (${actor.status}).` };
          }
          actor.replySessionId = sessionId;
        } else {
          const role = this.roles.find(r => r.id === roleId);
          if (!role) return { ok: false, error: `Unknown role: ${roleId}. Available: ${this.roles.map(r => r.id).join(', ')}` };
          if (this.actors.size >= MAX_ACTORS) return { ok: false, error: `Pool full (${this.actors.size}/${MAX_ACTORS}).` };

          actor = { id: name, role, status: "idle", createdAt: Date.now(), taskCount: 0, replySessionId: sessionId, chatHistory: [] };
          this.actors.set(name, actor);
        }

        actor.currentTask = task;
        actor.chatHistory.push({ role: 'user', text: task, source: 'jarvis' });
        actor.status = "running";
        actor.taskCount++;
        this.updateHud();

        this.bus.publish({
          channel: "ai.request",
          source: "jarvis-core",
          target: "actor-" + name,
          text: task,
          data: { name, role: actor.role, replySessionId: sessionId },
        });

        return { ok: true, actorId: name };
      },
    });

    this.ctx.toolRegistry.register({
      name: "actor_list",
      description: "List all actors in the pool with their status, role, and task count.",
      input_schema: { type: "object", properties: {} },
      handler: async () => ({
        maxActors: MAX_ACTORS,
        actors: [...this.actors.values()].map(a => ({
          id: a.id, role: a.role.id, status: a.status, taskCount: a.taskCount,
          currentTask: a.currentTask?.slice(0, 100),
          lastResultPreview: a.lastResult?.slice(0, 200),
          uptime: Math.round((Date.now() - a.createdAt) / 1000) + "s",
        })),
        roles: this.roles.map(r => ({ id: r.id, name: r.name, description: r.description })),
      }),
    });

    this.ctx.toolRegistry.register({
      name: "actor_kill",
      description: "Kill an actor and destroy its session.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Actor name to kill" } },
        required: ["name"],
      },
      handler: async (input: any) => {
        const name = String(input.name);
        const actor = this.actors.get(name);
        if (!actor) return { ok: false, error: `Actor not found: ${name}` };
        actor.status = "stopped";
        this.actors.delete(name);
        this.bus.publish({ channel: "system.event", source: this.id, event: "actor.kill", data: { name } });
        this.updateHud();
        return { ok: true };
      },
    });

    this.ctx.toolRegistry.register({
      name: "bus_publish",
      description: "Publish a message to the EventBus. Use to send messages to specific targets.",
      input_schema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Bus channel (e.g. 'ai.request', 'system.event')" },
          target: { type: "string", description: "Target ID (e.g. 'actor-alice', 'main')" },
          text: { type: "string", description: "Message text" },
        },
        required: ["channel", "target", "text"],
      },
      handler: async (input: any) => {
        const caller = input.__sessionId ? String(input.__sessionId) : "unknown";
        const source = caller.startsWith("actor-") ? caller.replace("actor-", "") : "jarvis";
        const { channel, target, text, ...rest } = input;
        this.bus.publish({
          channel: String(channel) as any,
          source,
          target: String(target),
          text: String(text),
          ...rest,
        });
        return { ok: true };
      },
    });
  }

  private getData(): Record<string, unknown> {
    const actors = [...this.actors.values()];
    return {
      maxActors: MAX_ACTORS,
      total: actors.length,
      active: actors.filter(a => a.status === "running" || a.status === "waiting_tools").length,
      idle: actors.filter(a => a.status === "idle").length,
      actors: actors.map(a => ({ id: a.id, role: a.role.id, status: a.status, tasks: a.taskCount })),
    };
  }

  private updateHud(): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: [...this.actors.values()].some(a => a.status === "running") ? "processing" : "running",
    });
  }
}
