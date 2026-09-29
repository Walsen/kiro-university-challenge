/**
 * Integration seam test — persistence adapters ↔ the REAL dev DynamoDB table
 * (task 6.5, R4.5, R6.1, R7.4; design "integration seams").
 *
 * Unit tests (`DynamoScoreRepository.test.ts`, `DynamoLeaderboardQuery.test.ts`)
 * pin each adapter's behaviour against a hand fake of the `send`-shaped
 * DocumentClient seam. They prove the adapters build the right commands, but a
 * fake cannot prove the commands are *correct DynamoDB* — that the condition
 * expressions the real service evaluates behave as the adapters assume, that the
 * GSI is keyed so an ascending `Query` really returns fastest-first, or that the
 * server-side key scheme matches the table CDK provisioned (`infra/data-store.ts`).
 * This test closes that seam: it composes the **real** `DynamoScoreRepository`
 * and `DynamoLeaderboardQuery` over the **real** marshalling DocumentClient
 * (`createDynamoDocumentClient`) against the **real** dev single-table + GSI.
 * Nothing on the DynamoDB side is faked — that is the point of a seam test; only
 * what is genuinely external to this seam (none of it here) would be.
 *
 * What it verifies, mapped to the cited criteria:
 *  - put/get round-trip — a persisted Score reads back through `personalBest`
 *    and `listByAccount` (R4.2, R5.1).
 *  - conditional personal-best (R4.5) — a strictly-faster later Score becomes
 *    the new best; a slower one does not displace it.
 *  - idempotent duplicate submit (R7.4) — re-putting the same account/scope/time
 *    is a no-op (`persisted: false`), leaving exactly one Score.
 *  - GSI ascending read (R6.1) — a `topN` leaderboard `Query` returns standings
 *    fastest-first, resolving public display names from the profile items.
 *
 * ## Environment and isolation
 *
 * The table name comes from `MAZE_DEV_TABLE_NAME`, defaulting to the known dev
 * table (`maze-game-platform-dev`); the region and credentials come from the
 * ambient AWS environment (the Devbox `AWS_PROFILE`/`AWS_REGION`). When the table
 * is unreachable — no credentials, offline, wrong account — the suite **skips**
 * rather than fails, so a routine `vitest run` off the dev stack (e.g. CI on the
 * pure core) is unaffected; this optional seam test asserts real behaviour only
 * when pointed at a real table.
 *
 * Every item this test writes is under freshly-random account ids in an isolated
 * maze-parameter scope (a random seed), so concurrent or repeated runs never
 * collide with each other or with real data, and each written key is tracked and
 * deleted in `afterAll` so the real table is left clean.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import { DynamoScoreRepository } from "./DynamoScoreRepository";
import { DynamoLeaderboardQuery } from "./DynamoLeaderboardQuery";
import {
  PARTITION_KEY,
  PROFILE_SORT_KEY,
  SORT_KEY,
  accountPartitionKey,
  personalBestSortKey,
  scoreSortKey,
} from "./dynamoSchema";
import type { MazeParams, Score } from "../../core/validateSubmission";

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

/** The dev single-table name; overridable so the test is not pinned to one env. */
const TABLE_NAME = readEnv("MAZE_DEV_TABLE_NAME") ?? "maze-game-platform-dev";

/** A short random token so parallel/repeat runs occupy disjoint keys. */
function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * A private maze-parameter scope, unique per call via a random seed. Each test
 * takes its own scope so its leaderboard partition (`LB#<params>`) and its
 * scored-account history hold only the entries that test writes — writes from
 * other tests (which share the one real table) land in different partitions and
 * cannot leak into a `topN` or `listByAccount` read under test.
 */
function freshScope(): MazeParams {
  return {
    rows: 7,
    columns: 7,
    seed: Math.floor(Math.random() * 1_000_000_000),
    timeLimitSeconds: 60,
  };
}

function score(params: MazeParams, elapsedMs: number): Score {
  return { outcome: "Won", mazeParams: params, elapsedMs };
}

// ---------------------------------------------------------------------------
// Live-table detection: skip cleanly when the dev stack is unreachable
// ---------------------------------------------------------------------------

/**
 * A real marshalling DocumentClient. The adapters accept it through their narrow
 * `DynamoDocumentClient` seam (it satisfies that shape), and the test harness
 * uses it directly for the housekeeping the ports do not expose — seeding a
 * profile item, the reachability `DescribeTable`, and per-key cleanup.
 */
let client: DynamoDBDocumentClient;
let repo: DynamoScoreRepository;
let leaderboard: DynamoLeaderboardQuery;
let live = false;

/** Keys written during the run, deleted in afterAll to leave the table clean. */
const writtenKeys: Array<{ PK: string; SK: string }> = [];

/** Track a key for cleanup (idempotent puts still target a key we should remove). */
function trackKey(pk: string, sk: string): void {
  writtenKeys.push({ PK: pk, SK: sk });
}

/**
 * Seed a profile item so the leaderboard's public-display-name resolution has a
 * real name to return (R6.2). Returns the account id it created.
 */
