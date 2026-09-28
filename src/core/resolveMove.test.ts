/**
 * RED-step unit tests for `resolveMove` (Task 7.1).
 *
 * These specify the behavior of the pure
 * `resolveMove(state: GameState, direction: Direction): GameState` function
 * BEFORE it is implemented in Task 7.2, so they are expected to fail to
 * compile/run until `./resolveMove` exists. Each test is named by the behavior
 * it specifies so a failure reads as a specification.
 *
 * Requirements covered:
 * - R2.1 a valid one-cell move advances the avatar exactly one cell,
 * - R2.2 a move into a wall leaves the avatar unchanged (block is surfaced by
 *   the store as `MoveBlocked`, not by `resolveMove`; see design "Error Handling"),
 * - R2.3 a move out of bounds leaves the avatar unchanged,
 * - R2.5 a move while a move is in progress is ignored,
 * - R4.1/R4.2 moving onto the exit with time remaining wins and captures elapsed time,
 * - R4.5 moving onto the exit at/below zero remaining time does not win,
 * - R4.4 a move while the session has ended (Won/Lost) or is Idle is rejected.
 *
 * Per design.md: `resolveMove` itself does not end the session on time expiry
 * (that is a `Tick` concern in `reduce`/`tickTimer`); it only refuses to grant
 * a Win when `remainingMs <= 0`. Blocked moves return the state unchanged; the
 * store emits `MoveBlocked` separately.
 */
import { describe, expect, it } from "vitest";

import { resolveMove } from "./resolveMove";
import { parseTimeLimit } from "./parseTimeLimit";
import {
  CellKind,
  type Direction,
  type GameState,
  type IdleState,
  type LostState,
  type Maze,
  type PlayingState,
  type Position,
  type TimeLimit,
  type WonState,
} from "./types";
import { at, makeMaze } from "./testFixtures/mazes";

const P = CellKind.Path;
const W = CellKind.Wall;

