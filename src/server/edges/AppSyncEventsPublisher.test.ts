import { describe, expect, it } from "vitest";

import {
  createSharedSession,
  joinSession,
  startSession,
  toProgressUpdate,
  toSnapshotUpdate,
  type SessionUpdate,
} from "../../core/platform/sharedSession";
import { AppSyncEventsPublisher } from "./AppSyncEventsPublisher";
import type { AppSyncPublisherClient } from "./appSyncPublisherClient";
import { sessionChannelPath } from "./appSyncPublisherClient";

/**
 * Unit tests for {@link AppSyncEventsPublisher} against a fake publish seam
 * (task 16.4). They assert the adapter addresses the correct session channel and
 * carries the authoritative {@link SessionUpdate} verbatim, so a subscribing
 * client receives exactly what the server projected (R9.1). No network is
 * touched; the real publish round-trip is the task 17.3 integration seam.
 */

const PARAMS = { rows: 5, columns: 5, seed: 7, timeLimitSeconds: 60 } as const;

/** A recording fake publish seam. */
class FakePublisherClient implements AppSyncPublisherClient {
  public readonly calls: Array<{ channel: string; event: Record<string, unknown> }> = [];

  public publish(
    channel: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.calls.push({ channel, event: { ...event } });
    return Promise.resolve();
  }
}

function snapshotFixture(): SessionUpdate {
  const created = createSharedSession("session-1", PARAMS, PARAMS.seed);
  if (!created.ok) throw new Error("fixture");
  const joined = joinSession(startSession(created.state), {
    participantId: "acct-alice",
    displayName: "Alice",
  });
  if (!joined.ok) throw new Error("fixture join");
  return toSnapshotUpdate(joined.state);
}

describe("AppSyncEventsPublisher", () => {
  it("publishes to the session's channel path", async () => {
    const client = new FakePublisherClient();
    const publisher = new AppSyncEventsPublisher(client);

    await publisher.publish("session-1", snapshotFixture());

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.channel).toBe(sessionChannelPath("session-1"));
  });

  it("carries the authoritative update payload verbatim", async () => {
    const client = new FakePublisherClient();
    const publisher = new AppSyncEventsPublisher(client);
    const update = snapshotFixture();

    await publisher.publish("session-1", update);

    // The published event is the update itself, so a subscriber sees exactly
    // what the server projected.
    expect(client.calls[0]?.event).toEqual(update);
  });

  it("publishes a progress diff for a single participant", async () => {
    const client = new FakePublisherClient();
    const publisher = new AppSyncEventsPublisher(client);
    const created = createSharedSession("session-1", PARAMS, PARAMS.seed);
    if (!created.ok) throw new Error("fixture");
    const joined = joinSession(startSession(created.state), {
      participantId: "acct-alice",
      displayName: "Alice",
    });
    if (!joined.ok) throw new Error("fixture");
    const alice = joined.state.participants.get("acct-alice");
    if (alice === undefined) throw new Error("fixture");

    await publisher.publish("session-1", toProgressUpdate(alice));

    expect(client.calls[0]?.event).toMatchObject({ kind: "progress" });
  });
});
