/**
 * Edge port interfaces (ports-and-adapters).
 *
 * These are the small, segregated interfaces the core/application layers depend
 * on for side-effecting concerns — timing (`Clock`), output (`Renderer`), and
 * input (`InputSource`) — plus the `MoveCommand` data that input produces.
 *
 * They live in the edges layer as the contracts that concrete adapters
 * (`SystemClock`, `CanvasRenderer`, `KeyboardInputSource`) implement, and that
 * tests substitute with fakes. Per the architecture steering, dependencies point
 * inward only: these interfaces reference core domain types but the core never
 * references the edges. Interface Segregation is honored by keeping `Renderer`
 * and `InputSource` separate and timing in its own `Clock`.
 */
import type {
  Direction,
  GameResult,
  Maze,
  MazeValidationError,
  Position,
} from "../core";

/**
 * Edge abstraction for timing. Provides a monotonic clock used only for
 * elapsed-time deltas, so the core stays free of `Date`/`performance` access.
 *
 * `SystemClock` wraps `performance.now()`; a `FakeClock` advances time
 * deterministically in tests.
 */
export interface Clock {
  /** Monotonic time in milliseconds; used only for elapsed-time deltas. */
  now(): number;
}

/**
 * Edge abstraction for output. A pure projection of immutable game state onto
 * the screen — it contains no game logic.
 *
 * `CanvasRenderer` implements this against a `CanvasRenderingContext2D`.
 */
export interface Renderer {
  renderMaze(maze: Maze): void;
  renderAvatar(position: Position, maze: Maze): void;
  renderRemainingTime(secondsRemaining: number): void;
  renderResult(result: GameResult): void;
  renderInvalidMaze(error: MazeValidationError): void;
  clearResult(): void;
}

/**
 * Edge abstraction for input. Registers handlers for player movement and for
 * the new-session / start control, and releases its resources on `dispose`.
 *
 * `KeyboardInputSource` maps arrow/WASD keys to `MoveCommand`s and a button
 * click to the new-session handler.
 */
export interface InputSource {
  /** Register a handler invoked with a MoveCommand when the player acts. */
  onCommand(handler: (command: MoveCommand) => void): void;
  /** Register a handler for the new-session / start control. */
  onNewSession(handler: () => void): void;
  dispose(): void;
}

/**
 * Movement input represented as data (Command pattern), decoupling the source
 * of input from its processing.
 */
export type MoveCommand = {
  readonly kind: "move";
  readonly direction: Direction;
};
