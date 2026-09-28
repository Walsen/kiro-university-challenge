/**
 * Unit tests for {@link DynamoScoreRepository} (task 6.3) against a faked
 * DynamoDB DocumentClient.
 *
 * These tests never touch AWS. They inject a hand fake for the `send`-shaped
 * {@link DynamoDocumentClient} seam that records the commands the adapter issues
 * and returns canned responses, so we can assert the adapter's *behavior* (what
 * it writes and how it reacts to a conditional-check failure) without a network.
 * The real dev-table integration is task 6.5.
 *
 * What is pinned here maps directly to the acceptance criteria the task cites:
 *  - R4.2 — a validated Score is persisted under the account partition.
 *  - R6.5 — the Score item carries the leaderboard GSI attributes, so the score
 *    and its leaderboard entry are written in one operation (freshness).
 *  - R7.4 — a duplicate submission (same account/scope/time) is a conditional
 *    put that fails the `attribute_not_exists` guard and resolves to a no-op
 *    (`persisted: false`), never a second Score.
 *  - R4.5 — the personal-best item is a conditional write that only wins when
 *    there is no prior best or the new time is strictly lower.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DynamoScoreRepository } from "./DynamoScoreRepository";
import {
  GSI1_PARTITION_KEY,
  GSI1_SORT_KEY,
  PARTITION_KEY,
  SORT_KEY,
  accountPartitionKey,
  leaderboardPartitionKey,
  leaderboardSortKey,
  personalBestSortKey,
  scoreSortKey,
} from "./dynamoSchema";
import type { DynamoCommand, DynamoDocumentClient } from "./dynamoClient";
import type { MazeParams, Score } from "../../core/validateSubmission";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TABLE = "maze-game-platform-test";
const PARAMS: MazeParams = { rows: 5, columns: 5, seed: 42, timeLimitSeconds: 60 };

function score(elapsedMs: number, params: MazeParams = PARAMS): Score {
  return { outcome: "Won", mazeParams: params, elapsedMs };
}

/** The DynamoDB SDK signals a failed condition with this error `name`. */
class ConditionalCheckFailed extends Error {
  public override readonly name = "ConditionalCheckFailedException";
}

// ---------------------------------------------------------------------------
// Fake DocumentClient seam
// ---------------------------------------------------------------------------

type Responder = (command: DynamoCommand) => unknown;

/**
 * Records every command sent and replies via a per-command-type responder. The
 * default responder succeeds; a test overrides it to simulate a conditional
 * failure or a canned `Query`/`Get` result.
 */
class FakeDocumentClient implements DynamoDocumentClient {
  public readonly sent: DynamoCommand[] = [];
  private responder: Responder = () => ({});

  public respondWith(responder: Responder): void {
    this.responder = responder;
  }

  public async send(command: DynamoCommand): Promise<unknown> {
    this.sent.push(command);
    // Await a resolved promise so a responder that throws surfaces as a rejected
    // promise (as the real client would) rather than a synchronous throw.
    await Promise.resolve();
    return this.responder(command);
  }

  public commandsOfType(type: string): DynamoCommand[] {
    return this.sent.filter((c) => c.constructor.name === type);
  }
}

function repo(client: DynamoDocumentClient): DynamoScoreRepository {
  return new DynamoScoreRepository({ client, tableName: TABLE });
}

// ---------------------------------------------------------------------------
// putScore
// ---------------------------------------------------------------------------

