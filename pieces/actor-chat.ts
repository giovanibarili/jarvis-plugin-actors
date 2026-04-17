import { MAX_CHAT_HISTORY } from "./types.js";

interface EventBus {
  publish(msg: any): void;
  subscribe(channel: string, handler: (msg: any) => void | Promise<void>): () => void;
}

interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}

interface PluginContext {
  bus: EventBus;
  registerRoute: (method: string, path: string, handler: any) => void;
}

type ServerResponse = import("node:http").ServerResponse;

export class ActorChatPiece implements Piece {
  readonly id = "actor-chat";
  readonly name = "Actor Chat";

  private bus!: EventBus;
  private ctx: PluginContext;
  private started = false;
  private chatHistories = new Map<string, Array<{ role: string; text: string; source?: string }>>();
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

    this.ctx.registerRoute("GET", "/plugins/actors/", (req: any, res: any) => this.handleGet(req, res));
    this.ctx.registerRoute("POST", "/plugins/actors/", (req: any, res: any) => this.handlePost(req, res));

    // Auto-subscribe to actor streams when a request targets an actor
    this.unsubscribes.push(
      this.bus.subscribe("ai.request", (msg: any) => {
        if (!msg.target?.startsWith("actor-")) return;
        if (msg.source === "actor-chat") return; // ignore our own sends
        const name = msg.target.replace("actor-", "");
        this.ensureSubscribed(name);
        const source = msg.source === "jarvis-core" ? "jarvis" : (msg.source ?? "unknown");
        const history = this.getHistory(name);
        history.push({ role: 'user', text: msg.text, source });
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
      this.bus.subscribe("ai.stream", (msg: any) => {
        if (msg.target !== target) return;
        switch (msg.event) {
          case "delta":
            this.broadcast(actorName, { type: "delta", text: msg.text });
            break;
          case "complete": {
            const history = this.getHistory(actorName);
            history.push({ role: 'actor', text: msg.text });
            if (history.length > MAX_CHAT_HISTORY) history.splice(0, history.length - MAX_CHAT_HISTORY);
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

  private getHistory(name: string) {
    if (!this.chatHistories.has(name)) this.chatHistories.set(name, []);
    return this.chatHistories.get(name)!;
  }

  private broadcast(actorName: string, data: any): void {
    const clients = this.sseClients.get(actorName);
    if (!clients) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { try { c.write(msg); } catch {} }
  }

  private parseUrl(url: string): { actorName: string; action: string } | null {
    const match = url?.match(/^\/plugins\/actors\/([^/]+)\/(send|stream|history|kill|abort)$/);
    if (!match) return null;
    return { actorName: match[1], action: match[2] };
  }

  private handleGet(req: any, res: any): void {
    const parsed = this.parseUrl(req.url);
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
      res.end(JSON.stringify(this.getHistory(actorName)));
      return;
    }

    res.writeHead(404); res.end();
  }

  private handlePost(req: any, res: any): void {
    const parsed = this.parseUrl(req.url);
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
      // Kill via bus event (same as actor_kill capability)
      this.bus.publish({
        channel: "system.event",
        source: "actor-chat",
        event: "actor.kill.request",
        data: { name: actorName },
      });
      // Notify main chat
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

    if (parsed.action !== "send") { res.writeHead(404); res.end(); return; }

    const { actorName } = parsed;
    let body = "";
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      try {
        const { text } = JSON.parse(body);
        const history = this.getHistory(actorName);
        history.push({ role: 'user', text, source: 'you' });
        this.broadcast(actorName, { type: "user", text, source: "you" });
        this.ensureSubscribed(actorName);

        this.bus.publish({
          channel: "ai.request",
          source: "actor-chat",
          target: "actor-" + actorName,
          text,
        });

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end();
      }
    });
  }
}
