/**
 * Unit tests for {@link DynamoLeaderboardQuery} (task 6.4) against a faked
 * DynamoDB DocumentClient.
 *
 * No AWS access: a hand fake for the `send` seam records the commands and
 * returns canned `Query`/`BatchGet` results, so we assert *how the adapter
 * reads* — a bounded ascending GSI query for the top segment, a better-time
 * count for own-rank — without a network. Real dev-table reads are task 6.5.
 *
 * Acceptance criteria under test:
 *  - R6.1 — top-N is an ascending GSI `Query` (fastest first), rank by position.
 *  - R6.4 — the top segment is bounded by `limit` (a `Limit` on the query).
 *  - R6.2 — each standing carries a public display name, resolved from the
 *    account's profile, never the private identifier.
 *  - R6.3 — own-rank reuses the pure `computeOwnRank` rule (one plus the number
 *    of strictly-better times), and an account with no entry is unranked.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DynamoLeaderboardQuery } from "./DynamoLeaderboardQuery";
import {
  GSI1_PARTITION_KEY,
  GSI1_SORT_KEY,
  LEADERBOARD_INDEX_NAME,
  accountPartitionKey,
  leaderboardPartitionKey,
  leaderboardSortKey,
} from "./dynamoSchema";
import type { DynamoCommand, DynamoDocumentClient } from "./dynamoClient";
import type { MazeParams } from "../../core/validateSubmission";

const TABLE = "maze-game-platform-test";
const PARAMS: MazeParams = { rows: 5, columns: 5, seed: 42, timeLimitSeconds: 60 };

/** A GSI item as the adapter would read it back for a leaderboard entry. */
function gsiEntry(accountId: string, timeMs: number): Record<string, unknown> {
  return {
    [GSI1_PARTITION_KEY]: leaderboardPartitionKey(PARAMS),
    [GSI1_SORT_KEY]: leaderboardSortKey(timeMs, accountId),
    accountId,
    elapsedMs: timeMs,
  };
}

type Responder = (command: DynamoCommand) => unknown;

class FakeDocumentClient implements DynamoDocumentClient {
  public readonly sent: DynamoCommand[] = [];
  private responder: Responder = () => ({});

  public respondWith(responder: Responder): void {
    this.responder = responder;
  }

  public send(command: DynamoCommand): Promise<unknown> {
    this.sent.push(command);
    return Promise.resolve(this.responder(command));
  }

  public commandsOfType(type: string): DynamoCommand[] {
    return this.sent.filter((c) => c.constructor.name === type);
  }
}

/**
 * A responder that answers the top-N `Query` with `entries` (in the order given)
 * and any profile `BatchGet` with the supplied display names. Profiles absent
 * from `names` are simply not returned, exercising the missing-profile fallback.
 */
function leaderboardResponder(
  entries: ReadonlyArray<{ accountId: string; timeMs: number }>,
  names: Record<string, string> = {},
): Responder {
  return (command) => {
    const type = command.constructor.name;
    if (type === "QueryCommand") {
      return { Items: entries.map((e) => gsiEntry(e.accountId, e.timeMs)) };
    }
    if (type === "BatchGetCommand") {
      const input = command.input as {
        RequestItems: Record<string, { Keys: ReadonlyArray<Record<string, unknown>> }>;
      };
      const request = input.RequestItems[TABLE];
      const responses = (request?.Keys ?? [])
        .map((key): Record<string, unknown> | null => {
          const accountId = String(key["PK"]).replace("ACCT#", "");
          const displayName = names[accountId];
          return displayName === undefined
            ? null
            : { PK: key["PK"], SK: "PROFILE", accountId, displayName };
        })
        .filter((item): item is Record<string, unknown> => item !== null);
      return { Responses: { [TABLE]: responses } };
    }
    return {};
  };
}

function query(client: DynamoDocumentClient): DynamoLeaderboardQuery {
  return new DynamoLeaderboardQuery({ client, tableName: TABLE });
}

// ---------------------------------------------------------------------------
// topN
// ---------------------------------------------------------------------------

