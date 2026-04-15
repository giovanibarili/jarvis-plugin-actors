import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Actor, ActorRole, ActorDispatchResultEvent } from "./types.js";
import { BUILT_IN_ROLES, MAX_ACTORS } from "./types.js";

interface EventBus {
  publish<T>(topic: string, data: any): void;
  subscribe<T>(topic: string, handler: (msg: T) => void | Promise<void>): () => void;
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

const HUD_TOPICS = {
  ADD: "hud.piece.add",
  UPDATE: "hud.piece.update",
  REMOVE: "hud.piece.remove",
} as const;

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

    this.unsubDispatchResult = this.bus.subscribe("actor.dispatch.result", (msg: any) => {
      this.handleDispatchResult(msg);
    });

    this.registerTools();

    this.bus.publish(HUD_TOPICS.ADD, {
      sessionId: "system",
      componentId: this.id,
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
    this.bus.publish(HUD_TOPICS.REMOVE, {
      sessionId: "system",
      componentId: this.id,
      pieceId: this.id,
    });
  }

  private handleDispatchResult(msg: any): void {
    const { name, result, replySessionId } = msg as ActorDispatchResultEvent;
    const actor = this.actors.get(name);
    if (actor) {
      actor.status = "idle";
      actor.lastResult = result;
      actor.currentTask = undefined;
      if (result) actor.chatHistory.push({ role: 'actor', text: result });
    }
    this.bus.publish("input.prompt", {
      sessionId: replySessionId,
      componentId: name,
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

        this.bus.publish("actor.dispatch", {
          sessionId: `actor-${name}`,
          componentId: this.id,
          name,
          role: actor.role,
          task,
          replySessionId: sessionId,
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
        this.bus.publish("actor.kill", { sessionId: "system", componentId: this.id, name });
        this.updateHud();
        return { ok: true };
      },
    });

    this.ctx.toolRegistry.register({
      name: "bus_publish",
      description: "Publish a message to the EventBus. Use to send messages to specific sessions.",
      input_schema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Bus topic (e.g. 'input.prompt')" },
          session_id: { type: "string", description: "Target session ID" },
          text: { type: "string", description: "Message text" },
        },
        required: ["topic", "session_id", "text"],
      },
      handler: async (input: any) => {
        const caller = input.__sessionId ? String(input.__sessionId) : "unknown";
        const source = caller.startsWith("actor-") ? caller.replace("actor-", "") : "jarvis";
        this.bus.publish(String(input.topic), {
          sessionId: String(input.session_id),
          componentId: source,
          text: String(input.text),
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
    this.bus.publish(HUD_TOPICS.UPDATE, {
      sessionId: "system",
      componentId: this.id,
      pieceId: this.id,
      data: this.getData(),
      status: [...this.actors.values()].some(a => a.status === "running") ? "processing" : "running",
    });
  }
}
