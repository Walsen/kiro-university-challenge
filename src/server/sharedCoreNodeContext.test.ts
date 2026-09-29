// @vitest-environment node
/**
 * Node/Lambda-context verification of the shared maze core — maze-game-platform
 * task 3.2 (R4.6).
 *
 * Task 3.1 packaged the Phase 1 `src/core` as a shared, importable module reused
 * UNCHANGED by both the browser client and the server-side Lambdas. This test
 * proves the other half of that claim: that the shared core actually **imports
 * and runs in a Node/server (Lambda-like) context** with no browser/DOM
 * dependency — it can rebuild a maze from concrete params + a seed and replay a
 * known solvable path through the pure reducer to a `Won` state entirely
 * server-side.
 *
 * Why this file is special:
 *
 *  - **It runs under the `node` environment**, not the repo-wide `jsdom` default
 *    (see the `// @vitest-environment node` docblock above and `vitest.config.ts`,
 *    which sets `environment: "jsdom"` globally). A Lambda has no `window`,
 *    `document`, or `CanvasRenderingContext2D`; running here means that if any
 *    core module reached for the DOM at import or call time, the import would
 *    throw or the replay would fail. Green under `node` is the actual proof the
 *    core is side-effect-free of the browser and Lambda-safe (R4.6, design
 *    "shared maze core package").
 *
 *  - **It imports the core exactly as a Lambda does** — through the package
 *    barrel `../core` (the surface task 3.1 exposed and the surface `package.json`
 *    re-exports as `./core`), rather than reaching into individual files. This
 *    exercises the whole exported surface in the Node context, mirroring how
 *    `src/server/handlers/scores.ts` consumes the shared core.
 *
 * Determinism (testing steering): the maze is rebuilt from a fixed seed via
 * `RecursiveBacktrackerGenerator` driven by a seeded `mulberry32` rng — the SAME
 * deterministic generator the client and `validateSubmission` use — so the run
 * replays identically every time. The solving path is derived from the rebuilt
 * maze by a local BFS over its Path cells (not a hand-written guess), so it
 * follows a route the maze actually contains. No wall clock, no `Math.random`.
 *
 * This does NOT reimplement any rule or modify the Phase 1 core: maze
 * construction, movement, timing, and the win transition all come from the
 * shared core; only the seeded rng and the BFS that reads the maze are local
 * test scaffolding.
 */
import { describe, expect, it } from "vitest";

import {
  CellKind,
  DefaultGameSessionFactory,
  DefaultMazeFactory,
  RecursiveBacktrackerGenerator,
  parseTimeLimit,
  reduce,
  type Direction,
  type GameState,
  type Maze,
  type Position,
} from "../core";

// ---------------------------------------------------------------------------
// Deterministic rng — the same mulberry32 the client and validateSubmission use,
// so a given seed rebuilds the exact maze a client would have played.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Local BFS over the rebuilt maze — derives a real solvable direction sequence.
// It reads only the maze's Path cells, mirroring the connectivity contract
// `validateMaze` enforces and the movement contract `resolveMove` honors, so
// following it lands on the exit.
// ---------------------------------------------------------------------------

const DIRECTION_DELTAS: ReadonlyArray<readonly [Direction, Position]> = [
  ["Up", { row: -1, column: 0 }],
  ["Down", { row: 1, column: 0 }],
  ["Left", { row: 0, column: -1 }],
  ["Right", { row: 0, column: 1 }],
];

function keyOf(p: Position): string {
  return `${p.row},${p.column}`;
}

function isPathCell(maze: Maze, p: Position): boolean {
  return maze.grid[p.row]?.[p.column] === CellKind.Path;
}

function reconstruct(
  cameFrom: Map<string, { prev: Position; direction: Direction }>,
  start: Position,
  exit: Position,
): Direction[] {
  const directions: Direction[] = [];
  let cursor = exit;
  while (keyOf(cursor) !== keyOf(start)) {
    const step = cameFrom.get(keyOf(cursor));
    if (step === undefined) {
      throw new Error("test setup: broken BFS parent chain");
    }
    directions.unshift(step.direction);
    cursor = step.prev;
  }
  return directions;
}

/** The shortest solvable direction sequence from start to exit of `maze`. */
function solutionMoves(maze: Maze): Direction[] {
  const start = maze.start;
  const exit = maze.exit;
  const visited = new Set<string>([keyOf(start)]);
  const queue: Position[] = [start];
  const cameFrom = new Map<string, { prev: Position; direction: Direction }>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.row === exit.row && current.column === exit.column) {
      return reconstruct(cameFrom, start, exit);
    }
    for (const [direction, delta] of DIRECTION_DELTAS) {
      const next: Position = {
        row: current.row + delta.row,
        column: current.column + delta.column,
      };
      if (!isPathCell(maze, next) || visited.has(keyOf(next))) {
        continue;
      }
      visited.add(keyOf(next));
      cameFrom.set(keyOf(next), { prev: current, direction });
      queue.push(next);
    }
  }
  throw new Error("test setup: no start-to-exit path in a validated maze");
}

