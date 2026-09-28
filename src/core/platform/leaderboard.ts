/**
 * Pure leaderboard key encoding and own-rank computation (R6.1, R6.3).
 *
 * These helpers hold the ranking rules the platform's leaderboard depends on,
 * kept pure and framework-agnostic so the same logic can be exercised in tests
 * and reused by the DynamoDB leaderboard adapter (see design.md "Data model"
 * and "Leaderboard"). No I/O, no DOM, no access to time or randomness.
 *
 * Key encoding: a leaderboard GSI entry is keyed with a sort key of the form
 * `<zeroPaddedTimeMs>#<accountId>`. The completion time in milliseconds is
 * zero-padded to a fixed width so that a lexicographic ascending sort of the
 * keys equals an ascending-time (fastest-first) sort (R6.1). The `accountId`
 * suffix is a deterministic tie-break for entries with identical times, so two
 * equal times always sort in a stable, well-defined order.
 *
 * Own-rank: an account's rank is one plus the number of accounts with a
 * strictly better (lower) time. Equal times therefore share the same rank
 * rather than being ordered arbitrarily, and an account with no entry is
 * reported as unranked (R6.3).
 */

/** Field separator between the zero-padded time and the accountId in a key. */
const KEY_SEPARATOR = "#";

/**
 * Fixed width, in digits, of the zero-padded time component of a leaderboard
 * sort key. All encoded times share this width so lexicographic order matches
 * numeric order. 15 digits encodes times up to just under 10^15 ms (over
 * 31,000 years), far beyond any legitimate maze completion time, while keeping
 * keys compact.
 */
export const LEADERBOARD_TIME_KEY_DIGITS = 15;

/** Largest time (exclusive) that fits in the fixed key width. */
const MAX_ENCODABLE_TIME_MS = 10 ** LEADERBOARD_TIME_KEY_DIGITS;

/**
 * A single leaderboard entry: an account's recorded completion time for the
 * leaderboard's maze parameter scope. An account may appear more than once
 * (one entry per recorded score); own-rank uses the account's best time.
 */
export interface LeaderboardEntry {
  readonly accountId: string;
  readonly timeMs: number;
}

/**
 * Result of an own-rank query: a 1-based rank when the account has an entry, or
 * an explicit "unranked" marker when it does not (R6.3).
 */
export type OwnRankResult =
  { readonly ranked: true; readonly rank: number } | { readonly ranked: false };

/**
 * Encode a leaderboard GSI sort key as `<zeroPaddedTimeMs>#<accountId>` (R6.1).
 *
 * The time is validated at the boundary and zero-padded to a fixed width so
 * that sorting the resulting keys lexicographically yields fastest-first order.
 * Fails fast with a typed error on input that cannot be encoded, so a malformed
 * value can never produce an ambiguously ordered key.
 */
export function encodeLeaderboardSortKey(timeMs: number, accountId: string): string {
  if (!Number.isInteger(timeMs)) {
    throw new RangeError(`leaderboard time must be an integer, received ${timeMs}`);
  }
  if (timeMs < 0) {
    throw new RangeError(`leaderboard time must be non-negative, received ${timeMs}`);
  }
  if (timeMs >= MAX_ENCODABLE_TIME_MS) {
    throw new RangeError(
      `leaderboard time ${timeMs} exceeds the encodable width of ${LEADERBOARD_TIME_KEY_DIGITS} digits`,
    );
  }
  if (accountId.length === 0) {
    throw new Error("leaderboard accountId must be a non-empty string");
  }

  const paddedTime = String(timeMs).padStart(LEADERBOARD_TIME_KEY_DIGITS, "0");
  return `${paddedTime}${KEY_SEPARATOR}${accountId}`;
}

/**
 * Compute an account's 1-based rank within a leaderboard, or report it unranked
 * (R6.3).
 *
 * The rank is one plus the number of accounts with a strictly better (lower)
 * time than the account's own best time. Using strict comparison means tied
 * times share a rank rather than being separated arbitrarily. When an account
 * has multiple entries, its best (lowest) time is used. An account absent from
 * the leaderboard is unranked.
 */
export function computeOwnRank(
  entries: ReadonlyArray<LeaderboardEntry>,
  accountId: string,
): OwnRankResult {
  const ownBest = bestTimeForAccount(entries, accountId);
  if (ownBest === null) {
    return { ranked: false };
  }

  const betterAccounts = new Set<string>();
  for (const entry of entries) {
    if (entry.accountId !== accountId && entry.timeMs < ownBest) {
      betterAccounts.add(entry.accountId);
    }
  }

  return { ranked: true, rank: betterAccounts.size + 1 };
}

/**
 * The lowest time recorded by an account, or `null` if it has no entry. An
 * account's rank is measured against this best time so that a slower duplicate
 * entry never worsens its rank.
 */
function bestTimeForAccount(
  entries: ReadonlyArray<LeaderboardEntry>,
  accountId: string,
): number | null {
  let best: number | null = null;
  for (const entry of entries) {
    if (entry.accountId === accountId && (best === null || entry.timeMs < best)) {
      best = entry.timeMs;
    }
  }
  return best;
}
