/**
 * Server-side view of the DynamoDB single-table key scheme (tasks 6.3/6.4).
 *
 * These constants and encoders mirror the item shapes the CDK table defines in
 * `infra/data-store.ts` (design "Data model (DynamoDB single-table)"). They are
 * duplicated here deliberately rather than imported: `infra/` is a separate
 * package that pulls in `aws-cdk-lib`, and the server edges layer must not
 * depend on CDK. Keeping a small, well-documented copy on the server side keeps
 * the dependency graph clean while a single seam-integration test (task 6.5)
 * against the real dev table guards that the two definitions agree.
 *
 * The attribute names below MUST stay in lockstep with `infra/data-store.ts`:
 *   PK / SK / GSI1PK / GSI1SK and the leaderboard index name.
 *
 * The encoders concentrate every string-key format in one place so the two
 * adapters share exactly one definition of "how a Score is keyed" and "how a
 * leaderboard scope is named" (DRY, Single Responsibility). Ascending-time key
 * ordering itself is the pure core's concern and is reused, not re-derived —
 * see {@link encodeLeaderboardSortKey}.
 */
import { encodeLeaderboardSortKey } from "../../core/platform/leaderboard";
import type { MazeParams } from "../../core/validateSubmission";

/** The single-table partition-key attribute (matches `infra/data-store.ts`). */
export const PARTITION_KEY = "PK";

/** The single-table sort-key attribute (matches `infra/data-store.ts`). */
export const SORT_KEY = "SK";

/** The leaderboard GSI partition-key attribute (matches `infra/data-store.ts`). */
export const GSI1_PARTITION_KEY = "GSI1PK";

/** The leaderboard GSI sort-key attribute (matches `infra/data-store.ts`). */
export const GSI1_SORT_KEY = "GSI1SK";

/** The leaderboard index name (matches `infra/data-store.ts`). */
export const LEADERBOARD_INDEX_NAME = "GSI1";

/** Separator between the segments of a composite key. */
const SEGMENT_SEPARATOR = "#";

/**
 * The partition every entity for one account lives under: `ACCT#<accountId>`.
 * Profile, scores, and personal bests share it so an account's data is one
 * bounded `Query` (design "Single table").
 */
export function accountPartitionKey(accountId: string): string {
  return `ACCT${SEGMENT_SEPARATOR}${accountId}`;
}

/**
 * A stable identity for a maze-parameter scope, embedded in both the score sort
 * key and the leaderboard partition key. Two Runs share a leaderboard exactly
 * when this token matches, so it must be a total, collision-free function of the
 * parameters. Order is fixed (`rows`x`columns`#`seed`#`timeLimitSeconds`) so the
 * same params always produce the same token.
 */
export function paramsToken(params: MazeParams): string {
  return `${params.rows}x${params.columns}${SEGMENT_SEPARATOR}${params.seed}${SEGMENT_SEPARATOR}${params.timeLimitSeconds}`;
}

/**
 * The leaderboard GSI partition key for a maze-parameter scope: `LB#<params>`.
 * All entries for one scope share it, so the top segment is a single ascending
 * `Query` on this partition (R6.1, R6.4).
 */
export function leaderboardPartitionKey(params: MazeParams): string {
  return `LB${SEGMENT_SEPARATOR}${paramsToken(params)}`;
}

/**
 * The personal-best sort key for a scope: `BEST#<params>`. One item per account
 * per scope, updated by a conditional write (R4.5).
 */
export function personalBestSortKey(params: MazeParams): string {
  return `BEST${SEGMENT_SEPARATOR}${paramsToken(params)}`;
}

/**
 * The sort key of an account's profile item: the constant `PROFILE`. One per
 * account, holding the public `displayName` a leaderboard read resolves (R6.2).
 */
export const PROFILE_SORT_KEY = "PROFILE";

/**
 * The partition every item for one shared session lives under:
 * `SESSION#<sessionId>` (Phase 2b, task 16.4). A session's authoritative state
 * is a single item in this partition, keyed by {@link SESSION_STATE_SORT_KEY},
 * so a stateless Lambda loads and overwrites it as one unit across a join, each
 * move, and a reconnect (R9.4, R9.5).
 */
export function sessionPartitionKey(sessionId: string): string {
  return `SESSION${SEGMENT_SEPARATOR}${sessionId}`;
}

/**
 * The sort key of a shared session's authoritative-state item: the constant
 * `STATE`. One per session, holding the server-owned maze (R8.1) and every
 * Participant's authoritative position (R9.2).
 */
export const SESSION_STATE_SORT_KEY = "STATE";

/**
 * The sort key of a persisted Score: `SCORE#<params>#<zeroPaddedTimeMs>#<accountId>`.
 *
 * The time and accountId suffix reuse the pure core's leaderboard sort-key
 * encoding, so a Score's base-table key and its leaderboard-index key are keyed
 * identically and a duplicate submission (same account, same scope, same
 * authoritative time) maps to the *same* item. That is what makes the
 * conditional put idempotent (R7.4) without a separate idempotency-key attribute:
 * the deterministic key derived from the validated Score *is* the dedupe key.
 */
export function scoreSortKey(
  params: MazeParams,
  timeMs: number,
  accountId: string,
): string {
  return `SCORE${SEGMENT_SEPARATOR}${paramsToken(params)}${SEGMENT_SEPARATOR}${encodeLeaderboardSortKey(timeMs, accountId)}`;
}

/**
 * The leaderboard GSI sort key: `<zeroPaddedTimeMs>#<accountId>`. Reuses the
 * pure encoder so ascending lexicographic order equals ascending-time order
 * (R6.1) and the tie-break is the shared, deterministic one.
 */
export function leaderboardSortKey(timeMs: number, accountId: string): string {
  return encodeLeaderboardSortKey(timeMs, accountId);
}
