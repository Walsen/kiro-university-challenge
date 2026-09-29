/**
 * Contract tests for the `ScoreRepository` / `LeaderboardQuery` server ports.
 *
 * The ports are pure interfaces (Dependency Inversion): the Lambdas depend on
 * them, and only the DynamoDB adapters (tasks 6.3/6.4) touch the AWS SDK. These
 * tests pin the shape of those contracts so a conforming in-memory fake can
 * stand in for the real adapters in the services' tests, and assert the ports
 * carry no storage-provider leakage (nothing here imports the AWS SDK, and the
 * fakes implement the whole surface without one).
 *
 * The fakes model just enough behavior to make the contract executable rather
 * than purely structural: idempotent `putScore`, conditional personal-best,
 * per-account isolation, paging, ascending top-N, and own-rank. The own-rank
 * fake delegates to the real pure `computeOwnRank` so the port's ranking
 * meaning is the same the core defines (R6.3), not a re-implementation.
 *
 * Requirements: R4 (persist score), R5 (personal scores/history), R6
 * (leaderboard).
 */
import { describe, expect, it } from "vitest";

import type {
  LeaderboardQuery,
  LeaderboardStanding,
  Page,
  PageToken,
  PutScoreResult,
  ScoreRepository,
} from "./ScoreRepository";
import type { MazeParams, Score } from "../../core/validateSubmission";
import {
  computeOwnRank,
  type LeaderboardEntry,
  type OwnRankResult,
} from "../../core/platform/leaderboard";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PARAMS: MazeParams = { rows: 5, columns: 5, seed: 42, timeLimitSeconds: 60 };
const OTHER_PARAMS: MazeParams = { rows: 7, columns: 7, seed: 7, timeLimitSeconds: 60 };

function score(elapsedMs: number, params: MazeParams = PARAMS): Score {
  return { outcome: "Won", mazeParams: params, elapsedMs };
}

/** Stable string identity for a maze-parameter scope, used to bucket entries. */
function paramsKey(params: MazeParams): string {
  return `${params.rows}x${params.columns}#${params.seed}#${params.timeLimitSeconds}`;
}

// ---------------------------------------------------------------------------
// In-memory fakes implementing the whole port surface (no AWS SDK)
// ---------------------------------------------------------------------------

interface StoredScore {
  readonly score: Score;
  readonly idempotencyKey: string;
}

/**
 * A minimal in-memory `ScoreRepository`. Its existence and type-checking is the
 * primary assertion: the port is implementable without any storage-provider
 * type. `putScore` takes an explicit idempotency key here to exercise the
 * dedupe contract the real adapter derives from the submission.
 */
class FakeScoreRepository implements ScoreRepository {
  private readonly byAccount = new Map<string, StoredScore[]>();
  private readonly pageSize: number;

  constructor(pageSize = 50) {
    this.pageSize = pageSize;
  }

  putScore(
    accountId: string,
    score: Score,
    idempotencyKey = `${accountId}:${score.elapsedMs}`,
  ): Promise<PutScoreResult> {
    const existing = this.byAccount.get(accountId) ?? [];
    if (existing.some((s) => s.idempotencyKey === idempotencyKey)) {
      return Promise.resolve({ persisted: false, isPersonalBest: false });
    }

    const priorBest = this.bestFor(existing, score.mazeParams);
    const isPersonalBest = priorBest === null || score.elapsedMs < priorBest.elapsedMs;

    existing.push({ score, idempotencyKey });
    this.byAccount.set(accountId, existing);
    return Promise.resolve({ persisted: true, isPersonalBest });
  }

  personalBest(accountId: string, params: MazeParams): Promise<Score | null> {
    const stored = this.byAccount.get(accountId) ?? [];
    return Promise.resolve(this.bestFor(stored, params));
  }

  listByAccount(accountId: string, page?: PageToken): Promise<Page<Score>> {
    const all = (this.byAccount.get(accountId) ?? []).map((s) => s.score);
    const offset = page === undefined ? 0 : Number(page);
    const items = all.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    const result: Page<Score> =
      nextOffset < all.length
        ? { items, nextPage: String(nextOffset) as PageToken }
        : { items };
    return Promise.resolve(result);
  }

  private bestFor(stored: StoredScore[], params: MazeParams): Score | null {
    const key = paramsKey(params);
    let best: Score | null = null;
    for (const { score } of stored) {
      if (paramsKey(score.mazeParams) === key) {
        if (best === null || score.elapsedMs < best.elapsedMs) {
          best = score;
        }
      }
    }
    return best;
  }
}

/**
 * A minimal in-memory `LeaderboardQuery` over a flat list of standings. `ownRank`
 * delegates to the real pure `computeOwnRank`, so the fake cannot disagree with
 * the core on what a rank means.
 */
class FakeLeaderboardQuery implements LeaderboardQuery {
  private readonly entries = new Map<
    string,
    Array<{ accountId: string; displayName: string; timeMs: number }>
  >();

  add(params: MazeParams, accountId: string, displayName: string, timeMs: number): void {
    const key = paramsKey(params);
    const list = this.entries.get(key) ?? [];
    list.push({ accountId, displayName, timeMs });
    this.entries.set(key, list);
  }

  topN(params: MazeParams, limit: number): Promise<ReadonlyArray<LeaderboardStanding>> {
    const list = [...(this.entries.get(paramsKey(params)) ?? [])].sort(
      (a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId),
    );
    const standings: LeaderboardStanding[] = list.slice(0, limit).map((e, index) => ({
      rank: index + 1,
      displayName: e.displayName,
      timeMs: e.timeMs,
      accountId: e.accountId,
    }));
    return Promise.resolve(standings);
  }

