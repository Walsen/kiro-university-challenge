import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { CellKind, type Direction, type Maze, type Position } from "./types";
import {
  MOVE_DURATION_MS,
  validateSubmission,
  type MazeParams,
} from "./validateSubmission";

/**
 * Property-based test for maze-game-platform Correctness Property: score
 * validity (Task 5.3).
 *
 * Property (design "Score submission and validation", R4.6): a submission
 * validates to a `Won` `Score` *if and only if* its move sequence traces a
 * solvable path that reaches the exit within the time limit. The property
 * exercises BOTH directions of the iff over randomly generated mazes:
 *
 *  - **Forward (⇒).** A move sequence that legitimately reaches the exit within
 *    the limit validates to a `Won` `Score` whose authoritative `elapsedMs` is
 *    the server-recomputed time — a deterministic function of the replayed run,
 *    independent of the (deliberately absurd) `clientElapsedMs` claim (R4.6).
 *  - **Reverse (⇐).** A non-winning / malformed / tampered submission — a
 *    truncated path that stops short of the exit, a path padded past the time
 *    limit with real accepted moves, an empty move list, or moves that are not
 *    valid directions at all — never validates to a `Won` `Score`; it yields a
 *    typed rejection (`not-a-win` or `malformed`), never a throw.
 *
 * The winning path is derived by a local BFS over the rebuilt maze's Path
 * cells, so a WIN case follows a route the maze actually contains rather than a
 * hand-written guess. A shortest BFS path never revisits a cell and is never
 * blocked, so each of its moves is accepted and the authoritative time is
 * exactly `(pathLength - 1) * MOVE_DURATION_MS` (the winning move itself is not
 * charged, mirroring the example tests).
 *
 * Determinism (testing steering): the maze is rebuilt from the submission seed
 * via `RecursiveBacktrackerGenerator` driven by a seeded mulberry32 PRNG — the
 * SAME deterministic generator `validateSubmission` uses — so a valid client run
 * replays identically server-side. Directions, the seed, dimensions, and the
 * negative-variant selector all come from fast-check arbitraries; no
 * `Math.random`, no wall clock. Custom arbitraries constrain generation to
 * valid domain values (a genuine solving path from the generated maze) while
 * mixing in mutated/invalid variants for the reverse direction. The property
 * runs a minimum of 100 iterations.
 *
 * _Validates: Requirements 4.6_
 */

/** fast-check iterations; testing steering requires a minimum of 100. */
const NUM_RUNS = 200;

/** Smallest dimension for which the generator yields distinct start/exit. */
const MIN_DIMENSION = 3;
/** Upper dimension bound; keeps the property fast at >= 100 iterations. */
const MAX_DIMENSION = 13;

/**
 * A generous, in-range time limit so a shortest solving path always finishes
 * within it — the forward direction is about a legitimate win, not the timer.
 */
const GENEROUS_TIME_LIMIT_SECONDS = 600;
/** The tightest allowed limit; used to build over-the-limit reverse cases. */
const TIGHT_TIME_LIMIT_SECONDS = 30;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * A client time claim that is absurd on purpose: the forward direction asserts
 * the authoritative time ignores it entirely (R4.6).
 */
const TAMPERED_CLIENT_MS = 1;

/**
 * A tiny deterministic PRNG (mulberry32): the same seed yields the same
 * sequence in `[0, 1)`, making maze generation reproducible without
 * `Math.random`. This is the exact PRNG `validateSubmission` uses internally,
 * so a maze rebuilt here matches the one it rebuilds. Defined locally per the
 * testing steering.
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

// ---------------------------------------------------------------------------
// Local BFS over the rebuilt maze — derives a real solvable direction sequence.
// Mirrors the connectivity `validateMaze` enforces and the movement contract
// `resolveMove` honors, so following it lands on the exit.
// ---------------------------------------------------------------------------

const DIRECTION_DELTAS: ReadonlyArray<readonly [Direction, Position]> = [
  ["Up", { row: -1, column: 0 }],
  ["Down", { row: 1, column: 0 }],
  ["Left", { row: 0, column: -1 }],
  ["Right", { row: 0, column: 1 }],
];

const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  Up: "Down",
  Down: "Up",
  Left: "Right",
  Right: "Left",
};

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

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Full 32-bit seed space for the injected PRNG. */
const seedArb = fc.integer({ min: 0, max: 0xffffffff });
const dimensionArb = fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION });

/**
 * The four ways a submission can fail the reverse direction of the iff. Each is
 * a well-formed *intent* the arbitrary realizes against a concrete maze:
 *  - `truncated`  — a solving path with its final (winning) move dropped, so it
 *    stops one cell short of the exit → `not-a-win`.
 *  - `over-limit` — real accepted oscillation moves that drain a tight timer to
 *    zero before the exit is reached → `not-a-win`.
 *  - `empty`      — no moves at all, the avatar never leaves the start → `not-a-win`.
 *  - `bad-moves`  — a token that is not a valid `Direction`, rejected at the
 *    boundary parse → `malformed`.
 */
