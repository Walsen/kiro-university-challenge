/**
 * Load test: leaderboard read p95 + score freshness against budgets. Task 10.3.
 *
 * This is a **gated load/perf integration test** in the same family as the
 * client↔API seam test (task 7.4, `scoresApi.integration.test.ts`): it drives
 * the **real** deployed HTTP API over HTTPS, authenticates against the **real**
 * Cognito pool, and reuses that test's proven patterns — `CognitoAuthProvider`
 * over `AmazonCognitoClient`, `AdminConfirmSignUp` standing in for the emailed
 * code, and a genuinely solvable run rebuilt from the *shared, unchanged* Phase 1
 * core so the server-side replay (R4.6) accepts it. Nothing on the cloud side is
 * faked; only the Player's inbox and the client-side maze generation (the same
 * core the server replays) are stood in for.
 *
 * What it measures and ASSERTS, against the adopted default budgets:
 *   - **R6.4 — leaderboard top-50 read p95 < 300 ms.** The public `GET
 *     /leaderboard` route (no auth) is driven at a chosen concurrency for a
 *     sample large enough to yield a real p95; per-request latencies are
 *     collected and p50/p95/max computed from them (not an average).
 *   - **R6.5 — freshness < 2 s.** After a VALID score is accepted via `POST
 *     /scores`, `GET /leaderboard` is polled and the time-to-visibility is
 *     measured; it must be under 2 000 ms.
 *   - **R7.2 — meeting the budgets under concurrent load.** The read p95 is
 *     measured under concurrent in-flight requests toward the 1,000-concurrent
 *     adopted target. A single test process cannot faithfully drive 1,000 truly
 *     simultaneous connections, so the concurrency and sample size actually used
 *     are configurable (`MAZE_LOAD_CONCURRENCY`, `MAZE_LOAD_SAMPLES`) and are
 *     **reported in the assertion output**; this test does not claim the 1,000
 *     target was driven — it measures the read path's latency distribution under
 *     meaningful concurrency and asserts the p95 budget.
 *
 * ## Environment, gating, and isolation
 *
 * Coordinates come from the CDK stack outputs supplied via the environment
 * (`MAZE_API_BASE_URL`, `MAZE_COGNITO_USER_POOL_ID`, `MAZE_COGNITO_CLIENT_ID`,
 * `MAZE_DEV_TABLE_NAME`), never hardcoded. Like the sibling seam tests it
 * **self-skips** unless the API and pool are supplied and the table is reachable,
 * so it never breaks the ordinary no-AWS unit run or CI. Run it explicitly:
 *
 *   MAZE_API_BASE_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com \
 *   MAZE_COGNITO_USER_POOL_ID=us-east-1_xxxx \
 *   MAZE_COGNITO_CLIENT_ID=xxxxxxxx \
 *   MAZE_DEV_TABLE_NAME=maze-game-platform \
 *   MAZE_LOAD_CONCURRENCY=50 MAZE_LOAD_SAMPLES=1000 \
 *   AWS_REGION=us-east-1 \
 *   devbox run -- npx vitest run src/server/handlers/loadTest.integration.test.ts
 *
 * The disposable dev user is deleted via `AdminDeleteUser` and every table item
 * this test writes (the seeded profile plus the persisted score / personal-best /
 * leaderboard keys) is deleted in `afterAll`, so the shared pool and table — and
 * the shared leaderboard — are left clean. A fresh random seed per run is its own
 * maze-parameter scope, so load data is isolated and cleaned up by scope.
 *
 * _Requirements: R6.4, R6.5, R7.2; design "Observability" / "Deployment Gates"._
 */
import {
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AmazonCognitoClient } from "../../client/edges/cognitoClient";
import { CognitoAuthProvider } from "../../client/edges/CognitoAuthProvider";
import { DefaultMazeFactory } from "../../core/MazeFactory";
import { RecursiveBacktrackerGenerator } from "../../core/RecursiveBacktrackerGenerator";
import { CellKind } from "../../core/types";
import type { Direction, Maze, Position } from "../../core/types";
import type { MazeParams } from "../../core/validateSubmission";
import {
  PARTITION_KEY,
  PROFILE_SORT_KEY,
  SORT_KEY,
  accountPartitionKey,
  personalBestSortKey,
  scoreSortKey,
} from "../edges/dynamoSchema";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Read a process env var without pulling `@types/node` into this
 * browser/jsdom-typed project (the test runs under Node via Vitest). Mirrors the
 * helper in the 7.4 seam test.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[name];
}

