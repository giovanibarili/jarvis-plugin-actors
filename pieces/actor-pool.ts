import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Actor, ActorRole, ActorDispatchResultEvent } from "./types.js";
import { BUILT_IN_ROLES, MAX_ACTORS } from "./types.js";
import type {
  Piece,
  PluginContext,
  SystemEventMessage,
  CapabilityDefinition,
  CapabilityHandler,
  EventBus,
} from "@jarvis/core";

export class ActorPoolPiece implements Piece {
  readonly id = "actor-pool";
  readonly name = "Actor Pool";

  private bus!: EventBus;
  private ctx: PluginContext;
  private actors = new Map<string, Actor>();
  private roles: ActorRole[];
  private started = false;
  private unsubDispatchResult?: () => void;

  private static readonly ROLES_DIR = join(process.env.HOME ?? "~", ".jarvis", "roles");

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.roles = this.loadRoles();
  }

  /**
   * Load roles from ~/.jarvis/roles/*.md files.
   * Falls back to BUILT_IN_ROLES if directory doesn't exist or is empty.
   * File format: YAML frontmatter (name, description) + body (system prompt).
   * Role ID = filename without extension.
   */
  private loadRoles(): ActorRole[] {
    const dir = ActorPoolPiece.ROLES_DIR;
    if (!existsSync(dir)) return [...BUILT_IN_ROLES];

    const files = readdirSync(dir).filter(f => f.endsWith(".md"));
    if (files.length === 0) return [...BUILT_IN_ROLES];

    const roles: ActorRole[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        const role = this.parseRoleFile(file, content);
        if (role) roles.push(role);
      } catch {
        // skip malformed files
      }
    }

    return roles.length > 0 ? roles : [...BUILT_IN_ROLES];
  }

  private parseRoleFile(filename: string, content: string): ActorRole | null {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = match[1];
    const body = match[2].trim();

    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

    if (!nameMatch || !descMatch || !body) return null;

    return {
      id: basename(filename, ".md"),
      name: nameMatch[1].trim(),
      description: descMatch[1].trim(),
      systemPrompt: body,
    };
  }

  systemContext(): string {
    const parts: string[] = [];

    // Active actors (dynamic state)
    const actorEntries = [...this.actors.values()];
    if (actorEntries.length > 0) {
      const actorList = actorEntries
        .map(a => `- ${a.id} (${a.role.id}): ${a.status}, ${a.taskCount} tasks done`)
        .join('\n');
      parts.push(`### Active Actors\n${actorList}`);
    }

    // Available roles (dynamic — loaded from ~/.jarvis/roles/)
    if (this.roles.length > 0) {
      const roleList = this.roles.map(r => `- ${r.id}: ${r.description}`).join('\n');
      parts.push(`### Available Roles\n${roleList}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : '';
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    this.unsubDispatchResult = this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event === "actor.dispatch.result") this.handleDispatchResult(msg);
      if (msg.event === "actor.kill.request") {
        const name = msg.data?.name as string | undefined;
        if (name) {
          const actor = this.actors.get(name);
          if (actor) {
            actor.status = "stopped";
            this.actors.delete(name);
            this.bus.publish({ channel: "system.event", source: this.id, event: "actor.kill", data: { name } });
            this.updateHud();
          }
        }
      }
      if (msg.event === "actor.create.request") {
        this.handleCreateRequest(msg);
      }
    });

    this.registerCapabilities();

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

  private handleCreateRequest(msg: SystemEventMessage): void {
    const name = msg.data?.name as string | undefined;
    const roleId = msg.data?.roleId as string | undefined;
    if (!name || !roleId) return;

    // Already exists
    if (this.actors.has(name)) return;

    const role = this.roles.find(r => r.id === roleId);
    if (!role) return;
    if (this.actors.size >= MAX_ACTORS) return;

    const actor: Actor = { id: name, role, status: "idle", createdAt: Date.now(), taskCount: 0, replyTo: "main", chatHistory: [] };
    this.actors.set(name, actor);
    this.updateHud();

    // Tell actor-runner to create the AI session (dispatch with no real task — just init)
    this.bus.publish({
      channel: "system.event",
      source: this.id,
      event: "actor.session.create",
      data: { name, role },
    });

    // Notify JARVIS main session
    this.bus.publish({
      channel: "ai.request",
      source: "system",
      target: "main",
      text: `[SYSTEM] Actor "${name}" (${role.id}) created from the HUD and is idle in the pool.`,
    });
  }

  private handleDispatchResult(msg: SystemEventMessage): void {
    const { name, result } = msg.data as unknown as ActorDispatchResultEvent;
    const actor = this.actors.get(name);
    if (actor) {
      actor.status = "idle";
      actor.lastResult = result;
      actor.currentTask = undefined;
      if (result) actor.chatHistory.push({ role: 'actor', text: result });
    }
    // ai.stream "complete" for actor chat UI is emitted by actor-runner.runTask
    // ai.request reply back to caller is handled by actor-runner.publishResult
    this.updateHud();
  }

  private registerCapabilities(): void {
    const roleIds = this.roles.map(r => r.id).join(", ");

    this.ctx.capabilityRegistry.register({
      name: "actor_dispatch",
      description: "Send a task to a named actor. If the actor exists, reuses its session (keeps memory). If new, creates one. The actor runs autonomously and reports back when done.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Actor name (e.g. 'alice', 'bob'). Same name = same session." },
          role: { type: "string", description: `Role for new actors: ${roleIds}.` },
          task: { type: "string", description: "The task description" },
        },
        required: ["name", "role", "task"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const sessionId = input.__sessionId ? String(input.__sessionId) : "main";
        const name = String(input.name);
        const roleId = String(input.role);
        const task = String(input.task);

        let actor = this.actors.get(name);
        if (actor) {
          if (actor.status === "running" || actor.status === "waiting_tools") {
            return { ok: false, error: `Actor '${name}' is busy (${actor.status}).` };
          }
          actor.replyTo = sessionId;
        } else {
          const role = this.roles.find(r => r.id === roleId);
          if (!role) return { ok: false, error: `Unknown role: ${roleId}. Available: ${this.roles.map(r => r.id).join(', ')}` };
          if (this.actors.size >= MAX_ACTORS) return { ok: false, error: `Pool full (${this.actors.size}/${MAX_ACTORS}).` };

          actor = { id: name, role, status: "idle", createdAt: Date.now(), taskCount: 0, replyTo: sessionId, chatHistory: [] };
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
          replyTo: sessionId,
          text: task,
          data: { name, role: actor.role },
        } as Parameters<EventBus["publish"]>[0]);

        return { ok: true, actorId: name };
      }) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "actor_list",
      description: "List all actors in the pool with their status, role, and task count.",
      input_schema: { type: "object", properties: {} },
      handler: (async () => ({
        maxActors: MAX_ACTORS,
        actors: [...this.actors.values()].map(a => ({
          id: a.id, role: a.role.id, status: a.status, taskCount: a.taskCount,
          currentTask: a.currentTask?.slice(0, 100),
          lastResultPreview: a.lastResult?.slice(0, 200),
          uptime: Math.round((Date.now() - a.createdAt) / 1000) + "s",
        })),
        roles: this.roles.map(r => ({ id: r.id, name: r.name, description: r.description })),
      })) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "actor_kill",
      description: "Kill an actor and destroy its session.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Actor name to kill" } },
        required: ["name"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const name = String(input.name);
        const actor = this.actors.get(name);
        if (!actor) return { ok: false, error: `Actor not found: ${name}` };
        actor.status = "stopped";
        this.actors.delete(name);
        this.bus.publish({ channel: "system.event", source: this.id, event: "actor.kill", data: { name } });
        this.updateHud();
        return { ok: true };
      }) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "bus_publish",
      description: "Publish a message to the EventBus. Use to send messages to specific targets.\n\n"
        + "Fire-and-forget (default): omit reply_to or set it to false. The message is delivered but "
        + "no response comes back to you. Use for notifications, one-way commands, or when you don't need an answer.\n\n"
        + "Request-reply: set reply_to=true. The target will automatically route its response back to your session "
        + "once it finishes processing. Use when you ask a question or need the result of a task.",
      input_schema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Bus channel (e.g. 'ai.request', 'system.event')" },
          target: { type: "string", description: "Target ID (e.g. 'actor-alice', 'main')" },
          text: { type: "string", description: "Message text" },
          reply_to: { type: "boolean", description: "Set to true to receive the target's response back in your session. Default: false (fire-and-forget)." },
        },
        required: ["channel", "target", "text"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const caller = input.__sessionId ? String(input.__sessionId) : "unknown";
        const source = caller.startsWith("actor-") ? caller : "jarvis";
        const channel = String(input.channel);
        const target = String(input.target);
        const text = String(input.text);
        const wantsReply = !!input.reply_to;
        // Set replyTo only when explicitly requested
        let replyTo: string | undefined;
        if (wantsReply) {
          replyTo = caller.startsWith("actor-") ? caller
            : caller === "main" ? "main"
            : undefined;
        }
        this.bus.publish({
          channel: channel as "ai.request",
          source,
          target,
          text,
          replyTo,
        } as Parameters<EventBus["publish"]>[0]);
        return { ok: true };
      }) as CapabilityHandler,
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
      roles: this.roles.map(r => ({ id: r.id, name: r.name, description: r.description })),
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
