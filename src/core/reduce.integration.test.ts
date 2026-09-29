/**
 * Integration Point A — Core reducer pipeline (Task 10.1, BLOCKING gate).
 *
 * Unit and property tests verify each core function in isolation. This test
 * composes the *real* pure core end-to-end with no edges — no `Clock`, no DOM,
 * no `Math.random()` — and drives a full session through pure `dispatch`
 * (repeated `reduce` calls). It proves the pure functions honor each other's
 * contracts before any edge adapter exists:
 *
 *   reduce → resolveMove → tickTimer → DefaultGameSessionFactory
 *          → a real generated maze (RecursiveBacktrackerGenerator + DefaultMazeFactory)
 *          → validateMaze → parseTimeLimit → types
 *
 * Two scenarios are driven:
 *   1. LOSS — StartSession, then Ticks to expiry while the avatar is off the
 *      exit, asserting the session ends Lost with reason "TimeExpired" (R3.3).
 *   2. WIN  — StartSession, then Moves along a BFS-derived solvable path onto
 *      the exit with time remaining, asserting the session ends Won with the
 *      elapsed time captured per the resolveMove contract (R1.2, R2.1, R2.2,
 *      R4.1).
 *
 * Determinism: the maze comes from a seeded mulberry32 rng injected into
 * `DefaultMazeFactory`; no wall clock and no `Math.random()` are used. The
 * solvable path is computed by a local BFS over Path cells in the test, so the
 * WIN run follows a route the maze actually contains rather than a hand-picked
 * guess.
 *
 * _Requirements: 1.2, 2.1, 2.2, 3.3, 4.1; design "Integration testing" Point A._
 */
import { describe, expect, it } from "vitest";

import { DefaultMazeFactory } from "./MazeFactory";
import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { parseTimeLimit } from "./parseTimeLimit";
import { reduce } from "./reduce";
import {
  CellKind,
  type Direction,
  type GameState,
  type IdleState,
  type Maze,
  type PlayingState,
  type Position,
  type TimeLimit,
} from "./types";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * A tiny deterministic PRNG (mulberry32). Given the same seed it produces the
 * same sequence of numbers in `[0, 1)`, so maze generation is reproducible
 * without touching `Math.random`. Matches the seeded rng used across the core
 * unit tests.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A valid branded TimeLimit produced through the only validator that makes one. */
