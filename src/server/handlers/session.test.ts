import { beforeEach, describe, expect, it } from "vitest";

import { CellKind } from "../../core/types";
import {
  SESSION_CAPACITY,
  createSharedSession,
  type SessionUpdate,
  type SharedSessionState,
} from "../../core/platform/sharedSession";
import type {
  SessionRepository,
  SessionUpdatePublisher,
} from "../ports/SessionRepository";
import { makeSessionHandler, type SessionCommandResult } from "./session";

/**
 * Unit tests for the Session service application handler (Task 16.4).
 *
 * The handler is the orchestration seam of the shared-session path (R8, R9): it
 * confirms the actor is authenticated, applies the pure shared-session core
 * (`createSharedSession` / `joinSession` / `resolveSessionMove`) against the
 * authoritative state loaded from the {@link SessionRepository}, persists the
 * result, and publishes the authoritative diff through the
 * {@link SessionUpdatePublisher}. It holds no rules of its own — capacity /
 * ended enforcement and move resolution live in the pure core — so these tests
 * fake both edges and assert the handler *delegates* correctly: persists and
 * publishes on a change, and does neither on a rejection (server-authoritative,
 * R9.2/R9.3).
 *
 * _Validates: Requirements 8.1, 8.3, 8.4, 9.1, 9.4, 9.5_
 */

const PARAMS = { rows: 5, columns: 5, seed: 4242, timeLimitSeconds: 60 } as const;

/** An in-memory {@link SessionRepository} fake recording loads and saves. */
class FakeSessionRepository implements SessionRepository {
  private readonly store = new Map<string, SharedSessionState>();
  public saves = 0;

  public seed(state: SharedSessionState): void {
    this.store.set(state.sessionId, state);
  }

  public load(sessionId: string): Promise<SharedSessionState | null> {
    return Promise.resolve(this.store.get(sessionId) ?? null);
  }

  public save(state: SharedSessionState): Promise<void> {
    this.saves += 1;
    this.store.set(state.sessionId, state);
    return Promise.resolve();
  }

  public current(sessionId: string): SharedSessionState | null {
    return this.store.get(sessionId) ?? null;
  }
}

/** A recording {@link SessionUpdatePublisher} fake capturing every publish. */
class FakePublisher implements SessionUpdatePublisher {
  public readonly published: Array<{ sessionId: string; update: SessionUpdate }> = [];

  public publish(sessionId: string, update: SessionUpdate): Promise<void> {
    this.published.push({ sessionId, update });
    return Promise.resolve();
  }

  public kinds(): ReadonlyArray<SessionUpdate["kind"]> {
    return this.published.map((p) => p.update.kind);
  }
}

let repository: FakeSessionRepository;
let publisher: FakePublisher;
let handle: (command: unknown) => Promise<SessionCommandResult>;

beforeEach(() => {
  repository = new FakeSessionRepository();
  publisher = new FakePublisher();
  handle = makeSessionHandler({ repository, publisher });
});

/** A Racing session with the given participants already seated, persisted. */
function seedRacingWith(
  participants: ReadonlyArray<{ id: string; name: string }>,
): SharedSessionState {
  const created = createSharedSession("session-1", PARAMS, PARAMS.seed);
  if (!created.ok) throw new Error("fixture maze must be constructible");
  const seated = new Map(
    participants.map(({ id, name }) => [
      id,
      {
        participantId: id,
        displayName: name,
        position: created.state.maze.start,
        moveSeq: 0,
        status: "Racing" as const,
      },
    ]),
  );
  const racing: SharedSessionState = {
    ...created.state,
    participants: seated,
    status: "Racing",
  };
  repository.seed(racing);
  return racing;
}

