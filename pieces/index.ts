import { ActorPoolPiece } from "./actor-pool.js";
import { ActorRunnerPiece } from "./actor-runner.js";
import { ActorChatPiece } from "./actor-chat.js";
import type { PluginContext } from "@jarvis/core";

export function createPieces(ctx: PluginContext) {
  return [
    new ActorPoolPiece(ctx),
    new ActorRunnerPiece(ctx),
    new ActorChatPiece(ctx),
  ];
}