const invalidKindArb = fc.constantFrom(
  "truncated",
  "over-limit",
  "empty",
  "bad-moves",
);

/**
 * Custom arbitrary for the FORWARD (⇒) direction: valid `MazeParams` with a
 * generous limit plus the genuine shortest solving path for that maze. The
 * authoritative time is fully determined by the path length.
 */
const winningCaseArb = fc
  .record({ rows: dimensionArb, columns: dimensionArb, seed: seedArb })
  .map(({ rows, columns, seed }) => {
    const params: MazeParams = {
      rows,
      columns,
      seed,
      timeLimitSeconds: GENEROUS_TIME_LIMIT_SECONDS,
    };
    const moves = solutionMoves(rebuild(params));
    // A shortest BFS path never revisits a cell and is never blocked, so every
    // move but the winning one is charged MOVE_DURATION_MS (R4.6).
    const expectedElapsedMs = (moves.length - 1) * MOVE_DURATION_MS;
    return { params, moves, expectedElapsedMs };
  });

/**
 * Custom arbitrary for the REVERSE (⇐) direction: valid `MazeParams` plus a
 * `moves` payload that, by construction, does NOT trace a solvable path within
 * the limit. Bundles the reason each variant must produce so the assertion can
 * be precise.
 */
interface InvalidCase {
  readonly params: MazeParams;
  readonly moves: ReadonlyArray<unknown>;
  readonly reason: "not-a-win" | "malformed";
}

const invalidCaseArb: fc.Arbitrary<InvalidCase> = fc
  .record({
    rows: dimensionArb,
    columns: dimensionArb,
    seed: seedArb,
    kind: invalidKindArb,
  })
  .map(({ rows, columns, seed, kind }): InvalidCase => {
    if (kind === "over-limit") {
      const params: MazeParams = {
        rows,
        columns,
        seed,
        timeLimitSeconds: TIGHT_TIME_LIMIT_SECONDS,
      };
      const maze = rebuild(params);
      const oscillation = oscillateFromStart(maze);
      const limitMs = TIGHT_TIME_LIMIT_SECONDS * MILLISECONDS_PER_SECOND;
      const padMovesNeeded =
        Math.ceil(limitMs / MOVE_DURATION_MS) + oscillation.length;
      const moves: Direction[] = [];
      while (moves.length < padMovesNeeded) {
        moves.push(...oscillation);
      }
      moves.push(...solutionMoves(maze));
      return { params, moves, reason: "not-a-win" };
    }

    const params: MazeParams = {
      rows,
      columns,
      seed,
      timeLimitSeconds: GENEROUS_TIME_LIMIT_SECONDS,
    };
    const maze = rebuild(params);
    const solution = solutionMoves(maze);

    if (kind === "truncated") {
      const short = solution.slice(0, Math.max(0, solution.length - 1));
      return { params, moves: short, reason: "not-a-win" };
    }
    if (kind === "empty") {
      return { params, moves: [], reason: "not-a-win" };
    }
    // "bad-moves": splice an invalid direction token into an otherwise real path.
    const tampered: unknown[] = [...solution, "Sideways"];
    return { params, moves: tampered, reason: "malformed" };
  });

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("validateSubmission — Property: score validity (R4.6)", () => {
  // Feature: maze-game-platform, Property: score validity
  it("validates to a Won Score iff the moves trace a solvable path within the time limit", () => {
    fc.assert(
      fc.property(
        winningCaseArb,
        invalidCaseArb,
        (winning, invalid) => {
          // Forward (⇒): a genuine solving path within the limit wins, with an
          // authoritative time derived from the replay — never the client claim.
          const won = validateSubmission({
            mazeParams: winning.params,
            moves: winning.moves,
            clientElapsedMs: TAMPERED_CLIENT_MS,
            idempotencyKey: "win",
          });

          expect(won.ok).toBe(true);
          if (!won.ok) {
            return;
          }
          expect(won.score.outcome).toBe("Won");
          expect(won.score.mazeParams).toEqual(winning.params);
          expect(won.score.elapsedMs).toBe(winning.expectedElapsedMs);
          expect(won.score.elapsedMs).not.toBe(TAMPERED_CLIENT_MS);

          // Reverse (⇐): a non-winning / malformed / tampered submission never
          // validates to a Won Score — it is a typed rejection.
          const rejected = validateSubmission({
            mazeParams: invalid.params,
            moves: invalid.moves,
            clientElapsedMs: TAMPERED_CLIENT_MS,
            idempotencyKey: "invalid",
          });

          expect(rejected.ok).toBe(false);
          if (rejected.ok) {
            return;
          }
          expect(rejected.reason).toBe(invalid.reason);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
