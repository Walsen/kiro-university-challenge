/**
 * Contract tests for the `SessionChannel` client port (Phase 2b).
 *
 * The port is a pure interface (Dependency Inversion): the rest of the client
 * depends on it, and only the `AppSyncEventsChannel` adapter (task 15.2) touches
 * AppSync. These tests pin the shape of that contract so a conforming fake can
 * stand in for the real adapter in the client's tests, and assert the port
 * carries no real-time-transport-specific leakage.
 *
 * Because the port is types-only, the checks are largely compile-time: a fake
 * that implements the interface must type-check, and the `onUpdate`/`Unsubscribe`
 * observer contract must hold. The runtime assertions exercise that fake to keep
 * the contract executable rather than purely structural.
 *
 * Requirements: R8.1 (same maze for all participants), R9.1 (realtime transport).
 */
import { describe, expect, it, vi } from "vitest";

import type { Direction } from "../../core/types";
import type {
  SessionChannel,
  SessionUpdate,
  Unsubscribe,
} from "./SessionChannel";

/**
 * A minimal in-memory fake implementing the whole port. Its existence and
 * type-checking is the primary assertion: the interface is implementable
 * without reference to any AppSync/WebSocket type. It keeps enough state (the
 * registered handlers) to exercise the observer contract at runtime, and lets a
 * test push updates via {@link FakeSessionChannel.push}.
 */
class FakeSessionChannel implements SessionChannel {
  private readonly handlers = new Set<(u: SessionUpdate) => void>();
  public readonly published: Array<{ sessionId: string; move: Direction }> = [];
  public joined: { sessionId: string; token: string } | null = null;

  join(sessionId: string, token: string): Promise<void> {
    this.joined = { sessionId, token };
    return Promise.resolve();
  }

  publishMove(sessionId: string, move: Direction): Promise<void> {
    this.published.push({ sessionId, move });
    return Promise.resolve();
  }

  onUpdate(handler: (u: SessionUpdate) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Fan an update out to the registered handlers, as the adapter would. */
  push(update: SessionUpdate): void {
    for (const handler of [...this.handlers]) {
      handler(update);
    }
  }
}

describe("SessionChannel port contract", () => {
  it("is implementable by a fake without any transport types (R8.1, R9.1)", () => {
    const channel: SessionChannel = new FakeSessionChannel();
    expect(channel).toBeInstanceOf(FakeSessionChannel);
  });

  it("join and publishMove take a sessionId and an intended Direction (R9.1)", async () => {
    const channel = new FakeSessionChannel();

    await channel.join("abc123", "jwt-token");
    await channel.publishMove("abc123", "Up");

    expect(channel.joined).toEqual({ sessionId: "abc123", token: "jwt-token" });
    expect(channel.published).toEqual([{ sessionId: "abc123", move: "Up" }]);
  });

  it("onUpdate delivers updates until its Unsubscribe is called (R9.1)", () => {
    const channel = new FakeSessionChannel();
    const handler = vi.fn();
    const unsubscribe = channel.onUpdate(handler);

    channel.push({ kind: "disconnect", participantId: "p1" });
    unsubscribe();
    channel.push({ kind: "disconnect", participantId: "p2" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ kind: "disconnect", participantId: "p1" });
  });
});
