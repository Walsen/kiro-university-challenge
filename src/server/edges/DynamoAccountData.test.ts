/**
 * Unit tests for {@link DynamoAccountData} (task 11.2, R11.5) against a faithful
 * in-memory DynamoDB fake.
 *
 * These tests never touch AWS. The fake is a single-item store keyed by
 * `(PK, SK)` that understands exactly the two command shapes the adapter issues
 * to erase an account — a partition `Query` (with pagination) and a
 * `BatchWriteItem` of `DeleteRequest`s. That lets us assert the adapter's
 * *behavior* — that it removes every app-owned item under the account, and only
 * that account's items — without a network. The real dev-table behaviour is a
 * seam-integration concern.
 *
 * What is pinned here maps directly to the stated data policy for R11.5:
 *  - the account's **profile** (personal data / display name), every **Score**
 *    (private history), and every **personal best** under `ACCT#<accountId>` are
 *    deleted;
 *  - deleting a Score item removes its leaderboard **GSI projection** with it
 *    (the projection lives on the same item), so a deleted Player's identity is
 *    not retained on the public leaderboard;
 *  - **another account's data is never touched** (per-account isolation, R11.2);
 *  - deletion is **idempotent** — a repeated request finds nothing and reports
 *    zero, never an error.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DynamoAccountData } from "./DynamoAccountData";
import {
  GSI1_PARTITION_KEY,
  GSI1_SORT_KEY,
  PARTITION_KEY,
  PROFILE_SORT_KEY,
  SORT_KEY,
  accountPartitionKey,
  leaderboardPartitionKey,
  leaderboardSortKey,
  personalBestSortKey,
  scoreSortKey,
} from "./dynamoSchema";
import type { DynamoCommand, DynamoDocumentClient } from "./dynamoClient";
import type { MazeParams } from "../../core/validateSubmission";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TABLE = "maze-game-platform-test";
const PARAMS: MazeParams = { rows: 5, columns: 5, seed: 42, timeLimitSeconds: 60 };

type Item = Record<string, unknown>;

/** A profile item for an account (its personal data). */
function profileItem(accountId: string, displayName: string): Item {
  return {
    [PARTITION_KEY]: accountPartitionKey(accountId),
    [SORT_KEY]: PROFILE_SORT_KEY,
    displayName,
  };
}

/** A Score item carrying its leaderboard GSI attributes on the same item. */
function scoreItem(accountId: string, elapsedMs: number): Item {
  return {
    [PARTITION_KEY]: accountPartitionKey(accountId),
    [SORT_KEY]: scoreSortKey(PARAMS, elapsedMs, accountId),
    [GSI1_PARTITION_KEY]: leaderboardPartitionKey(PARAMS),
    [GSI1_SORT_KEY]: leaderboardSortKey(elapsedMs, accountId),
    accountId,
    elapsedMs,
  };
}