const API_BASE_URL = readEnv("MAZE_API_BASE_URL");
const USER_POOL_ID = readEnv("MAZE_COGNITO_USER_POOL_ID");
const CLIENT_ID = readEnv("MAZE_COGNITO_CLIENT_ID");
const AWS_REGION = readEnv("AWS_REGION") ?? "us-east-1";
/** The single-table name; defaults to the shared stack's table. */
const TABLE_NAME = readEnv("MAZE_DEV_TABLE_NAME") ?? "maze-game-platform";

/** Present only when the API and both pool identifiers were supplied. */
const stackConfigured = Boolean(API_BASE_URL && USER_POOL_ID && CLIENT_ID);

// ---------------------------------------------------------------------------
// Load parameters (configurable; reported in output)
// ---------------------------------------------------------------------------

/** Parse a positive integer env var, falling back to a default. */
function readPositiveInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Number of requests in flight at once during the read measurement. A single
 * process cannot faithfully model 1,000 truly-simultaneous clients; this is a
 * defensible, reportable concurrency toward that target (default 50).
 */
const READ_CONCURRENCY = readPositiveInt("MAZE_LOAD_CONCURRENCY", 50);

/**
 * Total leaderboard reads to sample. p95 needs a real distribution; 1,000
 * samples put the 95th percentile on the 950th-slowest request, which is a
 * meaningful figure rather than an artifact of a handful of calls.
 */
const READ_SAMPLES = readPositiveInt("MAZE_LOAD_SAMPLES", 1_000);

/** The adopted default target this run reports itself against (not driven here). */
const CONCURRENT_TARGET = 1_000;

/**
 * Warm-up reads issued (and discarded) before the measured window. The budget
 * (R6.4) is a **steady-state** p95 under sustained load, matching the CloudWatch
 * Duration alarm on the leaderboard Lambda — not the one-off latency of the
 * cold-start burst when the function first scales from zero to `concurrency`
 * containers. Standard load-test practice is to ramp to steady state, then
 * measure. Several full concurrency waves warm the scaled-out fleet so the
 * sampled distribution is representative; a minimum floor covers low
 * concurrencies.
 */
const WARMUP_SAMPLES = Math.max(200, READ_CONCURRENCY * 4);

// ---------------------------------------------------------------------------
// Budgets (adopted defaults)
// ---------------------------------------------------------------------------

/** R6.4: leaderboard top-50 read p95 budget. */
const READ_P95_BUDGET_MS = 300;
/** R6.5: a newly accepted score becomes visible on the leaderboard within this. */
const FRESHNESS_BUDGET_MS = 2_000;
/** Top-N requested for the read measurement — the top-50 the budget names (R6.4). */
const TOP_N = 50;

// ---------------------------------------------------------------------------
// Constants (shared with the 7.4 seam test conventions)
// ---------------------------------------------------------------------------

/** A generous suite budget: SRP sign-in + a full read sweep + freshness poll. */
const LOAD_TIMEOUT_MS = 180_000;

const HTTP_CREATED = 201;
const HTTP_OK = 200;

const MAZE_ROWS = 7;
const MAZE_COLUMNS = 7;
const TIME_LIMIT_SECONDS = 60;

/** Satisfies the pool policy (≥ 12 chars, all four character classes). */
const VALID_CREDENTIAL = "S3cret-Passw0rd!x";

/** Freshness poll cadence: tight enough to resolve sub-second visibility. */
const FRESHNESS_POLL_INTERVAL_MS = 100;
/** Hard cap on the freshness poll so a never-visible score fails fast, not hangs. */
const FRESHNESS_POLL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Disposable identities and scopes
// ---------------------------------------------------------------------------

function uniqueIdentifier(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `maze-load-${unique}@example.com`;
}

