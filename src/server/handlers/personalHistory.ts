/**
 * The personal-history service handlers: `GET /scores/me` and
 * `GET /scores/me/best` (task 7.2).
 *
 * These are the read seams of the personal-scores path (R5). Each does only
 * orchestration — confirm the caller is authenticated, read data scoped to the
 * caller's own account through the {@link ScoreRepository} port, and shape a JSON
 * response. They hold no rules of their own, so the hexagonal Dependency Rule is
 * preserved: this module depends only on the port and the shared HTTP helpers,
 * never on the AWS SDK.
 *
 * ## Per-account isolation (R5.3, R11.2)
 *
 * The acting account is the JWT `sub` read via `accountIdFrom`, never a
 * client-supplied field, and it is the *only* account passed to the port. Every
 * `ScoreRepository` operation is scoped to a single `accountId` at the port
 * boundary, so a caller can never read another account's scores — one caller's
 * `sub` in, only that caller's scores out. A missing identity is a 401 with
 * nothing read (defence in depth behind the JWT authorizer, which rejects most
 * unauthenticated callers at the edge).
 *
 * Two separate factories rather than one router: the narrow {@link HttpApiEvent}
 * carries no route path, and API Gateway maps each route to its own handler, so
 * splitting them keeps each function single-responsibility and avoids inventing
 * a path-dispatch this layer would otherwise not need.
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
import type { PageToken, ScoreRepository } from "../ports/ScoreRepository";

/** HTTP status for a successful read. */
const HTTP_OK = 200;

/**
 * The query-string key carrying the opaque next-page cursor for `GET /scores/me`.
 * The value is a {@link PageToken} the repository previously issued; the client
 * only passes it back verbatim, never constructs or inspects it. Named once so
 * the route contract and this parser agree.
 */
const PAGE_CURSOR_KEY = "next";

/** Collaborators the personal-history handlers depend on, injected at the root. */
export interface PersonalHistoryHandlerDeps {
  readonly repository: ScoreRepository;
}

/**
 * Read the opaque page cursor from the query string, or `undefined` when absent.
 *
 * The cursor is treated as an opaque {@link PageToken}: it is passed straight
 * back to the repository that issued it, so its contents stay private to the
 * persistence adapter (the port models it as a branded, non-constructible type).
 * Casting here is the single, documented boundary where an inbound string is
 * accepted as that token.
 */
function pageCursorFrom(event: HttpApiEvent): PageToken | undefined {
  const raw = event.queryStringParameters?.[PAGE_CURSOR_KEY];
  return raw === undefined || raw.length === 0 ? undefined : (raw as PageToken);
}

/**
 * Build the `GET /scores/me` handler over its injected dependencies.
 *
 * Returns a page of ONLY the caller's own scores (R5.1), scoped to the JWT `sub`
 * (R5.3, R11.2). Supports the opaque page cursor: a `?next=` query parameter is
 * passed to the port as the {@link PageToken}, and the port's `nextPage` cursor
 * is surfaced in the response only when a further page exists.
 *
 * @param deps - the persistence port the handler reads through.
 * @returns an {@link HttpApiHandler} returning 401 (unauthenticated) or 200 with
 *   `{ items, nextPage? }`.
 */
export function makePersonalHistoryHandler({
  repository,
}: PersonalHistoryHandlerDeps): HttpApiHandler {
  return async function handlePersonalHistory(event): Promise<HttpApiResult> {
    // Identity first: the history is meaningful only for a known account, and it
    // must be the caller's own (R5.3, R11.2).
    const accountId = accountIdFrom(event);
    if (accountId === null) {
      return unauthorized();
    }

    // Scoped read: only this account's page. The cursor (if any) resumes where
    // the previous page ended.
    const page = await repository.listByAccount(accountId, pageCursorFrom(event));

    // Surface the next cursor only when the port reports a further page, so a
    // client iterates by following `nextPage` until it is absent (R5.1).
    return jsonResponse(HTTP_OK, {
      items: page.items,
      ...(page.nextPage === undefined ? {} : { nextPage: page.nextPage }),
    });
  };
}

/**
 * Build the `GET /scores/me/best` handler over its injected dependencies.
 *
 * Returns the caller's personal best for a maze-parameter scope (R5.2), scoped
 * to the JWT `sub` (R5.3, R11.2). A missing/malformed scope is a 400. A scope
 * the caller has never won is a success carrying `{ best: null }` — "no personal
 * best yet" is a normal answer, not an error.
 *
 * @param deps - the persistence port the handler reads through.
 * @returns an {@link HttpApiHandler} returning 401 (unauthenticated), 400
 *   (malformed scope), or 200 with `{ best: Score | null }`.
 */
export function makePersonalBestHandler({
  repository,
}: PersonalHistoryHandlerDeps): HttpApiHandler {
  return async function handlePersonalBest(event): Promise<HttpApiResult> {
    const accountId = accountIdFrom(event);
    if (accountId === null) {
      return unauthorized();
    }

    // A personal best is defined only relative to a maze scope; without a
    // well-formed one there is nothing to look up (R5.2).
    const params = parseMazeParamsQuery(event);
    if (params === null) {
      return badRequest("invalid maze parameters");
    }

    // Scoped read: the caller's own best for these params, or null when it has
    // never recorded a winning run for them.
    const best = await repository.personalBest(accountId, params);

    return jsonResponse(HTTP_OK, { best });
  };
}
