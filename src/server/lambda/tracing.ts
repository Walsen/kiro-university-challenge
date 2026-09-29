/**
 * The Lambda-entry tracing shim for the authenticated service routes (task 9.1,
 * R11.4).
 *
 * The pure {@link HttpApiHandler}s stay free of any AWS/X-Ray concern (hexagonal
 * Dependency Rule): they take the narrow HTTP event and return a result, nothing
 * more. But a trace still needs to be filterable by the acting account. This
 * module bridges that gap at the composition seam — the same place the Lambda
 * entry files bind a pure handler to its real adapters — by wrapping a handler so
 * that, on each request, it reads the JWT `sub` via the existing
 * {@link accountIdFrom} helper and records it as the trace's `accountId`
 * annotation (and nothing else) before delegating.
 *
 * The annotation is entirely delegated to {@link annotateAccountId}, so it writes
 * only the account id — never a token, credential, email, or other PII — and
 * no-ops safely when X-Ray is inactive (unit tests, local). Wrapping an
 * unauthenticated handler is harmless: with no `sub` in the context there is
 * simply nothing to annotate.
 *
 * This is a thin edge shim, not a handler rule; it changes no status code or
 * body and adds no dependency to the pure handler's signature.
 */
import { accountIdFrom, type HttpApiHandler } from "../handlers/http";
import { annotateAccountId } from "../edges/xray";

/**
 * Wrap an authenticated {@link HttpApiHandler} so each invocation annotates the
 * current trace with the caller's `accountId` (from the JWT `sub`) before
 * running the handler. Returns a handler with the identical contract.
 *
 * @param handler - the pure handler to instrument.
 * @returns a handler that annotates `accountId` then delegates unchanged.
 */
export function withAccountIdAnnotation(handler: HttpApiHandler): HttpApiHandler {
  return async function tracedHandler(event) {
    const accountId = accountIdFrom(event);
    if (accountId !== null) {
      annotateAccountId(accountId);
    }
    return handler(event);
  };
}
