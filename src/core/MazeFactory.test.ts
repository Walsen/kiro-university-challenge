import { describe, expect, it } from "vitest";

import { CellKind } from "./types";
import type { Maze } from "./types";
import type { MazeGenerator } from "./MazeGenerator";
import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { DefaultMazeFactory } from "./MazeFactory";

/**
 * Example-based unit tests for `DefaultMazeFactory` (Factory), Task 5.4.
 *
 * The factory centralizes maze construction and enforces the validity
 * contract: it calls the injected `MazeGenerator`, runs `validateMaze`, and
 * returns a typed `MazeResult` — never throwing for expected invalid input
 * (fail fast at the boundary, R1.6).
 *
 * Determinism is preserved by injecting a seeded `rng: () => number`, so the
 * factory never touches `Math.random()` directly.
 *
 * _Requirements: 1.6_
 */

/**
 * A tiny deterministic PRNG (mulberry32): the same seed yields the same
 * sequence in `[0, 1)`, keeping construction reproducible under test.
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

/** A `MazeGenerator` stub that always yields a fixed, known-invalid maze. */
class StubInvalidMazeGenerator implements MazeGenerator {
  constructor(private readonly maze: Maze) {}

  generate(): Maze {
    return this.maze;
  }
}

/**
 * A 3x3 all-wall maze whose declared start is a Wall cell, so `validateMaze`
 * rejects it with `NoStart`.
 */
function invalidMaze(): Maze {
  const grid: ReadonlyArray<ReadonlyArray<CellKind>> = [
    [CellKind.Wall, CellKind.Wall, CellKind.Wall],
    [CellKind.Wall, CellKind.Wall, CellKind.Wall],
    [CellKind.Wall, CellKind.Wall, CellKind.Wall],
  ];
  return {
    rows: 3,
    columns: 3,
    grid,
    start: { row: 0, column: 0 },
    exit: { row: 2, column: 2 },
  };
}

describe("DefaultMazeFactory", () => {
  it("returns ok:true with a valid maze from a real generator", () => {
    // A real generator produces a solvable maze, so the factory validates it
    // and returns the maze rather than an error.
    const factory = new DefaultMazeFactory(
      new RecursiveBacktrackerGenerator(),
      mulberry32(42),
    );

    const result = factory.create(9, 9);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.maze.rows).toBe(9);
      expect(result.maze.columns).toBe(9);
    }
  });

  it("returns ok:false with the matching error when the generator yields an invalid maze", () => {
    // R1.6: an invalid maze must not begin a session. The factory reports the
    // validation error as data instead of throwing.
    const factory = new DefaultMazeFactory(
      new StubInvalidMazeGenerator(invalidMaze()),
      mulberry32(1),
    );

    const result = factory.create(3, 3);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("NoStart");
    }
  });

  it("does not throw for expected invalid input", () => {
    // Fail fast at the boundary is modelled as a typed result, not an
    // exception, so callers are forced by the type system to handle both.
    const factory = new DefaultMazeFactory(
      new StubInvalidMazeGenerator(invalidMaze()),
      mulberry32(2),
    );

    expect(() => factory.create(3, 3)).not.toThrow();
  });
});
