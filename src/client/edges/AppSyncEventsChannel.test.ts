/**
 * Unit tests for `AppSyncEventsChannel` (client edge adapter for the
 * `SessionChannel` port).
 *
 * The adapter is exercised against a fake {@link AppSyncEventsClient} seam —
 * never real AppSync (the real round-trip is the task 17.3 integration seam).
 * The fake records connect/subscribe/publish calls and lets a test drive
 * inbound channel messages, so the tests can assert the adapter's own
 * behaviour: connecting + subscribing on join, publishing an intended move for
 * server-side resolution, validating inbound JSON into a typed `SessionUpdate`
 * before fanning it out to handlers, and add/remove of update handlers.
 *
 * _Requirements: R8.1, R9.1._
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Maze } from "../../core/types";
import type { SessionUpdate } from "../ports/SessionChannel";
import { AppSyncEventsChannel } from "./AppSyncEventsChannel";
import type {
  AppSyncEventsClient,
  ChannelMessage,
  ChannelSubscription,
} from "./appSyncEventsClient";

/**
 * A fully controllable fake seam. Every method is a spy; `subscribe` captures
 * the adapter's `onMessage` callback so a test can push inbound messages, and
 * hands back a subscription whose `close` is also a spy.
 */
interface FakeClient extends AppSyncEventsClient {
  connect: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  /** Push a message to the last subscription's handler, as the server would. */
  emit(message: ChannelMessage): void;
  /** The `close` spy of the last-created subscription. */
  lastClose: ReturnType<typeof vi.fn>;
  /** The channel the adapter last subscribed to. */
  lastChannel: string | null;
}

function makeFakeClient(): FakeClient {
  let onMessage: ((m: ChannelMessage) => void) | null = null;
  const lastClose = vi.fn();
  const fake = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi
      .fn()
      .mockImplementation(
        (channel: string, handler: (m: ChannelMessage) => void) => {
          onMessage = handler;
          fake.lastChannel = channel;
          const subscription: ChannelSubscription = { close: lastClose };
          return Promise.resolve(subscription);
        },
      ),
    publish: vi.fn().mockResolvedValue(undefined),
    emit(message: ChannelMessage): void {
      if (onMessage === null) {
        throw new Error("emit called before subscribe");
      }
      onMessage(message);
    },
    lastClose,
    lastChannel: null as string | null,
  };
  return fake;
}

/** A minimal structurally-valid maze the server would carry in a snapshot. */
const MAZE = {
  rows: 1,
  columns: 2,
  grid: [["Path", "Path"]],
  start: { row: 0, column: 0 },
  exit: { row: 0, column: 1 },
} as unknown as Maze;

const PARTICIPANT = {
  participantId: "p1",
  displayName: "Player One",
  position: { row: 0, column: 0 },
  finishedRank: null,
};

