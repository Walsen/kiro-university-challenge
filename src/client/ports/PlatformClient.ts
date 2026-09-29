/**
 * The client Platform SDK port (task 10.1).
 *
 * `PlatformClient` is the single, provider-agnostic interface the React UI (task
 * 10.2) depends on for every platform capability: authenticate, submit a score,
 * read personal history and personal best, and read the leaderboard and own
 * rank. The UI depends only on this port (Dependency Inversion); the concrete
 * `PlatformSdk` adapter in the client edges layer wires it over the
 * {@link AuthProvider} port and the {@link HttpTransport} port, and only that
 * adapter knows the API's URLs, status codes, or the bearer-token header.
 *
 * ## Typed failures, never an ambiguous throw (R12.5)
 *
 * Every operation resolves a {@link PlatformResult} — a discriminated union of
 * `{ ok: true, value }` or `{ ok: false, failure }` — rather than throwing on an
 * expected failure, matching the core's result-type convention (data-model
 * steering "validate at the boundary") and the design's "expected failures are
 * typed data, not exceptions". The UI switches on `failure.kind` to render an
 * explicit state (re-authenticate, invalid, rate-limited, retry) and is never
 * left ambiguous or frozen (R12.5, requirement 12.5). The failure kinds map
 * directly onto the design's Error Handling table:
 *
 * | kind             | cause                                             |
 * | ---------------- | ------------------------------------------------- |
 * | `unauthenticated`| no session, or the API rejected the token (401)   |
 * | `validation`     | the API rejected the request as invalid (400)     |
 * | `rate-limited`   | capacity exceeded / throttled (429) (R7.3)        |
 * | `network`        | the request never got a response (offline, DNS)   |
 * | `backend`        | the API returned an unexpected fault (5xx / other)|
 *
 * Requirements: R4 (submit score), R5 (personal scores/history), R6
 * (leaderboard/own-rank), R12.5 (explicit failure states).
 */
import type { AuthSession, SignUpResult } from "./AuthProvider";
import type { MazeParams, Score, ScoreSubmission } from "../../core/validateSubmission";
import type { OwnRankResult } from "../../core/platform/leaderboard";

// Re-export the shared domain shapes so UI code can import them from the one
// port module it already depends on, rather than reaching into `core` or the
// server package directly. These are the *same* types the server validates
// against — reused, never redefined divergently.
export type { MazeParams, Score, ScoreSubmission } from "../../core/validateSubmission";
export type { OwnRankResult } from "../../core/platform/leaderboard";
export type { AuthSession, SignUpResult } from "./AuthProvider";

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

/**
 * Why a platform operation could not complete. A closed, discriminated set so
 * the UI must handle every case and can render an explicit state for each
 * (R12.5). `message` is a human-readable detail for display/logging; it never
 * carries credentials or a full token (R11.4).
 */
export type PlatformFailure =
  | { readonly kind: "unauthenticated"; readonly message: string }
  | { readonly kind: "validation"; readonly message: string }
  | { readonly kind: "rate-limited"; readonly message: string }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "backend"; readonly message: string };

/** The discriminated result of every {@link PlatformClient} operation (R12.5). */
export type PlatformResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: PlatformFailure };

// ---------------------------------------------------------------------------
// Response DTOs (shared with the server route contracts)
// ---------------------------------------------------------------------------

/**
 * The outcome of a `POST /scores` submission, mirroring the Score handler's
 * response body. `persisted` is `false` for an idempotent duplicate (R7.4);
 * `elapsedMs` is the server-recomputed authoritative time, never the client's
 * claim (R4.6).
 */
export interface ScoreSubmissionResult {
  readonly persisted: boolean;
  readonly isPersonalBest: boolean;
  readonly elapsedMs: number;
}

/**
 * A page of the caller's own scores from `GET /scores/me` (R5.1). `nextPage` is
 * the opaque cursor to pass back for the following page, absent on the last.
 */
export interface ScoreHistoryPage {
  readonly items: ReadonlyArray<Score>;
  readonly nextPage?: string;
}

/**
 * One public leaderboard standing from `GET /leaderboard` (R6.1, R6.2). Carries
 * the display name only — never the private account identifier (R6.2, R11.3),
 * matching the server's public projection.
 */
export interface LeaderboardStanding {
  readonly rank: number;
  readonly displayName: string;
  readonly timeMs: number;
}

// ---------------------------------------------------------------------------
// Capability ports (segregated)
// ---------------------------------------------------------------------------

/**
 * The auth surface the SDK exposes. It delegates to the injected
 * {@link AuthProvider} (task 4.1/4.2) so the UI depends on one platform port
 * rather than two, while identity rules still live behind the auth adapter. The
 * auth-flow methods keep the provider's own throw-on-expected-failure contract
 * (R2.2/R3.4 non-disclosure is enforced there); the SDK adds typed results only
 * for the *HTTP* calls below, which are the ones that can be rate-limited or hit
 * a backend fault.
 */
export interface PlatformAuth {
  signUp(
    identifier: string,
    credential: string,
    displayName: string,
  ): Promise<SignUpResult>;
  confirm(identifier: string, code: string): Promise<void>;
  signIn(identifier: string, credential: string): Promise<AuthSession>;
  signOut(): Promise<void>;
  currentSession(): AuthSession | null;
  startRecovery(identifier: string): Promise<void>;
  completeRecovery(
    identifier: string,
    code: string,
    newCredential: string,
  ): Promise<void>;
}

/**
 * The client Platform SDK: the whole platform capability behind one port. It
 * composes {@link PlatformAuth} with the authenticated score/history calls and
 * the leaderboard reads, and every HTTP-backed method returns a
 * {@link PlatformResult} carrying a typed {@link PlatformFailure} on failure
 * (R12.5).
 */
export interface PlatformClient {
  /** The auth capability (delegates to the injected `AuthProvider`). */
  readonly auth: PlatformAuth;

  /**
   * Submit a completed run for server-side validation and persistence
   * (`POST /scores`, R4). Attaches the current session's bearer token; a missing
   * session or a rejected token is an `unauthenticated` failure with nothing
   * submitted (R4.3).
   */
  submitScore(
    submission: ScoreSubmission,
  ): Promise<PlatformResult<ScoreSubmissionResult>>;

  /**
   * Read a page of the caller's own score history (`GET /scores/me`, R5.1).
   * Pass the previous page's `nextPage` cursor to continue; omit it to start.
   */
  personalHistory(cursor?: string): Promise<PlatformResult<ScoreHistoryPage>>;

  /**
   * Read the caller's personal best for a maze-parameter scope
   * (`GET /scores/me/best`, R5.2), or `null` when they have no winning run for
   * it — "no personal best yet" is a success, not a failure.
   */
  personalBest(params: MazeParams): Promise<PlatformResult<Score | null>>;

  /**
   * Read the public top-N leaderboard for a maze-parameter scope
   * (`GET /leaderboard`, R6.1). Unauthenticated: no token is attached.
   */
  leaderboard(
    params: MazeParams,
    limit?: number,
  ): Promise<PlatformResult<ReadonlyArray<LeaderboardStanding>>>;

  /**
   * Read the caller's own rank for a maze-parameter scope
   * (`GET /leaderboard/me`, R6.3), or an unranked marker. Attaches the bearer
   * token; a missing/rejected session is an `unauthenticated` failure.
   */
  ownRank(params: MazeParams): Promise<PlatformResult<OwnRankResult>>;
}
