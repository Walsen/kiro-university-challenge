/**
 * Integration seam test: client ↔ API (real dev stack). Task 7.4.
 *
 * This is a **cloud-seam** integration test in the sense the testing steering
 * requires: it composes the *real* far side of the client↔API seam and fakes
 * nothing on the cloud side. It drives the **real** deployed HTTP API
 * (`MazeGamePlatform-dev`) over HTTPS with a **real** Cognito-issued JWT,
 * exercising the Score, personal-history, and leaderboard Lambdas end to end
 * against the **real** dev DynamoDB table behind them. The only things replaced
 * are what is genuinely external to the seam: the Player's email inbox (the
 * account is confirmed administratively via `AdminConfirmSignUp`, standing in
 * for the emailed code) and the client-side maze generation, which is the
 * *shared, unchanged* Phase 1 core reused here to construct a genuinely solvable
 * run — exactly the core the server replays.
 *
 * The seam under test (design "Deploy-First Delivery and Integration Seams"):
 *   client ↔ API — a bearer-JWT request submits a validated score, reads it
 *   back, and reads the leaderboard; a tampered submission is rejected
 *   server-side.
 *
 * What it verifies, mapped to the cited criteria:
 *   - R4.3: an authenticated (bearer-JWT) caller reaches the protected Score
 *     route; the JWT authorizer admitted the token.
 *   - R4.6 (anti-cheat): a VALID run — a real solvable move sequence + seed,
 *     validated server-side by replay — is accepted with the server-recomputed
 *     authoritative time, while a TAMPERED submission (a non-winning / altered
 *     move sequence claiming an unearned result) is REJECTED (400) with nothing
 *     persisted.
 *   - R5.1: the accepted score reads back through `GET /scores/me` (the caller's
 *     own history, per-account isolated).
 *   - R6.1: the accepted score appears on `GET /leaderboard`, ascending by time,
 *     under the run's maze-parameter scope.
 *
 * ## How a valid run is constructed
 *
 * The server validates a submission by rebuilding the maze from
 * `mazeParams` (size + seed) and replaying the moves through the shared core,
 * deriving an authoritative time (see `validateSubmission`, R4.6). To produce a
 * submission that will pass that replay, this test rebuilds the *identical* maze
 * the same way — `DefaultMazeFactory` + `RecursiveBacktrackerGenerator` seeded
 * by the same `mulberry32(seed)` the validator uses — then breadth-first solves
 * it from start to exit and turns the solution path into `Direction`s. It relies
 * on nothing private to the server: same pure core, same seed, same maze.
 *
 * ## Environment, gating, and isolation
 *
 * The API base URL and pool identifiers come from the CDK dev-stack outputs
 * (`ApiUrl`, `UserPoolId`, `UserPoolClientId` of `MazeGamePlatform-dev`) supplied
 * via the environment; they are never hardcoded. The test needs AWS credentials,
 * a deployed API, and a reachable pool — none of which are present in the
 * ordinary unit run or CI's no-AWS `vitest run`. It therefore **self-skips**
 * (matching the sibling seam tests) unless the API and pool are supplied and the
 * table is reachable, so it never breaks a no-AWS run. Run it explicitly (e.g. to
 * satisfy the G1 gate) with:
 *
 *   MAZE_API_BASE_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com \
 *   MAZE_COGNITO_USER_POOL_ID=us-east-1_xxxx \
 *   MAZE_COGNITO_CLIENT_ID=xxxxxxxx \
 *   MAZE_DEV_TABLE_NAME=maze-game-platform-dev \
 *   AWS_REGION=us-east-1 \
 *   devbox run -- npx vitest run src/server/handlers/scoresApi.integration.test.ts
 *
 * Every disposable dev user is deleted via `AdminDeleteUser` and every table item
 * this test writes (the seeded profile plus the persisted score / personal-best /
 * leaderboard keys) is deleted in `afterAll`, so the real pool and table are left
 * clean. Each run uses a fresh random seed as its own maze-parameter scope, so
 * concurrent or repeated runs never collide with each other or with real data.
 *
 * _Requirements: R4.3, R4.6, R5.1, R6.1; design "integration seams"._
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
 * Read a process environment variable without pulling `@types/node` into this
 * browser/jsdom-typed project. The test runs under Node (Vitest), so `process`
 * exists at runtime; we reach it through `globalThis` behind a narrow local type
 * rather than widening the project's ambient globals. Returns `undefined` when
 * the variable (or `process` itself) is absent.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[name];
}

/** Dev-stack coordinates, supplied out of band from the CDK stack outputs. */
const API_BASE_URL = readEnv("MAZE_API_BASE_URL");
const USER_POOL_ID = readEnv("MAZE_COGNITO_USER_POOL_ID");
const CLIENT_ID = readEnv("MAZE_COGNITO_CLIENT_ID");
const AWS_REGION = readEnv("AWS_REGION") ?? "us-east-1";
/** The dev single-table name; overridable so the test is not pinned to one env. */
const TABLE_NAME = readEnv("MAZE_DEV_TABLE_NAME") ?? "maze-game-platform-dev";

