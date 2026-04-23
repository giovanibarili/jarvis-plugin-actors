import { ActorPoolPiece } from "./actor-pool.js";
import { ActorRunnerPiece } from "./actor-runner.js";
import type { PluginContext } from "@jarvis/core";

export function createPieces(ctx: PluginContext) {
  return [
    new ActorPoolPiece(ctx),
    new ActorRunnerPiece(ctx),
  ];
}
