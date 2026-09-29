import { describe, expect, it } from "vitest";

import { parseTimeLimit } from "../parseTimeLimit";
import type { Maze, Position, TimeLimit } from "../types";
import { solvableMaze } from "../testFixtures/mazes";
import type { ParticipantState, SharedSessionState } from "./sharedSession";
import { resolveSession } from "./sessionResolution";

/**
 * Example-based unit tests for shared-session finish/timeout resolution
 * (Task 17.1, Red step).
 *
 * These specify how the server resolves a shared session purely from its
 * `Authoritative_State`: a Participant whose authoritative position has reached
 * the shared maze exit FINISHES, recording their authoritative finishing time
 * and a finishing RANK derived from the order of finishers; a Participant still
 * Racing when the session's time limit expires is resolved as NOT finished with
 * no time or rank; and resolving transitions the session to `Ended`. Finish and
 * rank are computed from authoritative state only — a client-claimed finish is
 * never trusted (R10.1, R10.2, R10.4).
 *
 * The fixture maze is the shared `solvableMaze`, whose exit is (2,2).
 *
 * _Validates: Requirements 10.1, 10.2, 10.4_
 */

const EXIT: Position = { row: 2, column: 2 };

function fixtureTimeLimit(): TimeLimit {
  return parseTimeLimit(60).value;
}

function participant(
  participantId: string,
  position: Position,
  displayName = participantId,
): ParticipantState {
  return { participantId, displayName, position, moveSeq: 0, status: "Racing" };
}

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

describe("resolveSession — a single finisher (R10.1)", () => {
  it("records the finisher with rank 1 and their authoritative finishing time", () => {
    const state = racingSession([participant("alice", EXIT)]);

    const { results } = resolveSession(state, new Map([["alice", 4200]]));

    expect(results).toEqual([
      {
        participantId: "alice",
        displayName: "alice",
        outcome: "Finished",
        timeMs: 4200,
        rank: 1,
      },
    ]);
  });

  it("uses the display name from the authoritative slice, not the id", () => {
    const state = racingSession([participant("alice", EXIT, "Alice")]);

    const { results } = resolveSession(state, new Map([["alice", 4200]]));

    expect(results[0]).toMatchObject({ displayName: "Alice", outcome: "Finished" });
  });
});

describe("resolveSession — multiple finishers ranked by finishing time (R10.1, R10.2)", () => {
  it("ranks finishers fastest-first", () => {
    const state = racingSession([
      participant("alice", EXIT),
      participant("bob", EXIT),
      participant("carol", EXIT),
    ]);

    const { results } = resolveSession(
      state,
      new Map([
        ["alice", 5000],
        ["bob", 3000],
        ["carol", 4000],
      ]),
    );

    const byId = Object.fromEntries(results.map((r) => [r.participantId, r]));
    expect(byId.bob).toMatchObject({ rank: 1, timeMs: 3000, outcome: "Finished" });
    expect(byId.carol).toMatchObject({ rank: 2, timeMs: 4000, outcome: "Finished" });
    expect(byId.alice).toMatchObject({ rank: 3, timeMs: 5000, outcome: "Finished" });
  });

  it("breaks a tie deterministically by participantId (consistent with leaderboard)", () => {
    const state = racingSession([
      participant("bob", EXIT),
      participant("alice", EXIT),
    ]);

    const { results } = resolveSession(
      state,
      new Map([
        ["bob", 3000],
        ["alice", 3000],
      ]),
    );

    const byId = Object.fromEntries(results.map((r) => [r.participantId, r]));
    // Equal times: the lexicographically smaller id ranks first.
    expect(byId.alice).toMatchObject({ rank: 1 });
    expect(byId.bob).toMatchObject({ rank: 2 });
  });
});

describe("resolveSession — time expiry means not finished (R10.4)", () => {
  it("resolves a still-racing participant as NotFinished with no time or rank", () => {
    const state = racingSession([participant("alice", { row: 1, column: 1 })]);

    const { results } = resolveSession(state, new Map());

    expect(results).toEqual([
      {
        participantId: "alice",
        displayName: "alice",
        outcome: "NotFinished",
        reason: "TimeExpired",
      },
    ]);
  });

  it("resolves finishers and non-finishers together in one session", () => {
    const state = racingSession([
      participant("alice", EXIT),
      participant("bob", { row: 0, column: 1 }),
    ]);

    const { results } = resolveSession(state, new Map([["alice", 2500]]));

    const byId = Object.fromEntries(results.map((r) => [r.participantId, r]));
    expect(byId.alice).toMatchObject({ outcome: "Finished", rank: 1, timeMs: 2500 });
    expect(byId.bob).toMatchObject({ outcome: "NotFinished", reason: "TimeExpired" });
  });

  it("treats a participant at the exit without a recorded finish time as not finished", () => {
    // Defensive: finish is authoritative, so an exit position with no recorded
    // authoritative time is not a trusted finish.
    const state = racingSession([participant("alice", EXIT)]);

    const { results } = resolveSession(state, new Map());

    expect(results[0]).toMatchObject({ outcome: "NotFinished", reason: "TimeExpired" });
  });
});

describe("resolveSession — session becomes Ended (R10.2)", () => {
  it("transitions the session to Ended", () => {
    const state = racingSession([participant("alice", EXIT)]);

    const { endedState } = resolveSession(state, new Map([["alice", 4200]]));

    expect(endedState.status).toBe("Ended");
  });

  it("marks finishers Finished in the ended authoritative state and leaves non-finishers Racing", () => {
    const state = racingSession([
      participant("alice", EXIT),
      participant("bob", { row: 0, column: 1 }),
    ]);

    const { endedState } = resolveSession(state, new Map([["alice", 2500]]));

    expect(endedState.participants.get("alice")?.status).toBe("Finished");
    expect(endedState.participants.get("bob")?.status).toBe("Racing");
  });

  it("does not mutate the input state", () => {
    const state = racingSession([participant("alice", EXIT)]);

    resolveSession(state, new Map([["alice", 4200]]));

    expect(state.status).toBe("Racing");
    expect(state.participants.get("alice")?.status).toBe("Racing");
  });
});
