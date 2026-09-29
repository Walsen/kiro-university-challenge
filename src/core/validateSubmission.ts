/**
 * Server-side score validation (maze-game-platform R4.1, R4.4, R4.6).
 *
 * `validateSubmission` is the anti-cheat centerpiece of the score path. A client
 * plays a Run locally and submits the *move sequence and maze parameters* — not
 * just a claimed time. The server rebuilds the maze from those parameters and
 * **replays the moves through the shared Phase 1 core rules**, deriving an
 * authoritative time from the replay. It persists nothing on its own; it returns
 * a typed result that the Score service acts on.
 *
 * The Phase 1 pure core is reused UNCHANGED: `DefaultMazeFactory` +
 * `RecursiveBacktrackerGenerator` rebuild the maze, `parseTimeLimit` brands the
 * limit, `GameSessionFactory` seats a fresh `PlayingState`, and `reduce`
 * (delegating to `resolveMove`/`tickTimer`) advances it. Because generation and
 * the rules are pure and deterministic, the same seed rebuilds the exact maze
 * the client played and the same moves replay identically (design "shared maze
 * core package", "Determinism").
 *
 * Authoritative time (R4.6). The submission's `clientElapsedMs` is advisory only
 * and never trusted. The server derives the time from the replayed run itself:
 * each accepted move costs a fixed, server-owned `MOVE_DURATION_MS`, so the
 * authoritative `elapsedMs` is a deterministic function of the run, not of any
 * client-supplied number. Interleaving each `Move` with a `Tick` of that
 * duration also lets the shared timer rule enforce the time limit — a run that
 * would only reach the exit after the limit expires transitions to `Lost` and
 * is rejected, exactly as gameplay would.
 *
 * Failure is modelled as typed data, never thrown (data-model steering "validate
 * at the boundary"): untrusted input arrives as `unknown`, is parsed here, and
 * any malformed / non-winning / tampered submission yields `{ ok: false, reason }`.
 *
 * Pure: no I/O, no DOM, no `Date.now()`, no `Math.random()`.
 */
import { DefaultMazeFactory } from "./MazeFactory";
import { RecursiveBacktrackerGenerator } from "./RecursiveBacktrackerGenerator";
import { DefaultGameSessionFactory } from "./GameSessionFactory";
import { parseTimeLimit } from "./parseTimeLimit";
import { reduce } from "./reduce";
import type { Direction, GameState, Maze } from "./types";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * The parameters that identify a maze Run: its size and the generation seed.
 * The seed makes generation reproducible, so the server rebuilds the identical
 * maze the client played (design "size/difficulty + generation seed").
 */
export interface MazeParams {
  readonly rows: number;
  readonly columns: number;
  readonly seed: number;
  readonly timeLimitSeconds: number;
}

/**
 * A client's claim that it completed a Run. Carries the move sequence and maze
 * parameters the server replays; `clientElapsedMs` is advisory only (the server
 * recomputes an authoritative time) and `idempotencyKey` dedupes retried or
 * concurrent submissions downstream (R7.4). See design "Score submission and
 * validation".
 */
export interface ScoreSubmission {
  readonly mazeParams: MazeParams;
  readonly moves: ReadonlyArray<Direction>;
  readonly clientElapsedMs: number;
  readonly idempotencyKey: string;
}

/**
 * A validated, authoritative Score. `elapsedMs` is the server-recomputed time,
 * so a client cannot persist an arbitrary unearned time (R4.6).
 */
export interface Score {
  readonly outcome: "Won";
  readonly mazeParams: MazeParams;
  readonly elapsedMs: number;
}

/** Why a submission was rejected. `not-a-win` = a well-formed but losing/incomplete run. */
export type SubmissionRejectionReason = "malformed" | "not-a-win";

/** Typed result of validating a submission — never thrown. */
export type ValidateSubmissionResult =
  | { readonly ok: true; readonly score: Score }
  | { readonly ok: false; readonly reason: SubmissionRejectionReason };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Server-owned duration charged for each accepted move. It makes the
 * authoritative time a deterministic function of the replayed run (R4.6) and
 * drives the shared timer rule so the time limit is enforced during replay.
 */
export const MOVE_DURATION_MS = 250;

const VALID_DIRECTIONS: ReadonlySet<string> = new Set<Direction>([
  "Up",
  "Down",
  "Left",
  "Right",
]);

