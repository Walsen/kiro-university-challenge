---
inclusion: fileMatch
fileMatchPattern: 'src/core/**'
---

# Data Model

This document is the single source for the project's domain data model and the core types
that represent game state. It applies when creating or changing types in `src/core/`. It
builds on the base typing rules in the engineering standards
(`#[[file:engineering-standards.md]]`) and the layering in the architecture doc
(`#[[file:architecture.md]]`) — it does not restate them, it specializes them for the
domain model.

## Principles

These specialize the engineering-standards typing rules for domain modeling:

- **Immutability.** All domain models are `readonly`. Transitions produce new values rather
  than mutating existing ones. This keeps core logic pure and safe to share.
- **Make illegal states unrepresentable.** Prefer discriminated unions and branded types so
  that invalid combinations cannot be constructed. Fields that only make sense in one state
  live only in that state's variant.
- **Validate at the boundary.** Untrusted external input enters as `unknown` and is parsed
  into a domain type by a pure validator before use. Model failure as typed data, not thrown
  exceptions.

## Core Types

These are the canonical domain types (from the maze-game design). Keep definitions in
`src/core/types.ts` and treat this as the single source of truth for their shape.

### Grid primitives

```typescript
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
```

### Maze

```typescript
export interface Maze {
  readonly rows: number;
  readonly columns: number;
  /** grid[row][column] — Path or Wall. */
  readonly grid: ReadonlyArray<ReadonlyArray<CellKind>>;
  readonly start: Position;
  readonly exit: Position;
}
```

Invariants (enforced by `validateMaze`, not by the type alone):
- exactly one start and one exit,
- start and exit are distinct cells,
- start and exit are Path cells,
- a start-to-exit route exists through 4-directionally adjacent Path cells.

### Branded TimeLimit

A constrained integer that can only be produced by `parseTimeLimit`, so an out-of-range
number can never reach the timer.

```typescript
export type TimeLimit = number & { readonly __brand: "TimeLimit" };

export const MIN_TIME_LIMIT_SECONDS = 30;
export const MAX_TIME_LIMIT_SECONDS = 600;
export const DEFAULT_TIME_LIMIT_SECONDS = 60;
```

### Game state (State pattern as a discriminated union)

This is the data shape behind the State pattern that the architecture doc
(`#[[file:architecture.md]]`) assigns to the game lifecycle. The lifecycle is modeled as
explicit states; fields specific to a state live only in that variant, so e.g. a "won"
state without an elapsed time cannot be built.

```typescript
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
  readonly timerStarted: boolean;   // paused until first move or 1s (R6.3)
  readonly moveInProgress: boolean; // true during a move animation (R2.5)
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
```

### Actions, config, results, and errors

```typescript
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
  | "NoStart" | "MultipleStarts"
  | "NoExit" | "MultipleExits"
  | "StartEqualsExit"
  | "NoPathFromStartToExit";
```

### Result wrappers (typed failure, no exceptions)

Validators and factories return a discriminated result rather than throwing on expected
invalid input.

```typescript
export type MazeValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: MazeValidationError };

export type MazeResult =
  | { readonly ok: true; readonly maze: Maze }
  | { readonly ok: false; readonly error: MazeValidationError };

export type TimeLimitResult =
  | { readonly ok: true; readonly value: TimeLimit }
  | { readonly ok: false; readonly value: TimeLimit; readonly reason: "not-integer" | "out-of-range" };
```

## Conventions

- Add new domain concepts as `readonly` types in `src/core/types.ts`; do not scatter
  domain shapes across edge modules.
- When a value has a domain constraint (a bounded number, a closed set of strings), model it
  as a branded type or union and produce it only through a validator.
- Extend the state machine by adding a new variant to the `GameState` union and handling it
  in `reduce`, rather than adding optional fields to an existing variant.
- Keep no magic numbers in the model; name them as constants (e.g. the time-limit bounds).
