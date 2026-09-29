/**
 * Unit tests for the Score handler `POST /scores` (task 7.1) against an
 * in-memory {@link ScoreRepository} fake.
 *
 * No AWS: the handler is the orchestration seam (validate the submission with
 * the pure core, persist via the port), so it is exercised with a fake repo and
 * plain event objects. The real dev-stack seam is task 7.4.
 *
 * Acceptance criteria under test:
 *  - R4.1 — a winning submission persists a Score tied to the caller's account.
 *  - R4.3 — a request without an authenticated account is rejected (401), and
 *    nothing is persisted. (The authorizer rejects most unauthenticated callers
 *    at the edge; this is the handler's own guard.)
 *  - R4.4 — a malformed / non-winning submission is rejected (400), nothing
 *    persisted.
 *  - R4.6 — the persisted time is the server-recomputed authoritative time from
 *    `validateSubmission`, not the client's `clientElapsedMs`.
 *  - R7.4 — a duplicate submission is reported as idempotent (not a second Score).
 *  - R7.3 — beyond capacity, a downstream throttling error is shed as a clear,
 *    retryable 429 rather than an ambiguous 5xx, and no accepted Score is
 *    corrupted on that path.
 *  - R11.2 — the account persisted against is the JWT `sub`, never a client field.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { makeScoreHandler } from "./scores";
import type { HttpApiEvent } from "./http";
import type {
  Page,
  PutScoreResult,
  ScoreRepository,
} from "../ports/ScoreRepository";
import type { MazeParams, Score } from "../../core/validateSubmission";
import { DefaultMazeFactory } from "../../core/MazeFactory";
import { RecursiveBacktrackerGenerator } from "../../core/RecursiveBacktrackerGenerator";
import { DefaultGameSessionFactory } from "../../core/GameSessionFactory";
import { parseTimeLimit } from "../../core/parseTimeLimit";
import { reduce } from "../../core/reduce";
import { MOVE_DURATION_MS } from "../../core/validateSubmission";
import { CellKind, type Direction, type GameState, type Maze } from "../../core/types";

// ---------------------------------------------------------------------------
// A recording in-memory ScoreRepository fake
// ---------------------------------------------------------------------------

class FakeScoreRepository implements ScoreRepository {
  /** Only durable, accepted Scores land here; a rejected write must not. */
  public readonly puts: Array<{ accountId: string; score: Score }> = [];
  /** Simulates a duplicate: the next put reports `persisted:false`. */
  public nextIsDuplicate = false;
  /**
   * Simulates the store being at capacity: the next put throws the given
   * throttling error *before* recording anything, mirroring DynamoDB rejecting a
   * write wholesale under throttling (R7.3).
   */
  public nextThrows: Error | null = null;

  public putScore(accountId: string, score: Score): Promise<PutScoreResult> {
    if (this.nextThrows !== null) {
      // Reject wholesale — nothing is appended to `puts`, so no accepted Score
      // is corrupted or partially written on the degradation path (R7.3).
      return Promise.reject(this.nextThrows);
    }
    this.puts.push({ accountId, score });
    if (this.nextIsDuplicate) {
      return Promise.resolve({ persisted: false, isPersonalBest: false });
    }
    return Promise.resolve({ persisted: true, isPersonalBest: true });
  }

  public personalBest(): Promise<Score | null> {
    return Promise.resolve(null);
  }

  public listByAccount(): Promise<Page<Score>> {
    return Promise.resolve({ items: [] });
  }
}

// ---------------------------------------------------------------------------
// A real solvable submission (moves derived from the actual maze the server
// rebuilds), so validateSubmission returns a genuine Won score.
// ---------------------------------------------------------------------------

const PARAMS: MazeParams = { rows: 6, columns: 6, seed: 1234, timeLimitSeconds: 120 };

/** mulberry32 must match validateSubmission's own seeded rng so mazes agree. */
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

function rebuildMaze(params: MazeParams): Maze {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(params.seed),
  );
  const result = factory.create(params.rows, params.columns);
  if (!result.ok) {
    throw new Error("fixture maze failed to build");
  }
  return result.maze;
}

