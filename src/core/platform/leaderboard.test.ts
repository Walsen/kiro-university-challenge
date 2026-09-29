import { describe, expect, it } from "vitest";

import {
  LEADERBOARD_TIME_KEY_DIGITS,
  computeOwnRank,
  encodeLeaderboardSortKey,
  type LeaderboardEntry,
} from "./leaderboard";

/**
 * Example-based unit tests for leaderboard key encoding and own-rank
 * computation (Task 5.4, Red step).
 *
 * These specify the behavior of the pure leaderboard helpers before the
 * implementation in `leaderboard.ts` exists, so they are expected to fail
 * until Task 5.5.
 *
 * The design's data model (see design.md "Data model") keys a leaderboard GSI
 * entry with GSI1SK `<zeroPaddedTimeMs>#<accountId>`, chosen so a `Query` in
 * ascending sort order returns fastest-first (R6.1). Own-rank (R6.3) is served
 * by counting entries with a strictly better time.
 *
 * _Validates: Requirements 6.1, 6.3_
 */
describe("encodeLeaderboardSortKey (R6.1)", () => {
  it("formats the key as <zeroPaddedTimeMs>#<accountId>", () => {
    const key = encodeLeaderboardSortKey(1234, "acct-1");

    expect(key).toBe(`${"1234".padStart(LEADERBOARD_TIME_KEY_DIGITS, "0")}#acct-1`);
  });

  it("zero-pads the time to a fixed width so lexicographic order equals numeric order", () => {
    const key = encodeLeaderboardSortKey(1234, "acct-1");
    const [timePart] = key.split("#");

    expect(timePart).toHaveLength(LEADERBOARD_TIME_KEY_DIGITS);
    expect(timePart).toBe("0".repeat(LEADERBOARD_TIME_KEY_DIGITS - 4) + "1234");
  });

  it("encodes a zero time as all zeros", () => {
    const key = encodeLeaderboardSortKey(0, "acct-z");

    expect(key).toBe(`${"0".repeat(LEADERBOARD_TIME_KEY_DIGITS)}#acct-z`);
  });

  it("preserves ascending-time ordering under lexicographic sort of the keys", () => {
    // A faster time must sort before a slower one, even when the slower time
    // has more digits than the faster one (the classic "10" < "9" trap that
    // zero-padding fixes).
    const fast = encodeLeaderboardSortKey(9, "acct-a");
    const slow = encodeLeaderboardSortKey(10, "acct-b");
    const slower = encodeLeaderboardSortKey(100000, "acct-c");

    const sorted = [slower, slow, fast].sort();

    expect(sorted).toEqual([fast, slow, slower]);
  });

  it("breaks ties deterministically by accountId (ascending) for equal times", () => {
    const first = encodeLeaderboardSortKey(500, "acct-a");
    const second = encodeLeaderboardSortKey(500, "acct-b");

    // Equal time, so the tie-break is the accountId suffix; "acct-a" < "acct-b".
    expect([second, first].sort()).toEqual([first, second]);
  });

  it("rejects a negative time", () => {
    expect(() => encodeLeaderboardSortKey(-1, "acct-1")).toThrow();
  });

  it("rejects a non-integer time", () => {
    expect(() => encodeLeaderboardSortKey(1.5, "acct-1")).toThrow();
  });

  it("rejects a time that exceeds the encodable width", () => {
    const tooBig = 10 ** LEADERBOARD_TIME_KEY_DIGITS;

    expect(() => encodeLeaderboardSortKey(tooBig, "acct-1")).toThrow();
  });

  it("rejects an empty accountId", () => {
    expect(() => encodeLeaderboardSortKey(100, "")).toThrow();
  });
});

describe("computeOwnRank (R6.3)", () => {
  const entries: ReadonlyArray<LeaderboardEntry> = [
    { accountId: "acct-a", timeMs: 1000 },
    { accountId: "acct-b", timeMs: 2000 },
    { accountId: "acct-c", timeMs: 3000 },
  ];

  it("ranks the fastest entry first (rank 1)", () => {
    const result = computeOwnRank(entries, "acct-a");

    expect(result).toEqual({ ranked: true, rank: 1 });
  });

  it("counts entries with a strictly better time to derive the rank", () => {
    const result = computeOwnRank(entries, "acct-c");

    // Two accounts are strictly faster, so this is rank 3.
    expect(result).toEqual({ ranked: true, rank: 3 });
  });

  it("does not count equal times as better (ties share the higher rank)", () => {
    const tied: ReadonlyArray<LeaderboardEntry> = [
      { accountId: "acct-a", timeMs: 1000 },
      { accountId: "acct-b", timeMs: 1000 },
      { accountId: "acct-c", timeMs: 1000 },
    ];

    // No entry is strictly faster than another, so every tied account is rank 1.
    expect(computeOwnRank(tied, "acct-a")).toEqual({ ranked: true, rank: 1 });
    expect(computeOwnRank(tied, "acct-b")).toEqual({ ranked: true, rank: 1 });
    expect(computeOwnRank(tied, "acct-c")).toEqual({ ranked: true, rank: 1 });
  });

  it("uses the account's best (lowest) time when it has multiple entries", () => {
    const withDuplicates: ReadonlyArray<LeaderboardEntry> = [
      { accountId: "acct-a", timeMs: 5000 },
      { accountId: "acct-a", timeMs: 1500 },
      { accountId: "acct-b", timeMs: 2000 },
    ];

    // acct-a's best is 1500, faster than acct-b's 2000, so acct-a is rank 1.
    expect(computeOwnRank(withDuplicates, "acct-a")).toEqual({ ranked: true, rank: 1 });
    // acct-b has one account strictly faster (acct-a at 1500), so rank 2.
    expect(computeOwnRank(withDuplicates, "acct-b")).toEqual({ ranked: true, rank: 2 });
  });

  it("reports an account with no entry as unranked (R6.3)", () => {
    const result = computeOwnRank(entries, "acct-unknown");

    expect(result).toEqual({ ranked: false });
  });

  it("reports unranked against an empty leaderboard", () => {
    expect(computeOwnRank([], "acct-a")).toEqual({ ranked: false });
  });
});
