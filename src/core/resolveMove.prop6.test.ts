/**
 * Property-based test for `resolveMove` — design Correctness Property 6
 * (Task 7.5).
 *
 * Property 6: A move while a move is in progress is ignored. For any
 * `PlayingState` whose `moveInProgress` is true and any `Direction`, applying a
 * move leaves the avatar position and status unchanged — the move is dropped
 * regardless of whether its target would otherwise be a valid one-cell move,
 * the exit, a wall, or out of bounds (R2.5).
 *
 * We assert the strongest form of "unchanged": `resolveMove(state, dir)` is
 * deep-equal to the input `state` (so status, avatar, and every other field are
 * identical). Because the avatar is placed on a random Path cell of a real,
 * solvable maze, some sampled directions target valid path cells (which a move
 * with `moveInProgress: false` would accept) — those must still be ignored here.
 *
 * Determinism (testing steering): the maze is built by the real generator
 * driven by an injected seeded PRNG (mulberry32), never `Math.random()`
 * directly, so any failing run is reproducible from its seed. The PRNG helper
 * is defined locally rather than imported from another task's test file.
 *
 * **Validates: Requirements 2.5**
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";

import { resolveMove } from "./resolveMove";
import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { parseTimeLimit } from "./parseTimeLimit";
import {
  CellKind,
  type Direction,
  type Maze,
  type PlayingState,
  type Position,
  type TimeLimit,
} from "./types";

/** fast-check iterations; testing steering requires a minimum of 100. */
const NUM_RUNS = 100;
/** Smallest dimension for which the generator yields a distinct start/exit. */
const MIN_DIMENSION = 3;
/** Upper dimension bound; keeps the property fast at ≥ 100 iterations. */
const MAX_DIMENSION = 15;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * A tiny deterministic PRNG (mulberry32): the same seed yields the same
 * sequence in `[0, 1)`, making maze generation reproducible without
 * `Math.random`.
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

/** A branded time limit produced through the only validator that brands one. */
function timeLimit(seconds: number): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test fixture expected a valid time limit, got ${seconds}`);
  }
  return result.value;
}

/** Every in-bounds Path cell of the maze — candidate avatar positions. */
function pathCells(maze: Maze): ReadonlyArray<Position> {
  const cells: Position[] = [];
  for (let row = 0; row < maze.rows; row += 1) {
    for (let column = 0; column < maze.columns; column += 1) {
      if (maze.grid[row]?.[column] === CellKind.Path) {
        cells.push({ row, column });
      }
    }
  }
  return cells;
}

const generator = new RecursiveBacktrackerGenerator();
const dimensionArb = fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION });
const seedArb = fc.integer({ min: 0, max: 0xffffffff });
const directionArb: fc.Arbitrary<Direction> = fc.constantFrom(
  "Up",
  "Down",
  "Left",
  "Right",
);

/**
 * A `PlayingState` with `moveInProgress: true`, the avatar on a randomly chosen
 * Path cell of a freshly generated valid maze, and a paired arbitrary
 * direction. Time-limit seconds and remaining time are sampled across the valid
 * range so the assertion is not tied to any one clock value.
 */
const scenarioArb = fc
  .record({
    rows: dimensionArb,
    columns: dimensionArb,
    seed: seedArb,
    limitSeconds: fc.integer({ min: 30, max: 600 }),
    remainingFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    direction: directionArb,
  })
  .chain((base) => {
    const maze = generator.generate(base.rows, base.columns, mulberry32(base.seed));
    const limit = timeLimit(base.limitSeconds);
    const remainingMs = Math.round(
      base.remainingFraction * limit * MILLISECONDS_PER_SECOND,
    );
    return fc
      .constantFrom(...pathCells(maze))
      .map((avatar): { state: PlayingState; direction: Direction } => ({
        state: {
          status: "Playing",
          maze,
          avatar,
          timeLimit: limit,
          remainingMs,
          timerStarted: true,
          pausedElapsedMs: 0,
          moveInProgress: true,
        },
        direction: base.direction,
      }));
  });

describe("resolveMove (property)", () => {
  // Feature: maze-game, Property 6: A move while a move is in progress is ignored
  test("a move while a move is in progress is ignored", () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, direction }) => {
        const next = resolveMove(state, direction);

        // The move is dropped: state is returned unchanged in full.
        expect(next).toEqual(state);
        // Spell out the invariant the property names, for a readable failure.
        expect(next.status).toBe("Playing");
        expect(next.avatar).toEqual(state.avatar);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
