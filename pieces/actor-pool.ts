import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Actor, ActorRole, ActorDispatchResultEvent, ActorReportedStatus, ActorStatusEvent } from "./types.js";
import { BUILT_IN_ROLES, MAX_ACTORS } from "./types.js";
import { readActorMeta, writeActorMeta, deleteActorMeta } from "./actor-meta.js";
import type {
  Piece,
  PluginContext,
  SystemEventMessage,
  CapabilityDefinition,
  CapabilityHandler,
  EventBus,
  GraphHandle,
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
  private graphHandle?: GraphHandle;

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
    // IMPORTANT: do NOT inject Active Actors here — the active-actor list changes
    // every time an actor is created/killed, which would invalidate the BP1
    // plugin-dynamic-context cache on every mutation. Instead, create/kill events
    // are surfaced to the main session as `[SYSTEM] <reminder>...</reminder>` chat
    // messages (see handleCreateRequest and the actor_kill capability handler).
    // Available Roles is stable across an entire JARVIS run (loaded once from
    // ~/.jarvis/roles/) so it stays in the system prompt safely.
    if (this.roles.length === 0) return '';
    const roleList = this.roles.map(r => `- ${r.id}: ${r.description}`).join('\n');
    return `### Available Roles\n${roleList}`;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    this.unsubDispatchResult = this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event === "actor.status") this.handleActorStatus(msg);
      if (msg.event === "actor.dispatch.result") this.handleDispatchResult(msg);
      if (msg.event === "actor.state.change") this.handleStateChange(msg);
      if (msg.event === "actor.kill.request") {
        const name = msg.data?.name as string | undefined;
        if (name) {
          const actor = this.actors.get(name);
          if (actor) {
            // If not persistent, clear saved session file before killing
            if (!actor.persistent) {
              const sm = this.ctx.sessionManager;
              if (sm) sm.clearSaved(`actor-${name}`);
            }
            // Kill always removes the meta sidecar — the actor no longer exists.
            deleteActorMeta(name);
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
      if (msg.event === "actor.chat.open") {
        const name = msg.data?.name as string | undefined;
        if (name) this.openActorChat(name);
      }
    });

    this.registerCapabilities();
    this.registerRoutes();
    this.restoreSavedActorSessions();

    // Register graph children — show each actor as a child node of Actor Pool
    if (this.ctx.graphHandle) {
      this.graphHandle = this.ctx.graphHandle(this.id);
      this.updateGraph();
    }

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
        renderer: { plugin: "jarvis-plugin-actors", file: "ActorPoolRenderer" },
      },
    });
  }

  async stop(): Promise<void> {
    this.unsubDispatchResult?.();
    if (this.graphHandle) {
      this.graphHandle.setChildren(undefined);
    }
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

    const actor: Actor = { id: name, role, status: "idle", createdAt: Date.now(), taskCount: 0, replyTo: "main", chatHistory: [], persistent: false };
    this.syncPersistence(actor);
    this.actors.set(name, actor);
    // Manual-created actors start ephemeral — no meta file until toggled persistent.
    this.updateHud();

    // Tell actor-runner to create the AI session (dispatch with no real task — just init)
    this.bus.publish({
      channel: "system.event",
      source: this.id,
      event: "actor.session.create",
      data: { name, role },
    });

    // Notify JARVIS main session via a reminder tag (kept out of the system
    // prompt to preserve the BP1 cache — see systemContext() note).
    this.bus.publish({
      channel: "ai.request",
      source: "system",
      target: "main",
      text: `[SYSTEM] <reminder>Actor "${name}" (role: ${role.id}) was created by the user from the HUD and is now idle in the pool. DO NOT kill this actor — it was manually created by the user.</reminder>`,
    });
  }

  private handleStateChange(msg: SystemEventMessage): void {
    const name = msg.data?.name as string | undefined;
    const state = msg.data?.state as string | undefined;
    if (!name || !state) return;
    const actor = this.actors.get(name);
    if (!actor) return;
    // Map runner states to actor status
    if (state === "running") actor.status = "running";
    else if (state === "waiting_tools") actor.status = "waiting_tools";
    else if (state === "idle") actor.status = "idle";
    this.updateHud();
  }

  private handleActorStatus(msg: SystemEventMessage): void {
    const { actorId, status, message } = msg.data as unknown as ActorStatusEvent;
    const actor = this.actors.get(actorId);
    if (!actor) return;
    actor.statusMessage = `[${status}] ${message}`;
    this.updateHud();
  }

  private handleDispatchResult(msg: SystemEventMessage): void {
    const { name, result } = msg.data as unknown as ActorDispatchResultEvent;
    const actor = this.actors.get(name);
    if (actor) {
      actor.status = "idle";
      actor.lastResult = result;
      actor.currentTask = undefined;
      actor.statusMessage = undefined;
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
          persistent: { type: "boolean", description: "If true, session is saved to disk and restored on boot. Default: false (ephemeral)." },
        },
        required: ["name", "role", "task"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const sessionId = input.__sessionId ? String(input.__sessionId) : "main";
        const name = String(input.name);
        const roleId = String(input.role);
        const task = String(input.task);
        const persistent = input.persistent === true;

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

          actor = { id: name, role, status: "idle", createdAt: Date.now(), taskCount: 0, replyTo: sessionId, chatHistory: [], persistent };
          this.actors.set(name, actor);
          this.syncPersistence(actor);
          if (persistent) {
            writeActorMeta(name, { roleId: role.id, persistent: true, createdAt: actor.createdAt });
          }
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
        // Kill always removes the meta sidecar; clearSaved only if actor was persistent.
        if (actor.persistent) {
          const sm = this.ctx.sessionManager;
          if (sm) sm.clearSaved(`actor-${name}`);
        }
        deleteActorMeta(name);
        actor.status = "stopped";
        this.actors.delete(name);
        this.bus.publish({ channel: "system.event", source: this.id, event: "actor.kill", data: { name } });
        this.updateHud();
        return { ok: true };
      }) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "actor_status",
      description: "Report current actor status to the HUD. Call this proactively when your state changes.",
      input_schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["working", "waiting", "done", "error", "needs_input"],
            description: "Current actor status",
          },
          message: {
            type: "string",
            description: "Short description of current state, e.g. 'Running tests', 'Waiting for API response'",
          },
        },
        required: ["status", "message"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const caller = input.__sessionId ? String(input.__sessionId) : "unknown";
        const actorId = caller.startsWith("actor-") ? caller.replace("actor-", "") : caller;
        const status = String(input.status) as ActorReportedStatus;
        const message = String(input.message);

        this.bus.publish({
          channel: "system.event",
          source: `actor-${actorId}`,
          event: "actor.status",
          data: { actorId, status, message },
        });

        return { ok: true };
      }) as CapabilityHandler,
    });

    this.ctx.capabilityRegistry.register({
      name: "bus_publish",
      description: "Publish a message to the EventBus. Use to send messages to specific targets.\n\n"
        + "Fire-and-forget (default): omit reply_to. The message is delivered but "
        + "no response comes back to you. Use for notifications, one-way commands, or when you don't need an answer.\n\n"
        + "Request-reply: set reply_to to a session ID (e.g. 'actor-alice', 'main'). The target will route its response "
        + "to that session once it finishes processing. Use when you ask a question or need the result of a task. "
        + "Typically set reply_to to your own session ID so the answer comes back to you.",
      input_schema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Bus channel (e.g. 'ai.request', 'system.event')" },
          target: { type: "string", description: "Target ID (e.g. 'actor-alice', 'main')" },
          text: { type: "string", description: "Message text" },
          reply_to: { type: "string", description: "Session ID to route the response to (e.g. 'actor-alice', 'main'). Omit for fire-and-forget." },
        },
        required: ["channel", "target", "text"],
      },
      handler: (async (input: Record<string, unknown>) => {
        const caller = input.__sessionId ? String(input.__sessionId) : "unknown";
        const source = caller.startsWith("actor-") ? caller : "jarvis";
        const channel = String(input.channel);
        const target = String(input.target);
        const text = String(input.text);
        // reply_to is a session ID string — pass it directly as replyTo
        const replyTo = input.reply_to ? String(input.reply_to) : undefined;
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

  /** Sync the actor's persistent flag to SessionManager ephemeral state */
  private syncPersistence(actor: Actor): void {
    const sm = this.ctx.sessionManager;
    if (!sm) return;
    const sessionId = `actor-${actor.id}`;
    // ephemeral = NOT persistent
    sm.setEphemeral(sessionId, !actor.persistent);
  }

  /** Toggle persistence for an actor (called from HUD or HTTP) */
  private togglePersistence(name: string): boolean | null {
    const actor = this.actors.get(name);
    if (!actor) return null;
    actor.persistent = !actor.persistent;
    this.syncPersistence(actor);
    if (actor.persistent) {
      // Toggled ON — persist the meta sidecar so the role survives restart.
      // Force an immediate session save so the meta and session file appear together.
      writeActorMeta(name, { roleId: actor.role.id, persistent: true, createdAt: actor.createdAt });
      const sm = this.ctx.sessionManager;
      if (sm) sm.save(`actor-${name}`);
    } else {
      // Toggled OFF — clear both the saved session file and the meta sidecar.
      const sm = this.ctx.sessionManager;
      if (sm) sm.clearSaved(`actor-${name}`);
      deleteActorMeta(name);
    }
    this.updateHud();
    return actor.persistent;
  }

  /**
   * Restore actors from saved sessions on disk.
   *
   * SessionManager.listSaved("actor-") returns all persisted actor session labels.
   * For each, we read the sidecar `actor-<name>.meta.json` to recover the role id
   * the actor was originally created with. If the meta is missing or points to an
   * unknown role, we fall back to `generic` (and log the drift) — but persisted
   * actors should always have a meta written by createRequest/dispatch/toggle.
   */
  private restoreSavedActorSessions(): void {
    const sm = this.ctx.sessionManager;
    if (!sm) return;
    const savedActors = sm.listSaved("actor-");
    if (savedActors.length === 0) return;

    for (const sessionId of savedActors) {
      const name = sessionId.replace("actor-", "");
      if (this.actors.has(name)) continue;
      if (this.actors.size >= MAX_ACTORS) break;

      const meta = readActorMeta(name);
      const genericRole = this.roles.find(r => r.id === "generic") ?? this.roles[0];
      let role: ActorRole | undefined;
      if (meta) {
        role = this.roles.find(r => r.id === meta.roleId);
        if (!role) {
          console.warn(`[actor-pool] meta for "${name}" points to unknown role "${meta.roleId}"; falling back to generic`);
          role = genericRole;
        }
      } else {
        // Legacy actor saved before meta support — fall back and re-write the meta
        // so next restore is clean.
        console.warn(`[actor-pool] no meta sidecar for persisted actor "${name}"; defaulting to generic role`);
        role = genericRole;
      }
      if (!role) continue;

      const createdAt = meta?.createdAt ?? Date.now();
      const actor: Actor = {
        id: name, role, status: "idle", createdAt,
        taskCount: 0, replyTo: "main", chatHistory: [], persistent: true,
      };
      this.actors.set(name, actor);
      // Mark session persistence AFTER actor is in the map (syncPersistence needs sessionManager)
      this.syncPersistence(actor);
      // Back-fill the meta if it was missing so we don't warn again next boot.
      if (!meta) {
        writeActorMeta(name, { roleId: role.id, persistent: true, createdAt });
      }

      // Tell actor-runner to create the AI session (will restore conversation from disk)
      this.bus.publish({
        channel: "system.event",
        source: this.id,
        event: "actor.session.create",
        data: { name, role },
      });
    }
    if (this.actors.size > 0) this.updateHud();
  }

  /**
   * Open an actor chat panel in the HUD.
   *
   * The panel declares `renderer: { plugin: null, file: "ChatPanel" }` — the
   * core ChatPanelHudAdapter resolves it from window.__JARVIS_COMPONENTS.
   * Session identity is passed opaquely as `data.sessionId`. The actor plugin
   * is the only place that decides the "actor-<name>" naming convention —
   * core jarvis-app knows nothing about "actor" as a concept.
   */
  private openActorChat(name: string): void {
    const actor = this.actors.get(name);
    if (!actor) return;
    const chatPieceId = `actor-chat-${name}`;
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: chatPieceId,
      piece: {
        pieceId: chatPieceId,
        type: "panel",
        name: `Chat: ${name}`,
        status: "running",
        data: {
          sessionId: `actor-${name}`,
          assistantLabel: name.toUpperCase(),
        },
        position: { x: 100, y: 100 },
        size: { width: 480, height: 400 },
        ephemeral: true,
        renderer: { plugin: null, file: "ChatPanel" },
      },
    });
  }

  private registerRoutes(): void {
    // Route: POST /plugins/actors/open-chat/<name>
    this.ctx.registerRoute("POST", "/plugins/actors/open-chat/", (req: any, res: any) => {
      const name = req.url?.split("/plugins/actors/open-chat/")[1]?.split("?")[0];
      if (!name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing actor name" }));
        return;
      }
      this.openActorChat(name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    // Route: POST /plugins/actors/toggle-persistent/<name>
    this.ctx.registerRoute("POST", "/plugins/actors/toggle-persistent/", (req: any, res: any) => {
      const name = req.url?.split("/plugins/actors/toggle-persistent/")[1]?.split("?")[0];
      if (!name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing actor name" }));
        return;
      }
      const result = this.togglePersistence(name);
      if (result === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `Actor not found: ${name}` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, persistent: result }));
    });

    // Route: POST /plugins/actors/create — spawn a new actor
    // Body: { name, role }
    // Chat endpoints (send/stream/history/abort) were removed in favour of the
    // core sessionId-aware /chat/* endpoints.
    this.ctx.registerRoute("POST", "/plugins/actors/create", (req: any, res: any) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { name, role } = JSON.parse(body) as { name: string; role: string };
          if (!name || !role) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "name and role are required" }));
            return;
          }
          this.bus.publish({
            channel: "system.event",
            source: this.id,
            event: "actor.create.request",
            data: { name, roleId: role },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    });

    // Route: POST /plugins/actors/<name>/kill — administrative lifecycle
    this.ctx.registerRoute("POST", "/plugins/actors/", (req: any, res: any) => {
      // Match /plugins/actors/<name>/kill — other paths already handled above
      const match = req.url?.match(/^\/plugins\/actors\/([^/]+)\/kill$/);
      if (!match) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Not found" }));
        return;
      }
      const name = match[1];
      this.bus.publish({
        channel: "system.event",
        source: this.id,
        event: "actor.kill.request",
        data: { name },
      });
      // Notify main chat that a manual kill happened (reminder tag — see
      // systemContext() note about keeping actor list out of the system prompt).
      this.bus.publish({
        channel: "ai.request",
        source: "system",
        target: "main",
        text: `[SYSTEM] <reminder>Actor "${name}" was manually killed from the HUD and removed from the pool.</reminder>`,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  private getData(): Record<string, unknown> {
    const actors = [...this.actors.values()];
    return {
      maxActors: MAX_ACTORS,
      total: actors.length,
      active: actors.filter(a => a.status === "running" || a.status === "waiting_tools").length,
      idle: actors.filter(a => a.status === "idle").length,
      actors: actors.map(a => ({ id: a.id, role: a.role.id, status: a.status, tasks: a.taskCount, statusMessage: a.statusMessage, persistent: a.persistent })),
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
    this.updateGraph();
  }

  private updateGraph(): void {
    if (!this.graphHandle) return;
    const actors = [...this.actors.values()];
    const active = actors.filter(a => a.status === "running" || a.status === "waiting_tools").length;
    this.graphHandle.update({ meta: { max: MAX_ACTORS, active } });
    this.graphHandle.setChildren(() => {
      if (this.actors.size === 0) return [];
      return [...this.actors.values()].map(a => ({
        id: `actor-${a.id}`,
        label: a.id,
        status: a.status === "running" ? "processing" : a.status === "waiting_tools" ? "waiting_tools" : a.status === "idle" ? "running" : a.status,
        meta: { role: a.role.id, tasks: a.taskCount },
      }));
    });
  }
}
