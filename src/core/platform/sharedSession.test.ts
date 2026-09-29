import { describe, expect, it } from "vitest";

import { parseTimeLimit } from "../parseTimeLimit";
import type { Maze, Position, TimeLimit } from "../types";
import { solvableMaze } from "../testFixtures/mazes";
import {
  resolveSessionMove,
  type ParticipantState,
  type SharedSessionState,
} from "./sharedSession";

/**
 * Example-based unit tests for the server-authoritative shared-session reducer
 * (Task 16.1, Red step).
 *
 * These specify the behavior of `resolveSessionMove` before it is implemented
 * (Task 16.2), so they are expected to fail until then. The reducer resolves a
 * Participant's intended move against the server-held `Authoritative_State` by
 * reusing the unchanged Phase 1 shared core (`resolveMove`): a legal move
 * advances the acting Participant's authoritative position, while an illegal
 * (wall / out-of-bounds) or out-of-order / stale move is rejected and leaves
 * that Participant's authoritative position unchanged. Moves are resolved
 * against the authoritative state, never a client-claimed position, and one
 * Participant's move never alters another's (design "Server-authoritative
 * shared session").
 *
 * The fixture maze is the shared `solvableMaze`:
 *
 *   S P W
 *   W P W
 *   W P E
 *
 * so from Start (0,0) the only legal first step is Right into (0,1); Down into
 * (1,0) is a wall, and Up/Left leave the grid.
 *
 * _Validates: Requirements 9.2, 9.3_
 */

const START: Position = { row: 0, column: 0 };

/** A branded, in-range time limit for the fixtures. */
function fixtureTimeLimit(): TimeLimit {
  return parseTimeLimit(60).value;
}

/** Seat a Participant at a given authoritative position and move sequence. */
function participant(
  participantId: string,
  position: Position,
  moveSeq = 0,
): ParticipantState {
  return {
    participantId,
    displayName: participantId,
    position,
    moveSeq,
    status: "Racing",
  };
}

/**
 * Build a Racing shared session from the shared maze with the given
 * Participants seated on their authoritative positions.
 */
function racingSession(
  participants: ReadonlyArray<ParticipantState>,
  maze: Maze = solvableMaze(),
): SharedSessionState {
  return {
    sessionId: "session-1",
    maze,
    timeLimit: fixtureTimeLimit(),
    participants: new Map(participants.map((p) => [p.participantId, p])),
    status: "Racing",
  };
}

describe("resolveSessionMove — legal moves against authoritative state (R9.2)", () => {
  it("advances the acting participant's authoritative position on a legal move", () => {
    const session = racingSession([participant("alice", START)]);

    const result = resolveSessionMove(session, {
      participantId: "alice",
      direction: "Right",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alice = result.state.participants.get("alice");
    expect(alice?.position).toEqual({ row: 0, column: 1 });
  });

  it("increments the acting participant's move sequence on a legal move", () => {
    const session = racingSession([participant("alice", START, 0)]);

    const result = resolveSessionMove(session, {
      participantId: "alice",
      direction: "Right",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.participants.get("alice")?.moveSeq).toBe(1);
  });

  it("resolves against the authoritative position, not a client-claimed one", () => {
    // Alice's authoritative position is (0,1); the only legal step from there
    // is Down into (1,1). A move resolved against a client-claimed Start (0,0)
    // would instead accept Right, so accepting Down proves the reducer used the
    // authoritative position (R9.2).
    const session = racingSession([participant("alice", { row: 0, column: 1 }, 1)]);

    const result = resolveSessionMove(session, {
      participantId: "alice",
      direction: "Down",
      expectedSeq: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.participants.get("alice")?.position).toEqual({
      row: 1,
      column: 1,
    });
  });
});

describe("resolveSessionMove — illegal moves are rejected, position unchanged (R9.3)", () => {
  it("rejects a move into a wall and leaves the position unchanged", () => {
    const session = racingSession([participant("alice", START, 0)]);

    // Down from Start (0,0) targets (1,0), which is a Wall.
    const result = resolveSessionMove(session, {
      participantId: "alice",
      direction: "Down",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal-move");
  });

  it("rejects a move out of bounds and leaves the position unchanged", () => {
    const session = racingSession([participant("alice", START, 0)]);

    // Up from Start (0,0) leaves the grid.
    const result = resolveSessionMove(session, {
      participantId: "alice",
      direction: "Up",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal-move");
  });

  it("rejects a stale / out-of-order move and leaves the position unchanged", () => {
    // Alice has already advanced to moveSeq 1; a command still expecting seq 0
    // is stale and must be rejected without moving her, even though Right would
    // otherwise be a legal step (R9.3 "out-of-order update").
    const authoritative = participant("alice", { row: 0, column: 1 }, 1);
    const session = racingSession([authoritative]);

    const result = resolveSessionMove(session, {
      participantId: "alice",
      direction: "Down",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("out-of-order");
  });
});

describe("resolveSessionMove — isolation between participants (R9.2)", () => {
  it("one participant's move does not alter another participant's position", () => {
    const alice = participant("alice", START, 0);
    const bob = participant("bob", START, 0);
    const session = racingSession([alice, bob]);

    const result = resolveSessionMove(session, {
      participantId: "alice",
      direction: "Right",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bob is untouched: same authoritative position and move sequence.
    expect(result.state.participants.get("bob")).toEqual(bob);
  });

  it("rejects a move from an unknown participant", () => {
    const session = racingSession([participant("alice", START, 0)]);

    const result = resolveSessionMove(session, {
      participantId: "mallory",
      direction: "Right",
      expectedSeq: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown-participant");
  });
});
