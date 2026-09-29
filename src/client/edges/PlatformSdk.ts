/**
 * `PlatformSdk` — the client Platform SDK over the ports (task 10.1).
 *
 * This is the one adapter the design names as the "Platform client SDK (auth,
 * scores, leaderboard, ...)". Per the hexagonal architecture it lives in the
 * client edges layer and depends *inward* on three ports: the
 * {@link PlatformClient} contract it implements, the {@link AuthProvider} it
 * delegates auth to (task 4.1/4.2), and the {@link HttpTransport} it sends
 * requests over. It references no `fetch`/DOM type and no AWS SDK — those live
 * only in the injected transport adapter and the Cognito adapter respectively,
 * so the SDK's own rules (attach the bearer token, map status codes to typed
 * failures) are pure orchestration and unit-testable against fakes.
 *
 * ## Responsibilities
 *
 *  - **Auth** is delegated wholesale to the injected `AuthProvider` (exposed as
 *    `sdk.auth`), so the UI has one platform port to depend on.
 *  - **Authenticated calls** (`submitScore`, `personalHistory`, `personalBest`,
 *    `ownRank`) read the current session, fail fast with an `unauthenticated`
 *    result when there is none, and otherwise attach `Authorization: Bearer
 *    <token>` (R4.3, R5.3).
 *  - **The public leaderboard read** attaches no token (R6.1).
 *  - **Every HTTP call** turns the response — or a transport rejection — into a
 *    typed {@link PlatformResult}: a `2xx` is parsed to the success value, and
 *    401/400/429/5xx and a network rejection each map to a distinct
 *    {@link PlatformFailure} kind (R12.5). Nothing throws for an expected
 *    failure.
 *
 * Requirements: R4, R5, R6, R12.5.
 */
import type { AuthProvider } from "../ports/AuthProvider";
import type { HttpRequest, HttpTransport } from "../ports/HttpTransport";
import type {
  LeaderboardStanding,
  MazeParams,
  OwnRankResult,
  PlatformAuth,
  PlatformClient,
  PlatformFailure,
  PlatformResult,
  Score,
  ScoreHistoryPage,
  ScoreSubmission,
  ScoreSubmissionResult,
} from "../ports/PlatformClient";

/** The lowest 2xx status; anything at/above this and below 300 is a success. */
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Collaborators injected at the composition root (Dependency Injection). */
export interface PlatformSdkDeps {
  /** Absolute API base URL, e.g. `https://api.dev.example.com` (no trailing slash). */
  readonly baseUrl: string;
  /** The transport the SDK sends requests over (fetch adapter in production). */
  readonly transport: HttpTransport;
  /** The identity port the SDK delegates auth to and reads the bearer token from. */
  readonly authProvider: AuthProvider;
}

export class PlatformSdk implements PlatformClient {
  /** Base URL with any trailing slash removed so path joins are unambiguous. */
  private readonly baseUrl: string;
  private readonly transport: HttpTransport;
  private readonly authProvider: AuthProvider;

  /** Auth is delegated to the injected provider; the SDK just re-exposes it. */
  public readonly auth: PlatformAuth;

  public constructor(deps: PlatformSdkDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.transport = deps.transport;
    this.authProvider = deps.authProvider;
    this.auth = deps.authProvider;
  }

  public submitScore(
    submission: ScoreSubmission,
  ): Promise<PlatformResult<ScoreSubmissionResult>> {
    return this.authenticatedJson<ScoreSubmissionResult>({
      method: "POST",
      path: "/scores",
      body: submission,
    });
  }

  public personalHistory(cursor?: string): Promise<PlatformResult<ScoreHistoryPage>> {
    const query = cursor === undefined ? "" : `?next=${encodeURIComponent(cursor)}`;
    return this.authenticatedJson<ScoreHistoryPage>({
      method: "GET",
      path: `/scores/me${query}`,
    });
  }

  public async personalBest(params: MazeParams): Promise<PlatformResult<Score | null>> {
    const result = await this.authenticatedJson<{ readonly best: Score | null }>({
      method: "GET",
      path: `/scores/me/best?${mazeParamsQuery(params)}`,
    });
    return result.ok ? { ok: true, value: result.value.best } : result;
  }

  public async leaderboard(
    params: MazeParams,
    limit?: number,
  ): Promise<PlatformResult<ReadonlyArray<LeaderboardStanding>>> {
    const limitQuery = limit === undefined ? "" : `&limit=${limit}`;
    const result = await this.sendJson<{
      readonly standings: ReadonlyArray<LeaderboardStanding>;
    }>(
      {
        method: "GET",
        path: `/leaderboard?${mazeParamsQuery(params)}${limitQuery}`,
      },
      // The public leaderboard read carries no bearer token (R6.1).
      undefined,
    );
    return result.ok ? { ok: true, value: result.value.standings } : result;
  }

