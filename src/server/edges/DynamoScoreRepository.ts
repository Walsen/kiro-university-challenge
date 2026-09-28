/**
 * `DynamoScoreRepository` — the {@link ScoreRepository} adapter over DynamoDB
 * (task 6.3, R4.2, R4.5, R6.5, R7.4).
 *
 * This is the only score-persistence module that touches the AWS SDK. It
 * translates the provider-agnostic port operations into single-table reads and
 * writes against the schema defined in `infra/data-store.ts` (mirrored in
 * {@link ./dynamoSchema}), and translates DynamoDB's conditional-check outcomes
 * back into the port's `PutScoreResult`. The rest of the server depends only on
 * the port (Dependency Inversion); swapping the store is a new adapter, not a
 * caller change.
 *
 * ## putScore — three properties, in one pass
 *
 * **Idempotent (R7.4).** The Score item's sort key is a deterministic function
 * of `(params, authoritative time, accountId)` — see {@link scoreSortKey}. A
 * retried or concurrent duplicate of the *same* validated Run therefore targets
 * the identical item, and the put carries an `attribute_not_exists` condition:
 * the first write wins, a duplicate fails the condition and is reported as a
 * no-op (`persisted: false`) rather than creating a second Score. No separate
 * idempotency-key attribute is needed because the key derived from the
 * validated Score *is* the dedupe key.
 *
 * **Fresh leaderboard (R6.5).** The Score item itself carries the leaderboard
 * GSI attributes (`GSI1PK`/`GSI1SK`), so persisting a Score and publishing its
 * leaderboard entry are the *same* write. A qualifying Score is visible to a
 * subsequent leaderboard `Query` as soon as the GSI propagates — no second
 * write, no separate pipeline.
 *
 * **Personal best (R4.5).** A second, conditional `Update` maintains the
 * `BEST#<params>` item, succeeding only when there is no prior best or the new
 * time is strictly lower. Its success is exactly "this Score is a new personal
 * best", which the result reports. It runs only after the Score is newly
 * persisted, so a deduped submission never disturbs the best.
 *
 * Failure handling: a `ConditionalCheckFailedException` is an *expected* control
 * signal (duplicate, or not-a-best), narrowed to a boolean; any other error is
 * an infrastructure fault and propagates unchanged.
 *
 * _Requirements: R4.2, R4.5, R5.1, R5.2, R5.3, R6.5, R7.4._
 */
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { DynamoDocumentClient } from "./dynamoClient";
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
import type {
  Page,
  PageToken,
  PutScoreResult,
  ScoreRepository,
} from "../ports/ScoreRepository";
import type { MazeParams, Score } from "../../core/validateSubmission";

/** The DynamoDB error `name` raised when a conditional write's guard is not met. */
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

/** Default page size for the account history read (R5.1). */
const DEFAULT_HISTORY_PAGE_SIZE = 50;

/** Sort-key prefix identifying a Score item within an account's partition. */
const SCORE_SK_PREFIX = "SCORE#";

/** Construction dependencies (Dependency Injection). */
export interface DynamoScoreRepositoryConfig {
  /** The DynamoDB DocumentClient seam; a fake in tests, the real client in prod. */
  readonly client: DynamoDocumentClient;
  /** The single table's name (from the CDK stack output, injected at the root). */
  readonly tableName: string;
  /** Page size for `listByAccount`; defaults to {@link DEFAULT_HISTORY_PAGE_SIZE}. */
  readonly historyPageSize?: number;
}

/**
 * The persisted attributes of a Score item. The domain `Score` is flattened onto
 * named attributes (rather than a nested map) so the same attributes project
 * cleanly onto the leaderboard GSI and read back without a nested decode.
 */
interface ScoreItemAttributes {
  readonly accountId: string;
  readonly elapsedMs: number;
  readonly rows: number;
  readonly columns: number;
  readonly seed: number;
  readonly timeLimitSeconds: number;
}

export class DynamoScoreRepository implements ScoreRepository {
  private readonly client: DynamoDocumentClient;
  private readonly tableName: string;
  private readonly historyPageSize: number;

  public constructor(config: DynamoScoreRepositoryConfig) {
    this.client = config.client;
    this.tableName = config.tableName;
    this.historyPageSize = config.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
  }

  public async putScore(accountId: string, score: Score): Promise<PutScoreResult> {
    const persisted = await this.writeScoreItem(accountId, score);
    if (!persisted) {
      // A duplicate of an already-recorded Run: no new Score, and it cannot be a
      // new best (the earlier identical write already accounted for it) (R7.4).
      return { persisted: false, isPersonalBest: false };
    }

    const isPersonalBest = await this.updatePersonalBest(accountId, score);
    return { persisted: true, isPersonalBest };
  }

