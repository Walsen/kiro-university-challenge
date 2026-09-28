/**
 * RED-step unit tests for `validateMaze` (Task 4.1).
 *
 * These specify the behavior of the pure `validateMaze(maze): MazeValidationResult`
 * function BEFORE it is implemented in Task 4.2, so they are expected to fail to
 * compile/run until `./validateMaze` exists. Tests are named by the behavior they
 * specify so a failure reads as a specification.
 *
 * Requirements: 1.4 (exactly one start and one exit, distinct), 1.5 (an adjacent
 * path route from start to exit exists), 1.6 (invalid mazes are rejected).
 *
 * Note on multiplicity errors: the `Maze` model (src/core/types.ts) carries a
 * single `start` and a single `exit` Position, so a maze with zero or multiple
 * start/exit *cells* cannot be represented by the type. `validateMaze` therefore
 * expresses "no valid start/exit" as the start/exit position not designating a
 * usable Path cell (out of bounds or a Wall) -> `NoStart` / `NoExit`. The
 * `MultipleStarts` / `MultipleExits` members of `MazeValidationError` remain part
 * of the error union for callers that validate richer maze sources; they are
 * referenced at the type level below but are not producible from this model.
 */
import { describe, expect, it } from "vitest";

import { validateMaze } from "./validateMaze";
import type { MazeValidationError } from "./types";
import {
  disconnectedMaze,
  exitOnWallMaze,
  exitOutOfBoundsMaze,
  solvableMaze,
  startEqualsExitMaze,
  startOnWallMaze,
  startOutOfBoundsMaze,
} from "./testFixtures/mazes";

describe("validateMaze", () => {
  it("accepts a solvable maze with one start, one exit, and a connecting path", () => {
    const result = validateMaze(solvableMaze());

    expect(result).toEqual({ ok: true });
  });

  it("rejects a maze whose start cell is a wall as having no start", () => {
    const result = validateMaze(startOnWallMaze());

    expect(result).toEqual({ ok: false, error: "NoStart" });
  });

  it("rejects a maze whose start position is outside the grid as having no start", () => {
    const result = validateMaze(startOutOfBoundsMaze());

    expect(result).toEqual({ ok: false, error: "NoStart" });
  });

  it("rejects a maze whose exit cell is a wall as having no exit", () => {
    const result = validateMaze(exitOnWallMaze());

    expect(result).toEqual({ ok: false, error: "NoExit" });
  });

  it("rejects a maze whose exit position is outside the grid as having no exit", () => {
    const result = validateMaze(exitOutOfBoundsMaze());

    expect(result).toEqual({ ok: false, error: "NoExit" });
  });

  it("rejects a maze whose start and exit are the same cell", () => {
    const result = validateMaze(startEqualsExitMaze());

    expect(result).toEqual({ ok: false, error: "StartEqualsExit" });
  });

  it("rejects a maze with no adjacent-path route from start to exit", () => {
    const result = validateMaze(disconnectedMaze());

    expect(result).toEqual({ ok: false, error: "NoPathFromStartToExit" });
  });

  it("reports every rejection as a typed, non-throwing failure result", () => {
    // Fail fast at the boundary with typed data, never a thrown exception (R1.6).
    const rejecting = [
      startOnWallMaze(),
      exitOnWallMaze(),
      startEqualsExitMaze(),
      disconnectedMaze(),
    ];

    for (const maze of rejecting) {
      const result = validateMaze(maze);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The error is drawn from the MazeValidationError union.
        const error: MazeValidationError = result.error;
        expect(typeof error).toBe("string");
      }
    }
  });
});
