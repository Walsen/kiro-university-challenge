/**
 * Lambda entry for the Session service (task 16.4, Phase 2b).
 *
 * A thin shim: translate the invocation event into a plain session command,
 * hand it to the pure {@link makeSessionHandler} bound to its real adapters at
 * the composition root ({@link sessionContext}), and shape a small result. The
 * function is invoked by the AppSync Events channel handler when a client
 * publishes an intended `join`/`move` on `sessions/<sessionId>`; the resolved
 * authoritative update is fanned out by the handler through the publisher port,
 * not returned here.
 *
 * ## Trust boundary (R9.2, R11.2)
 *
 * The acting account is the Cognito `sub` from the AppSync identity context —
 * AppSync validates the client's Cognito JWT before invoking — never a
 * client-supplied field, so a client can only ever act as its own Participant.
 * The display name is likewise taken from the verified identity claims. The
 * client-supplied payload contributes only the intended move / session scope,
 * which the pure core resolves authoritatively; a payload with no verified
 * identity yields an `unauthenticated` rejection with nothing persisted or
 * published (R8.4).
 *
 * The trace is annotated with the acting `accountId` only (R11.4) before the
 * handler runs, mirroring the HTTP services; annotation no-ops when X-Ray is
 * inactive so unit runs stay deterministic.
 */
import { annotateAccountId } from "../edges/xray";
import { sessionContext } from "./sessionContext";

/**
 * The slice of the AppSync Events invocation the entry reads. Transcribed as a
 * narrow local type (rather than pulling in `@types/aws-lambda`) so nothing
 * provider-specific is needed to type it; the runtime event is a superset.
 *
 * `identity.claims` are the validated Cognito JWT claims AppSync attaches after
 * authorizing the connection — `sub` is the authoritative account id and `name`
 * the Player-chosen display name. `payload` is the untrusted client message
 * (the intended `join`/`move`).
 */
interface SessionInvocationEvent {
  readonly identity?: {
    readonly sub?: string;
    readonly claims?: Readonly<Record<string, unknown>>;
  };
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** The Cognito claim carrying the Player-chosen display name (mirrors sign-up). */
const DISPLAY_NAME_CLAIM = "name";

/** Shown when a verified display-name claim is absent; never the identifier (R11.3). */
const UNKNOWN_DISPLAY_NAME = "Unknown Player";

/**
 * Read the acting account id from the AppSync identity context. AppSync places
 * the validated `sub` either directly on `identity.sub` or within `claims`;
 * accept either so the entry is robust to the identity shape.
 */
function accountIdFrom(event: SessionInvocationEvent): string {
  const direct = event.identity?.sub;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const claim = event.identity?.claims?.["sub"];
  return typeof claim === "string" ? claim : "";
}

/** Read the verified display name from the identity claims, or a safe fallback. */
function displayNameFrom(event: SessionInvocationEvent): string {
  const claim = event.identity?.claims?.[DISPLAY_NAME_CLAIM];
  return typeof claim === "string" && claim.length > 0 ? claim : UNKNOWN_DISPLAY_NAME;
}

/**
 * Handle one Session invocation: derive the trusted identity, merge it into the
 * untrusted client payload as the command's `accountId`/`displayName` (server
 * trust boundary), and delegate to the pure handler.
 */
export async function handler(
  event: SessionInvocationEvent,
): Promise<{ ok: boolean; reason?: string }> {
  const accountId = accountIdFrom(event);
  if (accountId.length > 0) {
    annotateAccountId(accountId);
  }

  // The command is the client payload with the *server-derived* identity fields
  // overlaid, so a client cannot claim another account (R11.2).
  const command = {
    ...(event.payload ?? {}),
    accountId,
    displayName: displayNameFrom(event),
  };

  const result = await sessionContext.handle(command);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
