/**
 * Reusable maze fixtures for `validateMaze` tests.
 *
 * These are hand-built, deterministic mazes that exercise each structural
 * invariant checked by `validateMaze` (see design.md "Maze" invariants and
 * requirements R1.4–R1.6). They are test-only helpers and contain no logic
 * beyond small builders that keep the fixtures readable.
 *
 * Grid convention: `grid[row][column]`, `P` = Path, `W` = Wall. The `start`
 * and `exit` positions index into that grid.
 */
import { CellKind, type Maze, type Position } from "../types";

const P = CellKind.Path;
const W = CellKind.Wall;

/** Build a Position tersely. */
export function at(row: number, column: number): Position {
  return { row, column };
}

/**
 * Build a Maze from a compact grid, inferring `rows`/`columns` from the grid
 * shape so fixtures only have to state the layout plus start/exit.
 */
export function makeMaze(
  grid: ReadonlyArray<ReadonlyArray<CellKind>>,
  start: Position,
  exit: Position,
): Maze {
  return {
    rows: grid.length,
    columns: grid[0]?.length ?? 0,
    grid,
    start,
    exit,
  };
}

/**
 * A valid, solvable maze:
 *
 *   S P W
 *   W P W
 *   W P E
 *
 * Start (0,0) connects to exit (2,2) via an L-shaped path down column 1.
 */
export function solvableMaze(): Maze {
  return makeMaze(
    [
      [P, P, W],
      [W, P, W],
      [W, P, P],
    ],
    at(0, 0),
    at(2, 2),
  );
}

/**
 * A maze whose grid is fully connected but whose `start` position points at a
 * Wall cell — there is no valid start. Expected error: `NoStart`.
 *
 *   W P E      start -> (0,0) is a Wall
 *   P P P
 */
export function startOnWallMaze(): Maze {
  return makeMaze(
    [
      [W, P, P],
      [P, P, P],
    ],
    at(0, 0),
    at(0, 2),
  );
}

/**
 * A maze whose `exit` position points at a Wall cell — there is no valid exit.
 * Expected error: `NoExit`.
 *
 *   S P W      exit -> (0,2) is a Wall
 *   P P P
 */
export function exitOnWallMaze(): Maze {
  return makeMaze(
    [
      [P, P, W],
      [P, P, P],
    ],
    at(0, 0),
    at(0, 2),
  );
}

/**
 * A maze whose `start` position is outside the grid boundaries. A start cell
 * that does not exist in the grid is treated as no start present.
 * Expected error: `NoStart`.
 */
export function startOutOfBoundsMaze(): Maze {
  return makeMaze(
    [
      [P, P],
      [P, P],
    ],
    at(5, 5),
    at(1, 1),
  );
}

/**
 * A maze whose `exit` position is outside the grid boundaries.
 * Expected error: `NoExit`.
 */
export function exitOutOfBoundsMaze(): Maze {
  return makeMaze(
    [
      [P, P],
      [P, P],
    ],
    at(0, 0),
    at(9, 0),
  );
}

/**
 * A maze where the start and exit are the very same cell. There must be two
 * distinct role cells. Expected error: `StartEqualsExit`.
 *
 *   P P
 *   P P      start === exit === (0,0)
 */
export function startEqualsExitMaze(): Maze {
  return makeMaze(
    [
      [P, P],
      [P, P],
    ],
    at(0, 0),
    at(0, 0),
  );
}

/**
 * A maze with valid, distinct start and exit path cells but no route of
 * 4-directionally adjacent Path cells between them (a wall column fully
 * separates the two halves). Expected error: `NoPathFromStartToExit`.
 *
 *   S W E
 *   P W P
 */
export function disconnectedMaze(): Maze {
  return makeMaze(
    [
      [P, W, P],
      [P, W, P],
    ],
    at(0, 0),
    at(0, 2),
  );
}