/** A 60-second limit produced through the only validator that brands one. */
function timeLimit(seconds = 60): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test fixture expected a valid time limit, got ${seconds}`);
  }
  return result.value;
}

/**
 * A small maze used across the movement tests:
 *
 *   S P W
 *   W P W
 *   W P E
 *
 * Start (0,0), exit (2,2). Column 1 is the connecting path. (0,2) and the two
 * cells below it are walls, giving in-bounds wall targets to test against.
 */
function movementMaze(): Maze {
  return makeMaze(
    [
      [P, P, W],
      [W, P, W],
      [W, P, P],
    ],
    at(0, 0),
    at(2, 2),
  );
}

/** Build a Playing state with sensible defaults, overridable per test. */
function playing(overrides: Partial<PlayingState> = {}): PlayingState {
  const maze = overrides.maze ?? movementMaze();
  const limit = overrides.timeLimit ?? timeLimit();
  return {
    status: "Playing",
    maze,
    avatar: overrides.avatar ?? maze.start,
    timeLimit: limit,
    remainingMs: overrides.remainingMs ?? limit * 1000,
    timerStarted: overrides.timerStarted ?? false,
    pausedElapsedMs: overrides.pausedElapsedMs ?? 0,
    moveInProgress: overrides.moveInProgress ?? false,
  };
}

describe("resolveMove", () => {
  it("advances the avatar exactly one cell for a valid in-bounds path move", () => {
    // From start (0,0), moving Right onto the path cell (0,1). (R2.1)
    const state = playing({ avatar: at(0, 0) });

    const next = resolveMove(state, "Right");

    expect(next.status).toBe("Playing");
    expect(next.avatar).toEqual(at(0, 1));
  });

  it("moves down one cell when the target below is a path cell", () => {
    // From (0,1), moving Down onto path cell (1,1). (R2.1)
    const state = playing({ avatar: at(0, 1) });

    const next = resolveMove(state, "Down");

    expect(next.avatar).toEqual(at(1, 1));
  });

  it("leaves the avatar unchanged when the target cell is a wall", () => {
    // From start (0,0), moving Down targets wall (1,0): blocked, no movement. (R2.2)
    const state = playing({ avatar: at(0, 0) });

    const next = resolveMove(state, "Down");

    expect(next.status).toBe("Playing");
    expect(next.avatar).toEqual(at(0, 0));
    // A blocked move surfaces no state change; the store emits MoveBlocked.
    expect(next).toEqual(state);
  });

  it("leaves the avatar unchanged when the target cell is out of bounds", () => {
    // From start (0,0), moving Up leaves the grid (row -1): blocked. (R2.3)
    const state = playing({ avatar: at(0, 0) });

    const next = resolveMove(state, "Up");

    expect(next.status).toBe("Playing");
    expect(next.avatar).toEqual(at(0, 0));
    expect(next).toEqual(state);
  });

  it("ignores a move while a previous move is still in progress", () => {
    // Even though Right onto (0,1) would be valid, moveInProgress drops it. (R2.5)
    const state = playing({ avatar: at(0, 0), moveInProgress: true });

    const next = resolveMove(state, "Right");

    expect(next.status).toBe("Playing");
    expect(next.avatar).toEqual(at(0, 0));
    expect(next).toEqual(state);
  });

  it("wins and captures elapsed time when moving onto the exit with time remaining", () => {
    // Avatar adjacent to exit at (2,1); moving Right enters exit (2,2). (R4.1, R4.2)
    const limit = timeLimit(60);
    const remainingMs = 45_000; // 15s elapsed
    const state = playing({
      avatar: at(2, 1),
      timeLimit: limit,
      remainingMs,
      timerStarted: true,
    });

    const next = resolveMove(state, "Right");

    expect(next.status).toBe("Won");
    expect(next.avatar).toEqual(at(2, 2));
    if (next.status === "Won") {
      // elapsed = timeLimit*1000 - remainingMs = 60000 - 45000 = 15000ms
      const won: WonState = next;
      expect(won.elapsedMs).toBe(limit * 1000 - remainingMs);
    }
  });

  it("does not win when moving onto the exit with zero remaining time", () => {
    // Onto the exit while remainingMs <= 0 must not be a win. (R4.5)
    const state = playing({
      avatar: at(2, 1),
      remainingMs: 0,
      timerStarted: true,
    });

    const next = resolveMove(state, "Right");

    expect(next.status).not.toBe("Won");
  });

  it("does not win when moving onto the exit with negative remaining time", () => {
    // remainingMs below zero is likewise not a win. (R4.5)
    const state = playing({
      avatar: at(2, 1),
      remainingMs: -500,
      timerStarted: true,
    });

    const next = resolveMove(state, "Right");

    expect(next.status).not.toBe("Won");
  });

  it("rejects a move once the session has been won, leaving state unchanged", () => {
    // Any move after the session ends is rejected. (R4.4)
    const maze = movementMaze();
    const won: WonState = {
      status: "Won",
      maze,
      avatar: maze.exit,
      timeLimit: timeLimit(),
      elapsedMs: 12_340,
    };

    const next = resolveMove(won, "Left");

    expect(next).toEqual(won);
  });

  it("rejects a move once the session has been lost, leaving state unchanged", () => {
    // Any move after the session ends is rejected. (R4.4)
    const maze = movementMaze();
    const lost: LostState = {
      status: "Lost",
      maze,
      avatar: at(2, 1),
      timeLimit: timeLimit(),
      reason: "TimeExpired",
    };

    const next = resolveMove(lost, "Right");

    expect(next).toEqual(lost);
  });

  it("rejects a move while the game is idle, leaving state unchanged", () => {
    // A move before a session starts is rejected. (R4.4)
    const maze = movementMaze();
    const idle: IdleState = {
      status: "Idle",
      maze,
      avatar: maze.start,
      timeLimit: timeLimit(),
    };

    const next = resolveMove(idle, "Right");

    expect(next).toEqual(idle);
  });

  it("treats every direction from a blocked position as leaving the avatar put", () => {
    // Start (0,0): Up and Left are out of bounds, Down is a wall; only Right moves.
    const state = playing({ avatar: at(0, 0) });
    const blocked: ReadonlyArray<Direction> = ["Up", "Left", "Down"];

    for (const direction of blocked) {
      const next: GameState = resolveMove(state, direction);
      expect(next.avatar).toEqual(at(0, 0));
    }
  });

  it("does not mutate the position object passed in", () => {
    // Purity/immutability: a valid move produces a new avatar, not a mutation.
    const startPos: Position = at(0, 0);
    const state = playing({ avatar: startPos });

    resolveMove(state, "Right");

    expect(startPos).toEqual(at(0, 0));
  });
});
