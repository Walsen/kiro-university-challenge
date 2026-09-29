/**
 * Shared HTTP-handler seam and helpers for the Phase 2a service Lambdas
 * (tasks 7.1–7.3).
 *
 * The Score, personal-history, and leaderboard Lambdas all sit behind the same
 * API Gateway **HTTP API** (payload format 2.0) and share the same concerns:
 * read the acting account from the JWT authorizer's request context, parse the
 * maze-parameter scope from the query string, and shape a JSON response. Those
 * concerns live here once so each handler is just orchestration — parse the
 * request, call the pure core / a port, shape the response — and so per-account
 * isolation is enforced by one well-tested helper rather than re-derived per
 * route (R11.2).
 *
 * ## Boundary, not an adapter
 *
 * A handler is the composition/orchestration seam of the hexagon: it depends on
 * the ports (`ScoreRepository`, `LeaderboardQuery`) and the pure core
 * (`validateSubmission`), never on the AWS SDK. To keep that true without
 * pulling in `@types/aws-lambda`, the small slice of the API Gateway v2 event
 * and result this layer needs is transcribed here as narrow local types. The
 * real event the runtime passes satisfies these shapes structurally; a test
 * constructs a plain object of the same shape. No `aws-lambda` type leaks past
 * this module (hexagonal Dependency Rule).
 *
 * ## Untrusted input
 *
 * The request body and query string are untrusted and enter as `unknown` /
 * strings; they are parsed defensively here and by `validateSubmission`
 * (data-model steering "validate at the boundary"). The acting account id is
 * taken **only** from the validated JWT claims in the request context — never
 * from a client-supplied field — so a caller cannot act as another account
 * (R11.2).
 */
import type { MazeParams } from "../../core/validateSubmission";

// ---------------------------------------------------------------------------
// Narrow API Gateway HTTP API (payload v2.0) event/result slice
// ---------------------------------------------------------------------------

/**
 * The JWT authorizer's contribution to the request context: the validated
 * token's claims. API Gateway places the Cognito `sub` (and other claims) here
 * only after the authorizer has admitted the caller, so reading `sub` from it is
 * trustworthy — it is the acting account identity (R11.2). Absent on a public
 * (unauthorized) route.
 */
export interface JwtAuthorizerContext {
  readonly jwt?: {
    readonly claims?: Readonly<Record<string, unknown>>;
  };
}

/** The request-context slice a handler reads (identity only). */
export interface RequestContext {
  readonly authorizer?: JwtAuthorizerContext;
}

/**
 * The slice of the API Gateway v2 proxy event the handlers use. Kept minimal
 * (Interface Segregation): a body, the query-string parameters, and the
 * authorizer context. The runtime event is a superset of this shape.
 */
export interface HttpApiEvent {
  readonly body?: string | null;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly requestContext?: RequestContext;
}

/** The proxy result shape API Gateway expects back (payload v2.0). */
export interface HttpApiResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A handler: an async function from the narrow event to a JSON result. */
export type HttpApiHandler = (event: HttpApiEvent) => Promise<HttpApiResult>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const JSON_CONTENT_TYPE = { "content-type": "application/json" } as const;

/** Shape a JSON success/error response with the given status code. */
export function jsonResponse(statusCode: number, payload: unknown): HttpApiResult {
  return {
    statusCode,
    headers: JSON_CONTENT_TYPE,
    body: JSON.stringify(payload),
  };
}

/**
 * A 401 for a request that reached a handler without a usable account identity.
 * The JWT authorizer rejects unauthenticated callers at the edge before the
 * handler runs (R4.3, R5.3), so this is defence in depth for a protected route
 * whose context is unexpectedly missing the `sub` claim — it never discloses
 * why beyond "unauthorized".
 */
export function unauthorized(): HttpApiResult {
  return jsonResponse(401, { error: "unauthorized" });
}

/** A 400 for a malformed request or an invalid submission (R4.4). */
export function badRequest(reason: string): HttpApiResult {
  return jsonResponse(400, { error: reason });
}

// ---------------------------------------------------------------------------
// Graceful degradation / load posture (R7.2, R7.3)
// ---------------------------------------------------------------------------

/**
 * The concurrent-player target the Phase 2a services are designed and load-
 * tested against (the design's adopted default — see "Open Design Decisions").
 * Documented here, at the handler seam, so the budget the platform commits to is
 * co-located with the code that upholds it and can be asserted by the load test
 * (task 9.3) and the G2 checkpoint (task 12). The associated read budgets are
 * top-50 leaderboard p95 < 300 ms and leaderboard freshness < 2 s.
 *
 * Beyond this target the serverless stack (API Gateway + Lambda + on-demand
 * DynamoDB) auto-scales; when a downstream store nonetheless signals it is at
 * capacity, the affected request is shed with {@link tooManyRequests} rather
 * than surfaced as an ambiguous fault, so already-accepted Scores are never
 * corrupted (R7.3).
 */
