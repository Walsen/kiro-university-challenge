import { describe, expect, it, vi } from "vitest";

import { reduce } from "../core";
import { at, disconnectedMaze, solvableMaze } from "../core/testFixtures/mazes";
import { parseTimeLimit } from "../core";
import {
  type GameConfig,
  type Maze,
  type MazeResult,
  type PlayingState,
  type TimeLimit,
} from "../core";

import { GameStore } from "./GameStore";

/**
 * Example-based unit tests for the application store `GameStore`
 * (State + Observer, design "Components and Interfaces").
 *
 * Red step (Task 11.1): these specify the store's behavior before the
 * implementation in `GameStore.ts` exists (Task 11.2), so they are expected to
 * fail on the missing `./GameStore` import until then.
 *
 * The store is the single source of truth for `GameState`. It applies the pure
 * `reduce` transition on `dispatch`, exposes the current state via `getState`,
 * and notifies observers registered through `subscribe` with `GameEvent`s
 * (`StateChanged`, `MoveBlocked`, `InvalidMaze`). It never renders — it emits
 * events the renderer consumes (design "GameStore").
 *
 * Design decisions this test pins down for Task 11.2 (all consistent with the
 * design's `GameEvent` union and `GameStore` interface, plus the Error Handling
 * section):
 * - `StateChanged` carries the new state and fires whenever a dispatch changes
 *   the state (R5.1, R5.2 — the outcome the renderer projects).
 * - `MoveBlocked` fires when a `Move` leaves the state unchanged — a blocked
 *   move into a wall or out of bounds (R2.2, R2.3, design Error Handling).
 * - `InvalidMaze` carries the `MazeValidationError` and fires when a session is
 *   started from a maze that fails validation, so the store never enters
 *   `Playing` (R1.6, design Error Handling). The store validates a candidate
 *   maze through an injected `MazeFactory` port (Dependency Inversion).
 */

const MILLISECONDS_PER_SECOND = 1000;

