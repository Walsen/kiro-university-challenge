/**
 * Lambda entry for the Session service (task 16.4 / 15.x wiring, Phase 2b).
 *
 * A thin shim between the AppSync Events transport and the pure Session handler.
 * It is invoked by the `sessions` channel namespace's `onPublish` handler (see
 * `infra/realtime-channel.ts`) when a client publishes an intended `join`/`move`
 * on `sessions/<sessionId>`: AppSync forwards each authorized publish to this
 * Lambda as a data source. The shim derives the trusted identity, translates
 * each untrusted client intent into a plain session command, hands it to the
 * pure {@link makeSessionHandler} bound to its real adapters at the composition
 * root ({@link sessionContext}), and reports a small per-event result. The
 * resolved authoritative update is fanned out by the handler through the
 * publisher port (server IAM publish), **not** returned here — the `onPublish`
 * handler broadcasts nothing, so the raw client intent never reaches
 * subscribers.
 *
 * ## Invocation shape (AppSync Events data source)
 *
 * The `onPublish` handler invokes this Lambda with the connection's validated
 * identity and the batch of published events:
 *
 * ```jsonc
 * {
 *   "identity": { "sub": "<cognito-sub>", "claims": { "name": "...", ... } },
 *   "channel":  "sessions/<sessionId>",
 *   "events":   [ { "id": "...", "payload": { "kind": "move", "move": "Up" } } ]
 * }
 * ```
 *
 * The single-event, `{ identity, payload }` shape the earlier direct-invocation
 * seam used is still accepted (a batch of one), so both the deployed data-source
 * path and a direct test invocation resolve identically.
 *
 * ## Trust boundary (R9.2, R11.2)
 *
 * The acting account is the Cognito `sub` from the AppSync identity context —
 * AppSync validates the client's Cognito JWT before invoking — never a
 * client-supplied field, so a client can only ever act as its own Participant.
 * The display name is likewise taken from the verified identity claims, and the
 * `sessionId` is derived from the **channel path** the client is authorized on,
 * not from the payload. The client-supplied payload contributes only the
 * intended action (`join`/`move`) and its move data, which the pure core
 * resolves authoritatively; a payload with no verified identity yields an
 * `unauthenticated` rejection with nothing persisted or published (R8.4).
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
 * the Player-chosen display name. `channel` is the channel path the client is
 * authorized to publish on (`sessions/<sessionId>`). `events` is the batch of
 * published messages, each `payload` an untrusted client intent; the legacy
 * single `payload` field is accepted as a batch of one.
 */
interface SessionInvocationEvent {
  readonly identity?: {
    readonly sub?: string;
    readonly claims?: Readonly<Record<string, unknown>>;
  };
  readonly channel?: string;
  readonly events?: ReadonlyArray<{ readonly payload?: unknown }>;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** The typed outcome the entry reports for the batch (one result per event). */
interface SessionHandlerResponse {
  readonly results: ReadonlyArray<{ ok: boolean; reason?: string }>;
}

/** The Cognito claim carrying the Player-chosen display name (mirrors sign-up). */
const DISPLAY_NAME_CLAIM = "name";

/** Shown when a verified display-name claim is absent; never the identifier (R11.3). */
const UNKNOWN_DISPLAY_NAME = "Unknown Player";

/** The channel namespace shared sessions flow through (mirrors the IaC name). */
const SESSIONS_NAMESPACE = "sessions";

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
 * Derive the `sessionId` from the authorized channel path (`sessions/<id>`).
 * The path is the trust-anchored scope AppSync authorized the publish on, so it
 * is preferred over any payload-supplied id. AppSync supplies the path with a
 * leading slash (`/sessions/<id>`), so empty segments are dropped before
 * matching — both `sessions/<id>` and `/sessions/<id>` yield `<id>`. Returns
 * `""` for anything that is not exactly the sessions namespace with a single
 * non-empty id segment (absent path, wrong namespace, or extra segments), so a
 * command with no session is rejected as `malformed` downstream.
 */
function sessionIdFrom(channel: string | undefined): string {
  if (typeof channel !== "string") {
    return "";
  }
  const segments = channel.split("/").filter((segment) => segment.length > 0);
  const [namespace, id, ...rest] = segments;
  if (namespace !== SESSIONS_NAMESPACE || rest.length > 0) {
    return "";
  }
  return id ?? "";
}

/** Narrow an unknown value to a plain object without asserting field types. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalise the batch of published events into a list of untrusted intent
 * payloads. Accepts the AppSync Events `events: [{ payload }]` shape and the
 * legacy single-`payload` shape (as a batch of one), and drops non-object
 * payloads so a stray message cannot become a command.
 */
function intentsFrom(event: SessionInvocationEvent): ReadonlyArray<Record<string, unknown>> {
  const raw =
    event.events !== undefined
      ? event.events.map((e) => e.payload)
      : [event.payload];
  return raw.filter(isRecord);
}

/**
 * Translate one untrusted client intent into a command for the pure handler,
 * overlaying the *server-derived* identity and session scope so a client cannot
 * claim another account or session (R11.2). The client's `publishMove`
 * vocabulary (`kind: "move"`, `move`) is mapped to the core command vocabulary
 * (`action: "move"`, `direction`); a `join` intent is mapped likewise. Any
 * fields the pure handler validates (`params`, `expectedSeq`) are carried
 * through from the payload and re-validated there — nothing here trusts them.
 */
function toCommand(
  intent: Record<string, unknown>,
  identity: { accountId: string; displayName: string; sessionId: string },
): Record<string, unknown> {
  // The client may speak either the wire `kind` vocabulary or the core `action`
  // vocabulary; normalise to `action`.
  const action = intent["action"] ?? intent["kind"];
  // The move direction may arrive as `direction` (core) or `move` (client).
  const direction = intent["direction"] ?? intent["move"];

  // Prefer the channel-derived session scope (the path AppSync authorized). Fall
  // back to a payload `sessionId` only when no channel was supplied — the legacy
  // direct-invocation seam, which carried the id in the payload and had no path.
  const sessionId =
    identity.sessionId.length > 0 ? identity.sessionId : intent["sessionId"];

  return {
    ...intent,
    action,
    direction,
    sessionId,
    // Server-derived, never client-supplied (R11.2).
    accountId: identity.accountId,
    displayName: identity.displayName,
  };
}

/**
 * Handle one Session invocation. Derive the trusted identity and authorized
 * session scope once, then resolve each published intent through the pure
 * handler, collecting a per-event result. Publishing/persisting happens inside
 * the pure handler via its ports; this shim returns only a small status summary
 * (the `onPublish` handler ignores the return and broadcasts nothing).
 */
export async function handler(
  event: SessionInvocationEvent,
): Promise<SessionHandlerResponse> {
  const accountId = accountIdFrom(event);
  if (accountId.length > 0) {
    annotateAccountId(accountId);
  }

  const identity = {
    accountId,
    displayName: displayNameFrom(event),
    sessionId: sessionIdFrom(event.channel),
  };

  const intents = intentsFrom(event);

  const results: Array<{ ok: boolean; reason?: string }> = [];
  for (const intent of intents) {
    const command = toCommand(intent, identity);
    const result = await sessionContext.handle(command);
    results.push(result.ok ? { ok: true } : { ok: false, reason: result.reason });
  }
  return { results };
}
