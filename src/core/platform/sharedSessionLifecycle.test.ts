import { describe, expect, it } from "vitest";

import {
  SESSION_CAPACITY,
  createSharedSession,
  joinSession,
  startSession,
  toSnapshotUpdate,
  toProgressUpdate,
  toJoinUpdate,
  resolveSessionMove,
  type ParticipantIdentity,
  type SharedSessionState,
} from "./sharedSession";

/**
 * Example-based unit tests for the pure shared-session *lifecycle* helpers the
 * Session Lambda (Task 16.4) composes: creating a session with a server-owned
 * maze, joining under a stated capacity, refusing to join an ended session,
 * starting the race, and projecting the authoritative state into the diff
 * updates the server publishes.
 *
 * These are pure core logic — the maze is built from params + seed through the
 * unchanged shared maze core, so the same seed always yields the same maze
 * (R8.1), and randomness/time never enter directly. The Lambda (an edge
 * composition) reuses these; it does not reimplement any rule here.
 *
 * _Validates: Requirements 8.1, 8.2, 8.3, 9.4, 9.5_
 */

const PARAMS = { rows: 5, columns: 5, seed: 1234, timeLimitSeconds: 60 } as const;

function identity(participantId: string, displayName: string): ParticipantIdentity {
  return { participantId, displayName };
}

/** Build a fresh Lobby session, asserting the server-owned maze was constructible. */
function lobby(): SharedSessionState {
  const created = createSharedSession("session-1", PARAMS, PARAMS.seed);
  if (!created.ok) {
    throw new Error(`fixture maze should be constructible: ${created.reason}`);
  }
  return created.state;
}

describe("createSharedSession — server owns the maze (R8.1)", () => {
  it("creates a Lobby session with a maze rebuilt from params + seed", () => {
    const created = createSharedSession("session-1", PARAMS, PARAMS.seed);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.state.status).toBe("Lobby");
    expect(created.state.sessionId).toBe("session-1");
    expect(created.state.participants.size).toBe(0);
    expect(created.state.maze.rows).toBe(PARAMS.rows);
    expect(created.state.maze.columns).toBe(PARAMS.columns);
  });

  it("is deterministic: the same params + seed rebuild an identical maze", () => {
    const a = createSharedSession("a", PARAMS, PARAMS.seed);
    const b = createSharedSession("b", PARAMS, PARAMS.seed);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.state.maze).toEqual(b.state.maze);
  });

  it("rejects params that cannot form a valid maze", () => {
    const created = createSharedSession(
      "session-1",
      { ...PARAMS, rows: 1, columns: 1 },
      7,
    );

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("invalid-maze");
  });
});

describe("joinSession — capacity and lifecycle enforcement (R8.3)", () => {
  it("adds an authenticated participant seated on the shared start cell (R8.1, R8.2)", () => {
    const result = joinSession(lobby(), identity("alice", "Alice"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alice = result.state.participants.get("alice");
    expect(alice?.position).toEqual(result.state.maze.start);
    expect(alice?.displayName).toBe("Alice");
    expect(alice?.moveSeq).toBe(0);
    expect(alice?.status).toBe("Racing");
  });

  it("is idempotent for a participant already in the session", () => {
    const first = joinSession(lobby(), identity("alice", "Alice"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = joinSession(first.state, identity("alice", "Alice"));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.state.participants.size).toBe(1);
  });

  it("refuses to add a participant beyond the stated capacity and says why (R8.3)", () => {
    let state = lobby();
    for (let i = 0; i < SESSION_CAPACITY; i += 1) {
      const r = joinSession(state, identity(`p${i}`, `P${i}`));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      state = r.state;
    }

    const overflow = joinSession(state, identity("late", "Late"));
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.reason).toBe("session-full");
  });

  it("refuses to join an ended session and says why (R8.3)", () => {
    const ended: SharedSessionState = { ...lobby(), status: "Ended" };

    const result = joinSession(ended, identity("alice", "Alice"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("session-ended");
  });
});

describe("startSession — begin the race (R8.2)", () => {
  it("moves a Lobby session to Racing", () => {
    const joined = joinSession(lobby(), identity("alice", "Alice"));
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    const racing = startSession(joined.state);
    expect(racing.status).toBe("Racing");
  });
});

describe("update projections — authoritative diffs the server publishes (R9.4, R9.5)", () => {
  it("projects a full snapshot carrying the shared maze and every participant", () => {
    const joined = joinSession(lobby(), identity("alice", "Alice"));
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const racing = startSession(joined.state);

    const snapshot = toSnapshotUpdate(racing);

    expect(snapshot.kind).toBe("snapshot");
    if (snapshot.kind !== "snapshot") return;
    expect(snapshot.maze).toEqual(racing.maze);
    expect(snapshot.status).toBe("Racing");
    expect(snapshot.participants).toHaveLength(1);
    expect(snapshot.participants[0]).toMatchObject({
      participantId: "alice",
      displayName: "Alice",
      position: racing.maze.start,
      finishedRank: null,
    });
  });

  it("projects a join diff for a single participant, display name only (R11.3)", () => {
    const joined = joinSession(lobby(), identity("alice", "Alice"));
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const alice = joined.state.participants.get("alice");
    expect(alice).toBeDefined();
    if (alice === undefined) return;

    const update = toJoinUpdate(alice);

    expect(update.kind).toBe("join");
    if (update.kind !== "join") return;
    expect(update.participant).toMatchObject({
      participantId: "alice",
      displayName: "Alice",
    });
    // The private identifier is never the display name; only public fields leave.
    expect(Object.keys(update.participant).sort()).toEqual(
      ["displayName", "finishedRank", "participantId", "position"].sort(),
    );
  });

  it("projects a progress diff for the participant that advanced", () => {
    const joined = joinSession(lobby(), identity("alice", "Alice"));
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const racing = startSession(joined.state);

    // Advance Alice one legal step from the shared start, then project.
    const legalDirection = firstLegalDirection(racing);
    const moved = resolveSessionMove(racing, {
      participantId: "alice",
      direction: legalDirection,
      expectedSeq: 0,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const advanced = moved.state.participants.get("alice");
    expect(advanced).toBeDefined();
    if (advanced === undefined) return;

    const update = toProgressUpdate(advanced);
    expect(update.kind).toBe("progress");
    if (update.kind !== "progress") return;
    expect(update.participant.participantId).toBe("alice");
    expect(update.participant.position).toEqual(advanced.position);
  });
});

/**
 * Find a direction that is a legal first step from the shared start on the
 * generated maze, so the progress test is independent of which way the seeded
 * maze opens.
 */
function firstLegalDirection(
  state: SharedSessionState,
): "Up" | "Down" | "Left" | "Right" {
  for (const direction of ["Up", "Down", "Left", "Right"] as const) {
    const result = resolveSessionMove(state, {
      participantId: firstParticipantId(state),
      direction,
      expectedSeq: 0,
    });
    if (result.ok) {
      return direction;
    }
  }
  throw new Error("generated maze has no legal first move from start");
}

function firstParticipantId(state: SharedSessionState): string {
  const [id] = [...state.participants.keys()];
  if (id === undefined) {
    throw new Error("session has no participants");
  }
  return id;
}