/** A personal-best item for an account. */
function bestItem(accountId: string, elapsedMs: number): Item {
  return {
    [PARTITION_KEY]: accountPartitionKey(accountId),
    [SORT_KEY]: personalBestSortKey(PARAMS),
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// A faithful in-memory DynamoDB modelling Query (paginated) + BatchWrite delete
// ---------------------------------------------------------------------------

/**
 * An in-memory single table keyed by `(PK, SK)` that understands exactly the
 * commands {@link DynamoAccountData} issues:
 *
 *  - `QueryCommand` on `#pk = :pk` — return every item under the requested
 *    partition. To exercise the adapter's pagination, the query returns at most
 *    {@link pageSize} items per call and a `LastEvaluatedKey` when more remain.
 *  - `BatchWriteCommand` with `DeleteRequest`s — remove each item at its
 *    `(PK, SK)` key.
 *
 * It enforces isolation structurally: a query is filtered to the requested
 * partition, so there is no path by which one account's deletion reads or
 * removes another account's items.
 */
class InMemoryDynamo implements DynamoDocumentClient {
  private readonly items = new Map<string, Item>();
  public batchWriteCount = 0;

  public constructor(private readonly pageSize = Number.POSITIVE_INFINITY) {}

  private static keyOf(pk: unknown, sk: unknown): string {
    return `${String(pk)}\u0000${String(sk)}`;
  }

  public seed(...items: Item[]): void {
    for (const item of items) {
      this.items.set(InMemoryDynamo.keyOf(item[PARTITION_KEY], item[SORT_KEY]), {
        ...item,
      });
    }
  }

  public async send(command: DynamoCommand): Promise<unknown> {
    const type = command.constructor.name;
    const input = command.input as Record<string, unknown>;
    await Promise.resolve();
    switch (type) {
      case "QueryCommand":
        return this.query(input);
      case "BatchWriteCommand":
        return this.batchWrite(input);
      default:
        throw new Error(`unexpected command ${type}`);
    }
  }

  private query(input: Record<string, unknown>): unknown {
    const values = input["ExpressionAttributeValues"] as Record<string, unknown>;
    const pk = values[":pk"];
    const all = [...this.items.values()]
      .filter((item) => item[PARTITION_KEY] === pk)
      .sort((a, b) => String(a[SORT_KEY]).localeCompare(String(b[SORT_KEY]))); // stable order for paging

    const start = input["ExclusiveStartKey"] as Item | undefined;
    const from =
      start === undefined
        ? 0
        : all.findIndex((item) => item[SORT_KEY] === start[SORT_KEY]) + 1;
    const slice = all.slice(from, from + this.pageSize);
    const last = slice[slice.length - 1];
    const more = from + slice.length < all.length;

    // Project only the key attributes (the adapter asks for #pk, #sk).
    const items = slice.map((item) => ({
      [PARTITION_KEY]: item[PARTITION_KEY],
      [SORT_KEY]: item[SORT_KEY],
    }));
    return more && last !== undefined
      ? {
          Items: items,
          LastEvaluatedKey: {
            [PARTITION_KEY]: last[PARTITION_KEY],
            [SORT_KEY]: last[SORT_KEY],
          },
        }
      : { Items: items };
  }

  private batchWrite(input: Record<string, unknown>): unknown {
    this.batchWriteCount += 1;
    const requestItems = input["RequestItems"] as Record<
      string,
      Array<{ DeleteRequest?: { Key: Item } }>
    >;
    for (const requests of Object.values(requestItems)) {
      expect(requests.length).toBeLessThanOrEqual(25); // DynamoDB batch cap
      for (const request of requests) {
        const key = request.DeleteRequest?.Key;
        if (key !== undefined) {
          this.items.delete(InMemoryDynamo.keyOf(key[PARTITION_KEY], key[SORT_KEY]));
        }
      }
    }
    return {};
  }

  // -- test-only observation helpers --

  public itemsUnder(pk: string): Item[] {
    return [...this.items.values()].filter((item) => item[PARTITION_KEY] === pk);
  }

  public size(): number {
    return this.items.size;
  }
}

function accountData(client: DynamoDocumentClient): DynamoAccountData {
  return new DynamoAccountData({ client, tableName: TABLE });
}

// ---------------------------------------------------------------------------
// deleteAccount
// ---------------------------------------------------------------------------

describe("DynamoAccountData.deleteAccount (R11.5)", () => {
  let store: InMemoryDynamo;

  beforeEach(() => {
    store = new InMemoryDynamo();
  });

  it("deletes the account's profile, scores, and personal bests (R11.5)", async () => {
    store.seed(
      profileItem("acct-a", "Ada"),
      scoreItem("acct-a", 5_000),
      scoreItem("acct-a", 3_000),
      bestItem("acct-a", 3_000),
    );

    const result = await accountData(store).deleteAccount("acct-a");

    expect(result.itemsDeleted).toBe(4);
    expect(store.itemsUnder(accountPartitionKey("acct-a"))).toHaveLength(0);
  });

  it("removes the leaderboard GSI projection with the Score item (R11.5)", async () => {
    // The GSI attributes live on the same item as the Score; deleting the item
    // removes its leaderboard entry, so the deleted player's identity is not
    // retained on the public leaderboard.
    store.seed(profileItem("acct-a", "Ada"), scoreItem("acct-a", 5_000));

    await accountData(store).deleteAccount("acct-a");

    const remaining = store
      .itemsUnder(accountPartitionKey("acct-a"))
      .filter((item) => item[GSI1_PARTITION_KEY] !== undefined);
    expect(remaining).toHaveLength(0);
  });

  it("never touches another account's data (per-account isolation, R11.2)", async () => {
    store.seed(
      profileItem("acct-a", "Ada"),
      scoreItem("acct-a", 5_000),
      profileItem("acct-b", "Bo"),
      scoreItem("acct-b", 4_000),
      bestItem("acct-b", 4_000),
    );

    await accountData(store).deleteAccount("acct-a");

    // Account A is gone; account B is untouched.
    expect(store.itemsUnder(accountPartitionKey("acct-a"))).toHaveLength(0);
    expect(store.itemsUnder(accountPartitionKey("acct-b"))).toHaveLength(3);
  });

  it("is idempotent: deleting an account with nothing left reports zero (R11.5)", async () => {
    // No items seeded for this account.
    const result = await accountData(store).deleteAccount("ghost");

    expect(result.itemsDeleted).toBe(0);
    // Nothing to delete, so no batch-write is issued.
    expect(store.batchWriteCount).toBe(0);
  });

  it("follows query pagination so a large history is fully erased (R11.5)", async () => {
    const paged = new InMemoryDynamo(10); // 10 items per query page
    const scores = Array.from({ length: 60 }, (_, i) => scoreItem("acct-a", i + 1));
    paged.seed(profileItem("acct-a", "Ada"), ...scores);
    const total = paged.size();

    const result = await accountData(paged).deleteAccount("acct-a");

    expect(result.itemsDeleted).toBe(total); // profile + 60 scores
    expect(paged.itemsUnder(accountPartitionKey("acct-a"))).toHaveLength(0);
    // 61 items in batches of 25 => at least 3 BatchWrite calls.
    expect(paged.batchWriteCount).toBeGreaterThanOrEqual(3);
  });
});