/** Present only when the API and both pool identifiers were supplied for a real run. */
const stackConfigured = Boolean(API_BASE_URL && USER_POOL_ID && CLIENT_ID);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A generous per-test budget: real Cognito SRP + several API round-trips. */
const INTEGRATION_TIMEOUT_MS = 45_000;

/** HTTP statuses the assertions reference by name rather than as magic numbers. */
const HTTP_CREATED = 201;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

/** The maze size for the run. Small enough to solve fast, large enough to be a real maze. */
const MAZE_ROWS = 7;
const MAZE_COLUMNS = 7;
/** A comfortable limit so a short solved run is never a time loss. */
const TIME_LIMIT_SECONDS = 60;

/**
 * A credential that satisfies the pool's policy (≥ 12 chars, all four character
 * classes — see `identity-user-pool.ts`).
 */
const VALID_CREDENTIAL = "S3cret-Passw0rd!x";

// ---------------------------------------------------------------------------
// Disposable identities and scopes
// ---------------------------------------------------------------------------

/**
 * A unique email per run so repeated runs never collide on an existing account.
 * Uses the reserved `example.com` domain (can receive no real mail — fitting,
 * since the account is confirmed administratively).
 */
function uniqueIdentifier(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `maze-api-seam-${unique}@example.com`;
}

/**
 * A private maze-parameter scope, unique per call via a random seed. Each test
 * takes its own scope so its leaderboard partition and history hold only the
 * entries that test writes, never leaking into another run's read.
 */
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
// ---------------------------------------------------------------------------

/**
 * A tiny deterministic PRNG (mulberry32), byte-for-byte the one
 * `validateSubmission` seeds maze generation with. Reproduced here (it is not
 * exported) so the test rebuilds the *identical* maze the server will rebuild
 * from the same seed — the whole point of the anti-cheat replay.
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

/** Rebuild the maze the server will rebuild from these params, or throw if invalid. */
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

/** The four moves and the row/column delta each applies to the avatar. */
const MOVES: ReadonlyArray<{ direction: Direction; dRow: number; dColumn: number }> = [
  { direction: "Up", dRow: -1, dColumn: 0 },
  { direction: "Down", dRow: 1, dColumn: 0 },
  { direction: "Left", dRow: 0, dColumn: -1 },
  { direction: "Right", dRow: 0, dColumn: 1 },
];

/** Encode a position as a grid key for the BFS visited/parent maps. */
function key(position: Position): string {
  return `${position.row},${position.column}`;
}

/**
 * Breadth-first solve the maze from start to exit and return the winning move
 * sequence. BFS over 4-adjacent `Path` cells finds the shortest route; the route
 * is then differenced into `Direction`s. Throws if no route exists — but
 * `validateMaze` guarantees one, so a throw would be a real defect, not flakiness.
 */
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

