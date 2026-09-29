/**
 * Application (orchestration) layer entry point.
 *
 * Holds the current game state, applies pure core transitions, and emits change
 * events. Depends only on core types and on injected edge ports (`Clock`,
 * `MazeGenerator`, `Renderer`, `InputSource`) — never on `window`, `Date`,
 * `KeyboardEvent`, or `CanvasRenderingContext2D`. See
 * `.kiro/steering/architecture.md`.
 *
 * This file is a placeholder for the scaffold and is fleshed out by the
 * maze-game application tasks (`GameStore`, `GameController`).
 */
export { GameStore } from "./GameStore";
export type { GameEvent, MazeSource } from "./GameStore";
export { GameController } from "./GameController";
