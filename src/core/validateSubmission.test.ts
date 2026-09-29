/**
 * Failing tests (Red phase) for server-side score validation — maze-game-platform
 * task 5.1.
 *
 * `validateSubmission` is new PURE server-side logic that reuses the Phase 1
 * maze core UNCHANGED. Given a `ScoreSubmission` (maze parameters + a move
 * sequence), it rebuilds the maze from the params + seed, replays the moves
 * through the shared `reduce`/`resolveMove` rules, and:
 *
 *  - returns an authoritative `Won` `Score` with a server-recomputed time when
 *    the moves are a solvable path that reaches the exit within the time limit
 *    (R4.1, R4.6), and
 *  - returns a typed rejection (never throws) for a non-winning, malformed, or
 *    tampered submission (R4.4, R4.6).
 *
 * Determinism (testing steering): the maze is rebuilt from the submission's
 * seed via `RecursiveBacktrackerGenerator` driven by a seeded mulberry32 rng —
 * the SAME deterministic generator the client uses — so a valid client run
 * replays identically server-side. No wall clock, no `Math.random`. The
 * expected solvable move sequence is derived by a local BFS over the rebuilt
 * maze's Path cells, so the WIN cases follow a route the maze actually contains
 * rather than a hand-written guess.
 *
 * These tests are written BEFORE the implementation (Red → Green → Refactor).
 */
import { describe, expect, it } from "vitest";

import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { CellKind, type Direction, type Maze, type Position } from "./types";
import {
  MOVE_DURATION_MS,
  validateSubmission,
  type MazeParams,
  type ScoreSubmission,
} from "./validateSubmission";

// ---------------------------------------------------------------------------
// Deterministic rng — the same mulberry32 the rest of the core tests use, so a
// submission's seed rebuilds the exact maze the client played.
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
// Mirrors the connectivity contract `validateMaze` enforces and the movement
// contract `resolveMove` honors, so following it lands on the exit.
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

const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  Up: "Down",
  Down: "Up",
  Left: "Right",
  Right: "Left",
};

/**
 * A two-move round trip between the start and an adjacent Path cell: step to a
 * neighbour, then step straight back. Both moves are accepted by `resolveMove`,
 * so each advances the server timer — a way to burn time without winning.
 */
function oscillateFromStart(maze: Maze): Direction[] {
  for (const [direction, delta] of DIRECTION_DELTAS) {
    const neighbor: Position = {
      row: maze.start.row + delta.row,
      column: maze.start.column + delta.column,
    };
    if (isPathCell(maze, neighbor)) {
      return [direction, OPPOSITE[direction]];
    }
  }
  throw new Error("test setup: start cell has no Path neighbour");
}

/** Rebuild the same maze `validateSubmission` will, for computing test fixtures. */
function rebuild(params: MazeParams): Maze {
  return new RecursiveBacktrackerGenerator().generate(
    params.rows,
    params.columns,
    mulberry32(params.seed),
  );
}

// A small, solvable maze fixture used across the winning cases.
const PARAMS: MazeParams = { rows: 9, columns: 9, seed: 4242, timeLimitSeconds: 60 };