/** Walk the BFS parent chain from exit back to start, yielding moves in order. */
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

/** Build the JSON body of a valid `POST /scores` submission for a solved run. */
function validSubmissionBody(params: MazeParams): unknown {
  return {
    mazeParams: params,
    moves: solve(buildMaze(params)),
    clientElapsedMs: 1_234, // advisory only; the server recomputes the real time.
    idempotencyKey: `seam-${params.seed}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** A single authenticated JSON request against the real API. */
async function api(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<ApiResponse> {
  const response = await fetch(`${API_BASE_URL as string}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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

/** The query string encoding a maze-parameter scope for the GET routes. */
function scopeQuery(params: MazeParams): string {
  return (
    `?rows=${params.rows}&columns=${params.columns}` +
    `&seed=${params.seed}&timeLimitSeconds=${params.timeLimitSeconds}`
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!stackConfigured)("client ↔ API seam (real dev stack)", () => {
  // Non-null assertions are safe here: `skipIf` guarantees the identifiers are
  // set whenever this block runs.
  const userPoolId = USER_POOL_ID as string;
  const clientId = CLIENT_ID as string;

  let provider: CognitoAuthProvider;
  let cognitoAdmin: CognitoIdentityProviderClient;
  let docClient: DynamoDBDocumentClient;
  let live = false;

  /** Disposable users to remove in cleanup, even on assertion failure. */
  const createdIdentifiers: string[] = [];
  /** Table keys written (seeded profile + score/best keys) to remove in cleanup. */
  const writtenKeys: Array<{ PK: string; SK: string }> = [];

  function trackKey(pk: string, sk: string): void {
    writtenKeys.push({ PK: pk, SK: sk });
  }

  /**
   * Provision a confirmed dev account and return its JWT and Cognito `sub`. The
   * `sub` is the account id the server scopes writes to, and the id whose
   * profile the leaderboard resolves a display name from.
   */
  async function provisionSignedInUser(
    displayName: string,
  ): Promise<{ token: string; accountId: string }> {
    const identifier = uniqueIdentifier();
    createdIdentifiers.push(identifier);

    await provider.signUp(identifier, VALID_CREDENTIAL, displayName);
    // Stand in for the emailed confirmation code with a real admin confirmation.
    await cognitoAdmin.send(
      new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: identifier }),
    );

    const session = await provider.signIn(identifier, VALID_CREDENTIAL);
    // The access token's `sub` claim is the account id the API uses (R11.2).
    const claims = decodeJwtClaims(session.accessToken);
    const sub = typeof claims["sub"] === "string" ? claims["sub"] : "";
    expect(sub.length).toBeGreaterThan(0);

    // Seed a profile item so the leaderboard can resolve a public display name
    // for this account (R6.2). The account-provisioning path that would create
    // this on sign-up is not part of this seam; the leaderboard read is.
    await seedProfile(sub, displayName);

    return { token: session.accessToken, accountId: sub };
  }

  /** Write a profile item (PK=ACCT#<sub>, SK=PROFILE) with a public display name. */
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

  /** Record the base-table keys a persisted Score + its personal best occupy. */
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

    // A cheap DescribeTable decides reachability without writing anything. Any
    // failure (no creds, offline, no such table) flips the suite to skip, so a
    // configured-but-unreachable environment does not fail a routine run.
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
    "submits a valid score with a real JWT, reads it back, and sees it on the leaderboard (R4.3, R5.1, R6.1)",
    async ({ skip }) => {
      if (!live) {
        skip();
        return;
      }
      const params = freshScope();
      const { token, accountId } = await provisionSignedInUser("Seam Racer");

      // (1) submit a VALID run. The server rebuilds the maze from params+seed and
      // replays the moves, so an authenticated caller reaching a 201 proves both
      // the JWT authorizer admitted the token (R4.3) and the run replayed to a win.
      const submission = await api("POST", "/scores", token, validSubmissionBody(params));
      expect(submission.status).toBe(HTTP_CREATED);
      const created = submission.body as {
        persisted: boolean;
        isPersonalBest: boolean;
        elapsedMs: number;
      };
      expect(created.persisted).toBe(true);
      expect(created.isPersonalBest).toBe(true);
      // The persisted time is the server-recomputed authoritative time (R4.6),
      // not the advisory clientElapsedMs (1_234) the body carried.
      expect(created.elapsedMs).toBeGreaterThan(0);
      expect(created.elapsedMs).not.toBe(1_234);
      trackScoreKeys(params, accountId, created.elapsedMs);

      // (2) read it back through the caller's own history (R5.1).
      const mine = await api("GET", "/scores/me", token);
      expect(mine.status).toBe(HTTP_OK);
      const history = mine.body as {
        items: ReadonlyArray<{ elapsedMs: number; mazeParams: MazeParams }>;
      };
      const own = history.items.find((s) => s.mazeParams.seed === params.seed);
      expect(own, "the just-submitted score in the caller's history").toBeDefined();
      expect(own?.elapsedMs).toBe(created.elapsedMs);

      // (3) read the public leaderboard for the scope and see the score (R6.1).
      const board = await api("GET", `/leaderboard${scopeQuery(params)}`, token);
      expect(board.status).toBe(HTTP_OK);
      const standings = (
        board.body as {
          standings: ReadonlyArray<{ rank: number; displayName: string; timeMs: number }>;
        }
      ).standings;
      // The scope is private to this run, so the caller's single score is the
      // whole ranking: rank 1, its display name, its authoritative time.
      expect(standings[0]?.rank).toBe(1);
      expect(standings[0]?.displayName).toBe("Seam Racer");
      expect(standings[0]?.timeMs).toBe(created.elapsedMs);
      // The private account identifier never appears in a public standing (R11.3).
      expect(JSON.stringify(standings)).not.toContain(accountId);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "rejects a tampered submission server-side and persists nothing (R4.6)",
    async ({ skip }) => {
      if (!live) {
        skip();
        return;
      }
      const params = freshScope();
      const { token } = await provisionSignedInUser("Seam Cheater");

      // A tampered run: the FIRST move of the valid solution is dropped, so the
      // replay no longer reaches the exit. The body still claims a fast time, but
      // the server trusts only its own replay, so it is a non-winning run.
      const valid = solve(buildMaze(params));
      const tampered = valid.slice(1);
      const tamperedBody = {
        mazeParams: params,
        moves: tampered,
        clientElapsedMs: 1, // an unearned, absurdly-fast claimed time.
        idempotencyKey: `tampered-${params.seed}`,
      };

      const rejected = await api("POST", "/scores", token, tamperedBody);
      // Rejected server-side by replay: a well-formed but non-winning run is 400
      // with nothing persisted (R4.6 anti-cheat).
      expect(rejected.status).toBe(HTTP_BAD_REQUEST);

      // Nothing persisted: the caller's history for this scope stays empty, and
      // the leaderboard for this scope has no standing.
      const mine = await api("GET", "/scores/me", token);
      expect(mine.status).toBe(HTTP_OK);
      const history = mine.body as {
        items: ReadonlyArray<{ mazeParams: MazeParams }>;
      };
      expect(history.items.some((s) => s.mazeParams.seed === params.seed)).toBe(false);

      const board = await api("GET", `/leaderboard${scopeQuery(params)}`, token);
      expect(board.status).toBe(HTTP_OK);
      const standings = (board.body as { standings: ReadonlyArray<unknown> }).standings;
      expect(standings).toHaveLength(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

/**
 * Decode a JWT's claims payload (the middle segment) without verifying the
 * signature — the token came straight from Cognito, so this only reads the
 * already-trusted `sub`. Base64url-decoded via `atob`, available in the Node
 * runtime Vitest uses.
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
