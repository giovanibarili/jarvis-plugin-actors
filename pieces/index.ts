import { ActorPoolPiece } from "./actor-pool.js";
import { ActorRunnerPiece } from "./actor-runner.js";
import { ActorChatPiece } from "./actor-chat.js";

interface PluginContext {
  bus: any;
  capabilityRegistry: any;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: any;
  registerRoute: (method: string, path: string, handler: any) => void;
}

export function createPieces(ctx: PluginContext) {
  return [
    new ActorPoolPiece(ctx),
    new ActorRunnerPiece(ctx),
    new ActorChatPiece(ctx),
  ];
}
