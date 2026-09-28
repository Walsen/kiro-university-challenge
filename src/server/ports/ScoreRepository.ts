/**
 * Server-side persistence ports (ports-and-adapters).
 *
 * `ScoreRepository` and `LeaderboardQuery` are the abstractions the Score,
 * personal-history, and leaderboard Lambdas depend on for durable storage and
 * ranked reads. Per the Phase 2 design and the Dependency Inversion principle,
 * the services talk only to these interfaces; only the DynamoDB adapters
 * (`DynamoScoreRepository`, `DynamoLeaderboardQuery` — tasks 6.3/6.4) reference
 * the AWS SDK. No DynamoDB (or any storage-provider) type appears in these
 * contracts, so the documented Redis-sorted-set pivot for `LeaderboardQuery`
 * (design "Data model", D3) is a matter of swapping the adapter behind the port
 * — callers do not change.
 *
 * The interfaces are transcribed from the design's "Score submission and
 * validation" and "Data model" / "Leaderboard" sections. Domain types are
 * reused unchanged from the pure core: `MazeParams`/`Score` from
 * `validateSubmission` (task 5.2) and `LeaderboardEntry`/`OwnRankResult` from
 * `platform/leaderboard` (task 5.5). The port adds only the small,
 * provider-agnostic result/paging shapes the design references but leaves to
 * the persistence layer to define (`PutScoreResult`, `PageToken`, `Page<T>`,
 * `LeaderboardStanding`).
 *
 * Requirements: R4 (persist score), R5 (personal scores/history), R6
 * (leaderboard).
 */
import type { MazeParams, Score } from "../../core/validateSubmission";
import type { OwnRankResult } from "../../core/platform/leaderboard";

/**
 * Outcome of persisting a Score (R4.2, R4.5, R7.4).
 *
 * A put is idempotent on the submission's `idempotencyKey`: a retried or
 * concurrent duplicate resolves without creating a second Score (`persisted`
 * is `false` for the duplicate). `isPersonalBest` reports whether this Score
 * became the account's best time for its maze parameters, which the
 * conditional personal-best write establishes (R4.5) — the service uses it to
 * tell the Player their run set a new personal best. Provider-agnostic: it
 * exposes the facts a caller reacts to, not how any store recorded them.
 */
export interface PutScoreResult {
  /**
   * Whether this call durably recorded a new Score. `false` when an existing
   * Score already carried the same `idempotencyKey`, so the write was a no-op
   * (R7.4).
   */
  readonly persisted: boolean;
  /**
   * Whether this Score is the account's best (lowest) time for its maze
   * parameters after the write (R4.5).
   */
  readonly isPersonalBest: boolean;
}

/**
 * An opaque cursor into a paged result set. Its contents are private to the
 * adapter that issued it (e.g. an encoded DynamoDB `LastEvaluatedKey`); callers
 * only pass a token back to fetch the next page, never construct or inspect one.
 * Kept a distinct branded type so a storage-provider key can never leak through
 * the port as a plain object.
 */
export type PageToken = string & { readonly __brand: "PageToken" };

/**
 * One page of results plus the cursor to the next page. `nextPage` is absent
 * (rather than `null`) when the current page is the last, so a caller iterates
 * by passing `nextPage` back until it is no longer present.
 */
export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextPage?: PageToken;
}

/**
 * The persistence capability the score and personal-history services depend on.
 * Implemented by `DynamoScoreRepository` in the server edges layer (task 6.3);
 * substituted by an in-memory fake in tests.
 *
 * Every operation is scoped to a single `accountId` so per-account isolation is
 * enforced at the port boundary (R5.3, R11.2): a caller cannot read or write
 * another account's scores through this interface.
 */
export interface ScoreRepository {
  /**
   * Persist a validated Score for `accountId`, returning whether it was newly
   * recorded and whether it is a new personal best (R4.2, R4.5). Idempotent on
   * the originating submission's idempotency key (R7.4).
   */
  putScore(accountId: string, score: Score): Promise<PutScoreResult>;

  /**
   * The account's best (lowest-time) Score for the given maze parameters, or
   * `null` when it has never recorded a winning run for them (R5.2).
   */
  personalBest(accountId: string, params: MazeParams): Promise<Score | null>;

  /**
   * A page of the account's own Scores, most useful first, for its history view
   * (R5.1). Pass the previous page's `nextPage` cursor to continue; omit `page`
   * to read from the start.
   */
  listByAccount(accountId: string, page?: PageToken): Promise<Page<Score>>;
}

/**
 * A single ranked leaderboard standing returned by a top-N read (R6.1, R6.2).
 *
 * Deliberately public-safe: it carries the Player-chosen `displayName`, never
 * the private account identifier (R6.2, R11.3). The `accountId` retained here
 * lets an authenticated caller highlight its own row, but the leaderboard
 * service maps it away for the public `GET /leaderboard` response.
 */
export interface LeaderboardStanding {
  /** 1-based rank; ties share a rank (see `computeOwnRank`). */
  readonly rank: number;
  /** Public display name to show for this standing (R6.2). */
  readonly displayName: string;
  /** Authoritative completion time in milliseconds. */
  readonly timeMs: number;
  /**
   * The owning account. Present so an authenticated caller can locate its own
   * row; excluded from the public leaderboard projection (R11.3).
   */
  readonly accountId: string;
}

/**
 * The ranked-read capability the leaderboard service depends on (R6). Kept
 * separate from `ScoreRepository` (Interface Segregation): reading a ranking is
 * a different concern from persisting scores, and it is the seam behind which
 * the Redis-sorted-set pivot lives. Implemented by `DynamoLeaderboardQuery`
 * (task 6.4); substituted by a fake in tests.
 */
export interface LeaderboardQuery {
  /**
   * The fastest `limit` standings for a maze-parameter scope, ascending by time
   * so rank 1 is the fastest (R6.1). The read is bounded by `limit` (R6.4).
   */
  topN(params: MazeParams, limit: number): Promise<ReadonlyArray<LeaderboardStanding>>;

  /**
   * The account's own rank within a maze-parameter scope, or an unranked marker
   * when it has no qualifying entry (R6.3). Reuses the pure `computeOwnRank`
   * ranking rule — an account's rank is one plus the number of accounts with a
   * strictly better time — so the port and the core agree on what a rank means.
   */
  ownRank(params: MazeParams, accountId: string): Promise<OwnRankResult>;
}
