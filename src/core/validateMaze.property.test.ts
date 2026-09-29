/**
 * Property-based test for `validateMaze` (Task 4.3).
 *
 * Realizes design correctness Property 2 ("Invalid mazes are rejected and no
 * session starts", Validates: Requirements 1.6) as a single fast-check property
 * running at least 100 iterations, per the testing steering conventions.
 *
 * The `Maze` model (src/core/types.ts) carries a single `start` and a single
 * `exit` `Position`, so "zero or multiple starts/exits" is not representable by
 * the type. The representable structural failure modes this property covers are
 * therefore:
 *   - `NoStart`               — start out of bounds, or on a Wall cell
 *   - `NoExit`                — exit out of bounds, or on a Wall cell
 *   - `StartEqualsExit`       — start and exit are the same in-bounds Path cell
 *   - `NoPathFromStartToExit` — distinct Path start/exit with no adjacent route
 *
 * A custom arbitrary generates structurally invalid mazes across all four modes;
 * for each, `validateMaze` must return `ok: false` with an error drawn from the
 * `MazeValidationError` union (so no `Playing` session could start — R1.6).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { validateMaze } from "./validateMaze";
import { CellKind, type Maze, type MazeValidationError, type Position } from "./types";

/** The complete set of error values the `MazeValidationError` union may take. */
const MAZE_VALIDATION_ERRORS: ReadonlySet<MazeValidationError> = new Set([
  "NoStart",
  "MultipleStarts",
  "NoExit",
  "MultipleExits",
  "StartEqualsExit",
  "NoPathFromStartToExit",
]);

const MIN_DIMENSION = 2;
const MAX_DIMENSION = 6;

/** A grid where every cell is a Path — a fully connected open field. */
function allPathGrid(rows: number, columns: number): CellKind[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => CellKind.Path),
  );
}

/** An in-bounds coordinate arbitrary for a grid of the given dimensions. */
function positionArb(rows: number, columns: number): fc.Arbitrary<Position> {
  return fc.record({
    row: fc.integer({ min: 0, max: rows - 1 }),
    column: fc.integer({ min: 0, max: columns - 1 }),
  });
}

/** A coordinate that is guaranteed to fall OUTSIDE a grid of the given size. */
function outOfBoundsPositionArb(rows: number, columns: number): fc.Arbitrary<Position> {
  // At least one axis is pushed beyond the grid, so the position is never valid.
  return fc.oneof(
    fc.record({
      row: fc.integer({ min: rows, max: rows + 5 }),
      column: fc.integer({ min: 0, max: columns - 1 }),
    }),
    fc.record({
      row: fc.integer({ min: 0, max: rows - 1 }),
      column: fc.integer({ min: columns, max: columns + 5 }),
    }),
    fc.record({
      row: fc.integer({ min: rows, max: rows + 5 }),
      column: fc.integer({ min: columns, max: columns + 5 }),
    }),
  );
}

/** Dimensions plus a distinct pair of in-bounds cells, for the modes needing them. */
interface DimsWithTwoCells {
  readonly rows: number;
  readonly columns: number;
  readonly a: Position;
  readonly b: Position;
}

function dimsWithTwoDistinctCellsArb(): fc.Arbitrary<DimsWithTwoCells> {
  return fc
    .record({
      rows: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
      columns: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
    })
    .chain(({ rows, columns }) =>
      fc
        .tuple(positionArb(rows, columns), positionArb(rows, columns))
        .filter(([a, b]) => a.row !== b.row || a.column !== b.column)
        .map(([a, b]) => ({ rows, columns, a, b })),
    );
}

/** Mode 1: start is out of bounds or on a Wall -> NoStart. */
function noStartMazeArb(): fc.Arbitrary<Maze> {
  return fc
    .record({
      rows: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
      columns: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
    })
    .chain(({ rows, columns }) =>
      fc
        .tuple(
          fc.boolean(), // start out of bounds vs. on a wall
          positionArb(rows, columns),
          outOfBoundsPositionArb(rows, columns),
          positionArb(rows, columns),
        )
        .map(([startOutOfBounds, startInBounds, startOob, exit]) => {
          const grid = allPathGrid(rows, columns);
          let start: Position;
          if (startOutOfBounds) {
            start = startOob;
          } else {
            // Make the in-bounds start cell a Wall so it is not a valid start.
            grid[startInBounds.row]![startInBounds.column] = CellKind.Wall;
            start = startInBounds;
          }
          return { rows, columns, grid, start, exit };
        }),
    );
}

