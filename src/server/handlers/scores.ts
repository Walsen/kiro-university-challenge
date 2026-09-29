/**
 * The Score service Lambda handler: `POST /scores` (task 7.1).
 *
 * This is the orchestration seam of the score path (R4). It does three things
 * and nothing more: confirm the caller is authenticated, validate the submitted
 * run against the shared pure core, and persist the resulting authoritative
 * Score through the {@link ScoreRepository} port. It holds no rules of its own —
 * the maze replay and win/time enforcement live in `validateSubmission`, and
 * idempotency / personal-best live in the repository adapter — so the hexagonal
 * Dependency Rule is preserved: this module depends only on the ports and the
 * pure core, never on the AWS SDK.
 *
 * Trust boundaries (see design "Score submission and validation"):
 *  - The acting account is the JWT `sub` read via `accountIdFrom`, never a
 *    client-supplied field, so a caller can only ever persist against its own
 *    account (R11.2). A missing identity is a 401 with nothing persisted (R4.3);
 *    the JWT authorizer rejects most unauthenticated callers at the edge, this
 *    is the handler's own defence in depth.
 *  - The request body is untrusted `unknown`; `validateSubmission` parses and
 *    replays it. A malformed or non-winning run is a 400 with nothing persisted
 *    (R4.4).
 *  - The persisted time is the server-recomputed `score.elapsedMs` from the
 *    replay, never the client's advisory `clientElapsedMs` (R4.6).
 */
import {
  accountIdFrom,
  badRequest,
  isCapacityError,
  jsonResponse,
  parseJsonBody,
  tooManyRequests,
  unauthorized,
  type HttpApiHandler,
  type HttpApiResult,
} from "./http";
import { validateSubmission } from "../../core/validateSubmission";
import type { ScoreRepository } from "../ports/ScoreRepository";

/** HTTP status for a newly created resource (a first-time persisted Score). */
const HTTP_CREATED = 201;
/**
 * HTTP status for a successful-but-not-created response. An idempotent duplicate
 * submission (R7.4) already exists, so the request succeeds without creating a
 * second Score.
 */
const HTTP_OK = 200;

/** Collaborators the Score handler depends on, injected at the composition root. */
export interface ScoreHandlerDeps {
  readonly repository: ScoreRepository;
}

/**
 * Build the `POST /scores` handler over its injected dependencies.
 *
 * @param deps - the persistence port the handler orchestrates.
 * @returns an {@link HttpApiHandler} that validates and persists a score
 *   submission, returning 401 (unauthenticated), 400 (malformed / non-winning),
 *   201 (newly persisted) or 200 (idempotent duplicate).
 */
export function makeScoreHandler({ repository }: ScoreHandlerDeps): HttpApiHandler {
  return async function handleScoreSubmission(event): Promise<HttpApiResult> {
    // Identity first: without a JWT-derived account there is nothing to persist
    // against, so reject before touching the body (R4.3, R11.2).
    const accountId = accountIdFrom(event);
    if (accountId === null) {
      return unauthorized();
    }

    // Validate the untrusted body by replaying it through the shared core. This
    // yields the authoritative Score (with the server-recomputed time) or a
    // typed rejection; either way the client's claimed time is never trusted
    // (R4.4, R4.6).
    const validation = validateSubmission(parseJsonBody(event));
    if (!validation.ok) {
      return badRequest(validation.reason);
    }

    // Persist against the caller's own account. The repository is idempotent on
    // the submission's idempotency key, so a retried or concurrent duplicate
    // resolves to `persisted: false` rather than a second Score (R7.4).
    //
    // Graceful degradation (R7.3): if the store is at capacity it rejects the
    // write wholesale — nothing is partially persisted — and raises a throttling
    // error. Shed that request as a clear, retryable 429 rather than letting it
    // surface as an ambiguous 5xx; any other fault is a genuine error and
    // propagates unchanged (design "Error Handling": expected failures are typed,
    // unexpected faults are 5xx). No already-accepted Score is touched here.
    let result: Awaited<ReturnType<ScoreRepository["putScore"]>>;
    try {
      result = await repository.putScore(accountId, validation.score);
    } catch (error) {
      if (isCapacityError(error)) {
        return tooManyRequests();
      }
      throw error;
    }

    // A duplicate is still a success, but reports 200 (nothing newly created);
    // a genuine first persist reports 201. The body carries the authoritative
    // time so the client reflects the earned result, not what it submitted.
    return jsonResponse(result.persisted ? HTTP_CREATED : HTTP_OK, {
      persisted: result.persisted,
      isPersonalBest: result.isPersonalBest,
      elapsedMs: validation.score.elapsedMs,
    });
  };
}
