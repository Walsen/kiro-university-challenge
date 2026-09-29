/**
 * Server-side account-lifecycle port (ports-and-adapters).
 *
 * `AccountData` is the abstraction the account-deletion Lambda depends on to
 * erase an account's own data on request (R11.5). It is kept **separate** from
 * `ScoreRepository`/`LeaderboardQuery` (Interface Segregation): erasing an
 * account is a distinct concern from persisting scores or reading a ranking, and
 * only the delete Lambda needs it — so only that function's IAM role is granted
 * the destructive access, keeping every other handler read-only or read/write
 * over the same table with no delete capability.
 *
 * Implemented by `DynamoAccountData` in the server edges layer; substituted by an
 * in-memory fake in tests. No storage-provider type appears in this contract, so
 * the store can be swapped behind the port without changing the handler
 * (Dependency Inversion).
 *
 * ## Stated data policy (R11.5)
 *
 * When a Player requests deletion of **their own** Account, the platform
 * **irreversibly deletes** every item the application owns under that account's
 * partition (`ACCT#<accountId>`):
 *
 *  - the **profile** item (`PROFILE`) — the account's personal data, i.e. its
 *    Player-chosen `displayName`;
 *  - every **Score** item (`SCORE#…`) — the account's private run history; and
 *  - every **personal-best** item (`BEST#…`).
 *
 * Because a Score item carries its own leaderboard-index attributes
 * (`GSI1PK`/`GSI1SK`) on the *same* item (see `DynamoScoreRepository`), deleting
 * the base item also removes its leaderboard projection: a deleted Player's
 * private identity is not retained anywhere, and their entries leave the public
 * leaderboard. Nothing is anonymized-in-place and kept — the data is **removed**,
 * and the removal is **irreversible** (there is no soft-delete or tombstone the
 * account can be restored from).
 *
 * Scope: this port owns the **application's** copy of the account's personal
 * data and private scores, which R11.5 requires be erased. The account's
 * identity record in the external identity provider (Cognito) is a separate
 * concern the composition root may additionally trigger; erasing the
 * app-owned data here satisfies R11.5 on its own.
 *
 * Requirement: R11.5 (account deletion / data policy).
 */

/**
 * The outcome of deleting an account's data (R11.5).
 *
 * `itemsDeleted` reports how many app-owned items were removed under the
 * account's partition (profile + scores + personal bests). Zero is a normal,
 * successful outcome — an account that never recorded a score and whose profile
 * was already gone has nothing left to erase, and deletion is idempotent: a
 * repeated request simply finds nothing and reports zero. Provider-agnostic: it
 * states the fact a caller reacts to, not how any store recorded the removal.
 */
export interface DeleteAccountResult {
  /** The number of app-owned items removed under the account's partition. */
  readonly itemsDeleted: number;
}

/**
 * The account-erasure capability the deletion handler depends on. Implemented by
 * `DynamoAccountData` (server edges); substituted by an in-memory fake in tests.
 *
 * Scoped to a single `accountId` at the port boundary so a caller can only ever
 * erase its **own** account (R11.2, R11.5): the handler passes the JWT `sub` and
 * nothing else, and this interface offers no way to name another account's data.
 */
export interface AccountData {
  /**
   * Irreversibly delete every app-owned item under `accountId` — profile,
   * scores, and personal bests, together with their leaderboard-index
   * projections — per the stated data policy above (R11.5). Idempotent: an
   * account with nothing left to erase resolves to `{ itemsDeleted: 0 }` rather
   * than failing.
   */
  deleteAccount(accountId: string): Promise<DeleteAccountResult>;
}
