/**
 * Internal AppSync Events seam for {@link AppSyncEventsChannel}.
 *
 * This module is the *only* place in the client that knows how the real-time
 * transport talks to AWS AppSync Events. It exposes a narrow,
 * transport-agnostic `AppSyncEventsClient` interface expressed purely in plain
 * data (no AppSync/WebSocket types in its signatures), following the same
 * pattern the identity edge uses ({@link CognitoClient} in `cognitoClient.ts`):
 * the adapter — and its unit tests — depend on this small seam rather than on an
 * SDK's connection internals, so tests inject a fake and never touch the network
 * (the real round-trip is the task 17.3 integration seam).
 *
 * The transport is the AppSync Events API provisioned in
 * `infra/realtime-channel.ts` (`maze-game-platform-realtime`), whose single
 * `sessions` channel namespace addresses a session as `/sessions/<sessionId>`.
 * Clients connect/subscribe with the Cognito JWT (`USER_POOL`); the server
 * publishes with IAM. This seam models the two client-side operations that
 * implies — subscribe to a channel, and publish a client message to a channel —
 * plus the connection lifecycle, and nothing more (Interface Segregation).
 *
 * Requirements: R8.1, R9.1.
 */

/** Milliseconds/seconds and other transport constants live with their use sites. */

/** The channel namespace shared sessions flow through, mirroring the IaC's
 * `SESSIONS_NAMESPACE_NAME`. Fixing it here keeps the adapter and the CDK naming
 * the same namespace without sharing infra code into the client bundle. */
export const SESSIONS_NAMESPACE = "sessions";

/**
 * The channel path for a given session under the shared namespace, e.g.
 * `sessions/abc123`. Centralised so the adapter never hand-builds the path.
 */
export function sessionChannelPath(sessionId: string): string {
  return `${SESSIONS_NAMESPACE}/${sessionId}`;
}

/**
 * A message received on a subscribed channel, reduced to the plain fields the
 * adapter needs. `data` is the already-parsed JSON payload as `unknown`; the
 * adapter validates it into a domain {@link SessionUpdate} at the boundary
 * (data-model steering "validate at the boundary"). No AppSync event type
 * leaks out.
 */
export interface ChannelMessage {
  /** The channel the message arrived on, e.g. `sessions/abc123`. */
  readonly channel: string;
  /** The message payload, parsed from JSON, still untyped until validated. */
  readonly data: unknown;
}

/**
 * A live subscription handle. Calling {@link ChannelSubscription.close} tears
 * down the underlying channel subscription; calling it more than once is a safe
 * no-op.
 */
export interface ChannelSubscription {
  close(): void;
}

/**
 * The real-time operations {@link AppSyncEventsChannel} depends on, each modelled
 * over plain data and a Promise where async. Implemented for real by an AppSync
 * Events WebSocket client at the composition root; faked in the adapter's unit
 * tests.
 */
export interface AppSyncEventsClient {
  /**
   * Establish the authenticated connection to the Event API using the Player's
   * bearer `token` (the Cognito JWT). Idempotent: a second call while connected
   * resolves without opening a second connection.
   */
  connect(token: string): Promise<void>;

  /**
   * Subscribe to `channel` (e.g. `sessions/abc123`), invoking `onMessage` for
   * every message the server publishes there. Resolves once the subscription is
   * established; the returned handle tears it down.
   */
  subscribe(
    channel: string,
    onMessage: (message: ChannelMessage) => void,
  ): Promise<ChannelSubscription>;

  /**
   * Publish a client message (the Player's intended move) to `channel`. The
   * server resolves it authoritatively; this seam only carries the plain
   * `payload` object across the wire.
   */
  publish(channel: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
}