// ---------------------------------------------------------------------------
// Boundary parsing (untrusted input -> typed submission)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseMazeParams(value: unknown): MazeParams | null {
  if (!isRecord(value)) {
    return null;
  }
  const { rows, columns, seed, timeLimitSeconds } = value;
  if (!isPositiveInteger(rows) || !isPositiveInteger(columns)) {
    return null;
  }
  // The seed only needs to be an integer (any value seeds the rng); dimensions
  // and time limit carry the range constraints.
  if (typeof seed !== "number" || !Number.isInteger(seed)) {
    return null;
  }
  // The time limit must be a valid, in-range limit — `parseTimeLimit` is the
  // single gate that brands it, so an out-of-range or non-integer value is
  // malformed here rather than reaching the timer. Narrow to a plain number
  // for the domain type from the parsed result.
  if (typeof timeLimitSeconds !== "number" || !parseTimeLimit(timeLimitSeconds).ok) {
    return null;
  }
  return { rows, columns, seed, timeLimitSeconds };
}

function parseMoves(value: unknown): ReadonlyArray<Direction> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const move of value) {
    if (typeof move !== "string" || !VALID_DIRECTIONS.has(move)) {
      return null;
    }
  }
  return value as ReadonlyArray<Direction>;
}

function parseSubmission(input: unknown): ScoreSubmission | null {
  if (!isRecord(input)) {
    return null;
  }
  const mazeParams = parseMazeParams(input["mazeParams"]);
  if (mazeParams === null) {
    return null;
  }
  const moves = parseMoves(input["moves"]);
  if (moves === null) {
    return null;
  }
  // `clientElapsedMs` is advisory and `idempotencyKey` is opaque to this pure
  // core; they are not required to be well-formed for validation to proceed,
  // so they are carried through defensively rather than gating the result.
  const clientElapsedMs =
    typeof input["clientElapsedMs"] === "number" ? input["clientElapsedMs"] : 0;
  const idempotencyKey =
    typeof input["idempotencyKey"] === "string" ? input["idempotencyKey"] : "";
  return { mazeParams, moves, clientElapsedMs, idempotencyKey };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function rebuildMaze(params: MazeParams): Maze | null {
  // A fresh generator + a seed-derived rng per call keeps this pure and
  // reproducible: same params in, same maze out. The factory validates the
  // maze, so an un-constructible maze (e.g. too small) is a typed failure.
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(params.seed),
  );
  const result = factory.create(params.rows, params.columns);
  return result.ok ? result.maze : null;
}

/**
 * Replay the moves through the shared reducer, charging `MOVE_DURATION_MS` per
 * move so the timer advances and the time limit is enforced. Stops early on a
 * terminal state (a win, or a loss on time expiry). Returns the final state.
 */
function replay(maze: Maze, moves: ReadonlyArray<Direction>, timeLimitSeconds: number): GameState {
  const parsed = parseTimeLimit(timeLimitSeconds);
  // Guarded upstream by parseMazeParams, but honor the typed result rather than
  // asserting: fall back to its default limit if it somehow reports not-ok.
  const timeLimit = parsed.value;

  let state: GameState = new DefaultGameSessionFactory().createSession(maze, timeLimit);

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
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validate a score submission by replaying it against the shared maze core.
 *
 * @param input - an untrusted submission (parsed defensively at the boundary).
 * @returns `{ ok: true, score }` with an authoritative `Won` `Score` when the
 *   moves solve the maze within the time limit; otherwise `{ ok: false, reason }`
 *   — `malformed` for unparseable input or an un-constructible maze, `not-a-win`
 *   for a well-formed run that does not reach the exit in time.
 */
export function validateSubmission(input: unknown): ValidateSubmissionResult {
  const submission = parseSubmission(input);
  if (submission === null) {
    return { ok: false, reason: "malformed" };
  }

  const maze = rebuildMaze(submission.mazeParams);
  if (maze === null) {
    return { ok: false, reason: "malformed" };
  }

  const finalState = replay(
    maze,
    submission.moves,
    submission.mazeParams.timeLimitSeconds,
  );

  if (finalState.status !== "Won") {
    return { ok: false, reason: "not-a-win" };
  }

  return {
    ok: true,
    score: {
      outcome: "Won",
      mazeParams: submission.mazeParams,
      // Authoritative: the core captured this from the replayed run's timer at
      // the winning move (R4.6). It is independent of `clientElapsedMs`.
      elapsedMs: finalState.elapsedMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic rng (mulberry32)
// ---------------------------------------------------------------------------

/**
 * A tiny deterministic PRNG (mulberry32). Given the same seed it yields the
 * same sequence in `[0, 1)`, so maze generation is reproducible without
 * touching `Math.random`. This matches the seeded rng the client uses to
 * generate the maze from the same seed, so client and server rebuild an
 * identical maze (design "Determinism").
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
