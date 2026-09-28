import { describe, expect, it } from "vitest";

import { reduce } from "./reduce";
import { resolveMove } from "./resolveMove";
import { tickTimer } from "./tickTimer";
import { parseTimeLimit } from "./parseTimeLimit";
import { at, solvableMaze } from "./testFixtures/mazes";
import {
  type GameConfig,
  type LostState,
  type Maze,
  type PlayingState,
  type TimeLimit,
  type WonState,
} from "./types";

/**
 * Example-based unit tests for the pure state reducer `reduce`.
 *
 * Red step (Task 9.1): these specify `reduce`'s behavior before the
 * implementation in `reduce.ts` exists (Task 9.2), so they are expected to
 * fail on the missing `./reduce` import until then.
 *
 * `reduce(state, action)` is the single transition function (design
 * "State transition diagram"). It delegates `Move` to `resolveMove`, `Tick`
 * to `tickTimer` (adding the Playing -> Lost on-expiry transition), builds a
 * fresh session on `StartSession`, clears `moveInProgress` on
 * `MoveAnimationComplete`, and freezes ended (`Won`/`Lost`) sessions.
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
 * yet started, matching the shape `StartSession` is specified to produce.
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

describe("reduce", () => {
  describe("StartSession", () => {
    it("produces a fresh Playing session with avatar on start and a full, unstarted timer", () => {
      // R6.5 / Property 3: StartSession always yields a fresh PlayingState.
      const maze = solvableMaze();
      const config: GameConfig = {
        rows: maze.rows,
        columns: maze.columns,
        timeLimit: timeLimit(45),
      };

      const next = reduce(freshPlaying(maze, 60), {
        type: "StartSession",
        config,
      });

      expect(next.status).toBe("Playing");
      const playing = next as PlayingState;
      expect(playing.avatar).toEqual(maze.start);
      expect(playing.remainingMs).toBe(45 * MILLISECONDS_PER_SECOND);
      expect(playing.timerStarted).toBe(false);
      expect(playing.moveInProgress).toBe(false);
    });

    it("discards a prior ended session, leaking no avatar or timer state", () => {
      // R6.5: retains no state from a discarded session.
      const maze = solvableMaze();
      const won: WonState = {
        status: "Won",
        maze,
        avatar: maze.exit,
        timeLimit: timeLimit(60),
        elapsedMs: 12_345,
      };
      const config: GameConfig = {
        rows: maze.rows,
        columns: maze.columns,
        timeLimit: timeLimit(30),
      };

      const next = reduce(won, { type: "StartSession", config });

      expect(next.status).toBe("Playing");
      const playing = next as PlayingState;
      // Avatar resets to start, not the exit the prior win left it on.
      expect(playing.avatar).toEqual(maze.start);
      expect(playing.avatar).not.toEqual(won.avatar);
      expect(playing.remainingMs).toBe(30 * MILLISECONDS_PER_SECOND);
    });
  });

  describe("Move", () => {
    it("delegates to resolveMove for a valid one-cell move", () => {
      // A move produces exactly what resolveMove produces for the same input
      // (aside from the R6.3 timer-start bookkeeping asserted separately).
      const maze = solvableMaze();
      const start = freshPlaying(maze, 60);

      const next = reduce(start, { type: "Move", direction: "Right" });
      const direct = resolveMove(start, "Right");

      // Right from (0,0) is a path cell (0,1): the avatar advances one cell.
      expect(next.status).toBe("Playing");
      expect((next as PlayingState).avatar).toEqual(at(0, 1));
      expect((next as PlayingState).avatar).toEqual(
        (direct as PlayingState).avatar,
      );
    });

    it("delegates a blocked move to resolveMove, leaving the avatar unchanged", () => {
      // Down from (0,0) targets (1,0), a wall: resolveMove blocks it (R2.2).
      const maze = solvableMaze();
      const start = freshPlaying(maze, 60);

      const next = reduce(start, { type: "Move", direction: "Down" });

      expect(next.status).toBe("Playing");
      expect((next as PlayingState).avatar).toEqual(maze.start);
    });

    it("starts the timer on the first accepted move", () => {
      // R6.3: the timer is paused until the first move; the first accepted
      // move starts it (timerStarted flips to true).
      const maze = solvableMaze();
      const start = freshPlaying(maze, 60);
      expect(start.timerStarted).toBe(false);

      const next = reduce(start, { type: "Move", direction: "Right" });

      expect(next.status).toBe("Playing");
      expect((next as PlayingState).timerStarted).toBe(true);
    });
  });

  describe("Tick", () => {
    it("delegates to tickTimer, decrementing remaining time without ending the session", () => {
      // A Tick that does not reach zero stays Playing with decremented time.
      // The timer is already started, so the Tick counts down via tickTimer
      // without the R6.3 pause bookkeeping.
      const maze = solvableMaze();
      const start: PlayingState = { ...freshPlaying(maze, 60), timerStarted: true };

      const next = reduce(start, { type: "Tick", elapsedMs: 1000 });
      const direct = tickTimer(start, 1000);

      expect(next.status).toBe("Playing");
      expect((next as PlayingState).remainingMs).toBe(59_000);
      expect((next as PlayingState).remainingMs).toBe(
        (direct as PlayingState).remainingMs,
      );
    });

    it("does not decrement remaining time on a sub-1s Tick while the timer is still paused (R6.3)", () => {
      // R6.3: a fresh session's timer is paused until the first move OR a
      // maximum of 1 second elapses. A single Tick shorter than that threshold
      // must not count down; it only accrues toward the 1s auto-start boundary.
      const maze = solvableMaze();
      const start = freshPlaying(maze, 60);
      const full = start.remainingMs;
      expect(start.timerStarted).toBe(false);

      const next = reduce(start, { type: "Tick", elapsedMs: 400 });

      expect(next.status).toBe("Playing");
      const playing = next as PlayingState;
      // Timer still paused: remaining time unchanged, timerStarted still false.
      expect(playing.remainingMs).toBe(full);
      expect(playing.timerStarted).toBe(false);
      // The avatar never moves on its own.
      expect(playing.avatar).toEqual(maze.start);
      // Progress toward the 1s threshold is recorded.
      expect(playing.pausedElapsedMs).toBe(400);
    });

    it("auto-starts the timer once cumulative paused Ticks reach 1s, counting down without moving the avatar (R6.3)", () => {
      // Two sub-1s Ticks accumulate to the 1000ms maximum. On crossing it the
      // timer starts and begins counting down; the avatar stays on start.
      const maze = solvableMaze();
      const start = freshPlaying(maze, 60);
      const full = start.remainingMs;

      const afterFirst = reduce(start, { type: "Tick", elapsedMs: 600 });
      expect((afterFirst as PlayingState).timerStarted).toBe(false);
      expect((afterFirst as PlayingState).remainingMs).toBe(full);

      const afterSecond = reduce(afterFirst, { type: "Tick", elapsedMs: 600 });

      expect(afterSecond.status).toBe("Playing");
      const playing = afterSecond as PlayingState;
      // Cumulative paused elapsed reached 1200ms >= 1000ms: timer now started.
      expect(playing.timerStarted).toBe(true);
      // The avatar is unchanged — the timer starts without any movement.
      expect(playing.avatar).toEqual(maze.start);
      // Elapsed beyond the 1000ms threshold (200ms) counts down.
      expect(playing.remainingMs).toBe(full - 200);
      expect(playing.remainingMs).toBeLessThan(full);
    });

    it("auto-starts and counts down the surplus when a single Tick exceeds the 1s threshold (R6.3)", () => {
      // One Tick larger than the 1s max: the first 1000ms closes the pause and
      // the remaining 500ms counts down, all without moving the avatar.
      const maze = solvableMaze();
      const start = freshPlaying(maze, 60);
      const full = start.remainingMs;

      const next = reduce(start, { type: "Tick", elapsedMs: 1500 });

      expect(next.status).toBe("Playing");
      const playing = next as PlayingState;
      expect(playing.timerStarted).toBe(true);
      expect(playing.avatar).toEqual(maze.start);
      expect(playing.remainingMs).toBe(full - 500);
    });

    it("counts down normally on a Tick once the timer has already started", () => {
      // Once started, a Tick decrements via tickTimer with no pause bookkeeping.
      const maze = solvableMaze();
      const start: PlayingState = { ...freshPlaying(maze, 60), timerStarted: true };

      const next = reduce(start, { type: "Tick", elapsedMs: 1000 });

      expect(next.status).toBe("Playing");
      expect((next as PlayingState).remainingMs).toBe(59_000);
    });

    it("transitions Playing to Lost when time reaches zero and the avatar is not on the exit", () => {
      // R3.3 / Property 8: timer reaching zero away from the exit is a loss.
      const maze = solvableMaze();
      const start: PlayingState = {
        ...freshPlaying(maze, 60),
        remainingMs: 500,
        timerStarted: true,
      };
      expect(start.avatar).not.toEqual(maze.exit);

      const next = reduce(start, { type: "Tick", elapsedMs: 500 });

      expect(next.status).toBe("Lost");
      expect((next as LostState).reason).toBe("TimeExpired");
    });
  });

  describe("frozen ended states", () => {
    it("leaves a Won state unchanged on Tick", () => {
      // R3.5 / Property 9: an ended session freezes the timer/outcome.
      const maze = solvableMaze();
      const won: WonState = {
        status: "Won",
        maze,
        avatar: maze.exit,
        timeLimit: timeLimit(60),
        elapsedMs: 4_200,
      };

      const next = reduce(won, { type: "Tick", elapsedMs: 1000 });

      expect(next).toEqual(won);
    });

    it("leaves a Lost state unchanged on Move", () => {
      // R3.4 / R4.4 / Property 12: moves after the session ends are rejected.
      const maze = solvableMaze();
      const lost: LostState = {
        status: "Lost",
        maze,
        avatar: maze.start,
        timeLimit: timeLimit(60),
        reason: "TimeExpired",
      };

      const next = reduce(lost, { type: "Move", direction: "Right" });

      expect(next).toEqual(lost);
    });
  });

  describe("MoveAnimationComplete", () => {
    it("clears the moveInProgress flag", () => {
      // Per design: MoveAnimationComplete ends the in-progress guard (R2.5).
      const maze = solvableMaze();
      const midMove: PlayingState = {
        ...freshPlaying(maze, 60),
        moveInProgress: true,
        timerStarted: true,
      };

      const next = reduce(midMove, { type: "MoveAnimationComplete" });

      expect(next.status).toBe("Playing");
      expect((next as PlayingState).moveInProgress).toBe(false);
    });
  });
});