  ownRank(params: MazeParams, accountId: string): Promise<OwnRankResult> {
    const list = this.entries.get(paramsKey(params)) ?? [];
    const leaderboardEntries: ReadonlyArray<LeaderboardEntry> = list.map((e) => ({
      accountId: e.accountId,
      timeMs: e.timeMs,
    }));
    return Promise.resolve(computeOwnRank(leaderboardEntries, accountId));
  }
}

// ---------------------------------------------------------------------------
// ScoreRepository contract
// ---------------------------------------------------------------------------

describe("ScoreRepository port contract", () => {
  it("is implementable by a fake without any storage-provider types (R4, R5)", () => {
    const repo: ScoreRepository = new FakeScoreRepository();
    expect(repo).toBeInstanceOf(FakeScoreRepository);
  });

  it("persists a score and reports it as a new personal best (R4.2, R4.5)", async () => {
    const repo: ScoreRepository = new FakeScoreRepository();

    const result = await repo.putScore("acct-a", score(5_000));

    expect(result).toEqual({ persisted: true, isPersonalBest: true });
  });

  it("treats a duplicate idempotency key as a no-op (R7.4)", async () => {
    const repo = new FakeScoreRepository();

    const first = await repo.putScore("acct-a", score(5_000), "key-1");
    const dup = await repo.putScore("acct-a", score(5_000), "key-1");

    expect(first.persisted).toBe(true);
    expect(dup).toEqual({ persisted: false, isPersonalBest: false });
  });

  it("marks a faster score as a new best but a slower one as not (R4.5)", async () => {
    const repo = new FakeScoreRepository();
    await repo.putScore("acct-a", score(5_000), "k1");

    const slower = await repo.putScore("acct-a", score(9_000), "k2");
    const faster = await repo.putScore("acct-a", score(3_000), "k3");

    expect(slower.isPersonalBest).toBe(false);
    expect(faster.isPersonalBest).toBe(true);
  });

  it("returns the account's best score for the params, or null when none (R5.2)", async () => {
    const repo: ScoreRepository = new FakeScoreRepository();
    await repo.putScore("acct-a", score(5_000));
    await repo.putScore("acct-a", score(2_500));

    await expect(repo.personalBest("acct-a", PARAMS)).resolves.toEqual(score(2_500));
    await expect(repo.personalBest("acct-a", OTHER_PARAMS)).resolves.toBeNull();
  });

  it("scopes reads to the acting account so accounts stay isolated (R5.3, R11.2)", async () => {
    const repo: ScoreRepository = new FakeScoreRepository();
    await repo.putScore("acct-a", score(5_000));

    const others = await repo.listByAccount("acct-b");

    expect(others.items).toEqual([]);
    await expect(repo.personalBest("acct-b", PARAMS)).resolves.toBeNull();
  });

  it("pages a large history via the opaque next-page cursor (R5.1)", async () => {
    const repo = new FakeScoreRepository(2);
    await repo.putScore("acct-a", score(1_000), "k1");
    await repo.putScore("acct-a", score(2_000), "k2");
    await repo.putScore("acct-a", score(3_000), "k3");

    const firstPage = await repo.listByAccount("acct-a");
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextPage).toBeDefined();

    const secondPage = await repo.listByAccount("acct-a", firstPage.nextPage);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextPage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LeaderboardQuery contract
// ---------------------------------------------------------------------------

describe("LeaderboardQuery port contract", () => {
  it("is implementable by a fake without any storage-provider types (R6)", () => {
    const query: LeaderboardQuery = new FakeLeaderboardQuery();
    expect(query).toBeInstanceOf(FakeLeaderboardQuery);
  });

  it("returns top-N standings ascending by time, fastest first (R6.1, R6.4)", async () => {
    const query = new FakeLeaderboardQuery();
    query.add(PARAMS, "acct-a", "Ada", 3_000);
    query.add(PARAMS, "acct-b", "Bo", 1_000);
    query.add(PARAMS, "acct-c", "Cy", 2_000);

    const top2 = await query.topN(PARAMS, 2);

    expect(top2).toEqual([
      { rank: 1, displayName: "Bo", timeMs: 1_000, accountId: "acct-b" },
      { rank: 2, displayName: "Cy", timeMs: 2_000, accountId: "acct-c" },
    ]);
  });

  it("exposes display names for public standings, not just identifiers (R6.2)", async () => {
    const query: LeaderboardQuery = new FakeLeaderboardQuery();
    (query as FakeLeaderboardQuery).add(PARAMS, "acct-a", "Ada", 3_000);

    const [top] = await query.topN(PARAMS, 1);

    expect(top?.displayName).toBe("Ada");
  });

  it("reports own rank by delegating to the pure ranking rule (R6.3)", async () => {
    const query = new FakeLeaderboardQuery();
    query.add(PARAMS, "acct-a", "Ada", 3_000);
    query.add(PARAMS, "acct-b", "Bo", 1_000);

    await expect(query.ownRank(PARAMS, "acct-a")).resolves.toEqual({
      ranked: true,
      rank: 2,
    });
  });

  it("reports an account with no entry as unranked (R6.3)", async () => {
    const query: LeaderboardQuery = new FakeLeaderboardQuery();

    await expect(query.ownRank(PARAMS, "nobody")).resolves.toEqual({ ranked: false });
  });
});
