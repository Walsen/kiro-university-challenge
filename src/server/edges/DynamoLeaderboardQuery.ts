/**
 * `DynamoLeaderboardQuery` — the {@link LeaderboardQuery} adapter over DynamoDB
 * (task 6.4, R6.1, R6.3, R6.4).
 *
 * The ranked-read half of the persistence layer, kept separate from the
 * write-side `DynamoScoreRepository` (Interface Segregation) and behind the same
 * port that the documented Redis-sorted-set pivot would slot into. It reads the
 * leaderboard entries the score adapter projects onto `GSI1` and turns them into
 * public standings and ranks.
 *
 * ## topN — bounded ascending read (R6.1, R6.4)
 *
 * The fastest `limit` standings are a single `Query` on the leaderboard
 * partition (`GSI1PK = LB#<params>`) with `ScanIndexForward: true` and a `Limit`
 * of `limit`: because the GSI sort key zero-pads the time, ascending
 * lexicographic order *is* ascending-time order, so the query returns
 * fastest-first and reads no more than `limit` rows — the bounded top segment
 * the latency budget calls for.
 *
 * **Public display names (R6.2, R11.3).** A leaderboard is public and must show
 * a Player-chosen display name, never the private identifier. The GSI entry
 * carries only the account id and time, so the top-N account ids are resolved to
 * their `displayName` via a single bounded `BatchGet` of their profile items —
 * bounded by `limit`, so it stays within budget. A missing profile falls back to
 * a neutral placeholder rather than ever exposing the identifier.
 *
 * ## ownRank — better-time count (R6.3)
 *
 * An account's rank is one plus the number of accounts with a strictly better
 * time. The adapter reads the entries for the scope and delegates the counting
 * to the pure {@link computeOwnRank} rule, so the port and the core agree on
 * what a rank means (tied times share a rank; an account with no entry is
 * unranked) rather than the adapter re-deriving it.
 *
 * At small/medium scale this scan of a scope's entries is a bounded query; if
 * exact rank at large scale becomes a requirement, the D3 pivot replaces this
 * adapter with a Redis sorted-set rank behind the same port.
 *
 * _Requirements: R6.1, R6.2, R6.3, R6.4, R11.3._
 */
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import type { DynamoDocumentClient } from "./dynamoClient";
import {
  GSI1_PARTITION_KEY,
  LEADERBOARD_INDEX_NAME,
  PARTITION_KEY,
  PROFILE_SORT_KEY,
  SORT_KEY,
  accountPartitionKey,
  leaderboardPartitionKey,
} from "./dynamoSchema";
import type { LeaderboardQuery, LeaderboardStanding } from "../ports/ScoreRepository";
import {
  computeOwnRank,
  type LeaderboardEntry,
  type OwnRankResult,
} from "../../core/platform/leaderboard";
import type { MazeParams } from "../../core/validateSubmission";

/**
 * Shown when a standing's account has no profile display name. Never the private
 * identifier (R11.3); a neutral placeholder keeps the public leaderboard whole
 * without disclosing who the account is.
 */
const UNKNOWN_DISPLAY_NAME = "Unknown Player";

/**
 * A generous bound on how many entries `ownRank` scans for a scope. Own-rank is
 * a count of better times, so it only needs the scope's entries; this cap keeps
 * the read bounded while comfortably covering a scope's realistic size. If exact
 * rank beyond this scale is required, the D3 Redis pivot supersedes this path.
 */
const OWN_RANK_SCAN_LIMIT = 1000;

/** Construction dependencies (Dependency Injection). */
export interface DynamoLeaderboardQueryConfig {
  /** The DynamoDB DocumentClient seam; a fake in tests, the real client in prod. */
  readonly client: DynamoDocumentClient;
  /** The single table's name (from the CDK stack output, injected at the root). */
  readonly tableName: string;
}

/** A leaderboard entry as read back from the GSI, before display-name resolution. */
interface RankedEntry {
  readonly accountId: string;
  readonly timeMs: number;
}

export class DynamoLeaderboardQuery implements LeaderboardQuery {
  private readonly client: DynamoDocumentClient;
  private readonly tableName: string;

  public constructor(config: DynamoLeaderboardQueryConfig) {
    this.client = config.client;
    this.tableName = config.tableName;
  }

  public async topN(
    params: MazeParams,
    limit: number,
  ): Promise<ReadonlyArray<LeaderboardStanding>> {
    const entries = await this.queryEntries(params, limit);
    if (entries.length === 0) {
      return [];
    }

    const names = await this.resolveDisplayNames(entries.map((e) => e.accountId));
    return entries.map((entry, index) => ({
      rank: index + 1,
      displayName: names.get(entry.accountId) ?? UNKNOWN_DISPLAY_NAME,
      timeMs: entry.timeMs,
      accountId: entry.accountId,
    }));
  }

  public async ownRank(params: MazeParams, accountId: string): Promise<OwnRankResult> {
    const entries = await this.queryEntries(params, OWN_RANK_SCAN_LIMIT);
    const leaderboardEntries: ReadonlyArray<LeaderboardEntry> = entries.map((e) => ({
      accountId: e.accountId,
      timeMs: e.timeMs,
    }));
    // Reuse the pure ranking rule so the adapter cannot disagree with the core.
    return computeOwnRank(leaderboardEntries, accountId);
  }

  /**
   * Read up to `limit` entries for the scope from the leaderboard GSI in
   * ascending-time order (R6.1, R6.4).
   */
  private async queryEntries(
    params: MazeParams,
    limit: number,
  ): Promise<ReadonlyArray<RankedEntry>> {
    const response = (await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: LEADERBOARD_INDEX_NAME,
        KeyConditionExpression: "#gsipk = :scope",
        ExpressionAttributeNames: { "#gsipk": GSI1_PARTITION_KEY },
        ExpressionAttributeValues: { ":scope": leaderboardPartitionKey(params) },
        // Zero-padded time keys make ascending order fastest-first (R6.1).
        ScanIndexForward: true,
        Limit: limit,
      }),
    )) as { Items?: ReadonlyArray<Record<string, unknown>> };

    return (response.Items ?? []).map(toRankedEntry);
  }

  /**
   * Resolve account ids to public display names via one bounded `BatchGet` of
   * their profile items (R6.2). Deduplicates ids so an account appearing more
   * than once in the top segment is fetched once.
   */
  private async resolveDisplayNames(
    accountIds: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, string>> {
    const uniqueIds = [...new Set(accountIds)];
    const response = (await this.client.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            Keys: uniqueIds.map((accountId) => ({
              [PARTITION_KEY]: accountPartitionKey(accountId),
              [SORT_KEY]: PROFILE_SORT_KEY,
            })),
          },
        },
      }),
    )) as { Responses?: Record<string, ReadonlyArray<Record<string, unknown>>> };

    const profiles = response.Responses?.[this.tableName] ?? [];
    const names = new Map<string, string>();
    for (const profile of profiles) {
      const accountId = profile["accountId"];
      const displayName = profile["displayName"];
      if (typeof accountId === "string" && typeof displayName === "string") {
        names.set(accountId, displayName);
      }
    }
    return names;
  }
}

/** Narrow a GSI item to the account id and time own-rank/top-N need. */
function toRankedEntry(item: Record<string, unknown>): RankedEntry {
  const accountId = item["accountId"];
  const timeMs = item["elapsedMs"];
  if (typeof accountId !== "string") {
    throw new TypeError("leaderboard entry missing a string accountId");
  }
  if (typeof timeMs !== "number") {
    throw new TypeError("leaderboard entry missing a numeric elapsedMs");
  }
  return { accountId, timeMs };
}
