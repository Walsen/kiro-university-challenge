/**
 * Presenting typed {@link PlatformFailure}s as explicit UI states (R12.5).
 *
 * The SDK never throws for an expected failure; it resolves a typed
 * {@link PlatformFailure} whose `kind` the UI must handle so the interface is
 * never left "ambiguous or frozen" (R12.5, requirement 12.5). This module maps
 * each `kind` to a short, human-readable headline the screens render, keeping
 * that mapping in one place so every screen surfaces failures consistently.
 *
 * The SDK's `failure.message` (the server's reason or a transport detail) is
 * shown as supporting detail by the screens; it never contains a credential or
 * full token (enforced by the SDK/API, R11.4).
 */
import type { PlatformFailure } from "../../client/ports/PlatformClient";

/** A short, human-readable headline for each failure kind (R12.3, R12.5). */
export function failureHeadline(failure: PlatformFailure): string {
  switch (failure.kind) {
    case "unauthenticated":
      return "Please sign in again";
    case "validation":
      return "That request was not accepted";
    case "rate-limited":
      return "Too many requests — please retry shortly";
    case "network":
      return "Cannot reach the server";
    case "backend":
      return "Something went wrong on our end";
    default:
      return assertNever(failure);
  }
}

/**
 * Whether a failure is worth offering the Player a retry for. Transient
 * failures (network, rate-limit, backend fault) are retryable; an
 * `unauthenticated` needs re-auth and a `validation` needs corrected input, so
 * a bare retry would just fail again.
 */
export function isRetryable(failure: PlatformFailure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "rate-limited" ||
    failure.kind === "backend"
  );
}

/** Exhaustiveness guard: a new failure kind becomes a compile error here. */
function assertNever(value: never): never {
  throw new Error(`Unhandled platform failure kind: ${JSON.stringify(value)}`);
}
