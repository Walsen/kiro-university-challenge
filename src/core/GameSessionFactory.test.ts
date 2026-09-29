/**
 * RED-step unit tests for `GameSessionFactory` (Task 9.3).
 *
 * These specify the pure factory that builds a fresh `PlayingState` for a new
 * Game_Session BEFORE it is implemented in `./GameSessionFactory`, so they are
 * expected to fail to compile/run until the implementation exists. Each test is
 * named by the behavior it specifies so a failure reads as a specification.
 *
 * Requirements covered:
 * - R1.2 / R6.2 a new session places the avatar on the maze Start_Cell,
 * - R6.3 the timer resets to the Time_Limit and starts paused (`timerStarted`
 *   false), so `remainingMs === timeLimit * 1000`,
 * - R6.5 the fresh session retains no avatar or timer value from any prior
 *   state (it is derived solely from the maze and time limit),
 * - R7.4 the provided valid Time_Limit is applied as the active limit.
 */
import { describe, expect, it } from "vitest";

import { DefaultGameSessionFactory } from "./GameSessionFactory";
import { parseTimeLimit } from "./parseTimeLimit";
import { type PlayingState, type TimeLimit } from "./types";
import { solvableMaze } from "./testFixtures/mazes";

/** A valid Time_Limit produced through the only validator that brands one. */
function timeLimit(seconds = 60): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test fixture expected a valid time limit, got ${seconds}`);
  }
  return result.value;
}

describe("GameSessionFactory.createSession", () => {
  it("places the avatar on the maze start cell (R1.2, R6.2)", () => {
    const maze = solvableMaze();
    const factory = new DefaultGameSessionFactory();

    const state = factory.createSession(maze, timeLimit(60));

    expect(state.avatar).toEqual(maze.start);
  });

  it("produces a Playing state with a paused timer reset to the time limit (R6.3)", () => {
    const factory = new DefaultGameSessionFactory();

    const state: PlayingState = factory.createSession(solvableMaze(), timeLimit(90));

    expect(state.status).toBe("Playing");
    expect(state.timerStarted).toBe(false);
    expect(state.moveInProgress).toBe(false);
    // 90 seconds -> 90_000 ms.
    expect(state.remainingMs).toBe(90 * 1000);
  });

  it("applies the provided valid time limit as the active limit (R7.4)", () => {
    const factory = new DefaultGameSessionFactory();
    const limit = timeLimit(300);

    const state = factory.createSession(solvableMaze(), limit);

    expect(state.timeLimit).toBe(limit);
    expect(state.remainingMs).toBe(300 * 1000);
  });

  it("derives the fresh session solely from the maze and limit, leaking no prior state (R6.5)", () => {
    const factory = new DefaultGameSessionFactory();
    const maze = solvableMaze();
    const limit = timeLimit(60);

    // Two independent calls with the same inputs must be structurally equal —
    // the factory carries over nothing from a previous invocation.
    const first = factory.createSession(maze, limit);
    const second = factory.createSession(maze, limit);

    expect(second).toEqual(first);
    expect(second.avatar).toEqual(maze.start);
    expect(second.remainingMs).toBe(60 * 1000);
    expect(second.timerStarted).toBe(false);
  });
});
