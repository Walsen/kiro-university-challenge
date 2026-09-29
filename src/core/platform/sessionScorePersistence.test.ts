import { describe, expect, it } from "vitest";

import type { MazeParams, Score } from "../validateSubmission";
import { toQualifyingScores, type QualifyingScore } from "./sessionScorePersistence";
import type { SessionParticipantResult } from "./sessionResolution";

/**
 * Example-based unit tests for the pure mapping from a resolved shared session
 * to the qualifying Scores that feed the shared leaderboard (Task 17.2, Red
 * step).
 *
 * These specify the pure half of R10.3: a `Finished` result maps to a `Won`
 * `Score` carrying the authoritative finishing time and the session's
 * maze-parameter scope, keyed by the finisher's accountId; a `NotFinished`
 * result yields no Score (R10.4). The mapping is a pure function of the resolved
 * results plus the session's scope — no I/O — so the Session handler composes it
 * with the {@link ScoreRepository} port rather than reimplementing it.
 *
 * A Participant's `participantId` in a shared session IS the acting account (the
 * server seats a joiner under its JWT `sub`), so the mapping carries it through
 * as the `accountId` scores are keyed by.
 *
 * _Validates: Requirements 10.3, 10.4_
 */

const PARAMS: MazeParams = { rows: 9, columns: 9, seed: 1234, timeLimitSeconds: 60 };

function finished(
  participantId: string,
  timeMs: number,
  rank: number,
  displayName = participantId,
): SessionParticipantResult {
  return { participantId, displayName, outcome: "Finished", timeMs, rank };
}

function notFinished(
  participantId: string,
  displayName = participantId,
): SessionParticipantResult {
  return { participantId, displayName, outcome: "NotFinished", reason: "TimeExpired" };
}

function wonScore(elapsedMs: number, params: MazeParams = PARAMS): Score {
  return { outcome: "Won", mazeParams: params, elapsedMs };
}

describe("toQualifyingScores — only Finished results become Scores (R10.3, R10.4)", () => {
  it("maps a Finished result to a Won Score keyed by the finisher's accountId", () => {
    const qualifying = toQualifyingScores([finished("alice", 4200, 1)], PARAMS);

    expect(qualifying).toEqual<ReadonlyArray<QualifyingScore>>([
      { accountId: "alice", score: wonScore(4200) },
    ]);
  });

  it("skips a NotFinished result — a timed-out Participant earns no win Score (R10.4)", () => {
    const qualifying = toQualifyingScores([notFinished("bob")], PARAMS);

    expect(qualifying).toEqual([]);
  });

  it("persists only the finishers when finishers and non-finishers are mixed", () => {
    const qualifying = toQualifyingScores(
      [finished("alice", 2500, 1), notFinished("bob"), finished("carol", 5000, 2)],
      PARAMS,
    );

    expect(qualifying).toEqual<ReadonlyArray<QualifyingScore>>([
      { accountId: "alice", score: wonScore(2500) },
      { accountId: "carol", score: wonScore(5000) },
    ]);
  });
});

describe("toQualifyingScores — carries the authoritative time and the session scope (R10.3)", () => {
  it("uses the authoritative finishing time as the Score's elapsedMs, not the rank", () => {
    const qualifying = toQualifyingScores([finished("alice", 7777, 3)], PARAMS);

    expect(qualifying[0]?.score.elapsedMs).toBe(7777);
  });

  it("scopes every Score to the session's maze parameters (the leaderboard scope)", () => {
    const other: MazeParams = { rows: 5, columns: 5, seed: 99, timeLimitSeconds: 90 };

    const qualifying = toQualifyingScores([finished("alice", 1000, 1)], other);

    expect(qualifying[0]?.score.mazeParams).toEqual(other);
  });

  it("returns an empty list for a session with no participants", () => {
    expect(toQualifyingScores([], PARAMS)).toEqual([]);
  });
});
