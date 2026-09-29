/**
 * Recursive backtracker maze generator (Strategy implementation of
 * `MazeGenerator`, Task 5.2).
 *
 * The recursive backtracker is a randomized depth-first traversal that carves a
 * perfect maze: a spanning tree over a set of "cell" positions. Because the
 * carved graph is a tree, every pair of carved cells is connected by a unique
 * path of 4-directionally adjacent Path cells. Choosing the start and exit as
 * two distinct carved cells therefore guarantees a start-to-exit route
 * (Requirements 1.4, 1.5).
 *
 * Cells occupy even grid coordinates; the odd coordinate between two adjacent
 * cells is the wall that gets knocked out when they are connected. Everything
 * else stays a Wall. The whole grid begins as Wall and paths are carved into it.
 *
 * Generation is pure and deterministic: randomness enters only through the
 * injected `rng: () => number` (never `Math.random()`), so the same seeded rng
 * yields byte-for-byte identical mazes (design "Determinism").
 */
import { CellKind, type Maze, type Position } from "./types";
import type { MazeGenerator } from "./MazeGenerator";

/** Carve cells sit two grid steps apart, with a wall cell between them. */
const CELL_SPACING = 2;

/** The four orthogonal cell-to-cell moves (two grid steps each). */
const CARVE_STEPS: ReadonlyArray<Position> = [
  { row: -CELL_SPACING, column: 0 },
  { row: CELL_SPACING, column: 0 },
  { row: 0, column: -CELL_SPACING },
  { row: 0, column: CELL_SPACING },
];

export class RecursiveBacktrackerGenerator implements MazeGenerator {
  generate(rows: number, columns: number, rng: () => number): Maze {
    const grid = createAllWallGrid(rows, columns);
    const start: Position = { row: 0, column: 0 };
    const exit = bottomRightCell(rows, columns);

    carve(grid, start, rng);

    return {
      rows,
      columns,
      grid: freezeGrid(grid),
      start,
      exit,
    };
  }
}

/** Build a mutable `rows x columns` grid filled entirely with Wall cells. */
function createAllWallGrid(rows: number, columns: number): CellKind[][] {
  const grid: CellKind[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const gridRow: CellKind[] = [];
    for (let column = 0; column < columns; column += 1) {
      gridRow.push(CellKind.Wall);
    }
    grid.push(gridRow);
  }
  return grid;
}

/**
 * The last carve cell, at the largest even coordinate within bounds. For odd
 * dimensions this is the true bottom-right corner; for even dimensions it is
 * one cell in, which is still a distinct carved cell reachable from the start.
 */
function bottomRightCell(rows: number, columns: number): Position {
  return {
    row: largestEvenBelow(rows),
    column: largestEvenBelow(columns),
  };
}

/** The largest even number strictly less than `size` (size is at least 1). */
function largestEvenBelow(size: number): number {
  const last = size - 1;
  return last % 2 === 0 ? last : last - 1;
}

/**
 * Iterative depth-first carving from `origin`. Each visited cell is marked Path,
 * and for each unvisited cell-neighbour (in a per-cell shuffled order) the wall
 * between the two is knocked out before descending. An explicit stack replaces
 * recursion so deep mazes cannot overflow the call stack.
 */
function carve(grid: CellKind[][], origin: Position, rng: () => number): void {
  const visited = new Set<string>();
  const stack: Position[] = [origin];

  markPath(grid, origin);
  visited.add(key(origin));

  while (stack.length > 0) {
    const current = stack[stack.length - 1]!;
    const next = pickUnvisitedNeighbor(grid, current, visited, rng);

    if (next === undefined) {
      stack.pop();
      continue;
    }

    knockOutWallBetween(grid, current, next);
    markPath(grid, next);
    visited.add(key(next));
    stack.push(next);
  }
}

/**
 * Choose an unvisited cell-neighbour of `cell`, considering neighbours in an
 * rng-shuffled order so the carved layout depends deterministically on the
 * seed. Returns `undefined` when the cell has no unvisited neighbours.
 */
function pickUnvisitedNeighbor(
  grid: CellKind[][],
  cell: Position,
  visited: Set<string>,
  rng: () => number,
): Position | undefined {
  for (const step of shuffledSteps(rng)) {
    const neighbor: Position = {
      row: cell.row + step.row,
      column: cell.column + step.column,
    };
    if (isCarvableCell(grid, neighbor) && !visited.has(key(neighbor))) {
      return neighbor;
    }
  }
  return undefined;
}

/** A copy of `CARVE_STEPS` shuffled with a deterministic Fisher-Yates draw. */
function shuffledSteps(rng: () => number): Position[] {
  const steps = [...CARVE_STEPS];
  for (let i = steps.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const temp = steps[i]!;
    steps[i] = steps[j]!;
    steps[j] = temp;
  }
  return steps;
}

/** Mark the wall cell lying between two adjacent carve cells as Path. */
function knockOutWallBetween(
  grid: CellKind[][],
  a: Position,
  b: Position,
): void {
  const wall: Position = {
    row: (a.row + b.row) / 2,
    column: (a.column + b.column) / 2,
  };
  markPath(grid, wall);
}

/** Set the cell at `position` to Path. */
function markPath(grid: CellKind[][], position: Position): void {
  grid[position.row]![position.column] = CellKind.Path;
}

/** True when `position` is an in-bounds cell coordinate to carve into. */
function isCarvableCell(grid: CellKind[][], position: Position): boolean {
  const gridRow = grid[position.row];
  if (gridRow === undefined) {
    return false;
  }
  return position.column >= 0 && position.column < gridRow.length;
}

/** A stable string key identifying a cell for visited-set membership. */
function key(position: Position): string {
  return `${position.row},${position.column}`;
}

/** Freeze rows into the immutable grid shape the `Maze` type requires. */
function freezeGrid(grid: CellKind[][]): ReadonlyArray<ReadonlyArray<CellKind>> {
  return grid.map((row) => [...row]);
}