/** BFS a winning move sequence through the rebuilt maze. */
function solve(maze: Maze): Direction[] {
  const key = (r: number, c: number): string => `${r},${c}`;
  const steps: ReadonlyArray<readonly [Direction, number, number]> = [
    ["Up", -1, 0],
    ["Down", 1, 0],
    ["Left", 0, -1],
    ["Right", 0, 1],
  ];
  const queue: Array<{ row: number; column: number; path: Direction[] }> = [
    { row: maze.start.row, column: maze.start.column, path: [] },
  ];
  const seen = new Set<string>([key(maze.start.row, maze.start.column)]);
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }
    if (node.row === maze.exit.row && node.column === maze.exit.column) {
      return node.path;
    }
    for (const [direction, dr, dc] of steps) {
      const nr = node.row + dr;
      const nc = node.column + dc;
      if (nr < 0 || nc < 0 || nr >= maze.rows || nc >= maze.columns) {
        continue;
      }
      if (maze.grid[nr]?.[nc] !== CellKind.Path) {
        continue;
      }
      const k = key(nr, nc);
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      queue.push({ row: nr, column: nc, path: [...node.path, direction] });
    }
  }
  throw new Error("no solution found for fixture maze");
}

/** The authoritative elapsedMs the server derives by replaying the winning moves. */
function authoritativeElapsedMs(maze: Maze, moves: ReadonlyArray<Direction>): number {
  const timeLimit = parseTimeLimit(PARAMS.timeLimitSeconds).value;
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
  if (state.status !== "Won") {
    throw new Error("fixture moves did not win");
  }
  return state.elapsedMs;
}

const SOLVED_MAZE = rebuildMaze(PARAMS);
const WINNING_MOVES = solve(SOLVED_MAZE);
const AUTHORITATIVE_MS = authoritativeElapsedMs(SOLVED_MAZE, WINNING_MOVES);

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "cognito-sub-abc";

function authedEvent(body: unknown, sub: string = ACCOUNT_ID): HttpApiEvent {
  return {
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { sub } } } },
  };
}

