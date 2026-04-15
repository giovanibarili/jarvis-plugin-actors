import { MAX_CHAT_HISTORY } from "./types.js";

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

    const sessionId = `actor-${actorName}`;

    this.unsubscribes.push(
      this.bus.subscribe(`core.${sessionId}.stream.delta`, (msg: any) => {
        this.broadcast(actorName, { type: "delta", text: msg.text });
      })
    );

    this.unsubscribes.push(
      this.bus.subscribe(`core.${sessionId}.stream.complete`, (msg: any) => {
        const history = this.getHistory(actorName);
        history.push({ role: 'actor', text: msg.fullText });
        if (history.length > MAX_CHAT_HISTORY) history.splice(0, history.length - MAX_CHAT_HISTORY);
        this.broadcast(actorName, { type: "done", fullText: msg.fullText });
      })
    );

    this.unsubscribes.push(
      this.bus.subscribe(`core.${sessionId}.error`, (msg: any) => {
        this.broadcast(actorName, { type: "error", error: msg.error });
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
    const match = url?.match(/^\/plugins\/actors\/([^/]+)\/(send|stream|history)$/);
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
    if (!parsed || parsed.action !== "send") { res.writeHead(404); res.end(); return; }

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

        this.bus.publish("input.prompt", {
          sessionId: `actor-${actorName}`,
          componentId: "actor-chat",
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