describe("DynamoScoreRepository.putScore", () => {
  let client: FakeDocumentClient;

  beforeEach(() => {
    client = new FakeDocumentClient();
  });

  it("writes the Score under the account partition with the score sort key (R4.2)", async () => {
    await repo(client).putScore("acct-a", score(5_000));

    const put = client.commandsOfType("PutCommand")[0];
    expect(put).toBeDefined();
    const item = (put?.input as { Item: Record<string, unknown> }).Item;
    expect(item[PARTITION_KEY]).toBe(accountPartitionKey("acct-a"));
    expect(item[SORT_KEY]).toBe(scoreSortKey(PARAMS, 5_000, "acct-a"));
    // The domain facts are persisted (R4.1: at least time + params).
    expect(item["elapsedMs"]).toBe(5_000);
    expect(item["accountId"]).toBe("acct-a");
  });

  it("carries the leaderboard GSI attributes on the same item for freshness (R6.5)", async () => {
    await repo(client).putScore("acct-a", score(5_000));

    const put = client.commandsOfType("PutCommand")[0];
    const item = (put?.input as { Item: Record<string, unknown> }).Item;
    // Score + leaderboard entry are one write, so a qualifying score appears in
    // subsequent leaderboard reads immediately.
    expect(item[GSI1_PARTITION_KEY]).toBe(leaderboardPartitionKey(PARAMS));
    expect(item[GSI1_SORT_KEY]).toBe(leaderboardSortKey(5_000, "acct-a"));
  });

  it("guards the Score put with a not-exists condition so it is idempotent (R7.4)", async () => {
    await repo(client).putScore("acct-a", score(5_000));

    const put = client.commandsOfType("PutCommand")[0];
    const input = put?.input as { ConditionExpression?: string };
    expect(input.ConditionExpression).toMatch(/attribute_not_exists/);
  });

  it("treats a duplicate score (conditional failure) as a no-op, persisting nothing new (R7.4)", async () => {
    client.respondWith((command) => {
      if (command.constructor.name === "PutCommand") {
        throw new ConditionalCheckFailed("duplicate");
      }
      return {};
    });

    const result = await repo(client).putScore("acct-a", score(5_000));

    expect(result.persisted).toBe(false);
    // A deduped submission never claims a personal best.
    expect(result.isPersonalBest).toBe(false);
  });

  it("reports persisted:true and a new personal best when both conditional writes win (R4.2, R4.5)", async () => {
    const result = await repo(client).putScore("acct-a", score(5_000));

    expect(result).toEqual({ persisted: true, isPersonalBest: true });
  });

  it("updates the personal-best item with a strictly-lower condition (R4.5)", async () => {
    await repo(client).putScore("acct-a", score(5_000));

    const update = client.commandsOfType("UpdateCommand")[0];
    expect(update).toBeDefined();
    const input = update?.input as {
      Key: Record<string, unknown>;
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.Key[PARTITION_KEY]).toBe(accountPartitionKey("acct-a"));
    expect(input.Key[SORT_KEY]).toBe(personalBestSortKey(PARAMS));
    // Only overwrite when there is no prior best or the new time is lower.
    expect(input.ConditionExpression).toMatch(/attribute_not_exists|<[ ]?:/);
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toContain(5_000);
  });

  it("reports isPersonalBest:false when the best-write condition fails but the score is new (R4.5)", async () => {
    client.respondWith((command) => {
      if (command.constructor.name === "UpdateCommand") {
        throw new ConditionalCheckFailed("slower than existing best");
      }
      return {};
    });

    const result = await repo(client).putScore("acct-a", score(9_000));

    // The Score itself persisted; it just was not a new best.
    expect(result).toEqual({ persisted: true, isPersonalBest: false });
  });

  it("does not attempt the personal-best write when the score was a duplicate (R7.4)", async () => {
    client.respondWith((command) => {
      if (command.constructor.name === "PutCommand") {
        throw new ConditionalCheckFailed("duplicate");
      }
      return {};
    });

    await repo(client).putScore("acct-a", score(5_000));

    expect(client.commandsOfType("UpdateCommand")).toHaveLength(0);
  });

  it("rethrows an unexpected error rather than swallowing it as a no-op", async () => {
    client.respondWith(() => {
      throw new Error("throttled");
    });

    await expect(repo(client).putScore("acct-a", score(5_000))).rejects.toThrow(
      "throttled",
    );
  });
});

// ---------------------------------------------------------------------------
// personalBest
// ---------------------------------------------------------------------------

describe("DynamoScoreRepository.personalBest", () => {
  it("returns the stored best Score for the account and params (R5.2)", async () => {
    const client = new FakeDocumentClient();
    client.respondWith((command) => {
      if (command.constructor.name === "GetCommand") {
        return {
          Item: {
            [PARTITION_KEY]: accountPartitionKey("acct-a"),
            [SORT_KEY]: personalBestSortKey(PARAMS),
            accountId: "acct-a",
            elapsedMs: 2_500,
            rows: PARAMS.rows,
            columns: PARAMS.columns,
            seed: PARAMS.seed,
            timeLimitSeconds: PARAMS.timeLimitSeconds,
          },
        };
      }
      return {};
    });

    const best = await repo(client).personalBest("acct-a", PARAMS);

    expect(best).toEqual(score(2_500));
  });

  it("returns null when the account has no best for the params (R5.2)", async () => {
    const client = new FakeDocumentClient();
    client.respondWith(() => ({})); // no Item

    await expect(repo(client).personalBest("acct-a", PARAMS)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listByAccount
// ---------------------------------------------------------------------------

describe("DynamoScoreRepository.listByAccount", () => {
  it("queries only the account's own score items and maps them to Scores (R5.1, R5.3)", async () => {
    const client = new FakeDocumentClient();
    client.respondWith((command) => {
      if (command.constructor.name === "QueryCommand") {
        return {
          Items: [
            {
              accountId: "acct-a",
              elapsedMs: 1_000,
              rows: PARAMS.rows,
              columns: PARAMS.columns,
              seed: PARAMS.seed,
              timeLimitSeconds: PARAMS.timeLimitSeconds,
            },
          ],
        };
      }
      return {};
    });

    const page = await repo(client).listByAccount("acct-a");

    const query = client.commandsOfType("QueryCommand")[0];
    const input = query?.input as { ExpressionAttributeValues?: Record<string, unknown> };
    expect(Object.values(input.ExpressionAttributeValues ?? {})).toContain(
      accountPartitionKey("acct-a"),
    );
    expect(page.items).toEqual([score(1_000)]);
    expect(page.nextPage).toBeUndefined();
  });

  it("surfaces an opaque next-page cursor when DynamoDB returns a LastEvaluatedKey (R5.1)", async () => {
    const client = new FakeDocumentClient();
    client.respondWith((command) => {
      if (command.constructor.name === "QueryCommand") {
        return {
          Items: [],
          LastEvaluatedKey: {
            [PARTITION_KEY]: accountPartitionKey("acct-a"),
            [SORT_KEY]: "x",
          },
        };
      }
      return {};
    });

    const page = await repo(client).listByAccount("acct-a");

    expect(page.nextPage).toBeDefined();
  });
});