function winningSubmission(overrides: Record<string, unknown> = {}): unknown {
  return {
    mazeParams: PARAMS,
    moves: WINNING_MOVES,
    clientElapsedMs: 1, // deliberately bogus; server must ignore it (R4.6)
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /scores handler", () => {
  let repo: FakeScoreRepository;

  beforeEach(() => {
    repo = new FakeScoreRepository();
  });

  it("persists a validated Score tied to the caller's account (R4.1, R11.2)", async () => {
    const handler = makeScoreHandler({ repository: repo });

    const result = await handler(authedEvent(winningSubmission()));

    expect(result.statusCode).toBe(201);
    expect(repo.puts).toHaveLength(1);
    // Persisted against the JWT sub, never a client-supplied id (R11.2).
    expect(repo.puts[0]?.accountId).toBe(ACCOUNT_ID);
  });

  it("ignores a client-supplied accountId in the body and writes only against the JWT sub (R11.2)", async () => {
    const handler = makeScoreHandler({ repository: repo });

    // A malicious caller injects identity-shaped fields into the body, trying to
    // persist a score against a DIFFERENT account. The handler takes the account
    // only from the verified JWT `sub`, and the validated Score carries no
    // account field at all, so the injected ids cannot widen the write.
    const result = await handler(
      authedEvent(
        winningSubmission({
          accountId: "victim-account",
          sub: "victim-account",
          owner: "victim-account",
        }),
        ACCOUNT_ID,
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(repo.puts).toHaveLength(1);
    // The write is scoped to the caller's own sub, not the injected id.
    expect(repo.puts[0]?.accountId).toBe(ACCOUNT_ID);
    // The persisted Score is identity-free: it exposes no account field a
    // client value could have populated.
    expect(repo.puts[0]?.score).not.toHaveProperty("accountId");
    expect(repo.puts[0]?.score).not.toHaveProperty("sub");
    expect(repo.puts[0]?.score).not.toHaveProperty("owner");
  });

  it("persists the server-recomputed authoritative time, not clientElapsedMs (R4.6)", async () => {
    const handler = makeScoreHandler({ repository: repo });

    await handler(authedEvent(winningSubmission({ clientElapsedMs: 999_999 })));

    expect(repo.puts[0]?.score.elapsedMs).toBe(AUTHORITATIVE_MS);
    expect(repo.puts[0]?.score.elapsedMs).not.toBe(999_999);
  });

  it("returns 201 with the personal-best flag from the repository", async () => {
    const handler = makeScoreHandler({ repository: repo });

    const result = await handler(authedEvent(winningSubmission()));
    const payload = JSON.parse(result.body) as {
      persisted: boolean;
      isPersonalBest: boolean;
      elapsedMs: number;
    };

    expect(payload.persisted).toBe(true);
    expect(payload.isPersonalBest).toBe(true);
    expect(payload.elapsedMs).toBe(AUTHORITATIVE_MS);
  });

  it("reports an idempotent duplicate without a second Score (R7.4)", async () => {
    repo.nextIsDuplicate = true;
    const handler = makeScoreHandler({ repository: repo });

    const result = await handler(authedEvent(winningSubmission()));
    const payload = JSON.parse(result.body) as { persisted: boolean };

    // Still a success (200), but nothing newly persisted.
    expect(result.statusCode).toBe(200);
    expect(payload.persisted).toBe(false);
  });

  it("rejects a request with no authenticated account and persists nothing (R4.3)", async () => {
    const handler = makeScoreHandler({ repository: repo });

    const result = await handler({ body: JSON.stringify(winningSubmission()) });

    expect(result.statusCode).toBe(401);
    expect(repo.puts).toHaveLength(0);
  });

  it("rejects a malformed body (400) and persists nothing (R4.4)", async () => {
    const handler = makeScoreHandler({ repository: repo });

    const result = await handler(authedEvent({ not: "a submission" }));

    expect(result.statusCode).toBe(400);
    expect(repo.puts).toHaveLength(0);
  });

  it("rejects a non-winning run (400) and persists nothing (R4.4, R4.6)", async () => {
    const handler = makeScoreHandler({ repository: repo });

    // A single step that does not solve the maze -> not-a-win.
    const result = await handler(
      authedEvent(winningSubmission({ moves: [WINNING_MOVES[0] ?? "Up"] })),
    );

    expect(result.statusCode).toBe(400);
    expect(repo.puts).toHaveLength(0);
  });

  it("rejects an empty body (400) without persisting (R4.4)", async () => {
    const handler = makeScoreHandler({ repository: repo });

    const result = await handler(authedEvent(undefined));

    expect(result.statusCode).toBe(400);
    expect(repo.puts).toHaveLength(0);
  });

  it("sheds a throttled/at-capacity write as a clear, retryable 429 (R7.3)", async () => {
    // The store signals it is at capacity by throwing a DynamoDB throttling
    // error; the handler must degrade gracefully rather than 5xx.
    repo.nextThrows = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    const handler = makeScoreHandler({ repository: repo });

    const result = await handler(authedEvent(winningSubmission()));
    const payload = JSON.parse(result.body) as { error: string; retryable: boolean };

    expect(result.statusCode).toBe(429);
    expect(result.headers["retry-after"]).toBe("1");
    // A clear, machine-readable indication — not an opaque 5xx.
    expect(payload).toEqual({ error: "capacity_exceeded", retryable: true });
  });

  it("never corrupts an accepted Score on the degradation path (R7.3)", async () => {
    repo.nextThrows = Object.assign(new Error("throttled"), {
      name: "ThrottlingException",
    });
    const handler = makeScoreHandler({ repository: repo });

    await handler(authedEvent(winningSubmission()));

    // The rejected write recorded nothing: no partial or corrupt Score persisted.
    expect(repo.puts).toHaveLength(0);
  });

  it("still surfaces an unexpected (non-capacity) fault as an error, not a 429 (design Error Handling)", async () => {
    // A genuine fault must not masquerade as a retryable capacity signal; it
    // propagates so the runtime maps it to a 5xx.
    repo.nextThrows = new Error("unexpected boom");
    const handler = makeScoreHandler({ repository: repo });

    await expect(handler(authedEvent(winningSubmission()))).rejects.toThrow(
      "unexpected boom",
    );
    expect(repo.puts).toHaveLength(0);
  });
});
