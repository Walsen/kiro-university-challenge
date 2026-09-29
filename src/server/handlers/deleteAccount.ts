/**
 * The account-deletion service handler: `DELETE /account/me` (task 11.2, R11.5).
 *
 * This is the orchestration seam of the account-erasure path. It does only
 * orchestration — confirm the caller is authenticated, erase data scoped to the
 * caller's **own** account through the {@link AccountData} port, and shape a JSON
 * response. It holds no rules of its own, so the hexagonal Dependency Rule is
 * preserved: this module depends only on the port and the shared HTTP helpers,
 * never on the AWS SDK.
 *
 * ## Per-account isolation (R11.2, R11.5)
 *
 * The acting account is the JWT `sub` read via `accountIdFrom`, never a
 * client-supplied field, and it is the *only* account passed to the port — the
 * route is `/account/me`, and a caller can delete only its own account. The
 * {@link AccountData} port offers no way to name another account's data, so a
 * caller cannot erase anyone else's. A missing identity is a 401 with nothing
 * deleted (defence in depth behind the JWT authorizer, which rejects most
 * unauthenticated callers at the edge).
 *
 * ## Stated data policy (R11.5)
 *
 * On success the platform has **irreversibly deleted** the account's app-owned
 * personal data (profile / display name), its private scores, and its personal
 * bests, along with the leaderboard-index projections carried on those score
 * items — so the deleted Player's private identity is not retained anywhere,
 * including the public leaderboard. See {@link AccountData} for the full policy.
 */
import {
  accountIdFrom,
  isCapacityError,
  jsonResponse,
  tooManyRequests,
  unauthorized,
  type HttpApiHandler,
  type HttpApiResult,
} from "./http";
import type { AccountData } from "../ports/AccountData";

/** HTTP status for a successful deletion (a normal 200 with a summary body). */
const HTTP_OK = 200;

/** Collaborators the delete-account handler depends on, injected at the root. */
export interface DeleteAccountHandlerDeps {
  readonly accountData: AccountData;
}

/**
 * Build the `DELETE /account/me` handler over its injected dependencies.
 *
 * Irreversibly erases ONLY the caller's own account data (R11.5), scoped to the
 * JWT `sub` (R11.2). Deletion is idempotent: a caller with nothing left to erase
 * still succeeds (200 with `itemsDeleted: 0`).
 *
 * @param deps - the account-erasure port the handler invokes.
 * @returns an {@link HttpApiHandler} returning 401 (unauthenticated), 429
 *   (downstream at capacity), or 200 with `{ deleted: true, itemsDeleted }`.
 */
export function makeDeleteAccountHandler({
  accountData,
}: DeleteAccountHandlerDeps): HttpApiHandler {
  return async function handleDeleteAccount(event): Promise<HttpApiResult> {
    // Identity first: erase only a known, authenticated account, and only the
    // caller's own (R11.2, R11.5). No id is ever taken from the request body or
    // query — the route is /account/me.
    const accountId = accountIdFrom(event);
    if (accountId === null) {
      return unauthorized();
    }

    // Scoped erasure: the caller's own partition only. Graceful degradation
    // (R7.3): a store at capacity is shed as a retryable 429 rather than an
    // ambiguous 5xx; any other fault propagates. A batched delete that is
    // throttled mid-way leaves the remaining items in place, and the operation
    // is idempotent, so a retry safely completes the erasure.
    let result: Awaited<ReturnType<AccountData["deleteAccount"]>>;
    try {
      result = await accountData.deleteAccount(accountId);
    } catch (error) {
      if (isCapacityError(error)) {
        return tooManyRequests();
      }
      throw error;
    }

    return jsonResponse(HTTP_OK, {
      deleted: true,
      itemsDeleted: result.itemsDeleted,
    });
  };
}
