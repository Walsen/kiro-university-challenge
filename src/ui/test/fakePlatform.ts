/**
 * A configurable in-memory fake {@link PlatformClient} for the UI smoke tests.
 *
 * The React shell depends only on the `PlatformClient` port, so tests inject
 * this fake and never touch the network, Cognito, or `fetch` — keeping renders
 * deterministic (testing steering "Determinism"). Every method has a sensible
 * default (empty history, empty leaderboard, unranked, successful auth) and can
 * be overridden per test to drive a specific screen state, including typed
 * failures for the R12.5 explicit-failure paths.
 */
import type {
  AuthSession,
  LeaderboardStanding,
  MazeParams,
  OwnRankResult,
  PlatformAuth,
  PlatformClient,
  PlatformResult,
  Score,
  ScoreHistoryPage,
  ScoreSubmission,
  ScoreSubmissionResult,
  SignUpResult,
} from "../../client/ports/PlatformClient";

/** Per-test overrides; anything omitted uses the fake's default behavior. */
export interface FakePlatformOptions {
  readonly initialSession?: AuthSession | null;
  readonly signIn?: (identifier: string, credential: string) => Promise<AuthSession>;
  readonly signUp?: (
    identifier: string,
    credential: string,
    displayName: string,
  ) => Promise<SignUpResult>;
  readonly submitScore?: (
    submission: ScoreSubmission,
  ) => Promise<PlatformResult<ScoreSubmissionResult>>;
  readonly personalHistory?: () => Promise<PlatformResult<ScoreHistoryPage>>;
  readonly personalBest?: (params: MazeParams) => Promise<PlatformResult<Score | null>>;
  readonly leaderboard?: (
    params: MazeParams,
  ) => Promise<PlatformResult<ReadonlyArray<LeaderboardStanding>>>;
  readonly ownRank?: (params: MazeParams) => Promise<PlatformResult<OwnRankResult>>;
}

/** A fake session with a far-future expiry, for signed-in tests. */
export function fakeSession(displayName = "Ada"): AuthSession {
  return {
    accessToken: "fake-token",
    displayName,
    expiresAt: Date.now() + 3_600_000,
  };
}

export function createFakePlatform(options: FakePlatformOptions = {}): PlatformClient {
  let session: AuthSession | null = options.initialSession ?? null;

  const auth: PlatformAuth = {
    async signUp(identifier, credential, displayName) {
      if (options.signUp) {
        return options.signUp(identifier, credential, displayName);
      }
      return { identifier, displayName, confirmationRequired: true };
    },
    async confirm() {
      /* default: succeeds */
    },
    async signIn(identifier, credential) {
      const established = options.signIn
        ? await options.signIn(identifier, credential)
        : fakeSession();
      session = established;
      return established;
    },
    signOut() {
      session = null;
      return Promise.resolve();
    },
    currentSession() {
      return session;
    },
    async startRecovery() {
      /* default: succeeds, reveals nothing (R3.4) */
    },
    async completeRecovery() {
      /* default: succeeds */
    },
  };

  return {
    auth,
    submitScore(submission) {
      return (
        options.submitScore?.(submission) ??
        Promise.resolve({
          ok: true,
          value: { persisted: true, isPersonalBest: false, elapsedMs: 0 },
        })
      );
    },
    personalHistory() {
      return (
        options.personalHistory?.() ??
        Promise.resolve({ ok: true, value: { items: [] } })
      );
    },
    personalBest(params) {
      return options.personalBest?.(params) ?? Promise.resolve({ ok: true, value: null });
    },
    leaderboard(params) {
      return options.leaderboard?.(params) ?? Promise.resolve({ ok: true, value: [] });
    },
    ownRank(params) {
      return (
        options.ownRank?.(params) ??
        Promise.resolve({ ok: true, value: { ranked: false } })
      );
    },
  };
}