function submissionWith(overrides: Partial<ScoreSubmission> = {}): ScoreSubmission {
  const maze = rebuild(PARAMS);
  return {
    mazeParams: PARAMS,
    moves: solutionMoves(maze),
    clientElapsedMs: 1234,
    idempotencyKey: "test-key-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Winning submissions
// ---------------------------------------------------------------------------

describe("validateSubmission — winning replay (R4.1, R4.6)", () => {
  it("accepts a solvable move sequence and returns an authoritative Won Score", () => {
    const result = validateSubmission(submissionWith());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.score.outcome).toBe("Won");
    expect(result.score.mazeParams).toEqual(PARAMS);
  });

  it("derives the authoritative time from the replayed run, not the client claim", () => {
    const maze = rebuild(PARAMS);
    const moves = solutionMoves(maze);
    // The authoritative time is server-derived: it advances the shared timer by
    // a fixed per-move duration for each accepted move before the winning one.
    // The advisory client time plays no part.
    const acceptedBeforeWin = moves.length - 1;
    const expectedMs = acceptedBeforeWin * MOVE_DURATION_MS;

    const result = validateSubmission(
      submissionWith({ moves, clientElapsedMs: 999_999 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.score.elapsedMs).toBe(expectedMs);
  });

  it("ignores a tampered (too-fast) client time and reports the real replayed time", () => {
    const result = validateSubmission(submissionWith({ clientElapsedMs: 1 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Server time is authoritative and independent of the unearned claim (R4.6).
    expect(result.score.elapsedMs).toBeGreaterThan(1);
  });

  it("tolerates leading blocked moves before the real path (they change no position)", () => {
    const maze = rebuild(PARAMS);
    const moves = solutionMoves(maze);
    // A blocked move at the start cell — start is a corner, so at least one of
    // Up/Left walks off-grid and is rejected by resolveMove, leaving position
    // unchanged. The remaining real path still wins.
    const withBlocked: Direction[] = ["Up", "Left", ...moves];

    const result = validateSubmission(submissionWith({ moves: withBlocked }));

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-winning submissions (R4.4)
// ---------------------------------------------------------------------------

describe("validateSubmission — non-winning replay is rejected (R4.4)", () => {
  it("rejects an empty move sequence that never reaches the exit", () => {
    const result = validateSubmission(submissionWith({ moves: [] }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-a-win");
  });

  it("rejects a truncated path that stops short of the exit", () => {
    const maze = rebuild(PARAMS);
    const moves = solutionMoves(maze);
    const short = moves.slice(0, Math.max(0, moves.length - 1));

    const result = validateSubmission(submissionWith({ moves: short }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-a-win");
  });

  it("rejects a run that exceeds the time limit before reaching the exit", () => {
    // The tightest allowed limit; each accepted move advances the server timer
    // by MOVE_DURATION_MS, so enough wandering runs it to zero (a Lost outcome)
    // before the exit is reached — not a win.
    const tight: MazeParams = { ...PARAMS, timeLimitSeconds: 30 };
    const maze = rebuild(tight);
    const shortest = solutionMoves(maze);

    // Oscillate between the start and an adjacent Path cell to burn time with
    // real, accepted moves. Enough round-trips to exceed the limit outright.
    const oscillation = oscillateFromStart(maze);
    const limitMs = tight.timeLimitSeconds * 1000;
    const padMovesNeeded = Math.ceil(limitMs / MOVE_DURATION_MS) + oscillation.length;
    const pad: Direction[] = [];
    while (pad.length < padMovesNeeded) {
      pad.push(...oscillation);
    }
    const moves = [...pad, ...shortest];

    const result = validateSubmission({
      mazeParams: tight,
      moves,
      clientElapsedMs: 100,
      idempotencyKey: "tight",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-a-win");
  });
});

// ---------------------------------------------------------------------------
// Malformed / tampered submissions (R4.4, R4.6)
// ---------------------------------------------------------------------------

describe("validateSubmission — malformed input is rejected as typed data (R4.4)", () => {
  it("rejects a non-object submission", () => {
    const result = validateSubmission(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("rejects a submission missing maze parameters", () => {
    const result = validateSubmission({
      moves: ["Right"],
      clientElapsedMs: 1,
      idempotencyKey: "k",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("rejects moves that are not an array of valid directions", () => {
    const result = validateSubmission(
      submissionWith({ moves: ["Sideways" as unknown as Direction] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("rejects a non-positive or out-of-range time limit (R4.4)", () => {
    const result = validateSubmission(
      submissionWith({ mazeParams: { ...PARAMS, timeLimitSeconds: 0 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("rejects non-integer / non-positive maze dimensions", () => {
    const result = validateSubmission(
      submissionWith({ mazeParams: { ...PARAMS, rows: 0 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("rejects params whose seed rebuilds no valid maze as malformed, not a crash", () => {
    // A 1x1 grid cannot carry a distinct start and exit — the factory returns a
    // validation error, which must surface as a typed rejection, not a throw.
    const result = validateSubmission(
      submissionWith({ mazeParams: { ...PARAMS, rows: 1, columns: 1 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });
});