  public ownRank(params: MazeParams): Promise<PlatformResult<OwnRankResult>> {
    return this.authenticatedJson<OwnRankResult>({
      method: "GET",
      path: `/leaderboard/me?${mazeParamsQuery(params)}`,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Send a request that requires the current session's bearer token. Reads the
   * session first and fails fast with an `unauthenticated` result when there is
   * none — nothing is sent (R4.3, R5.3). Otherwise attaches the token and
   * delegates to {@link sendJson}.
   */
  private authenticatedJson<T>(spec: {
    readonly method: HttpRequest["method"];
    readonly path: string;
    readonly body?: unknown;
  }): Promise<PlatformResult<T>> {
    const session = this.authProvider.currentSession();
    if (session === null) {
      return Promise.resolve(unauthenticated("no active session"));
    }
    return this.sendJson<T>(spec, session.accessToken);
  }

  /**
   * Send one request over the transport and reduce the outcome to a typed
   * {@link PlatformResult}. A transport rejection becomes a `network` failure; a
   * non-2xx status maps to the failure kind for that status; a 2xx body is
   * parsed as JSON, and an unparseable success body is a `backend` failure so a
   * caller never receives a malformed value as success (R12.5).
   */
  private async sendJson<T>(
    spec: {
      readonly method: HttpRequest["method"];
      readonly path: string;
      readonly body?: unknown;
    },
    bearerToken: string | undefined,
  ): Promise<PlatformResult<T>> {
    const headers: Record<string, string> = {};
    if (bearerToken !== undefined) {
      headers["authorization"] = `Bearer ${bearerToken}`;
    }
    if (spec.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const request: HttpRequest = {
      method: spec.method,
      url: `${this.baseUrl}${spec.path}`,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    };

    let response;
    try {
      response = await this.transport.send(request);
    } catch (error) {
      // A rejected transport is a genuine connection failure (offline, DNS,
      // TLS, timeout): the request never got a response (R12.5).
      return { ok: false, failure: { kind: "network", message: messageOf(error) } };
    }

    if (response.status >= HTTP_OK && response.status < HTTP_MULTIPLE_CHOICES) {
      return parseSuccessBody<T>(response.body);
    }

    return { ok: false, failure: failureForStatus(response.status, response.body) };
  }
}

// ---------------------------------------------------------------------------
// Free helpers (pure)
// ---------------------------------------------------------------------------

/** The canonical `unauthenticated` failure result. */
function unauthenticated(message: string): PlatformResult<never> {
  return { ok: false, failure: { kind: "unauthenticated", message } };
}

/**
 * Encode a {@link MazeParams} scope as the query string the `GET` routes expect
 * (`rows=&columns=&seed=&timeLimitSeconds=`), matching the server's
 * `parseMazeParamsQuery` contract. Kept a single function so the SDK and the
 * routes agree on the scope encoding.
 */
function mazeParamsQuery(params: MazeParams): string {
  return (
    `rows=${params.rows}` +
    `&columns=${params.columns}` +
    `&seed=${params.seed}` +
    `&timeLimitSeconds=${params.timeLimitSeconds}`
  );
}

/** Parse a 2xx body as JSON, mapping an unparseable body to a `backend` failure. */
function parseSuccessBody<T>(body: string): PlatformResult<T> {
  // An empty 2xx body decodes to `undefined`; callers of these routes always
  // expect a JSON object, so treat empty as a backend fault too.
  if (body.length === 0) {
    return { ok: false, failure: { kind: "backend", message: "empty response body" } };
  }
  try {
    return { ok: true, value: JSON.parse(body) as T };
  } catch {
    return {
      ok: false,
      failure: { kind: "backend", message: "malformed response body" },
    };
  }
}

/**
 * Map a non-2xx status to its typed {@link PlatformFailure}, mirroring the
 * design's Error Handling table. The response body's `error` field (when
 * present) is surfaced as the message so the UI can show the server's reason.
 */
function failureForStatus(status: number, body: string): PlatformFailure {
  const message = errorMessageFrom(body, status);
  if (status === HTTP_UNAUTHORIZED) {
    return { kind: "unauthenticated", message };
  }
  if (status === HTTP_BAD_REQUEST) {
    return { kind: "validation", message };
  }
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return { kind: "rate-limited", message };
  }
  // Any other non-2xx (5xx, or an unexpected 4xx) is an unexpected backend
  // fault from the client's perspective.
  return { kind: "backend", message };
}

/**
 * Extract a human-readable reason from an error response body. The service
 * handlers return `{ error: string }`; fall back to the raw body (or the status)
 * when it is not that shape, so the message is always something displayable and
 * never a full token or credential (R11.4 — the API never puts those in `error`).
 */
function errorMessageFrom(body: string, status: number): string {
  if (body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const { error } = parsed;
        if (typeof error === "string") {
          return error;
        }
      }
    } catch {
      // Not JSON; fall through to the raw body.
    }
    return body;
  }
  return `request failed with status ${status}`;
}

/** Reduce an unknown thrown/rejected value to a display string. */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