/** A private maze-parameter scope, unique per run via a random seed. */
function freshScope(): MazeParams {
  return {
    rows: MAZE_ROWS,
    columns: MAZE_COLUMNS,
    seed: Math.floor(Math.random() * 1_000_000_000),
    timeLimitSeconds: TIME_LIMIT_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Building a genuinely solvable run from the shared core
// (identical to the 7.4 seam test: same PRNG, factory, and BFS solve)
// ---------------------------------------------------------------------------

/** mulberry32 — byte-for-byte the PRNG `validateSubmission` seeds generation with. */
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

function buildMaze(params: MazeParams): Maze {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(params.seed),
  );
  const result = factory.create(params.rows, params.columns);
  if (!result.ok) {
    throw new Error(`maze construction failed: ${result.error}`);
  }
  return result.maze;
}

const MOVES: ReadonlyArray<{ direction: Direction; dRow: number; dColumn: number }> = [
  { direction: "Up", dRow: -1, dColumn: 0 },
  { direction: "Down", dRow: 1, dColumn: 0 },
  { direction: "Left", dRow: 0, dColumn: -1 },
  { direction: "Right", dRow: 0, dColumn: 1 },
];

function key(position: Position): string {
  return `${position.row},${position.column}`;
}

/** BFS-solve the maze from start to exit into a winning move sequence. */
function solve(maze: Maze): ReadonlyArray<Direction> {
  const inBounds = (p: Position): boolean =>
    p.row >= 0 && p.row < maze.rows && p.column >= 0 && p.column < maze.columns;
  const isPath = (p: Position): boolean => maze.grid[p.row]?.[p.column] === CellKind.Path;

  const parents = new Map<string, { from: Position; direction: Direction }>();
  const visited = new Set<string>([key(maze.start)]);
  const queue: Position[] = [maze.start];

  while (queue.length > 0) {
    const current = queue.shift() as Position;
    if (current.row === maze.exit.row && current.column === maze.exit.column) {
      return reconstruct(maze.start, maze.exit, parents);
    }
    for (const move of MOVES) {
      const next: Position = {
        row: current.row + move.dRow,
        column: current.column + move.dColumn,
      };
      if (!inBounds(next) || !isPath(next) || visited.has(key(next))) {
        continue;
      }
      visited.add(key(next));
      parents.set(key(next), { from: current, direction: move.direction });
      queue.push(next);
    }
  }

  throw new Error("no start-to-exit path — maze invariant violated");
}

function reconstruct(
  start: Position,
  exit: Position,
  parents: Map<string, { from: Position; direction: Direction }>,
): ReadonlyArray<Direction> {
  const directions: Direction[] = [];
  let cursor = exit;
  while (cursor.row !== start.row || cursor.column !== start.column) {
    const step = parents.get(key(cursor));
    if (step === undefined) {
      throw new Error("broken BFS parent chain");
    }
    directions.push(step.direction);
    cursor = step.from;
  }
  directions.reverse();
  return directions;
}

function validSubmissionBody(params: MazeParams): unknown {
  return {
    mazeParams: params,
    moves: solve(buildMaze(params)),
    clientElapsedMs: 1_234, // advisory only; the server recomputes the real time.
    idempotencyKey: `load-${params.seed}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** A single JSON request against the real API; token optional (public reads). */
async function api(
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: unknown,
): Promise<ApiResponse> {
  const response = await fetch(`${API_BASE_URL as string}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

function scopeQuery(params: MazeParams): string {
  return (
    `?rows=${params.rows}&columns=${params.columns}` +
    `&seed=${params.seed}&timeLimitSeconds=${params.timeLimitSeconds}`
  );
}

/** The public top-50 leaderboard path for a scope (no auth, R6.4). */
function leaderboardPath(params: MazeParams): string {
  return `/leaderboard${scopeQuery(params)}&limit=${TOP_N}`;
}

// ---------------------------------------------------------------------------
// Latency statistics
// ---------------------------------------------------------------------------

/**
 * The value at the given percentile of a latency sample, by nearest-rank on the
 * sorted samples. p95 of 1,000 samples is the 950th-slowest — a real order
 * statistic, not an average.
 */
function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil((p / 100) * sortedMs.length);
  const index = Math.min(sortedMs.length, Math.max(1, rank)) - 1;
  return sortedMs[index]!;
}

interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly min: number;
  readonly errors: number;
}

function summarize(latenciesMs: readonly number[], errors: number): LatencySummary {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : Number.NaN,
    min: sorted.length > 0 ? sorted[0]! : Number.NaN,
    errors,
  };
}

/**
 * Drive `totalSamples` GET /leaderboard reads with at most `concurrency` in
 * flight at once, timing each with `performance.now()`. A fixed-size worker pool
 * pulls from a shared counter so exactly `concurrency` requests overlap — a
 * defensible model of concurrent read load from one process.
 */