  public async personalBest(
    accountId: string,
    params: MazeParams,
  ): Promise<Score | null> {
    const response = (await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          [PARTITION_KEY]: accountPartitionKey(accountId),
          [SORT_KEY]: personalBestSortKey(params),
        },
      }),
    )) as { Item?: Record<string, unknown> };

    if (response.Item === undefined) {
      return null;
    }
    return toScore(response.Item);
  }

  public async listByAccount(accountId: string, page?: PageToken): Promise<Page<Score>> {
    const response = (await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :scorePrefix)",
        ExpressionAttributeNames: { "#pk": PARTITION_KEY, "#sk": SORT_KEY },
        ExpressionAttributeValues: {
          ":pk": accountPartitionKey(accountId),
          ":scorePrefix": SCORE_SK_PREFIX,
        },
        Limit: this.historyPageSize,
        // Fastest-first within the account's history mirrors the leaderboard's
        // ascending-time ordering; the score sort key is time-ordered per scope.
        ScanIndexForward: true,
        ...decodePageToken(page),
      }),
    )) as {
      Items?: ReadonlyArray<Record<string, unknown>>;
      LastEvaluatedKey?: Record<string, unknown>;
    };

    const items = (response.Items ?? []).map(toScore);
    const nextPage = encodePageToken(response.LastEvaluatedKey);
    return nextPage === undefined ? { items } : { items, nextPage };
  }

  /**
   * Write the Score item (with its leaderboard GSI attributes) under an
   * `attribute_not_exists` guard. Returns `true` when newly written, `false`
   * when the guard failed because an identical Score already exists (R7.4).
   */
  private async writeScoreItem(accountId: string, score: Score): Promise<boolean> {
    const { mazeParams: params, elapsedMs } = score;
    const item: Record<string, unknown> = {
      [PARTITION_KEY]: accountPartitionKey(accountId),
      [SORT_KEY]: scoreSortKey(params, elapsedMs, accountId),
      // Same-item leaderboard entry so the score is leaderboard-visible at once (R6.5).
      [GSI1_PARTITION_KEY]: leaderboardPartitionKey(params),
      [GSI1_SORT_KEY]: leaderboardSortKey(elapsedMs, accountId),
      ...scoreAttributes(accountId, score),
    };

    return this.runConditional(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        // Idempotent: the deterministic key means a duplicate targets this same
        // item, and this guard turns that duplicate into a no-op (R7.4).
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": PARTITION_KEY },
      }),
    );
  }

  /**
   * Conditionally update the `BEST#<params>` item, winning only when there is no
   * prior best or the new time is strictly lower. A win means this Score is a
   * new personal best (R4.5).
   */
  private async updatePersonalBest(accountId: string, score: Score): Promise<boolean> {
    const { mazeParams: params, elapsedMs } = score;
    return this.runConditional(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          [PARTITION_KEY]: accountPartitionKey(accountId),
          [SORT_KEY]: personalBestSortKey(params),
        },
        UpdateExpression: "SET #best = :time, #attrs = :attrs",
        ConditionExpression: "attribute_not_exists(#best) OR :time < #best",
        ExpressionAttributeNames: { "#best": "elapsedMs", "#attrs": "params" },
        ExpressionAttributeValues: {
          ":time": elapsedMs,
          ":attrs": scoreAttributes(accountId, score),
        },
      }),
    );
  }

  /**
   * Send a conditional write, mapping the two outcomes to a boolean: `true` when
   * it applied, `false` when the condition was not met. Any other error is an
   * infrastructure fault and propagates — a failed condition is control flow,
   * not an error to swallow broadly.
   */
  private async runConditional(command: PutCommand | UpdateCommand): Promise<boolean> {
    try {
      await this.client.send(command);
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        return false;
      }
      throw error;
    }
  }
}

/** The flat attribute payload shared by the Score item and the best item. */
function scoreAttributes(accountId: string, score: Score): ScoreItemAttributes {
  const { mazeParams: params, elapsedMs } = score;
  return {
    accountId,
    elapsedMs,
    rows: params.rows,
    columns: params.columns,
    seed: params.seed,
    timeLimitSeconds: params.timeLimitSeconds,
  };
}

/**
 * Rebuild a domain `Score` from a stored item. For the personal-best item the
 * flattened params live under a `params` map; for a score/GSI item they live at
 * the top level. Read whichever is present so one decoder serves both shapes.
 */
function toScore(item: Record<string, unknown>): Score {
  const source = isRecord(item["params"]) ? item["params"] : item;
  return {
    outcome: "Won",
    elapsedMs: asNumber(item["elapsedMs"]),
    mazeParams: {
      rows: asNumber(source["rows"]),
      columns: asNumber(source["columns"]),
      seed: asNumber(source["seed"]),
      timeLimitSeconds: asNumber(source["timeLimitSeconds"]),
    },
  };
}

function isConditionalCheckFailure(error: unknown): boolean {
  return isRecord(error) && error["name"] === CONDITIONAL_CHECK_FAILED;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError(`expected a numeric attribute, received ${typeof value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Opaque page cursor <-> DynamoDB LastEvaluatedKey
// ---------------------------------------------------------------------------

/**
 * Encode a DynamoDB `LastEvaluatedKey` as the port's opaque {@link PageToken}, or
 * `undefined` when the page was the last. The provider key never leaves the
 * adapter as a plain object — the caller only ever round-trips this string.
 */
function encodePageToken(
  lastKey: Record<string, unknown> | undefined,
): PageToken | undefined {
  if (lastKey === undefined) {
    return undefined;
  }
  return JSON.stringify(lastKey) as PageToken;
}

/** Decode an opaque cursor back into an `ExclusiveStartKey`, or nothing at page one. */
function decodePageToken(page: PageToken | undefined): {
  ExclusiveStartKey?: Record<string, unknown>;
} {
  if (page === undefined) {
    return {};
  }
  return { ExclusiveStartKey: JSON.parse(page) as Record<string, unknown> };
}