function timeLimit(seconds: number): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test setup: ${String(seconds)} is not a valid TimeLimit`);
  }
  return result.value;
}

/** Build a real, validated maze from a seeded rng via the real factory. */
function generatedMaze(rows: number, columns: number, seed: number): Maze {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(seed),
  );
  const result = factory.create(rows, columns);
  if (!result.ok) {
    throw new Error(`test setup: maze generation failed with ${result.error}`);
  }
  return result.maze;
}

/**
 * A fresh Idle state seeded with a real maze, so a `StartSession` action can
 * build a `PlayingState` on that maze the way the reducer is specified to
 * (reusing `state.maze`, since `GameConfig` carries no built maze).
 */
function idleOn(maze: Maze, seconds: number): IdleState {
  return { status: "Idle", maze, avatar: maze.start, timeLimit: timeLimit(seconds) };
}

/** Start a session by dispatching `StartSession` through the real reducer. */
function startSession(maze: Maze, seconds: number): PlayingState {
  const started = reduce(idleOn(maze, seconds), {
    type: "StartSession",
    config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
  });
  if (started.status !== "Playing") {
    throw new Error(`test setup: StartSession did not yield a Playing state`);
  }
  return started;
}

// ---------------------------------------------------------------------------
// Local BFS over the real generated maze (test-only path finder)
// ---------------------------------------------------------------------------

const DIRECTION_DELTAS: ReadonlyArray<readonly [Direction, Position]> = [
  ["Up", { row: -1, column: 0 }],
  ["Down", { row: 1, column: 0 }],
  ["Left", { row: 0, column: -1 }],
  ["Right", { row: 0, column: 1 }],
];

function keyOf(p: Position): string {
  return `${p.row},${p.column}`;
}

function isPathCell(maze: Maze, p: Position): boolean {
  return maze.grid[p.row]?.[p.column] === CellKind.Path;
}

/**
 * Breadth-first search over 4-directionally adjacent Path cells, returning the
 * sequence of `Direction`s that walks the avatar from `maze.start` to
 * `maze.exit`. This mirrors the connectivity contract `validateMaze` enforces
 * (R1.5) and the movement contract `resolveMove` honors (R2.1), so following it
 * step by step through `reduce` must land on the exit. Throws if no route
 * exists, which for a validated maze would itself be a contract violation.
 */
function bfsDirections(maze: Maze): Direction[] {
  const start = maze.start;
  const exit = maze.exit;
  const visited = new Set<string>([keyOf(start)]);
  const queue: Position[] = [start];
  const cameFrom = new Map<string, { prev: Position; direction: Direction }>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.row === exit.row && current.column === exit.column) {
      return reconstruct(cameFrom, start, exit);
    }
    for (const [direction, delta] of DIRECTION_DELTAS) {
      const next: Position = {
        row: current.row + delta.row,
        column: current.column + delta.column,
      };
      if (!isPathCell(maze, next) || visited.has(keyOf(next))) {
        continue;
      }
      visited.add(keyOf(next));
      cameFrom.set(keyOf(next), { prev: current, direction });
      queue.push(next);
    }
  }

  throw new Error("test setup: no start-to-exit path in a validated maze");
}

function reconstruct(
  cameFrom: Map<string, { prev: Position; direction: Direction }>,
  start: Position,
  exit: Position,
): Direction[] {
  const directions: Direction[] = [];
  let cursor = exit;
  while (!(cursor.row === start.row && cursor.column === start.column)) {
    const step = cameFrom.get(keyOf(cursor));
    if (step === undefined) {
      throw new Error("test setup: BFS reconstruction broke");
    }
    directions.unshift(step.direction);
    cursor = step.prev;
  }
  return directions;
}

describe("Integration Point A — core reducer pipeline", () => {
  it("drives a session to a LOSS when the timer reaches zero off the exit (R3.3)", () => {
    // A small, deterministic maze and a small time limit so a whole-second Tick
    // sequence reaches expiry quickly. The avatar stays on the Start_Cell, well
    // clear of the exit, so hitting zero is unambiguously a time-expiry loss.
    const maze = generatedMaze(9, 9, 4242);
    const limitSeconds = 30;

    const fresh = startSession(maze, limitSeconds);
    expect(fresh.status).toBe("Playing");
    expect(fresh.avatar).toEqual(maze.start);
    expect(maze.start).not.toEqual(maze.exit);

    let state: GameState = fresh;

    // Tick one second at a time until the timer is exhausted. Each Tick flows
    // reduce → tickTimer (decrement + clamp) and then reduce adds the
    // Playing → Lost transition on reaching zero off the exit. Per R6.3 the
    // timer is paused for the first 1s of elapsed time (the avatar never
    // moves), so a whole extra second's worth of Ticks is needed to expire it:
    // the first 1s Tick only closes the pause and starts the countdown.
    const totalMs = limitSeconds * MILLISECONDS_PER_SECOND;
    const pauseTicks = 1; // the first whole-second Tick closes the R6.3 pause
    const ticks = totalMs / MILLISECONDS_PER_SECOND + pauseTicks;
    for (let i = 0; i < ticks; i += 1) {
      expect(state.status).toBe("Playing");
      state = reduce(state, { type: "Tick", elapsedMs: MILLISECONDS_PER_SECOND });
    }

    expect(state.status).toBe("Lost");
    if (state.status !== "Lost") {
      throw new Error("expected a Lost state");
    }
    expect(state.reason).toBe("TimeExpired");
    // The lost session freezes on the start cell — no phantom movement occurred.
    expect(state.avatar).toEqual(maze.start);

    // A frozen session rejects further input (R4.4 / R3.4): Move and Tick are
    // no-ops once Lost.
    const afterMove = reduce(state, { type: "Move", direction: "Down" });
    expect(afterMove).toBe(state);
    const afterTick = reduce(state, { type: "Tick", elapsedMs: MILLISECONDS_PER_SECOND });
    expect(afterTick).toBe(state);
  });

  it("drives a session to a WIN along a BFS path with time remaining, capturing elapsed time (R1.2, R2.1, R2.2, R4.1)", () => {
    const maze = generatedMaze(11, 11, 20240607);
    const limitSeconds = 120;

    const fresh = startSession(maze, limitSeconds);
    expect(fresh.status).toBe("Playing");
    // R1.2: a fresh session seats the avatar on the Start_Cell.
    expect(fresh.avatar).toEqual(maze.start);

    // Derive an actually-solvable route from the real maze rather than guessing.
    const path = bfsDirections(maze);
    expect(path.length).toBeGreaterThan(0);

    // Interleave a Tick before the walk so the win captures a non-zero elapsed
    // time and we can check the resolveMove elapsed formula exactly. Per R6.3
    // the timer is paused for the first 1s of elapsed time (the avatar never
    // moves), so only the elapsed BEYOND that 1s max counts down: a 5s pre-walk
    // Tick leaves 4s of countdown once the pause closes.
    const preElapsedMs = 5 * MILLISECONDS_PER_SECOND;
    const timerAutostartMs = MILLISECONDS_PER_SECOND; // R6.3 1s pause maximum
    const countdownMs = preElapsedMs - timerAutostartMs;
    let state: GameState = reduce(fresh, { type: "Tick", elapsedMs: preElapsedMs });
    expect(state.status).toBe("Playing");
    if (state.status !== "Playing") {
      throw new Error("expected a Playing state after the pre-walk Tick");
    }
    // The single pre-walk Tick both closed the R6.3 pause and started counting.
    expect(state.timerStarted).toBe(true);
    // The avatar has not moved: the auto-start never nudges the avatar (R6.3).
    expect(state.avatar).toEqual(maze.start);
    const remainingBeforeWalk = state.remainingMs;
    expect(remainingBeforeWalk).toBe(
      limitSeconds * MILLISECONDS_PER_SECOND - countdownMs,
    );

    // Walk the path. `reduce` on Move delegates to `resolveMove` and does not
    // set `moveInProgress`, so consecutive Moves are accepted without a
    // MoveAnimationComplete between them. Every step but the last stays Playing
    // and advances exactly one cell (R2.1); the final step onto the exit wins.
    let previous: Position = state.avatar;
    for (let i = 0; i < path.length; i += 1) {
      const direction = path[i]!;
      const isLastStep = i === path.length - 1;
      state = reduce(state, { type: "Move", direction });

      if (!isLastStep) {
        expect(state.status).toBe("Playing");
        if (state.status !== "Playing") {
          throw new Error("expected a Playing state mid-walk");
        }
        // R2.1: exactly one cell in the issued direction.
        expect(manhattan(previous, state.avatar)).toBe(1);
        // R2.2: the move never lands on a Wall / off the grid.
        expect(isPathCell(maze, state.avatar)).toBe(true);
        // The timer keeps its value across Moves (no Tick happened here).
        expect(state.remainingMs).toBe(remainingBeforeWalk);
        previous = state.avatar;
      }
    }

    // R4.1: reaching the exit with time remaining ends the session as a win.
    expect(state.status).toBe("Won");
    if (state.status !== "Won") {
      throw new Error("expected a Won state");
    }
    expect(state.avatar).toEqual(maze.exit);
    // Elapsed time is captured (R4.2 shape): it equals timeLimit*1000 minus the
    // remaining time at the winning step. Only the countdown beyond the R6.3 1s
    // pause elapsed, since Moves don't advance the clock and the paused second
    // did not count down.
    expect(state.elapsedMs).toBe(countdownMs);
    expect(state.elapsedMs).toBe(
      limitSeconds * MILLISECONDS_PER_SECOND - remainingBeforeWalk,
    );
    expect(state.elapsedMs).toBeGreaterThanOrEqual(0);

    // The won session freezes too: further Moves are rejected (R4.4).
    const afterWin = reduce(state, { type: "Move", direction: "Up" });
    expect(afterWin).toBe(state);
  });
});

/** Manhattan distance between two grid positions. */
function manhattan(a: Position, b: Position): number {
  return Math.abs(a.row - b.row) + Math.abs(a.column - b.column);
}
