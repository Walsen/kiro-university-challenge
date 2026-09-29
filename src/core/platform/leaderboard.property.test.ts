import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  LEADERBOARD_TIME_KEY_DIGITS,
  encodeLeaderboardSortKey,
} from "./leaderboard";

/**
 * Property-based test for maze-game-platform Correctness Property: rank ordering
 * (Task 5.6).
 *
 * Property (design "Leaderboard" / data model, R6.1): *for any* set of finishing
 * times, sorting the entries by their encoded leaderboard sort key — compared
 * lexicographically, exactly as a DynamoDB GSI sort key would be — yields the
 * SAME order as sorting by ascending numeric time, with a deterministic
 * accountId tie-break for equal times. In other words, the zero-padded time key
 * preserves ascending-time (fastest-first) ordering:
 *
 *   keyOf(a) <= keyOf(b)  (string compare)
 *     iff  a.timeMs < b.timeMs
 *          OR (a.timeMs === b.timeMs AND a.accountId <= b.accountId).
 *
 * The property generates an array of `(timeMs, accountId)` entries, sorts one
 * copy by the encoded key (string comparison, the GSI's behavior) and another
 * copy independently by the numeric/lexical `(timeMs, accountId)` intent, then
 * asserts the two resulting orders are identical. A tie on both time and
 * accountId is possible; the comparators used are total and agree on such
 * duplicates, so the orders remain identical.
 *
 * Determinism (testing steering): all inputs come from fast-check arbitraries —
 * never `Math.random` or wall-clock time. Custom arbitraries cover the full
 * padded range the encoder supports: 0, values spanning many digit widths, and
 * values near the maximum encodable width, plus a small pool of accountIds so
 * equal-time collisions occur frequently and exercise the tie-break. The
 * property runs a minimum of 100 iterations.
 *
 * _Validates: Requirements 6.1_
 */

/** fast-check iterations; testing steering requires a minimum of 100. */
const NUM_RUNS = 200;

/** Largest time (inclusive) the encoder accepts: 10^digits - 1. */
const MAX_ENCODABLE_TIME_MS = 10 ** LEADERBOARD_TIME_KEY_DIGITS - 1;

/** A single leaderboard entry generated for the property. */
interface GeneratedEntry {
  readonly timeMs: number;
  readonly accountId: string;
}

/**
 * A valid, encodable time. `fc.nat` covers 0 and small values (which span
 * many different digit widths, the classic "10" < "9" lexicographic trap that
 * zero-padding must fix); `fc.integer` up to the maximum width exercises the
 * high end of the padded range. Both are non-negative integers, the only times
 * the encoder accepts.
 */
const timeMsArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat({ max: 100_000 }),
  fc.integer({ min: 0, max: MAX_ENCODABLE_TIME_MS }),
);

/**
 * A small pool of non-empty accountIds. Keeping the pool small makes equal-time
 * AND equal-account collisions common, so the deterministic tie-break and the
 * exact-duplicate case are both routinely exercised. The values are chosen so
 * their natural string order is non-trivial (not simply insertion order).
 */
const accountIdArb: fc.Arbitrary<string> = fc.constantFrom(
  "acct-a",
  "acct-b",
  "acct-c",
  "acct-10",
  "acct-2",
  "zzz",
  "A",
);

const entryArb: fc.Arbitrary<GeneratedEntry> = fc.record({
  timeMs: timeMsArb,
  accountId: accountIdArb,
});

const entriesArb: fc.Arbitrary<readonly GeneratedEntry[]> = fc.array(entryArb, {
  minLength: 0,
  maxLength: 30,
});

/**
 * Comparator expressing the intended ranking: ascending numeric time, then
 * ascending accountId as the deterministic tie-break for equal times. This is
 * the order the encoded key is required to reproduce (R6.1).
 */
function byTimeThenAccount(a: GeneratedEntry, b: GeneratedEntry): number {
  if (a.timeMs !== b.timeMs) {
    return a.timeMs - b.timeMs;
  }
  if (a.accountId < b.accountId) {
    return -1;
  }
  if (a.accountId > b.accountId) {
    return 1;
  }
  return 0;
}

/**
 * Comparator using ONLY the encoded key under lexicographic string comparison —
 * the behavior of the DynamoDB GSI sort key. If the encoding preserves
 * ascending-time order, this must agree with `byTimeThenAccount`.
 */
function byEncodedKey(a: GeneratedEntry, b: GeneratedEntry): number {
  const keyA = encodeLeaderboardSortKey(a.timeMs, a.accountId);
  const keyB = encodeLeaderboardSortKey(b.timeMs, b.accountId);
  if (keyA < keyB) {
    return -1;
  }
  if (keyA > keyB) {
    return 1;
  }
  return 0;
}

describe("encodeLeaderboardSortKey — Property: rank ordering (R6.1)", () => {
  // Feature: maze-game-platform, Property: rank ordering
  it("orders entries by encoded key identically to ascending time then accountId", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const byKey = [...entries].sort(byEncodedKey);
        const byIntent = [...entries].sort(byTimeThenAccount);

        expect(byKey).toEqual(byIntent);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