// ---------------------------------------------------------------------------
// The run under test: concrete params + seed, replayed server-side.
// ---------------------------------------------------------------------------

/**
 * Server-owned per-move duration. It advances the shared timer during replay so
 * the authoritative elapsed time is a deterministic function of the run — the
 * same discipline the Score Lambda's `validateSubmission` uses (R4.6). Kept as a
 * local constant so this file does not depend on validation internals; it just
 * needs *some* fixed tick to drive the timer.
 */
const MOVE_DURATION_MS = 250;

const ROWS = 11;
const COLUMNS = 11;
const SEED = 20240607;
const TIME_LIMIT_SECONDS = 60;

/** Rebuild the maze the way a Lambda would: shared factory + seeded generator. */
function rebuildMaze(): Maze {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(SEED),
  );
  const result = factory.create(ROWS, COLUMNS);
  if (!result.ok) {
    throw new Error(`test setup: maze rebuild failed (${result.error})`);
  }
  return result.maze;
}

/**
 * Replay a solving path through the shared reducer to a terminal state, exactly
 * as server-side validation would: alternate an accepted `Move` with a `Tick` of
 * the server-owned duration so the timer advances and the time limit is honored.
 */
function replayToTerminal(maze: Maze, moves: ReadonlyArray<Direction>): GameState {
  const parsed = parseTimeLimit(TIME_LIMIT_SECONDS);
  if (!parsed.ok) {
    throw new Error("test setup: time limit fixture is not valid");
  }
  let state: GameState = new DefaultGameSessionFactory().createSession(
    maze,
    parsed.value,
  );

  for (const direction of moves) {
    state = reduce(state, { type: "Move", direction });
    if (state.status === "Won" || state.status === "Lost") {
      break;
    }
    state = reduce(state, { type: "Tick", elapsedMs: MOVE_DURATION_MS });
    if (state.status === "Lost") {
      break;
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shared maze core runs in a Node/Lambda context (task 3.2, R4.6)", () => {
  it("imports the shared core through its package barrel without a DOM", () => {
    // If the core or anything it transitively imports touched `window`,
    // `document`, or the Canvas at module-load time, importing `../core` under
    // the node environment would already have thrown before this line. Reaching
    // here — with the exported symbols defined — is the import-side proof.
    expect(typeof DefaultMazeFactory).toBe("function");
    expect(typeof RecursiveBacktrackerGenerator).toBe("function");
    expect(typeof DefaultGameSessionFactory).toBe("function");
    expect(typeof reduce).toBe("function");
    expect(typeof parseTimeLimit).toBe("function");
    // `document` is a jsdom global; under the node environment it must be absent.
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
  });

  it("rebuilds a maze from params + seed and replays a known path to a Won state, server-side", () => {
    const maze = rebuildMaze();
    const moves = solutionMoves(maze);

    // A non-trivial run: the derived path actually traverses the maze.
    expect(moves.length).toBeGreaterThan(0);

    const finalState = replayToTerminal(maze, moves);

    // The core reached the win transition purely server-side.
    expect(finalState.status).toBe("Won");
    if (finalState.status !== "Won") return;

    // The authoritative elapsed time is server-derived from the replay: one
    // server-owned tick per accepted move before the winning one. It is a
    // deterministic function of the run, not of any client-supplied value
    // (R4.6).
    const ticksBeforeWin = moves.length - 1;
    expect(finalState.elapsedMs).toBe(ticksBeforeWin * MOVE_DURATION_MS);

    // The win is well within the time limit, so it is a genuine Won (not a Lost
    // on expiry that the reducer would have surfaced instead).
    expect(finalState.elapsedMs).toBeLessThan(TIME_LIMIT_SECONDS * 1000);

    // The avatar finished on the maze exit — the run really solved this maze.
    expect(finalState.avatar).toEqual(maze.exit);
  });

  it("rebuilds the identical maze for the same seed across independent imports", () => {
    // Determinism is what lets a Lambda rebuild the exact maze a client played
    // from the seed alone: two independent rebuilds from the same seed are
    // structurally identical, so the same path solves both.
    const first = rebuildMaze();
    const second = rebuildMaze();

    expect(second.grid).toEqual(first.grid);
    expect(second.start).toEqual(first.start);
    expect(second.exit).toEqual(first.exit);

    expect(replayToTerminal(second, solutionMoves(first)).status).toBe("Won");
  });
});
