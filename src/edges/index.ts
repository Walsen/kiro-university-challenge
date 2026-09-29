/**
 * Edges (impure adapters) layer entry point.
 *
 * The only modules that touch the browser or the outside world. Each implements
 * a port the core/application depends on (`Clock`, `Renderer`, `InputSource`,
 * `MazeGenerator`). Dependencies point inward only. See
 * `.kiro/steering/architecture.md`.
 *
 * The port interfaces (`Clock`, `Renderer`, `InputSource`, `MoveCommand`) are
 * defined in `./ports`. The concrete adapters (`SystemClock`, `CanvasRenderer`,
 * `KeyboardInputSource`) are fleshed out by the remaining maze-game edge tasks.
 */
export * from "./ports";
export { SystemClock } from "./SystemClock";
export { CanvasRenderer } from "./CanvasRenderer";
export { KeyboardInputSource } from "./KeyboardInputSource";
export { mulberry32 } from "./seededRng";