async function measureReadLatencies(
  path: string,
  totalSamples: number,
  concurrency: number,
): Promise<LatencySummary> {
  const latencies: number[] = [];
  let issued = 0;
  let errors = 0;

  async function worker(): Promise<void> {
    while (issued < totalSamples) {
      issued += 1;
      const start = performance.now();
      try {
        const res = await api("GET", path);
        const elapsed = performance.now() - start;
        if (res.status === HTTP_OK) {
          latencies.push(elapsed);
        } else {
          errors += 1;
        }
      } catch {
        errors += 1;
      }
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, totalSamples) }, () => worker());
  await Promise.all(pool);
  return summarize(latencies, errors);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!stackConfigured)("load test — leaderboard p95 + freshness (real stack)", () => {
  const userPoolId = USER_POOL_ID as string;
  const clientId = CLIENT_ID as string;

  let provider: CognitoAuthProvider;
  let cognitoAdmin: CognitoIdentityProviderClient;
  let docClient: DynamoDBDocumentClient;
  let live = false;

  const createdIdentifiers: string[] = [];
  const writtenKeys: Array<{ PK: string; SK: string }> = [];

  function trackKey(pk: string, sk: string): void {
    writtenKeys.push({ PK: pk, SK: sk });
  }

  async function provisionSignedInUser(
    displayName: string,
  ): Promise<{ token: string; accountId: string }> {
    const identifier = uniqueIdentifier();
    createdIdentifiers.push(identifier);

    await provider.signUp(identifier, VALID_CREDENTIAL, displayName);
    await cognitoAdmin.send(
      new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: identifier }),
    );

    const session = await provider.signIn(identifier, VALID_CREDENTIAL);
    const claims = decodeJwtClaims(session.accessToken);
    const sub = typeof claims["sub"] === "string" ? claims["sub"] : "";
    expect(sub.length).toBeGreaterThan(0);

    await seedProfile(sub, displayName);
    return { token: session.accessToken, accountId: sub };
  }

  async function seedProfile(accountId: string, displayName: string): Promise<void> {
    const pk = accountPartitionKey(accountId);
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          [PARTITION_KEY]: pk,
          [SORT_KEY]: PROFILE_SORT_KEY,
          accountId,
          displayName,
        },
      }),
    );
    trackKey(pk, PROFILE_SORT_KEY);
  }

  function trackScoreKeys(params: MazeParams, accountId: string, elapsedMs: number): void {
    const pk = accountPartitionKey(accountId);
    trackKey(pk, scoreSortKey(params, elapsedMs, accountId));
    trackKey(pk, personalBestSortKey(params));
  }

  beforeAll(async () => {
    provider = new CognitoAuthProvider(
      new AmazonCognitoClient({ userPoolId, clientId }),
    );
    cognitoAdmin = new CognitoIdentityProviderClient({ region: AWS_REGION });
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });

    try {
      await docClient.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
      live = true;
    } catch {
      live = false;
    }
  });

  afterAll(async () => {
    await Promise.all([
      ...createdIdentifiers.map((identifier) =>
        cognitoAdmin
          .send(
            new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: identifier }),
          )
          .catch(() => undefined),
      ),
      ...writtenKeys.map((k) =>
        docClient
          .send(
            new DeleteCommand({
              TableName: TABLE_NAME,
              Key: { [PARTITION_KEY]: k.PK, [SORT_KEY]: k.SK },
            }),
          )
          .catch(() => undefined),
      ),
    ]);
  });

  it(
    "leaderboard top-50 read p95 is under 300 ms under concurrent load (R6.4, R7.2)",
    async ({ skip }) => {
      if (!live) {
        skip();
        return;
      }

      // Seed the scope with one accepted score so the read returns a real,
      // populated top-50 payload (the server still does the GSI query + profile
      // resolution whether the board holds 1 or 50 rows).
      const params = freshScope();
      const { token, accountId } = await provisionSignedInUser("Load Reader");
      const submission = await api("POST", "/scores", token, validSubmissionBody(params));
      expect(submission.status).toBe(HTTP_CREATED);
      const created = submission.body as { elapsedMs: number };
      trackScoreKeys(params, accountId, created.elapsedMs);

      const path = leaderboardPath(params);
      // Ramp to steady state before measuring: warm the scaled-out Lambda fleet
      // with several full concurrency waves whose latencies are DISCARDED, so the
      // measured p95 reflects sustained read load and not the one-off cold-start
      // burst of scaling from zero (see WARMUP_SAMPLES; R6.4 is a steady-state
      // budget). The cold-start burst is characterized separately below.
      const coldBurst = await measureReadLatencies(path, WARMUP_SAMPLES, READ_CONCURRENCY);

      const stats = await measureReadLatencies(path, READ_SAMPLES, READ_CONCURRENCY);

      // Report the real distribution and how the concurrency relates to the
      // 1,000-concurrent adopted target — this run drives READ_CONCURRENCY in
      // flight from one process, NOT 1,000 simultaneous clients.
      console.log(
        [
          "",
          "── Leaderboard top-50 read load (R6.4 / R7.2) ──",
          `  samples:            ${stats.count} (errors: ${stats.errors})`,
          `  concurrency:        ${READ_CONCURRENCY} in flight`,
          `  toward target:      ${CONCURRENT_TARGET} concurrent (adopted default; NOT driven here)`,
          `  cold-start burst:   p95 ${coldBurst.p95.toFixed(1)} ms over ${coldBurst.count} warm-up reads (discarded; scale-from-zero, not steady state)`,
          `  p50:                ${stats.p50.toFixed(1)} ms`,
          `  p95:                ${stats.p95.toFixed(1)} ms   (budget < ${READ_P95_BUDGET_MS} ms)`,
          `  max:                ${stats.max.toFixed(1)} ms`,
          `  verdict:            ${stats.p95 < READ_P95_BUDGET_MS ? "PASS" : "FAIL"}`,
          "",
        ].join("\n"),
      );

      expect(stats.count).toBeGreaterThan(0);
      expect(stats.errors).toBe(0);
      expect(stats.p95).toBeLessThan(READ_P95_BUDGET_MS);
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    "a newly accepted score is visible on the leaderboard within 2 s (R6.5)",
    async ({ skip }) => {
      if (!live) {
        skip();
        return;
      }

      const params = freshScope();
      const { token, accountId } = await provisionSignedInUser("Freshness Racer");

      // Accept a valid score; the freshness clock starts the instant the write is
      // acknowledged (201), since that is when the platform owns it (R6.5).
      const submission = await api("POST", "/scores", token, validSubmissionBody(params));
      expect(submission.status).toBe(HTTP_CREATED);
      const created = submission.body as { elapsedMs: number };
      expect(created.elapsedMs).toBeGreaterThan(0);
      trackScoreKeys(params, accountId, created.elapsedMs);

      const acceptedAt = performance.now();
      const path = leaderboardPath(params);

      let visibleAfterMs = Number.NaN;
      const deadline = acceptedAt + FRESHNESS_POLL_TIMEOUT_MS;
      // Poll until the score shows on the public leaderboard for its scope.
      for (;;) {
        const board = await api("GET", path);
        if (board.status === HTTP_OK) {
          const standings = (
            board.body as { standings?: ReadonlyArray<{ timeMs: number }> }
          ).standings;
          if (standings?.some((s) => s.timeMs === created.elapsedMs)) {
            visibleAfterMs = performance.now() - acceptedAt;
            break;
          }
        }
        if (performance.now() >= deadline) {
          break;
        }
        await sleep(FRESHNESS_POLL_INTERVAL_MS);
      }

      console.log(
        [
          "",
          "── Leaderboard freshness (R6.5) ──",
          `  visible after:      ${Number.isNaN(visibleAfterMs) ? "NEVER (within poll window)" : `${visibleAfterMs.toFixed(0)} ms`}   (budget < ${FRESHNESS_BUDGET_MS} ms)`,
          `  poll cadence:       every ${FRESHNESS_POLL_INTERVAL_MS} ms`,
          `  verdict:            ${!Number.isNaN(visibleAfterMs) && visibleAfterMs < FRESHNESS_BUDGET_MS ? "PASS" : "FAIL"}`,
          "",
        ].join("\n"),
      );

      expect(visibleAfterMs).not.toBeNaN();
      expect(visibleAfterMs).toBeLessThan(FRESHNESS_BUDGET_MS);
    },
    LOAD_TIMEOUT_MS,
  );
});

/** Resolve after `ms` milliseconds without depending on `@types/node` timers. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Decode a JWT's claims payload without verifying the signature — the token came
 * straight from Cognito, so this only reads the already-trusted `sub`.
 */
function decodeJwtClaims(token: string): Record<string, unknown> {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return {};
  }
  const payload = segments[1]!.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const json = atob(payload);
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