async function seedAccount(displayName: string): Promise<string> {
  const accountId = `it-${randomToken()}`;
  const pk = accountPartitionKey(accountId);
  await client.send(
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
  return accountId;
}

/** Record the base-table keys a persisted Score + its personal best occupy. */
function trackScoreKeys(params: MazeParams, accountId: string, elapsedMs: number): void {
  const pk = accountPartitionKey(accountId);
  trackKey(pk, scoreSortKey(params, elapsedMs, accountId));
  trackKey(pk, personalBestSortKey(params));
}

beforeAll(async () => {
  client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  repo = new DynamoScoreRepository({ client, tableName: TABLE_NAME });
  leaderboard = new DynamoLeaderboardQuery({ client, tableName: TABLE_NAME });

  // A cheap DescribeTable decides reachability without writing anything. Any
  // failure (no creds, offline, no such table) flips the suite to skip.
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    live = true;
  } catch {
    live = false;
  }
});

afterAll(async () => {
  if (!live) {
    return;
  }
  // Best-effort cleanup: delete every key we wrote, ignoring already-gone keys.
  await Promise.all(
    writtenKeys.map((key) =>
      client
        .send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { [PARTITION_KEY]: key.PK, [SORT_KEY]: key.SK },
          }),
        )
        .catch(() => undefined),
    ),
  );
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe("persistence adapters ↔ real dev DynamoDB (task 6.5)", () => {
  it("round-trips a persisted Score through personalBest and listByAccount (R4.2, R5.1)", async ({
    skip,
  }) => {
    if (!live) {
      skip();
      return;
    }
    const params = freshScope();
    const accountId = await seedAccount(`Round Trip ${randomToken()}`);
    trackScoreKeys(params, accountId, 5_000);

    const result = await repo.putScore(accountId, score(params, 5_000));
    expect(result).toEqual({ persisted: true, isPersonalBest: true });

    // get: the personal best reads back as the same authoritative Score.
    await expect(repo.personalBest(accountId, params)).resolves.toEqual(
      score(params, 5_000),
    );

    // query: the account's own history contains exactly this Score.
    const page = await repo.listByAccount(accountId);
    expect(page.items).toContainEqual(score(params, 5_000));
  });

  it("keeps the strictly-faster time as the personal best via the conditional write (R4.5)", async ({
    skip,
  }) => {
    if (!live) {
      skip();
      return;
    }
    const params = freshScope();
    const accountId = await seedAccount(`Personal Best ${randomToken()}`);
    trackScoreKeys(params, accountId, 8_000);
    trackScoreKeys(params, accountId, 3_000);
    trackScoreKeys(params, accountId, 6_000);

    // First win sets the best.
    const first = await repo.putScore(accountId, score(params, 8_000));
    expect(first.isPersonalBest).toBe(true);

    // A strictly-faster win overtakes it — the conditional guard admits it.
    const faster = await repo.putScore(accountId, score(params, 3_000));
    expect(faster.isPersonalBest).toBe(true);
    await expect(repo.personalBest(accountId, params)).resolves.toEqual(
      score(params, 3_000),
    );

    // A slower later win is persisted but does NOT displace the best.
    const slower = await repo.putScore(accountId, score(params, 6_000));
    expect(slower).toEqual({ persisted: true, isPersonalBest: false });
    await expect(repo.personalBest(accountId, params)).resolves.toEqual(
      score(params, 3_000),
    );
  });

  it("treats a duplicate submission as an idempotent no-op (R7.4)", async ({ skip }) => {
    if (!live) {
      skip();
      return;
    }
    const params = freshScope();
    const accountId = await seedAccount(`Idempotent ${randomToken()}`);
    trackScoreKeys(params, accountId, 4_200);

    // Same account, same scope, same authoritative time => same item key.
    const first = await repo.putScore(accountId, score(params, 4_200));
    expect(first.persisted).toBe(true);

    const duplicate = await repo.putScore(accountId, score(params, 4_200));
    expect(duplicate).toEqual({ persisted: false, isPersonalBest: false });

    // Exactly one Score exists for the account despite two submits.
    const page = await repo.listByAccount(accountId);
    const matching = page.items.filter((s) => s.elapsedMs === 4_200);
    expect(matching).toHaveLength(1);
  });

  it("returns leaderboard standings fastest-first from the GSI ascending Query (R6.1)", async ({
    skip,
  }) => {
    if (!live) {
      skip();
      return;
    }
    // Three accounts race in this test's isolated scope, submitted out of order.
    const params = freshScope();
    const slow = await seedAccount("Slowpoke");
    const fast = await seedAccount("Speedy");
    const mid = await seedAccount("Middler");
    trackScoreKeys(params, slow, 9_000);
    trackScoreKeys(params, fast, 1_000);
    trackScoreKeys(params, mid, 5_000);

    await repo.putScore(slow, score(params, 9_000));
    await repo.putScore(fast, score(params, 1_000));
    await repo.putScore(mid, score(params, 5_000));

    const top = await leaderboard.topN(params, 3);

    // Ascending-time ordering: fastest first, ranks 1..3, public names resolved.
    expect(top.map((s) => s.timeMs)).toEqual([1_000, 5_000, 9_000]);
    expect(top.map((s) => s.rank)).toEqual([1, 2, 3]);
    expect(top.map((s) => s.displayName)).toEqual(["Speedy", "Middler", "Slowpoke"]);

    // ownRank agrees with the standings (better-time count, R6.3).
    await expect(leaderboard.ownRank(params, fast)).resolves.toEqual({
      ranked: true,
      rank: 1,
    });
    await expect(leaderboard.ownRank(params, slow)).resolves.toEqual({
      ranked: true,
      rank: 3,
    });
  });
});