export const CONCURRENT_PLAYER_TARGET = 1_000;

/**
 * The `Retry-After` hint (in seconds) sent with a {@link tooManyRequests}
 * response. A small, fixed backoff is enough to smooth a transient capacity
 * spike; it is advisory, and the submission is idempotent (R7.4), so a client
 * that retries after this delay cannot create a duplicate Score.
 */
const RETRY_AFTER_SECONDS = 1;

/** The DynamoDB/throttling error `name`s that mean "at capacity, retryable". */
const CAPACITY_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "TooManyRequestsException",
]);

/**
 * A `429 Too Many Requests` for a request shed because a downstream dependency
 * is at capacity (R7.3). It carries a `Retry-After` header and a typed,
 * machine-readable body (`error: "capacity_exceeded"`, `retryable: true`) so the
 * client can distinguish a transient, retryable capacity signal from a `4xx`
 * client error or an opaque `5xx` fault — a clear indication rather than
 * corrupting or losing an accepted Score. The write that triggered this was
 * rejected wholesale by the store, so nothing was partially persisted.
 */
export function tooManyRequests(): HttpApiResult {
  return {
    statusCode: 429,
    headers: { ...JSON_CONTENT_TYPE, "retry-after": String(RETRY_AFTER_SECONDS) },
    body: JSON.stringify({ error: "capacity_exceeded", retryable: true }),
  };
}

/**
 * Whether `error` is a downstream capacity/throttling signal that should be shed
 * as a `429` rather than propagated as a `5xx` (R7.3).
 *
 * Classification is by the AWS SDK error `name` (a plain string) and a
 * `$metadata.httpStatusCode` of 429, so this predicate stays free of any AWS SDK
 * type and can live at the handler seam without violating the Dependency Rule —
 * the adapters throw ordinary errors, and this reads their shape structurally.
 * An unrecognised error is deliberately *not* treated as capacity: only a known
 * throttling signal is retryable, everything else remains a genuine fault.
 */
export function isCapacityError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof named.name === "string" && CAPACITY_ERROR_NAMES.has(named.name)) {
    return true;
  }
  return named.$metadata?.httpStatusCode === 429;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The acting account id — the Cognito `sub` — from the JWT authorizer's request
 * context, or `null` when it is absent (which must not happen on a JWT-protected
 * route). Read here and nowhere else so every authenticated action is scoped to
 * the token's own account and can never trust a client-supplied id (R11.2).
 */
export function accountIdFrom(event: HttpApiEvent): string | null {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.["sub"];
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

// ---------------------------------------------------------------------------
// Body / query parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSON request body into `unknown`, or `null` when it is absent or not
 * valid JSON. Returning `unknown` (not a typed shape) is deliberate: the body is
 * untrusted, and the pure validator that consumes it (`validateSubmission`) does
 * the structural parsing at the boundary.
 */
export function parseJsonBody(event: HttpApiEvent): unknown {
  const { body } = event;
  if (body === undefined || body === null || body.length === 0) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * The query-string keys that encode a {@link MazeParams} scope on the `GET`
 * routes (`?rows=&columns=&seed=&timeLimitSeconds=`). Named once so the client
 * SDK, the routes, and this parser agree on the contract.
 */
export const MAZE_PARAM_KEYS = [
  "rows",
  "columns",
  "seed",
  "timeLimitSeconds",
] as const;

/**
 * Parse a maze-parameter scope from the query string, or `null` when a key is
 * missing or not an integer. The four values identify a leaderboard/personal-
 * best scope (design "API surface" `?params=`); modelling the scope as explicit
 * integer query parameters keeps it inspectable and avoids an opaque blob.
 *
 * This validates *shape* only (four integers). The stricter domain constraints
 * (positive dimensions, an in-range time limit) are the pure core's job and are
 * applied wherever the params are actually used to rebuild a maze; a leaderboard
 * read only needs a well-formed scope token, so over-validating here would
 * reject scopes the store may legitimately hold.
 */
export function parseMazeParamsQuery(event: HttpApiEvent): MazeParams | null {
  const query = event.queryStringParameters ?? {};
  const rows = parseIntegerParam(query["rows"]);
  const columns = parseIntegerParam(query["columns"]);
  const seed = parseIntegerParam(query["seed"]);
  const timeLimitSeconds = parseIntegerParam(query["timeLimitSeconds"]);
  if (
    rows === null ||
    columns === null ||
    seed === null ||
    timeLimitSeconds === null
  ) {
    return null;
  }
  return { rows, columns, seed, timeLimitSeconds };
}

/** Parse a query-string value as an integer, or `null` when absent/non-integer. */
function parseIntegerParam(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}
