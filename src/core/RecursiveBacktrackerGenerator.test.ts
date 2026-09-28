import { describe, expect, it } from "vitest";

import { CellKind } from "./types";
import type { Maze } from "./types";
import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { validateMaze } from "./validateMaze";

/**
 * Example-based unit tests for `RecursiveBacktrackerGenerator` (Strategy).
 *
 * Red step (Task 5.1): these specify behavior before the implementation in
 * `RecursiveBacktrackerGenerator.ts` (Task 5.2) and `validateMaze.ts`
 * (Task 4.2) exist, so they are expected to fail until those tasks land.
 *
 * Determinism is a testing-steering requirement: generation must never touch
 * `Math.random()` directly. Randomness is injected as `rng: () => number`,
 * seeded here with a small, self-contained PRNG (mulberry32) so the same seed
 * yields byte-for-byte identical mazes.
 *
 * _Requirements: 1.4, 1.5_
 */

/**
 * A tiny deterministic PRNG (mulberry32). Given the same seed it produces the
 * same sequence of numbers in `[0, 1)`, making generation reproducible without
 * depending on `Math.random`.
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

/** Representative dimensions to exercise (rows × columns). */
const REPRESENTATIVE_DIMENSIONS: ReadonlyArray<readonly [number, number]> = [
  [5, 5],
  [7, 9],
  [10, 10],
  [8, 12],
];

describe("RecursiveBacktrackerGenerator", () => {
  it("produces identical mazes for the same seed (determinism)", () => {
    // Two independent generators driven by rng seeded identically must yield
    // the same maze, proving generation depends only on its injected inputs.
    const generator = new RecursiveBacktrackerGenerator();

    const first = generator.generate(9, 9, mulberry32(12345));
    const second = generator.generate(9, 9, mulberry32(12345));

    expect(second).toEqual(first);
  });

  it("produces different mazes for different seeds", () => {
    // Distinct seeds should generally drive distinct layouts; if the generator
    // ignored its rng this would collapse to identical output.
    const generator = new RecursiveBacktrackerGenerator();

    const a = generator.generate(11, 11, mulberry32(1));
    const b = generator.generate(11, 11, mulberry32(2));

    expect(b).not.toEqual(a);
  });

  it("generates mazes that pass validateMaze for representative dimensions", () => {
    // R1.4 / R1.5: every generated maze has exactly one start and one exit
    // (distinct path cells) with an adjacent-path route between them, so
    // validateMaze must accept it.
    const generator = new RecursiveBacktrackerGenerator();

    for (const [rows, columns] of REPRESENTATIVE_DIMENSIONS) {
      const maze = generator.generate(rows, columns, mulberry32(rows * 100 + columns));

      const result = validateMaze(maze);

      expect(result.ok).toBe(true);
    }
  });

  it("reports the requested dimensions and places start and exit on path cells", () => {
    // R1.4: start and exit are distinct path cells within the requested grid.
    const generator = new RecursiveBacktrackerGenerator();
    const rows = 7;
    const columns = 9;

    const maze: Maze = generator.generate(rows, columns, mulberry32(777));

    expect(maze.rows).toBe(rows);
    expect(maze.columns).toBe(columns);
    expect(maze.grid).toHaveLength(rows);
    for (const gridRow of maze.grid) {
      expect(gridRow).toHaveLength(columns);
    }

    expect(cellAt(maze, maze.start.row, maze.start.column)).toBe(CellKind.Path);
    expect(cellAt(maze, maze.exit.row, maze.exit.column)).toBe(CellKind.Path);
    expect(maze.start).not.toEqual(maze.exit);
  });
});

/** Read a cell, failing loudly if the coordinates are out of the grid. */
function cellAt(maze: Maze, row: number, column: number): CellKind {
  const gridRow = maze.grid[row];
  if (gridRow === undefined) {
    throw new Error(`row ${row} out of bounds`);
  }
  const cell = gridRow[column];
  if (cell === undefined) {
    throw new Error(`column ${column} out of bounds`);
  }
  return cell;
}
