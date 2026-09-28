/**
 * Core domain types for the maze game.
 *
 * This is the single source of truth for the shape of the domain model (see
 * `.kiro/steering/data-model.md`). All models are immutable (`readonly`) and
 * illegal states are made unrepresentable via discriminated unions and a
 * branded `TimeLimit`. This module is pure: it declares types and constants
 * only, with no I/O, DOM, or direct access to time or randomness.
 */

// ---------------------------------------------------------------------------
// Grid primitives
// ---------------------------------------------------------------------------

export const enum CellKind {
  Path = "Path",
  Wall = "Wall",
}

/** Role a path cell plays; walls never have a role. */
export type CellRole = "Start" | "Exit" | "None";

export interface Position {
  readonly row: number;
  readonly column: number;
}

export type Direction = "Up" | "Down" | "Left" | "Right";

// ---------------------------------------------------------------------------
// Maze
// ---------------------------------------------------------------------------

export interface Maze {
  readonly rows: number;
  readonly columns: number;
  /** grid[row][column] — Path or Wall. */
  readonly grid: ReadonlyArray<ReadonlyArray<CellKind>>;
  readonly start: Position;
  readonly exit: Position;
}

// ---------------------------------------------------------------------------
// Branded TimeLimit
// ---------------------------------------------------------------------------

/**
 * A constrained integer that can only be produced by `parseTimeLimit`, so an
 * out-of-range number can never reach the timer.
 */
export type TimeLimit = number & { readonly __brand: "TimeLimit" };

export const MIN_TIME_LIMIT_SECONDS = 30;
export const MAX_TIME_LIMIT_SECONDS = 600;
export const DEFAULT_TIME_LIMIT_SECONDS = 60;

// ---------------------------------------------------------------------------
// Game state (State pattern as a discriminated union)
// ---------------------------------------------------------------------------

export type GameStatus = "Idle" | "Playing" | "Won" | "Lost";

export interface BaseState {
  readonly maze: Maze;
  readonly avatar: Position;
  readonly timeLimit: TimeLimit;
}

export interface IdleState extends BaseState {
  readonly status: "Idle";
}

export interface PlayingState extends BaseState {
  readonly status: "Playing";
  readonly remainingMs: number;
  /** Timer is paused until first move or 1s elapses (R6.3). */
  readonly timerStarted: boolean;
  /**
   * Elapsed time accrued while the timer is still paused (R6.3). Accumulates
   * across sub-1s Ticks until it reaches the 1s auto-start maximum, after which
   * `timerStarted` is true and this value is no longer consulted.
   */
  readonly pausedElapsedMs: number;
  /** True while a move animation is in progress (R2.5). */
  readonly moveInProgress: boolean;
}

export interface WonState extends BaseState {
  readonly status: "Won";
  readonly elapsedMs: number;
}

export interface LostState extends BaseState {
  readonly status: "Lost";
  readonly reason: "TimeExpired";
}

export type GameState = IdleState | PlayingState | WonState | LostState;

// ---------------------------------------------------------------------------
// Actions, config, results, and errors
// ---------------------------------------------------------------------------

export type GameAction =
  | { readonly type: "StartSession"; readonly config: GameConfig }
  | { readonly type: "Move"; readonly direction: Direction }
  | { readonly type: "Tick"; readonly elapsedMs: number }
  | { readonly type: "MoveAnimationComplete" };

export interface GameConfig {
  readonly rows: number;
  readonly columns: number;
  readonly timeLimit: TimeLimit;
}

export type GameResult =
  | { readonly outcome: "Won"; readonly elapsedSeconds: number }
  | { readonly outcome: "Lost"; readonly reason: "TimeExpired" };

export type MazeValidationError =
  | "NoStart"
  | "MultipleStarts"
  | "NoExit"
  | "MultipleExits"
  | "StartEqualsExit"
  | "NoPathFromStartToExit";

// ---------------------------------------------------------------------------
// Result wrappers (typed failure, no exceptions)
// ---------------------------------------------------------------------------

export type MazeValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: MazeValidationError };

export type MazeResult =
  | { readonly ok: true; readonly maze: Maze }
  | { readonly ok: false; readonly error: MazeValidationError };

export type TimeLimitResult =
  | { readonly ok: true; readonly value: TimeLimit }
  | {
      readonly ok: false;
      readonly value: TimeLimit;
      readonly reason: "not-integer" | "out-of-range";
    };