describe("DynamoLeaderboardQuery.topN", () => {
  let client: FakeDocumentClient;

  beforeEach(() => {
    client = new FakeDocumentClient();
  });

  it("issues an ascending, bounded Query against the leaderboard index (R6.1, R6.4)", async () => {
    client.respondWith(
      leaderboardResponder([{ accountId: "acct-b", timeMs: 1_000 }], { "acct-b": "Bo" }),
    );

    await query(client).topN(PARAMS, 10);

    const q = client.commandsOfType("QueryCommand")[0];
    const input = q?.input as {
      IndexName?: string;
      ScanIndexForward?: boolean;
      Limit?: number;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.IndexName).toBe(LEADERBOARD_INDEX_NAME);
    expect(input.ScanIndexForward).toBe(true); // fastest first
    expect(input.Limit).toBe(10); // bounded by N
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toContain(
      leaderboardPartitionKey(PARAMS),
    );
  });

  it("maps entries to standings ranked 1..N ascending by time (R6.1)", async () => {
    client.respondWith(
      leaderboardResponder(
        [
          { accountId: "acct-b", timeMs: 1_000 },
          { accountId: "acct-c", timeMs: 2_000 },
          { accountId: "acct-a", timeMs: 3_000 },
        ],
        { "acct-b": "Bo", "acct-c": "Cy", "acct-a": "Ada" },
      ),
    );

    const standings = await query(client).topN(PARAMS, 3);

    expect(standings).toEqual([
      { rank: 1, displayName: "Bo", timeMs: 1_000, accountId: "acct-b" },
      { rank: 2, displayName: "Cy", timeMs: 2_000, accountId: "acct-c" },
      { rank: 3, displayName: "Ada", timeMs: 3_000, accountId: "acct-a" },
    ]);
  });

  it("resolves the public display name from the account profile (R6.2)", async () => {
    client.respondWith(
      leaderboardResponder([{ accountId: "acct-a", timeMs: 3_000 }], { "acct-a": "Ada" }),
    );

    const [top] = await query(client).topN(PARAMS, 1);

    expect(top?.displayName).toBe("Ada");
    // The profile lookup keys the account partition, not any identifier column.
    const batch = client.commandsOfType("BatchGetCommand")[0];
    const input = batch?.input as {
      RequestItems: Record<string, { Keys: ReadonlyArray<Record<string, unknown>> }>;
    };
    const keys = input.RequestItems[TABLE]?.Keys ?? [];
    expect(keys[0]?.["PK"]).toBe(accountPartitionKey("acct-a"));
  });

  it("falls back to a neutral name (never the identifier) when a profile is missing (R6.2, R11.3)", async () => {
    // No name supplied for acct-a, so the profile BatchGet returns nothing for it.
    client.respondWith(leaderboardResponder([{ accountId: "acct-a", timeMs: 3_000 }]));

    const [top] = await query(client).topN(PARAMS, 1);

    expect(top?.displayName).toBeTruthy();
    expect(top?.displayName).not.toBe("acct-a"); // identifier never leaks
  });

  it("returns an empty leaderboard without a profile lookup when there are no entries", async () => {
    client.respondWith(leaderboardResponder([]));

    const standings = await query(client).topN(PARAMS, 10);

    expect(standings).toEqual([]);
    expect(client.commandsOfType("BatchGetCommand")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ownRank
// ---------------------------------------------------------------------------

describe("DynamoLeaderboardQuery.ownRank", () => {
  let client: FakeDocumentClient;

  beforeEach(() => {
    client = new FakeDocumentClient();
  });

  it("ranks the account one plus the number of strictly-better times (R6.3)", async () => {
    // Two accounts are faster than acct-a's 3_000, so it ranks 3rd.
    client.respondWith((command) => {
      if (command.constructor.name === "QueryCommand") {
        return {
          Items: [
            gsiEntry("acct-b", 1_000),
            gsiEntry("acct-c", 2_000),
            gsiEntry("acct-a", 3_000),
          ],
        };
      }
      return {};
    });

    await expect(query(client).ownRank(PARAMS, "acct-a")).resolves.toEqual({
      ranked: true,
      rank: 3,
    });
  });

  it("shares a rank across tied times, counting only strictly-better ones (R6.3)", async () => {
    client.respondWith((command) => {
      if (command.constructor.name === "QueryCommand") {
        return {
          Items: [
            gsiEntry("acct-b", 1_000),
            gsiEntry("acct-c", 2_000),
            gsiEntry("acct-a", 2_000),
          ],
        };
      }
      return {};
    });

    // One strictly-better time (1_000) => rank 2, shared with the tie at 2_000.
    await expect(query(client).ownRank(PARAMS, "acct-a")).resolves.toEqual({
      ranked: true,
      rank: 2,
    });
  });

  it("reports an account with no entry as unranked (R6.3)", async () => {
    client.respondWith((command) => {
      if (command.constructor.name === "QueryCommand") {
        return { Items: [gsiEntry("acct-b", 1_000)] };
      }
      return {};
    });

    await expect(query(client).ownRank(PARAMS, "nobody")).resolves.toEqual({
      ranked: false,
    });
  });

  it("queries the leaderboard partition for the params scope (R6.3)", async () => {
    client.respondWith((command) => {
      if (command.constructor.name === "QueryCommand") {
        return { Items: [gsiEntry("acct-a", 1_000)] };
      }
      return {};
    });

    await query(client).ownRank(PARAMS, "acct-a");

    const q = client.commandsOfType("QueryCommand")[0];
    const input = q?.input as {
      IndexName?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.IndexName).toBe(LEADERBOARD_INDEX_NAME);
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toContain(
      leaderboardPartitionKey(PARAMS),
    );
  });
});