/** Mode 2: start is a valid Path cell but exit is out of bounds or a Wall -> NoExit. */
function noExitMazeArb(): fc.Arbitrary<Maze> {
  return fc
    .record({
      rows: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
      columns: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
    })
    .chain(({ rows, columns }) =>
      fc
        .tuple(
          fc.boolean(), // exit out of bounds vs. on a wall
          positionArb(rows, columns),
          outOfBoundsPositionArb(rows, columns),
          positionArb(rows, columns),
        )
        .map(([exitOutOfBounds, exitInBounds, exitOob, start]) => {
          const grid = allPathGrid(rows, columns);
          let exit: Position;
          if (exitOutOfBounds) {
            exit = exitOob;
          } else {
            grid[exitInBounds.row]![exitInBounds.column] = CellKind.Wall;
            exit = exitInBounds;
          }
          // Keep the start a valid Path cell so validation reaches the exit check.
          grid[start.row]![start.column] = CellKind.Path;
          return { rows, columns, grid, start, exit };
        }),
    );
}

/** Mode 3: start === exit on a valid Path cell -> StartEqualsExit. */
function startEqualsExitMazeArb(): fc.Arbitrary<Maze> {
  return fc
    .record({
      rows: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
      columns: fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION }),
    })
    .chain(({ rows, columns }) =>
      positionArb(rows, columns).map((cell) => {
        const grid = allPathGrid(rows, columns);
        return { rows, columns, grid, start: cell, exit: cell };
      }),
    );
}

/**
 * Mode 4: distinct in-bounds Path start/exit with every other cell walled off,
 * so no adjacent-path route can connect them -> NoPathFromStartToExit.
 *
 * Isolating each of the two cells (all four orthogonal neighbours are Walls)
 * guarantees disconnection regardless of where the two cells land.
 */
function disconnectedMazeArb(): fc.Arbitrary<Maze> {
  return dimsWithTwoDistinctCellsArb().map(({ rows, columns, a, b }) => {
    const grid = Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => CellKind.Wall),
    );
    // Only the two role cells are Path; they share no orthogonal edge because
    // every neighbouring cell is a Wall, so BFS from start cannot reach exit.
    grid[a.row]![a.column] = CellKind.Path;
    grid[b.row]![b.column] = CellKind.Path;
    // If the two Path cells happen to be orthogonally adjacent, wall one off by
    // nudging: re-wall b's neighbourhood is impossible without touching a, so we
    // instead reject adjacency at the arbitrary level below via filter.
    return { rows, columns, grid, start: a, exit: b };
  });
}

/** A structurally invalid maze drawn from any of the representable failure modes. */
function invalidMazeArb(): fc.Arbitrary<Maze> {
  return fc.oneof(
    noStartMazeArb(),
    noExitMazeArb(),
    startEqualsExitMazeArb(),
    // Exclude the case where the two lone Path cells are orthogonally adjacent
    // (which would actually be connected) so this branch is always disconnected.
    disconnectedMazeArb().filter(
      (maze) =>
        Math.abs(maze.start.row - maze.exit.row) +
          Math.abs(maze.start.column - maze.exit.column) >
        1,
    ),
  );
}

describe("validateMaze rejects structurally invalid mazes", () => {
  // Feature: maze-game, Property 2: Invalid mazes are rejected and no session starts
  it("returns ok:false with a typed MazeValidationError for any invalid maze", () => {
    // Validates: Requirements 1.6
    fc.assert(
      fc.property(invalidMazeArb(), (maze) => {
        const result = validateMaze(maze);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(MAZE_VALIDATION_ERRORS.has(result.error)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
