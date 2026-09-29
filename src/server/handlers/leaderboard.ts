/**
 * The leaderboard service Lambda handlers: `GET /leaderboard` (public top-N) and
 * `GET /leaderboard/me` (authenticated own-rank) — task 7.3.
 *
 * These are the orchestration seam of the leaderboard path (R6). Each handler
 * parses the maze-parameter scope from the query string, calls the ranked-read
 * {@link LeaderboardQuery} port, and shapes a JSON response. They hold no ranking
 * rules of their own — ascending-by-time ordering and own-rank live in the pure
 * core / the query adapter — so the hexagonal Dependency Rule is preserved: this
 * module depends only on the port and the shared http helpers, never on the AWS
 * SDK.
 *
 * Two separate factories rather than one router (mirroring the 7.1 pattern of a
 * single `makeXHandler` per route): the two routes have different trust
 * postures, and keeping them apart lets each be wired to its own API Gateway
 * route and tested in isolation.
 *
 * Privacy boundary (R6.2, R11.3 — the reason this module exists as a seam):
 * `LeaderboardStanding` retains the private `accountId` so an authenticated
 * caller *could* highlight its own row, but the PUBLIC `GET /leaderboard`
 * response must expose only the display name, time, and rank. The projection
 * below maps `accountId` away, so the private identifier can never leak into a
 * public response even as the port's shape grows.
 */
import {
  accountIdFrom,
  badRequest,
  jsonResponse,
  parseMazeParamsQuery,
  unauthorized,
  type HttpApiEvent,
  type HttpApiHandler,
  type HttpApiResult,
} from "./http";
import type {
  LeaderboardQuery,
  LeaderboardStanding,
} from "../ports/ScoreRepository";

/** HTTP status for a successful read. */
const HTTP_OK = 200;

/**
 * The default number of standings a `GET /leaderboard` read returns when the
 * caller does not specify a `limit`. The design budgets the leaderboard around
 * the top 50 (top-50 p95 < 300 ms), so the default surfaces that segment.
 */
export const DEFAULT_LEADERBOARD_LIMIT = 50;

/**
 * The largest number of standings a single `GET /leaderboard` read may return,
 * regardless of a larger requested `limit`. Bounding the read keeps the query
 * within the design's response-time budget (R6.4) and prevents a client from
 * requesting an unbounded scan; an oversized `limit` is clamped down to this cap
 * rather than rejected, so a generous request still succeeds.
 */
export const MAX_LEADERBOARD_LIMIT = 50;

/** The query-string key carrying an optional caller-supplied result count. */
const LIMIT_QUERY_KEY = "limit";

/** Collaborators the leaderboard handlers depend on, injected at the composition root. */
export interface LeaderboardHandlerDeps {
  readonly query: LeaderboardQuery;
}

/**
 * The public projection of a standing: display name, time, and rank only. The
 * private `accountId` present on {@link LeaderboardStanding} is deliberately
 * dropped here so it can never appear in the public `GET /leaderboard` response
 * (R6.2, R11.3).
 */
interface PublicStanding {
  readonly rank: number;
  readonly displayName: string;
  readonly timeMs: number;
}

/** Map a full standing to its public, identifier-free projection (R11.3). */
function toPublicStanding(standing: LeaderboardStanding): PublicStanding {
  return {
    rank: standing.rank,
    displayName: standing.displayName,
    timeMs: standing.timeMs,
  };
}

/**
 * Resolve the effective result limit from the query string, clamped to
 * {@link MAX_LEADERBOARD_LIMIT}, or a typed rejection for a malformed value.
 *
 * An absent `limit` yields the default. A present value must be a positive
 * integer; a zero, negative, or non-integer value is a client error (400)
 * rather than being silently coerced, so a broken request is surfaced rather
 * than answered with a surprising page size. A value above the cap is clamped
 * (not rejected) so a generous-but-well-formed request still succeeds within the
 * bounded read (R6.4).
 */
function resolveLimit(
  raw: string | undefined,
): { ok: true; limit: number } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, limit: DEFAULT_LEADERBOARD_LIMIT };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false };
  }
  return { ok: true, limit: Math.min(parsed, MAX_LEADERBOARD_LIMIT) };
}

/**
 * Build the public `GET /leaderboard` handler over its injected dependencies.
 *
 * The route is unauthenticated: anyone may read the ranking. It requires a
 * well-formed maze-parameter scope (a missing or malformed scope is a 400) and
 * an optional `limit` (bounded to {@link MAX_LEADERBOARD_LIMIT}). It returns the
 * top-N standings ascending by time (R6.1), each projected to display name +
 * time + rank only — never the private account identifier (R6.2, R11.3).
 *
 * @param deps - the ranked-read port the handler orchestrates.
 * @returns an {@link HttpApiHandler} returning 400 (malformed scope / limit) or
 *   200 with the public standings.
 */
export function makeLeaderboardHandler({ query }: LeaderboardHandlerDeps): HttpApiHandler {
  return async function handlePublicLeaderboard(
    event: HttpApiEvent,
  ): Promise<HttpApiResult> {
    // A leaderboard read is scoped to a maze-parameter set; without a
    // well-formed scope there is nothing to rank (R6.1).
    const params = parseMazeParamsQuery(event);
    if (params === null) {
      return badRequest("invalid maze parameters");
    }

    const limit = resolveLimit(event.queryStringParameters?.[LIMIT_QUERY_KEY]);
    if (!limit.ok) {
      return badRequest("invalid limit");
    }

    const standings = await query.topN(params, limit.limit);

    // Project away the private identifier before it leaves the boundary: the
    // public response carries only display name + time + rank (R11.3).
    return jsonResponse(HTTP_OK, {
      standings: standings.map(toPublicStanding),
    });
  };
}

/**
 * Build the authenticated `GET /leaderboard/me` handler over its injected
 * dependencies.
 *
 * The route requires an authenticated account: the acting account is the JWT
 * `sub` read via `accountIdFrom`, never a client-supplied field (R11.2), and a
 * missing identity is a 401. It requires a well-formed maze-parameter scope (a
 * missing or malformed scope is a 400) and returns the caller's own rank for
 * that scope, or an explicit unranked marker when they have no qualifying entry
 * (R6.3).
 *
 * @param deps - the ranked-read port the handler orchestrates.
 * @returns an {@link HttpApiHandler} returning 401 (unauthenticated), 400
 *   (malformed scope), or 200 with the own-rank result.
 */
export function makeOwnRankHandler({ query }: LeaderboardHandlerDeps): HttpApiHandler {
  return async function handleOwnRank(event: HttpApiEvent): Promise<HttpApiResult> {
    // Identity first: own-rank is meaningful only for an authenticated caller,
    // so reject before parsing the scope (R6.3, R11.2). The JWT authorizer
    // rejects most unauthenticated callers at the edge; this is defence in depth.
    const accountId = accountIdFrom(event);
    if (accountId === null) {
      return unauthorized();
    }

    const params = parseMazeParamsQuery(event);
    if (params === null) {
      return badRequest("invalid maze parameters");
    }

    // The port reuses the pure `computeOwnRank` rule, so the response's meaning
    // of "rank" is exactly what the core defines (R6.3).
    const ownRank = await query.ownRank(params, accountId);

    return jsonResponse(HTTP_OK, ownRank);
  };
}
