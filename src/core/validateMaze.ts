/**
 * Pure maze validation (Task 4.2).
 *
 * `validateMaze` verifies the structural invariants of a `Maze` (see
 * data-model.md and design.md, requirements R1.4–R1.6) and returns a typed
 * `MazeValidationResult`. It never throws for expected invalid input: expected
 * failures are modelled as data (fail fast at the boundary, R1.6).
 *
 * The `Maze` model carries a single `start` and `exit` `Position`, so "no valid
 * start/exit" is expressed as that position not designating a usable Path cell
 * (out of bounds or a Wall) -> `NoStart` / `NoExit`.
 */
import {
  CellKind,
  type Maze,
  type MazeValidationResult,
  type Position,
} from "./types";

/** Number of 4-directional neighbours a grid cell has. */
const ORTHOGONAL_STEPS: ReadonlyArray<Position> = [
  { row: -1, column: 0 },
  { row: 1, column: 0 },
  { row: 0, column: -1 },
  { row: 0, column: 1 },
];

/**
 * Validate a maze's structural invariants in a fixed order so each maze yields
 * a single, deterministic error: start validity, exit validity, distinctness,
 * then start-to-exit connectivity.
 */
export function validateMaze(maze: Maze): MazeValidationResult {
  if (!isPathCell(maze, maze.start)) {
    return { ok: false, error: "NoStart" };
  }
  if (!isPathCell(maze, maze.exit)) {
    return { ok: false, error: "NoExit" };
  }
  if (samePosition(maze.start, maze.exit)) {
    return { ok: false, error: "StartEqualsExit" };
  }
  if (!hasAdjacentPathRoute(maze)) {
    return { ok: false, error: "NoPathFromStartToExit" };
  }
  return { ok: true };
}

/** True when `position` is inside the grid and refers to a Path cell. */
function isPathCell(maze: Maze, position: Position): boolean {
  return inBounds(maze, position) && cellAt(maze, position) === CellKind.Path;
}

/** True when `position` lies within the maze's grid boundaries. */
function inBounds(maze: Maze, position: Position): boolean {
  return (
    position.row >= 0 &&
    position.row < maze.rows &&
    position.column >= 0 &&
    position.column < maze.columns
  );
}

/** Read the cell kind at an in-bounds position. */
function cellAt(maze: Maze, position: Position): CellKind {
  return maze.grid[position.row]![position.column]!;
}

/** True when two positions denote the same cell. */
function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.column === b.column;
}

/**
 * Breadth-first search from `start`, stepping only between 4-directionally
 * adjacent Path cells, returning whether `exit` is reachable.
 */
function hasAdjacentPathRoute(maze: Maze): boolean {
  const visited = new Set<string>();
  const queue: Position[] = [maze.start];
  visited.add(key(maze.start));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (samePosition(current, maze.exit)) {
      return true;
    }
    for (const neighbor of pathNeighbors(maze, current)) {
      const neighborKey = key(neighbor);
      if (!visited.has(neighborKey)) {
        visited.add(neighborKey);
        queue.push(neighbor);
      }
    }
  }
  return false;
}

/** The in-bounds Path cells orthogonally adjacent to `position`. */
function pathNeighbors(maze: Maze, position: Position): Position[] {
  const neighbors: Position[] = [];
  for (const step of ORTHOGONAL_STEPS) {
    const candidate: Position = {
      row: position.row + step.row,
      column: position.column + step.column,
    };
    if (isPathCell(maze, candidate)) {
      neighbors.push(candidate);
    }
  }
  return neighbors;
}

/** A stable string key for set membership of a position. */
function key(position: Position): string {
  return `${position.row},${position.column}`;
}
