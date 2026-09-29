/**
 * Lambda entry for `DELETE /account/me` (task 11.2, R11.5).
 *
 * Binds the pure {@link makeDeleteAccountHandler} to the real {@link AccountData}
 * adapter from the composition root and exports it as the function's `handler`.
 * Per-account isolation (R11.2) is enforced by the handler from the JWT `sub`:
 * a caller can only ever delete its own account.
 */
import { makeDeleteAccountHandler } from "../handlers/deleteAccount";
import { serviceContext } from "./context";
import { withAccountIdAnnotation } from "./tracing";

export const handler = withAccountIdAnnotation(
  makeDeleteAccountHandler({
    accountData: serviceContext.accountData,
  }),
);
