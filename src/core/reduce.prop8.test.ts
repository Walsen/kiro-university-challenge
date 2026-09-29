import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { reduce } from "./reduce";
import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import {
  CellKind,
  type Maze,
  type PlayingState,
  type Position,
  type TimeLimit,
} from "./types";

/**
 * Property-based test for Correctness Property 8.
 *
 * Property 8 (design.md): *For any* `PlayingState` whose avatar is not on the
 * exit cell, a `Tick` whose elapsed time is greater than or equal to the
 * remaining time transitions the state to `Lost` with reason `TimeExpired`.
 *
 * This is the Playing -> Lost on-expiry transition owned by `reduce` (R3.3):
 * when the countdown reaches zero away from the exit, the session ends as a
 * loss. `tickTimer` only clamps `remainingMs` at zero; `reduce` adds the
 * transition, so this test drives `reduce` directly with a `Tick` action.
 *
 * The property holds the two premises fixed and asserts the conclusion:
 *   - premise: the avatar sits on a Path cell that is NOT the exit,
 *   - premise: `elapsedMs >= remainingMs` (the tick drains the timer to zero),
 *   - conclusion: the result is `Lost` with `reason === "TimeExpired"`.
 *
 * Determinism (testing steering): the maze comes from the real generator seeded
 * by a local mulberry32 PRNG, the avatar is chosen from the maze's own non-exit
 * Path cells, and `remainingMs`/`elapsedMs` are derived from fast-check
 * arbitraries — never `Math.random` or wall-clock time. `elapsedMs` is built as
 * `remainingMs + fc.nat()` so it is always >= the remaining time (including the
 * exact-equality boundary). Custom arbitraries constrain generation to the
 * valid input space, and the property runs a minimum of 100 iterations.
 *
 * _Validates: Requirements 3.3_
 */

/** fast-check iterations; testing steering requires a minimum of 100. */
const NUM_RUNS = 100;

/** Smallest dimension for which the generator yields distinct start/exit. */
const MIN_DIMENSION = 3;
/** Upper dimension bound; keeps the property fast at >= 100 iterations. */
const MAX_DIMENSION = 15;

const MILLISECONDS_PER_SECOND = 1000;
/** A branded 60s limit; its exact value is irrelevant to this transition. */
const TIME_LIMIT_SECONDS = 60;
/** Upper bound for generated remaining time: 600s (the max limit) in ms. */
const MAX_REMAINING_MS = 600 * MILLISECONDS_PER_SECOND;

/**
 * A tiny deterministic PRNG (mulberry32): the same seed yields the same
 * sequence in `[0, 1)`, making maze generation and avatar placement
 * reproducible without `Math.random`. Defined locally per the testing steering.
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

/** True when two positions are the same cell. */
function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.column === b.column;
}

/**
 * Every Path cell in the maze that is NOT the exit. Property 8 is scoped to an
 * avatar off the exit, so the exit cell is excluded from placement.
 */
function nonExitPathCells(maze: Maze): readonly Position[] {
  const cells: Position[] = [];
  for (let row = 0; row < maze.rows; row++) {
    for (let column = 0; column < maze.columns; column++) {
      const position: Position = { row, column };
      if (
        maze.grid[row]?.[column] === CellKind.Path &&
        !samePosition(position, maze.exit)
      ) {
        cells.push(position);
      }
    }
  }
  return cells;
}

/** Build a Playing state with the avatar on the given cell and the given timer. */
function playingWithAvatar(
  maze: Maze,
  avatar: Position,
  remainingMs: number,
): PlayingState {
  return {
    status: "Playing",
    maze,
    avatar,
    timeLimit: TIME_LIMIT_SECONDS as TimeLimit,
    remainingMs,
    timerStarted: true,
    pausedElapsedMs: 0,
    moveInProgress: false,
  };
}

const dimensionArb = fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION });
/** Full 32-bit seed space for the injected PRNG. */
const seedArb = fc.integer({ min: 0, max: 0xffffffff });
/** A unit fraction used to pick one Path cell independently of the maze seed. */
const cellFractionArb = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  maxExcluded: true,
});
/** Remaining time R in [0, max]; R = 0 exercises an already-drained timer. */
const remainingMsArb = fc.integer({ min: 0, max: MAX_REMAINING_MS });
/** The non-negative amount by which the tick meets or overshoots R. */
const overshootArb = fc.nat();

/**
 * Custom arbitrary: a valid `PlayingState` whose avatar sits on a random
 * non-exit Path cell, paired with an `elapsedMs` that is always >= the state's
 * `remainingMs` (built as `remainingMs + overshoot`). The maze comes from the
 * real generator so it is guaranteed valid.
 */
const expiryCaseArb: fc.Arbitrary<{
  readonly state: PlayingState;
  readonly elapsedMs: number;
}> = fc
  .record({
    rows: dimensionArb,
    columns: dimensionArb,
    seed: seedArb,
    cellFraction: cellFractionArb,
    remainingMs: remainingMsArb,
    overshoot: overshootArb,
  })
  .map(({ rows, columns, seed, cellFraction, remainingMs, overshoot }) => {
    const generator = new RecursiveBacktrackerGenerator();
    const maze = generator.generate(rows, columns, mulberry32(seed));
    const cells = nonExitPathCells(maze);
    const index = Math.min(
      cells.length - 1,
      Math.floor(cellFraction * cells.length),
    );
    const avatar = cells[index] ?? maze.start;
    const state = playingWithAvatar(maze, avatar, remainingMs);
    return { state, elapsedMs: remainingMs + overshoot };
  });

describe("reduce — Property 8: time expiring while not on the exit ends the session as a loss", () => {
  // Feature: maze-game, Property 8: Time expiring while not on the exit ends the session as a loss
  it("transitions to Lost with reason TimeExpired when a Tick drains the timer off the exit", () => {
    fc.assert(
      fc.property(expiryCaseArb, ({ state, elapsedMs }) => {
        const next = reduce(state, { type: "Tick", elapsedMs });

        expect(next.status).toBe("Lost");
        if (next.status !== "Lost") {
          return;
        }
        expect(next.reason).toBe("TimeExpired");
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
