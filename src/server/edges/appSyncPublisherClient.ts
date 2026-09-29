/**
 * Internal AppSync Events *publish* seam for {@link AppSyncEventsPublisher}
 * (server side, task 16.4).
 *
 * This is the server counterpart to the client's `appSyncEventsClient` seam.
 * It is the only place on the server that knows how an authoritative update
 * reaches AWS AppSync Events: the server publishes with IAM (SigV4) to the Event
 * API's HTTP endpoint, on the `sessions` channel namespace, addressing a session
 * as `sessions/<sessionId>` (see `infra/realtime-channel.ts`). The interface is
 * expressed purely in plain data — a channel path and a JSON-serializable
 * payload — so the publishing adapter and its unit tests depend on this narrow
 * seam rather than on an HTTP/SigV4 client, and inject a fake in tests
 * (Interface Segregation, Dependency Inversion). The real SigV4 HTTP client is
 * constructed at the Lambda composition root; the real round-trip is the task
 * 17.3 integration seam.
 *
 * Requirements: R9.1 (publish authoritative updates over the real-time
 * transport), R9.2 (only the server, as the IAM principal, publishes).
 */

/** The channel namespace shared sessions flow through (mirrors the IaC name). */
export const SESSIONS_NAMESPACE = "sessions";

/**
 * The channel path for a given session under the shared namespace, e.g.
 * `sessions/abc123`. Centralised so the adapter never hand-builds the path.
 */
export function sessionChannelPath(sessionId: string): string {
  return `${SESSIONS_NAMESPACE}/${sessionId}`;
}

/**
 * The single publish operation {@link AppSyncEventsPublisher} depends on,
 * modelled over plain data and a Promise. Implemented for real by a SigV4 HTTP
 * client against the Event API endpoint at the composition root; faked in the
 * adapter's unit tests.
 */
export interface AppSyncPublisherClient {
  /**
   * Publish one already-serialized event to `channel` (e.g. `sessions/abc123`).
   * The payload is a plain JSON-serializable object; the seam carries it across
   * the wire and does not interpret it.
   */
  publish(channel: string, event: Readonly<Record<string, unknown>>): Promise<void>;
}
