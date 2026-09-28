import { describe, expect, test } from "vitest";
import fc from "fast-check";

import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { validateMaze } from "./validateMaze";

/**
 * Property-based test for the maze generator (Task 5.3).
 *
 * Realizes design Correctness Property 1: for any grid dimensions and any
 * random seed, a generated maze is structurally valid and solvable — exactly
 * one start and one exit that are distinct Path cells, with a 4-directionally
 * adjacent Path route connecting them. `validateMaze` checks exactly those
 * invariants, so the property asserts every generated maze is accepted.
 *
 * Determinism (testing steering): randomness enters only through an injected
 * seeded PRNG (mulberry32), never `Math.random()` directly, so a failing run
 * is reproducible from its seed. The helper is defined locally here rather
 * than imported from another task's test file.
 *
 * Dimension range: rows and columns in [3, 25]. The lower bound of 3 is the
 * smallest grid in which the generator's start cell (0, 0) and its exit cell
 * (the largest even coordinate below each dimension) are two distinct carved
 * cells; the upper bound keeps ≥ 100 iterations fast while covering both odd
 * and even dimensions.
 *
 * **Validates: Requirements 1.4, 1.5**
 */

/** Smallest dimension for which start (0,0) and the exit are distinct cells. */
const MIN_DIMENSION = 3;
/** Upper dimension bound; keeps the property fast at ≥ 100 iterations. */
const MAX_DIMENSION = 25;
/** fast-check iterations; testing steering requires a minimum of 100. */
const NUM_RUNS = 100;

/**
 * A tiny deterministic PRNG (mulberry32): the same seed yields the same
 * sequence in `[0, 1)`, making generation reproducible without `Math.random`.
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

/** Grid dimensions within the supported, representative range. */
const dimensionArb = fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION });
/** Full 32-bit seed space for the injected PRNG. */
const seedArb = fc.integer({ min: 0, max: 0xffffffff });

describe("RecursiveBacktrackerGenerator (property)", () => {
  // Feature: maze-game, Property 1: Generated mazes are always valid and solvable
  test("generated mazes are always valid and solvable", () => {
    const generator = new RecursiveBacktrackerGenerator();

    fc.assert(
      fc.property(dimensionArb, dimensionArb, seedArb, (rows, columns, seed) => {
        const maze = generator.generate(rows, columns, mulberry32(seed));

        expect(validateMaze(maze).ok).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
