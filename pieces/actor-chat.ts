import type {
  Piece,
  PluginContext,
  AIRequestMessage,
  AIStreamMessage,
  EventBus,
  RouteHandler,
  SessionManager,
} from "@jarvis/core";
import type { IncomingMessage, ServerResponse } from "node:http";

export class ActorChatPiece implements Piece {
  readonly id = "actor-chat";
  readonly name = "Actor Chat";

  private bus!: EventBus;
  private ctx: PluginContext;
  private sessions!: SessionManager;
  private started = false;
  private sseClients = new Map<string, Set<ServerResponse>>();
  private unsubscribes: Array<() => void> = [];
  private subscribedActors = new Set<string>();

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    if (!this.ctx.sessionManager) {
      throw new Error("ActorChatPiece requires sessionManager in PluginContext (requires @jarvis/core >= 0.3.0)");
    }
    this.sessions = this.ctx.sessionManager;

    this.ctx.registerRoute("GET", "/plugins/actors/", ((req: IncomingMessage, res: ServerResponse) => this.handleGet(req, res)) as RouteHandler);
    this.ctx.registerRoute("POST", "/plugins/actors/", ((req: IncomingMessage, res: ServerResponse) => this.handlePost(req, res)) as RouteHandler);

    // Auto-subscribe to actor streams when a request targets an actor
    this.unsubscribes.push(
      this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
        if (!msg.target?.startsWith("actor-")) return;
        if (msg.source === "actor-chat") return; // ignore our own sends
        const name = msg.target.replace("actor-", "");
        this.ensureSubscribed(name);
        const source = msg.source === "jarvis-core" ? "jarvis"
          : msg.source?.startsWith("actor-") ? msg.source.replace("actor-", "actor:")
          : (msg.source ?? "unknown");
        this.broadcast(name, { type: "user", text: msg.text, source });
      })
    );
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    for (const clients of this.sseClients.values()) {
      for (const c of clients) { try { c.end(); } catch {} }
    }
    this.sseClients.clear();
  }

  private ensureSubscribed(actorName: string): void {
    if (this.subscribedActors.has(actorName)) return;
    this.subscribedActors.add(actorName);

    const target = `actor-${actorName}`;

    this.unsubscribes.push(
      this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
        if (msg.target !== target) return;
        switch (msg.event) {
          case "delta":
            this.broadcast(actorName, { type: "delta", text: msg.text });
            break;
          case "complete": {
            this.broadcast(actorName, { type: "done", fullText: msg.text });
            break;
          }
          case "error":
            this.broadcast(actorName, { type: "error", error: msg.text });
            break;
          case "tool_start":
            this.broadcast(actorName, { type: "tool_start", name: msg.toolName, id: msg.toolId, args: msg.toolArgs });
            break;
          case "tool_done":
            this.broadcast(actorName, { type: "tool_done", name: msg.toolName, id: msg.toolId, ms: msg.toolMs, output: msg.toolOutput });
            break;
          case "tool_cancelled":
            this.broadcast(actorName, { type: "tool_cancelled", name: msg.toolName, id: msg.toolId });
            break;
          case "aborted":
            this.broadcast(actorName, { type: "aborted" });
            break;
        }
      })
    );
  }

  private broadcast(actorName: string, data: Record<string, unknown>): void {
    const clients = this.sseClients.get(actorName);
    if (!clients) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { try { c.write(msg); } catch {} }
  }

  private parseUrl(url: string): { actorName: string; action: string } | null {
    // Special route: POST /plugins/actors/create
    if (url === "/plugins/actors/create") return { actorName: "", action: "create" };
    const match = url?.match(/^\/plugins\/actors\/([^/]+)\/(send|stream|history|kill|abort)$/);
    if (!match) return null;
    return { actorName: match[1], action: match[2] };
  }

  private handleGet(req: IncomingMessage, res: ServerResponse): void {
    const parsed = this.parseUrl(req.url ?? "");
    if (!parsed) { res.writeHead(404); res.end(); return; }

    const { actorName, action } = parsed;

    if (action === "stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      this.ensureSubscribed(actorName);
      if (!this.sseClients.has(actorName)) this.sseClients.set(actorName, new Set());
      this.sseClients.get(actorName)!.add(res);
      req.on("close", () => this.sseClients.get(actorName)?.delete(res));
      return;
    }

    if (action === "history") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const sessionId = `actor-${actorName}`;
      // Check both in-memory AND on-disk sessions
      if (!this.sessions.has(sessionId)) {
        const saved = this.sessions.listSaved("actor-");
        if (!saved.includes(sessionId)) {
          res.end("[]");
          return;
        }
      }
      try {
        const managed = this.sessions.get(sessionId);
        const rawMessages = managed.session.getMessages() as any[];
        const entries = this.parseMessagesToHistory(rawMessages);
        res.end(JSON.stringify(entries));
      } catch {
        res.end("[]");
      }
      return;
    }

    res.writeHead(404); res.end();
  }

  /**
   * Parse raw AI session messages into chat history entries.
   * Same logic as core's ChatPiece.handleHistory — single source of truth from the session.
   */
  private parseMessagesToHistory(rawMessages: any[]): any[] {
    const entries: any[] = [];

    for (const msg of rawMessages) {
      if (msg.role === "user") {
        // Skip tool_result messages (they appear as role=user with tool_result blocks)
        if (Array.isArray(msg.content) && msg.content.every((b: any) => b.type === "tool_result")) {
          continue;
        }
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") text += block.text;
          }
        }
        if (!text.trim()) continue; // Skip empty user messages
        entries.push({ role: "user", text, source: "jarvis" });
      } else if (msg.role === "assistant") {
        let text = "";
        const toolUses: any[] = [];
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") text += block.text;
            if (block.type === "tool_use") toolUses.push(block);
          }
        }
        if (text) {
          entries.push({ role: "actor", text });
        }
        // Tool uses are available but the actor chat UI renders them via SSE events,
        // so we don't include them in history hydration to avoid duplication.
      }
    }

    return entries;
  }

  private handlePost(req: IncomingMessage, res: ServerResponse): void {
    const parsed = this.parseUrl(req.url ?? "");
    if (!parsed) { res.writeHead(404); res.end(); return; }

    if (parsed.action === "abort") {
      const { actorName } = parsed;
      this.bus.publish({
        channel: "system.event",
        source: "actor-chat",
        event: "actor.abort.request",
        data: { name: actorName },
      });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (parsed.action === "kill") {
      const { actorName } = parsed;
      this.bus.publish({
        channel: "system.event",
        source: "actor-chat",
        event: "actor.kill.request",
        data: { name: actorName },
      });
      this.bus.publish({
        channel: "ai.request",
        source: "system",
        target: "main",
        text: `[SYSTEM] Actor "${actorName}" was manually killed from the HUD.`,
      });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (parsed.action === "create") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { name, role } = JSON.parse(body) as { name: string; role: string };
          if (!name || !role) {
            res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: false, error: "name and role are required" }));
            return;
          }
          // Request actor creation — actor-pool will register it, actor-runner will create the session
          this.bus.publish({
            channel: "system.event",
            source: "actor-chat",
            event: "actor.create.request",
            data: { name, roleId: role },
          });
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    if (parsed.action !== "send") { res.writeHead(404); res.end(); return; }

    const { actorName } = parsed;
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { text?: string; prompt?: string; images?: any[] };
        const text = parsed.text ?? parsed.prompt ?? "";
        const images = parsed.images;
        this.broadcast(actorName, { type: "user", text, source: "you" });
        this.ensureSubscribed(actorName);

        this.bus.publish({
          channel: "ai.request",
          source: "actor-chat",
          target: "actor-" + actorName,
          text,
          ...(images && images.length > 0 ? { images } : {}),
        } as any);

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end();
      }
    });
  }
}