/** A valid branded TimeLimit produced through the only validator that makes one. */
function timeLimit(seconds: number): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test setup: ${String(seconds)} is not a valid TimeLimit`);
  }
  return result.value;
}

/**
 * Build a fresh `PlayingState` on the given maze with the timer full and not
 * yet started — the shape a started session has.
 */
function freshPlaying(maze: Maze, seconds: number): PlayingState {
  const limit = timeLimit(seconds);
  return {
    status: "Playing",
    maze,
    avatar: maze.start,
    timeLimit: limit,
    remainingMs: limit * MILLISECONDS_PER_SECOND,
    timerStarted: false,
    pausedElapsedMs: 0,
    moveInProgress: false,
  };
}

/** A `GameConfig` sized to the given maze with a valid time limit. */
function configFor(maze: Maze, seconds: number): GameConfig {
  return {
    rows: maze.rows,
    columns: maze.columns,
    timeLimit: timeLimit(seconds),
  };
}

/**
 * A stub `MazeFactory` port that always succeeds with the given maze. The store
 * depends on the abstraction (a `create` returning a `MazeResult`), not on the
 * concrete `MazeFactory`.
 */
function factoryReturning(maze: Maze): { create: () => MazeResult } {
  return { create: (): MazeResult => ({ ok: true, maze }) };
}

/** A stub `MazeFactory` port that always fails validation with the given error. */
function factoryFailing(): { create: () => MazeResult } {
  return {
    create: (): MazeResult => ({ ok: false, error: "NoPathFromStartToExit" }),
  };
}

describe("GameStore", () => {
  describe("dispatch applies reduce", () => {
    it("advances the avatar to match reduce's output for a valid move", () => {
      // dispatch is specified to apply the pure `reduce` transition, so the
      // resulting state must equal reduce(previous, action) (R2.1 via reduce).
      const maze = solvableMaze();
      const initial = freshPlaying(maze, 60);
      const store = new GameStore(initial, factoryReturning(maze));

      store.dispatch({ type: "Move", direction: "Right" });

      const expected = reduce(initial, { type: "Move", direction: "Right" });
      // Right from (0,0) targets path cell (0,1): the avatar advances one cell.
      expect(store.getState().status).toBe("Playing");
      expect((store.getState() as PlayingState).avatar).toEqual(at(0, 1));
      expect(store.getState()).toEqual(expected);
    });
  });

  describe("getState returns the current state", () => {
    it("returns the initial state before any dispatch", () => {
      const maze = solvableMaze();
      const initial = freshPlaying(maze, 60);
      const store = new GameStore(initial, factoryReturning(maze));

      expect(store.getState()).toEqual(initial);
    });

    it("returns the updated state after a dispatch", () => {
      const maze = solvableMaze();
      // A started timer so the Tick counts down; the R6.3 pause (a Tick before
      // the timer starts) is exercised by the reducer's own tests.
      const initial: PlayingState = { ...freshPlaying(maze, 60), timerStarted: true };
      const store = new GameStore(initial, factoryReturning(maze));

      store.dispatch({ type: "Tick", elapsedMs: 1000 });

      expect((store.getState() as PlayingState).remainingMs).toBe(59_000);
    });
  });

  describe("subscribe receives StateChanged", () => {
    it("notifies observers with a StateChanged event carrying the new state when the state changes", () => {
      // R5.1/R5.2: the store emits the changed state for the renderer to project.
      const maze = solvableMaze();
      const initial = freshPlaying(maze, 60);
      const store = new GameStore(initial, factoryReturning(maze));
      const observer = vi.fn();
      store.subscribe(observer);

      store.dispatch({ type: "Move", direction: "Right" });

      const changed = store.getState();
      expect(observer).toHaveBeenCalledWith({
        type: "StateChanged",
        state: changed,
      });
    });
  });

  describe("subscribe receives MoveBlocked", () => {
    it("notifies observers with MoveBlocked when a move into a wall leaves the state unchanged", () => {
      // R2.2: Down from (0,0) targets (1,0), a wall — the move is blocked and
      // the avatar stays put, so the store signals MoveBlocked.
      const maze = solvableMaze();
      const initial = freshPlaying(maze, 60);
      const store = new GameStore(initial, factoryReturning(maze));
      const observer = vi.fn();
      store.subscribe(observer);

      store.dispatch({ type: "Move", direction: "Down" });

      expect((store.getState() as PlayingState).avatar).toEqual(maze.start);
      expect(observer).toHaveBeenCalledWith({ type: "MoveBlocked" });
    });
  });

  describe("subscribe receives InvalidMaze", () => {
    it("emits InvalidMaze and does not enter Playing when a session is started from an invalid maze", () => {
      // R1.6 / design Error Handling: an invalid maze is rejected via the
      // injected MazeFactory; the store emits InvalidMaze with the error and
      // never enters a Playing session.
      const invalid = disconnectedMaze();
      const initial = freshPlaying(solvableMaze(), 60);
      const store = new GameStore(initial, factoryFailing());
      const observer = vi.fn();
      store.subscribe(observer);

      store.dispatch({
        type: "StartSession",
        config: configFor(invalid, 60),
      });

      expect(observer).toHaveBeenCalledWith({
        type: "InvalidMaze",
        error: "NoPathFromStartToExit",
      });
      expect(store.getState().status).not.toBe("Playing");
    });
  });

  describe("unsubscribe stops notifications", () => {
    it("does not notify an observer after its unsubscribe function is called", () => {
      const maze = solvableMaze();
      const initial = freshPlaying(maze, 60);
      const store = new GameStore(initial, factoryReturning(maze));
      const observer = vi.fn();
      const unsubscribe = store.subscribe(observer);

      unsubscribe();
      store.dispatch({ type: "Move", direction: "Right" });

      expect(observer).not.toHaveBeenCalled();
    });

    it("keeps notifying other observers after one unsubscribes", () => {
      const maze = solvableMaze();
      const initial = freshPlaying(maze, 60);
      const store = new GameStore(initial, factoryReturning(maze));
      const staying = vi.fn();
      const leaving = vi.fn();
      store.subscribe(staying);
      const unsubscribeLeaving = store.subscribe(leaving);

      unsubscribeLeaving();
      store.dispatch({ type: "Move", direction: "Right" });

      expect(leaving).not.toHaveBeenCalled();
      expect(staying).toHaveBeenCalledWith({
        type: "StateChanged",
        state: store.getState(),
      });
    });
  });
});
