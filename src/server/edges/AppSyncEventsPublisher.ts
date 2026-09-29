/**
 * `AppSyncEventsPublisher` — the {@link SessionUpdatePublisher} adapter over AWS
 * AppSync Events (server side, task 16.4).
 *
 * This is the one server module that fans an authoritative {@link SessionUpdate}
 * out to a session's Participants over the real-time transport (R9.1). Per the
 * hexagonal architecture it lives in the server edges layer and depends *inward*
 * on the {@link SessionUpdatePublisher} port and the narrow
 * {@link AppSyncPublisherClient} seam; the Session handler depends only on the
 * port, so no AppSync/HTTP/SigV4 type ever leaks past this file (Dependency
 * Inversion).
 *
 * Its job is a thin translation: address the session's channel
 * (`sessions/<sessionId>`) and hand the update to the seam as the event payload.
 * The update is a plain, JSON-serializable projection of the authoritative state
 * (the pure core produced it), so it crosses the wire verbatim and the
 * subscribing client validates it back into a domain update at its own boundary
 * (data-model steering "validate at the boundary"). Only the server publishes —
 * as the IAM principal — so an update on the channel is authoritative by
 * construction (R9.2); clients are not granted publish.
 *
 * Requirements: R9.1, R9.2.
 */
import type { SessionUpdate } from "../../core/platform/sharedSession";
import type { SessionUpdatePublisher } from "../ports/SessionRepository";
import {
  type AppSyncPublisherClient,
  sessionChannelPath,
} from "./appSyncPublisherClient";

export class AppSyncEventsPublisher implements SessionUpdatePublisher {
  /**
   * @param client the AppSync Events publish seam performing the actual SigV4
   *   HTTP publish; a real client in production, a fake in tests.
   */
  public constructor(private readonly client: AppSyncPublisherClient) {}

  public async publish(sessionId: string, update: SessionUpdate): Promise<void> {
    // The update is already a plain JSON-serializable object; publish it as the
    // event payload on the session's channel. A subscriber receives it verbatim.
    await this.client.publish(sessionChannelPath(sessionId), update);
  }
}