describe("session handler — unauthenticated", () => {
  it("rejects a command with no acting account and touches no edge (R8.4)", async () => {
    const result = await handle({
      action: "join",
      sessionId: "session-1",
      accountId: "",
      displayName: "Nobody",
      params: PARAMS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unauthenticated");
    expect(repository.saves).toBe(0);
    expect(publisher.published).toHaveLength(0);
  });
});

describe("session handler — join", () => {
  it("creates a server-owned session on first join and seats the joiner (R8.1)", async () => {
    const result = await handle({
      action: "join",
      sessionId: "session-1",
      accountId: "acct-alice",
      displayName: "Alice",
      params: PARAMS,
    });

    expect(result.ok).toBe(true);
    const state = repository.current("session-1");
    expect(state).not.toBeNull();
    // The maze was built by the server from params+seed, not supplied by the client.
    expect(state?.maze.rows).toBe(PARAMS.rows);
    const participant = state?.participants.get("acct-alice");
    expect(participant?.displayName).toBe("Alice");
    expect(participant?.position).toEqual(state?.maze.start);
  });

  it("publishes a snapshot so the joiner receives authoritative state (R9.4)", async () => {
    await handle({
      action: "join",
      sessionId: "session-1",
      accountId: "acct-alice",
      displayName: "Alice",
      params: PARAMS,
    });

    expect(publisher.kinds()).toContain("snapshot");
    const snapshot = publisher.published.find((p) => p.update.kind === "snapshot");
    expect(snapshot?.sessionId).toBe("session-1");
  });

  it("rejects a join beyond the stated capacity and publishes nothing new (R8.3)", async () => {
    // Fill the session to capacity.
    const full = Array.from({ length: SESSION_CAPACITY }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
    }));
    seedRacingWith(full);
    publisher.published.length = 0;
    const savesBefore = repository.saves;

    const result = await handle({
      action: "join",
      sessionId: "session-1",
      accountId: "late",
      displayName: "Late",
      params: PARAMS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("session-full");
    expect(repository.saves).toBe(savesBefore);
    expect(publisher.published).toHaveLength(0);
  });

  it("rejects a join on an ended session and says why (R8.3)", async () => {
    const created = createSharedSession("session-1", PARAMS, PARAMS.seed);
    if (!created.ok) throw new Error("fixture");
    repository.seed({ ...created.state, status: "Ended" });
    const savesBefore = repository.saves;

    const result = await handle({
      action: "join",
      sessionId: "session-1",
      accountId: "acct-alice",
      displayName: "Alice",
      params: PARAMS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("session-ended");
    expect(repository.saves).toBe(savesBefore);
  });

  it("re-join by an existing participant is idempotent (reconnect, R9.5) and re-sends a snapshot", async () => {
    seedRacingWith([{ id: "acct-alice", name: "Alice" }]);
    publisher.published.length = 0;

    const result = await handle({
      action: "join",
      sessionId: "session-1",
      accountId: "acct-alice",
      displayName: "Alice",
      params: PARAMS,
    });

    expect(result.ok).toBe(true);
    expect(repository.current("session-1")?.participants.size).toBe(1);
    // A reconnect must restore the current authoritative state to the client.
    expect(publisher.kinds()).toContain("snapshot");
  });
});

describe("session handler — move (server-authoritative, R9.2/R9.3)", () => {
  it("resolves a legal move, persists the advance, and publishes progress (R9.1)", async () => {
    const racing = seedRacingWith([{ id: "acct-alice", name: "Alice" }]);
    publisher.published.length = 0;
    const savesBefore = repository.saves;

    const direction = firstLegalDirection(racing, "acct-alice");
    const result = await handle({
      action: "move",
      sessionId: "session-1",
      accountId: "acct-alice",
      direction,
      expectedSeq: 0,
    });

    expect(result.ok).toBe(true);
    // The authoritative position advanced and was persisted.
    expect(repository.saves).toBe(savesBefore + 1);
    const moved = repository.current("session-1")?.participants.get("acct-alice");
    expect(moved?.moveSeq).toBe(1);
    // A minimal progress diff was published for the participant that advanced.
    expect(publisher.kinds()).toContain("progress");
    const progress = publisher.published.find((p) => p.update.kind === "progress");
    if (progress?.update.kind === "progress") {
      expect(progress.update.participant.participantId).toBe("acct-alice");
    }
  });

  it("rejects an illegal move without changing state or publishing (R9.3)", async () => {
    const racing = seedRacingWith([{ id: "acct-alice", name: "Alice" }]);
    publisher.published.length = 0;
    const savesBefore = repository.saves;

    const illegal = firstIllegalDirection(racing, "acct-alice");
    const result = await handle({
      action: "move",
      sessionId: "session-1",
      accountId: "acct-alice",
      direction: illegal,
      expectedSeq: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal-move");
    // No authoritative change was persisted and nothing was published.
    expect(repository.saves).toBe(savesBefore);
    expect(publisher.published).toHaveLength(0);
    expect(repository.current("session-1")?.participants.get("acct-alice")?.moveSeq).toBe(
      0,
    );
  });

  it("rejects a stale / out-of-order move, leaving the position unchanged (R9.3)", async () => {
    const racing = seedRacingWith([{ id: "acct-alice", name: "Alice" }]);
    // Advance once so the authoritative seq is 1.
    const dir = firstLegalDirection(racing, "acct-alice");
    await handle({
      action: "move",
      sessionId: "session-1",
      accountId: "acct-alice",
      direction: dir,
      expectedSeq: 0,
    });
    publisher.published.length = 0;
    const savesBefore = repository.saves;

    const result = await handle({
      action: "move",
      sessionId: "session-1",
      accountId: "acct-alice",
      direction: dir,
      expectedSeq: 0, // stale
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("out-of-order");
    expect(repository.saves).toBe(savesBefore);
    expect(publisher.published).toHaveLength(0);
  });

  it("rejects a move against a session that does not exist", async () => {
    const result = await handle({
      action: "move",
      sessionId: "missing",
      accountId: "acct-alice",
      direction: "Right",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown-session");
    expect(publisher.published).toHaveLength(0);
  });
});

describe("session handler — malformed commands", () => {
  it("rejects an unknown action as malformed and touches no edge", async () => {
    const result = await handle({ action: "explode", accountId: "acct-alice" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
    expect(repository.saves).toBe(0);
    expect(publisher.published).toHaveLength(0);
  });

  it("rejects a non-object command as malformed", async () => {
    const result = await handle(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });
});

// ---------------------------------------------------------------------------
// Helpers: discover legal/illegal directions on the seeded maze
// ---------------------------------------------------------------------------

const DIRECTIONS = ["Up", "Down", "Left", "Right"] as const;
type Dir = (typeof DIRECTIONS)[number];

function firstLegalDirection(state: SharedSessionState, participantId: string): Dir {
  const start = state.participants.get(participantId)?.position;
  if (start === undefined) throw new Error("participant not seated");
  for (const direction of DIRECTIONS) {
    const target = step(start, direction);
    if (isPath(state, target)) {
      return direction;
    }
  }
  throw new Error("no legal direction from start");
}

function firstIllegalDirection(state: SharedSessionState, participantId: string): Dir {
  const start = state.participants.get(participantId)?.position;
  if (start === undefined) throw new Error("participant not seated");
  for (const direction of DIRECTIONS) {
    const target = step(start, direction);
    if (!isPath(state, target)) {
      return direction;
    }
  }
  throw new Error("no illegal direction from start");
}

function step(
  position: { row: number; column: number },
  direction: Dir,
): { row: number; column: number } {
  switch (direction) {
    case "Up":
      return { row: position.row - 1, column: position.column };
    case "Down":
      return { row: position.row + 1, column: position.column };
    case "Left":
      return { row: position.row, column: position.column - 1 };
    case "Right":
      return { row: position.row, column: position.column + 1 };
  }
}

function isPath(
  state: SharedSessionState,
  position: { row: number; column: number },
): boolean {
  const { maze } = state;
  if (
    position.row < 0 ||
    position.column < 0 ||
    position.row >= maze.rows ||
    position.column >= maze.columns
  ) {
    return false;
  }
  return maze.grid[position.row]?.[position.column] === CellKind.Path;
}