describe("AppSyncEventsChannel", () => {
  let client: FakeClient;
  let channel: AppSyncEventsChannel;

  beforeEach(() => {
    client = makeFakeClient();
    channel = new AppSyncEventsChannel(client);
  });

  describe("join (R8.1, R9.1)", () => {
    it("connects with the bearer token then subscribes to the session channel", async () => {
      await channel.join("abc123", "jwt-token");

      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.connect).toHaveBeenCalledWith("jwt-token");
      expect(client.subscribe).toHaveBeenCalledTimes(1);
      expect(client.lastChannel).toBe("sessions/abc123");
    });

    it("connects before it subscribes", async () => {
      const order: string[] = [];
      client.connect.mockImplementation(() => {
        order.push("connect");
        return Promise.resolve();
      });
      client.subscribe.mockImplementation((ch: string) => {
        order.push("subscribe");
        client.lastChannel = ch;
        return Promise.resolve({ close: client.lastClose });
      });

      await channel.join("abc123", "jwt-token");

      expect(order).toEqual(["connect", "subscribe"]);
    });
  });

  describe("publishMove (server-resolved) (R9.1)", () => {
    it("publishes the intended move as a plain payload to the session channel", async () => {
      await channel.publishMove("abc123", "Up");

      expect(client.publish).toHaveBeenCalledTimes(1);
      expect(client.publish).toHaveBeenCalledWith("sessions/abc123", {
        kind: "move",
        move: "Up",
      });
    });

    it("does not resolve the move locally (no snapshot/position is computed)", async () => {
      const received: SessionUpdate[] = [];
      channel.onUpdate((u) => received.push(u));

      await channel.publishMove("abc123", "Right");

      // Publishing alone produces no client-side update; the server must echo one.
      expect(received).toEqual([]);
    });
  });

  describe("onUpdate — subscribe/unsubscribe (Observer)", () => {
    it("delivers a validated snapshot update to a registered handler", async () => {
      const received: SessionUpdate[] = [];
      channel.onUpdate((u) => received.push(u));
      await channel.join("abc123", "jwt-token");

      client.emit({
        channel: "sessions/abc123",
        data: {
          kind: "snapshot",
          maze: MAZE,
          timeLimit: 60,
          status: "Racing",
          participants: [PARTICIPANT],
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ kind: "snapshot", status: "Racing" });
    });

    it("delivers a progress update", async () => {
      const received: SessionUpdate[] = [];
      channel.onUpdate((u) => received.push(u));
      await channel.join("abc123", "jwt-token");

      client.emit({
        channel: "sessions/abc123",
        data: { kind: "progress", participant: PARTICIPANT },
      });

      expect(received).toEqual([{ kind: "progress", participant: PARTICIPANT }]);
    });

    it("fans one update out to every registered handler", async () => {
      const a = vi.fn();
      const b = vi.fn();
      channel.onUpdate(a);
      channel.onUpdate(b);
      await channel.join("abc123", "jwt-token");

      client.emit({
        channel: "sessions/abc123",
        data: { kind: "disconnect", participantId: "p1" },
      });

      expect(a).toHaveBeenCalledWith({ kind: "disconnect", participantId: "p1" });
      expect(b).toHaveBeenCalledWith({ kind: "disconnect", participantId: "p1" });
    });

    it("stops delivering to a handler after its unsubscribe is called", async () => {
      const handler = vi.fn();
      const unsubscribe = channel.onUpdate(handler);
      await channel.join("abc123", "jwt-token");

      unsubscribe();
      client.emit({
        channel: "sessions/abc123",
        data: { kind: "disconnect", participantId: "p1" },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("treats a second unsubscribe call as a safe no-op", async () => {
      const handler = vi.fn();
      const unsubscribe = channel.onUpdate(handler);
      await channel.join("abc123", "jwt-token");

      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
    });

    it("leaves other handlers registered when one unsubscribes mid-dispatch", async () => {
      const kept = vi.fn();
      let unsubscribeSelf: () => void = () => undefined;
      const removing = vi.fn(() => unsubscribeSelf());
      unsubscribeSelf = channel.onUpdate(removing);
      channel.onUpdate(kept);
      await channel.join("abc123", "jwt-token");

      client.emit({
        channel: "sessions/abc123",
        data: { kind: "disconnect", participantId: "p1" },
      });

      // Both still receive the in-flight update; only the next one is skipped.
      expect(removing).toHaveBeenCalledTimes(1);
      expect(kept).toHaveBeenCalledTimes(1);
    });
  });

  describe("boundary validation (malformed payloads are dropped)", () => {
    beforeEach(async () => {
      await channel.join("abc123", "jwt-token");
    });

    it("drops a message with an unknown kind", () => {
      const handler = vi.fn();
      channel.onUpdate(handler);

      client.emit({ channel: "sessions/abc123", data: { kind: "nope" } });

      expect(handler).not.toHaveBeenCalled();
    });

    it("drops a non-object payload", () => {
      const handler = vi.fn();
      channel.onUpdate(handler);

      client.emit({ channel: "sessions/abc123", data: "not-json-object" });

      expect(handler).not.toHaveBeenCalled();
    });

    it("drops a progress update whose participant is missing a position", () => {
      const handler = vi.fn();
      channel.onUpdate(handler);

      client.emit({
        channel: "sessions/abc123",
        data: {
          kind: "progress",
          participant: { participantId: "p1", displayName: "P", finishedRank: null },
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("drops a snapshot with an invalid status", () => {
      const handler = vi.fn();
      channel.onUpdate(handler);

      client.emit({
        channel: "sessions/abc123",
        data: {
          kind: "snapshot",
          maze: MAZE,
          timeLimit: 60,
          status: "Bogus",
          participants: [],
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("accepts a participant carrying a finished rank", () => {
      const received: SessionUpdate[] = [];
      channel.onUpdate((u) => received.push(u));

      client.emit({
        channel: "sessions/abc123",
        data: {
          kind: "result",
          participants: [{ ...PARTICIPANT, finishedRank: 1 }],
        },
      });

      expect(received).toEqual([
        { kind: "result", participants: [{ ...PARTICIPANT, finishedRank: 1 }] },
      ]);
    });
  });
});
