import { describe, expect, it } from "vitest";

import { resolveSession } from "../../core/platform/sessionResolution";
import type {
  ParticipantState,
  SharedSessionState,
} from "../../core/platform/sharedSession";
import { parseTimeLimit } from "../../core/parseTimeLimit";
import { solvableMaze } from "../../core/testFixtures/mazes";
import type { Position, TimeLimit } from "../../core/types";
import type { MazeParams, Score } from "../../core/validateSubmission";
import type {
  Page,
  PutScoreResult,
  ScoreRepository,
} from "../ports/ScoreRepository";
import { persistSessionScores } from "./sessionScores";

/**
 * Unit tests for persisting qualifying shared-session results through the R4
 * score path (Task 17.2, Red step).
 *
 * R10.3 requires a Participant's qualifying (Finished) result to feed the *same*
 * persistent-score and leaderboard system solo play uses. This module composes
 * the pure `toQualifyingScores` mapping with the existing
 * {@link ScoreRepository} port — no parallel store, no second leaderboard — so
 * these tests assert exactly that delegation:
 *  - only Finished results are persisted, each via `putScore` (R10.3);
 *  - a NotFinished / timed-out Participant earns no win Score (R10.4);
 *  - each persisted Score carries the authoritative time and is keyed by the
 *    finisher's accountId within the session's maze-parameter scope;
 *  - re-resolving the same session does NOT create duplicate leaderboard
 *    entries — the port is idempotent on the deterministic (scope, time,
 *    account) key, so a retried resolution is a no-op (R7.4 reused).
 *
 * The repository is faked in memory (no AWS). The fake mirrors the real
 * `DynamoScoreRepository` dedupe contract: a Score keyed by (scope, time,
 * account) that already exists is a `persisted: false` no-op, so the idempotency
 * assertion exercises real behaviour rather than a stub.
 *
 * _Validates: Requirements 10.3, 10.4_
 */

const PARAMS: MazeParams = { rows: 9, columns: 9, seed: 1234, timeLimitSeconds: 60 };
const EXIT: Position = { row: 2, column: 2 };

function fixtureTimeLimit(): TimeLimit {
  return parseTimeLimit(PARAMS.timeLimitSeconds).value;
}

function participant(participantId: string, position: Position): ParticipantState {
  return { participantId, displayName: participantId, position, moveSeq: 0, status: "Racing" };
}

function racingSession(participants: ReadonlyArray<ParticipantState>): SharedSessionState {
  return {
    sessionId: "session-1",
    maze: solvableMaze(),
    timeLimit: fixtureTimeLimit(),
    participants: new Map(participants.map((p) => [p.participantId, p])),
    status: "Racing",
  };
}

/** Stable identity for a maze scope + authoritative time + account — the dedupe key. */
function dedupeKey(accountId: string, score: Score): string {
  const { rows, columns, seed, timeLimitSeconds } = score.mazeParams;
  return `${accountId}#${rows}x${columns}#${seed}#${timeLimitSeconds}#${score.elapsedMs}`;
}

/**
 * An in-memory {@link ScoreRepository} that mirrors the real adapter's
 * idempotency: a Score whose deterministic (account, scope, time) key already
 * exists is a no-op, exactly as the DynamoDB conditional put behaves (R7.4).
 * Records every accepted put so tests can assert what fed the leaderboard.
 */
class FakeScoreRepository implements ScoreRepository {
  public readonly puts: Array<{ accountId: string; score: Score }> = [];
  private readonly seen = new Set<string>();

  public putScore(accountId: string, score: Score): Promise<PutScoreResult> {
    const key = dedupeKey(accountId, score);
    if (this.seen.has(key)) {
      return Promise.resolve({ persisted: false, isPersonalBest: false });
    }
    this.seen.add(key);
    this.puts.push({ accountId, score });
    return Promise.resolve({ persisted: true, isPersonalBest: true });
  }

  public personalBest(): Promise<Score | null> {
    return Promise.resolve(null);
  }

  public listByAccount(): Promise<Page<Score>> {
    return Promise.resolve({ items: [] as ReadonlyArray<Score> } as Page<Score>);
  }
}

function wonScore(elapsedMs: number): Score {
  return { outcome: "Won", mazeParams: PARAMS, elapsedMs };
}

describe("persistSessionScores — only qualifying results feed the leaderboard (R10.3, R10.4)", () => {
  it("persists a Score for each finisher via the ScoreRepository port", async () => {
    const repo = new FakeScoreRepository();
    const resolution = resolveSession(
      racingSession([participant("alice", EXIT), participant("carol", EXIT)]),
      new Map([
        ["alice", 2500],
        ["carol", 5000],
      ]),
    );

    const summary = await persistSessionScores(resolution, PARAMS, repo);

    expect(summary.persisted).toBe(2);
    expect(repo.puts).toEqual([
      { accountId: "alice", score: wonScore(2500) },
      { accountId: "carol", score: wonScore(5000) },
    ]);
  });

  it("does not persist a NotFinished / timed-out Participant (R10.4)", async () => {
    const repo = new FakeScoreRepository();
    const resolution = resolveSession(
      racingSession([participant("alice", EXIT), participant("bob", { row: 0, column: 1 })]),
      new Map([["alice", 3000]]),
    );

    await persistSessionScores(resolution, PARAMS, repo);

    expect(repo.puts.map((p) => p.accountId)).toEqual(["alice"]);
  });

  it("keys each Score by the finisher's accountId within the session scope", async () => {
    const repo = new FakeScoreRepository();
    const resolution = resolveSession(
      racingSession([participant("alice", EXIT)]),
      new Map([["alice", 4200]]),
    );

    await persistSessionScores(resolution, PARAMS, repo);

    expect(repo.puts[0]).toEqual({
      accountId: "alice",
      score: { outcome: "Won", mazeParams: PARAMS, elapsedMs: 4200 },
    });
  });

  it("persists nothing when no Participant finished", async () => {
    const repo = new FakeScoreRepository();
    const resolution = resolveSession(
      racingSession([participant("alice", { row: 1, column: 1 })]),
      new Map(),
    );

    const summary = await persistSessionScores(resolution, PARAMS, repo);

    expect(summary.persisted).toBe(0);
    expect(repo.puts).toEqual([]);
  });
});

describe("persistSessionScores — idempotent under re-resolution (R10.3 reusing R7.4)", () => {
  it("re-resolving the same session creates no duplicate leaderboard entries", async () => {
    const repo = new FakeScoreRepository();
    const session = racingSession([participant("alice", EXIT), participant("carol", EXIT)]);
    const finishTimes = new Map([
      ["alice", 2500],
      ["carol", 5000],
    ]);

    const first = await persistSessionScores(resolveSession(session, finishTimes), PARAMS, repo);
    // A retry of resolution (e.g. the Session Lambda re-invoked) resolves the
    // identical authoritative state to the identical Scores.
    const second = await persistSessionScores(resolveSession(session, finishTimes), PARAMS, repo);

    expect(first.persisted).toBe(2);
    // The second pass sees each Score already recorded: no new leaderboard entry.
    expect(second.persisted).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(repo.puts).toHaveLength(2);
  });
});
