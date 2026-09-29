import { describe, expect, it } from "vitest";

import type { Maze, MazeValidationError } from "./types";
import type { MazeGenerator } from "./MazeGenerator";
import { DefaultMazeFactory } from "./MazeFactory";
import {
  disconnectedMaze,
  exitOnWallMaze,
  exitOutOfBoundsMaze,
  startEqualsExitMaze,
  startOnWallMaze,
  startOutOfBoundsMaze,
} from "./testFixtures/mazes";

/**
 * Dedicated error-path unit tests for `DefaultMazeFactory` (Factory), Task 5.5.
 *
 * Where `MazeFactory.test.ts` (Task 5.4) lightly covers a single invalid case,
 * this file exhaustively exercises every `MazeValidationError` the factory can
 * surface. The factory composes an injected `MazeGenerator` with `validateMaze`
 * and reports validation failure as typed data — `{ ok: false, error }` — never
 * throwing for expected invalid input (fail fast at the boundary, R1.6). This is
 * the construction-side of design Property 2: an invalid maze yields the matching
 * error and no session begins.
 *
 * The `Maze` model carries a single `start` and `exit` `Position`, so
 * `MultipleStarts`/`MultipleExits` are unrepresentable and cannot be produced by
 * any generator; the representable failures are `NoStart`, `NoExit`,
 * `StartEqualsExit`, and `NoPathFromStartToExit`.
 *
 * _Requirements: 1.6_
 */

/**
 * A `MazeGenerator` stub that ignores its arguments and always yields a fixed,
 * known maze. This isolates the factory's error path from any generation logic:
 * whatever invalid maze we inject is exactly what `create` must validate.
 */
class FixedMazeGenerator implements MazeGenerator {
  constructor(private readonly maze: Maze) {}

  generate(): Maze {
    return this.maze;
  }
}

/**
 * A generator whose randomness source records every call, letting us assert the
 * factory does not reach `Math.random()` directly and stays deterministic.
 */
function unusedRng(): () => number {
  return () => 0;
}

/**
 * Each representable validation failure, paired with the fixture that triggers
 * it and the error the factory must report. Out-of-bounds and on-wall positions
 * both collapse to the same `NoStart`/`NoExit` error because the single-position
 * model treats "no usable path cell there" as the absence of that role cell.
 */
const invalidCases: ReadonlyArray<{
  readonly name: string;
  readonly maze: Maze;
  readonly expected: MazeValidationError;
}> = [
  { name: "start on a wall cell", maze: startOnWallMaze(), expected: "NoStart" },
  {
    name: "start outside the grid",
    maze: startOutOfBoundsMaze(),
    expected: "NoStart",
  },
  { name: "exit on a wall cell", maze: exitOnWallMaze(), expected: "NoExit" },
  {
    name: "exit outside the grid",
    maze: exitOutOfBoundsMaze(),
    expected: "NoExit",
  },
  {
    name: "start and exit are the same cell",
    maze: startEqualsExitMaze(),
    expected: "StartEqualsExit",
  },
  {
    name: "no adjacent path route from start to exit",
    maze: disconnectedMaze(),
    expected: "NoPathFromStartToExit",
  },
];

describe("DefaultMazeFactory error path", () => {
  describe("returns ok:false with the matching MazeValidationError", () => {
    for (const { name, maze, expected } of invalidCases) {
      it(`reports ${expected} when the generator yields a maze with ${name}`, () => {
        const factory = new DefaultMazeFactory(
          new FixedMazeGenerator(maze),
          unusedRng(),
        );

        const result = factory.create(maze.rows, maze.columns);

        expect(result.ok).toBe(false);
        // Narrow on the discriminant so `error` is accessible and type-checked.
        if (!result.ok) {
          expect(result.error).toBe(expected);
        }
      });
    }
  });

  describe("models failure as data rather than throwing (R1.6)", () => {
    for (const { name, maze } of invalidCases) {
      it(`does not throw when the generator yields a maze with ${name}`, () => {
        const factory = new DefaultMazeFactory(
          new FixedMazeGenerator(maze),
          unusedRng(),
        );

        expect(() => factory.create(maze.rows, maze.columns)).not.toThrow();
      });
    }
  });

  it("never exposes a maze on a failed result", () => {
    // The MazeResult union carries `maze` only on the ok branch, so a rejected
    // maze must not leak through: an invalid maze produces no session input.
    const factory = new DefaultMazeFactory(
      new FixedMazeGenerator(disconnectedMaze()),
      unusedRng(),
    );

    const result = factory.create(2, 3);

    expect(result.ok).toBe(false);
    expect("maze" in result).toBe(false);
  });
});
