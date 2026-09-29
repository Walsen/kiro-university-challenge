import { describe, expect, it } from "vitest";

import { tickTimer } from "./tickTimer";
import {
  CellKind,
  type Maze,
  type PlayingState,
  type Position,
  type TimeLimit,
} from "./types";

/**
 * Example-based unit tests for `tickTimer` (pure core timer rule).
 *
 * Red step (Task 7.8): these specify behavior before the implementation in
 * `tickTimer.ts` exists, so they are expected to fail to import/run until Task
 * 7.9 provides the implementation.
 *
 * Scope per the refactored design: `tickTimer` only decrements `remainingMs`
 * by the elapsed time and clamps it at zero (never negative). The
 * Playing -> Lost on-expiry transition lives in `reduce` (Task 9), NOT here, so
 * these tests assert clamp/monotonic behavior only and never expect a status
 * change. Displayed remaining seconds are asserted as the design invariant
 * `max(0, floor(remainingMs / 1000))` computed from the returned `remainingMs`.
 *
 * _Requirements: 3.2, 3.3; design Correctness Property 7._
 */

// A tiny 1x2 all-path maze is enough for timer tests; movement is not exercised.
const MAZE: Maze = {
  rows: 1,
  columns: 2,
  grid: [[CellKind.Path, CellKind.Path]],
  start: { row: 0, column: 0 },
  exit: { row: 0, column: 1 },
};

/** Brand a raw seconds value as a `TimeLimit` for fixture construction only. */
function timeLimit(seconds: number): TimeLimit {
  return seconds as TimeLimit;
}

/** Build a `PlayingState` fixture with the avatar on a path cell. */
function playing(
  remainingMs: number,
  overrides: Partial<PlayingState> = {},
): PlayingState {
  const avatar: Position = overrides.avatar ?? MAZE.start;
  return {
    status: "Playing",
    maze: MAZE,
    avatar,
    timeLimit: timeLimit(60),
    remainingMs,
    timerStarted: true,
    pausedElapsedMs: 0,
    moveInProgress: false,
    ...overrides,
  };
}

/** The design's displayed-seconds invariant, computed from remaining ms. */
function displayedSeconds(remainingMs: number): number {
  return Math.max(0, Math.floor(remainingMs / 1000));
}

describe("tickTimer", () => {
  it("decreases remainingMs by the elapsed milliseconds for a PlayingState", () => {
    // R3.2 / Property 7: the timer counts down. 30000ms remaining minus a
    // 1000ms tick leaves 29000ms.
    const before = playing(30_000);

    const after = tickTimer(before, 1_000);

    expect(after.status).toBe("Playing");
    expect((after as PlayingState).remainingMs).toBe(29_000);
  });

  it("produces a remainingMs that is never greater than the previous value (monotonic non-increasing)", () => {
    // Property 7: remainingMs is monotonic non-increasing for any non-negative
    // elapsed time, including a zero-length tick.
    const before = playing(5_000);

    const afterZero = tickTimer(before, 0);
    const afterSome = tickTimer(before, 750);

    expect((afterZero as PlayingState).remainingMs).toBeLessThanOrEqual(
      before.remainingMs,
    );
    expect((afterSome as PlayingState).remainingMs).toBeLessThanOrEqual(
      before.remainingMs,
    );
  });

  it("clamps remainingMs at zero when the elapsed time exceeds the remaining time", () => {
    // R3.3 / Property 7: elapsed larger than remaining must not drive the timer
    // negative; it clamps at exactly 0.
    const before = playing(500);

    const after = tickTimer(before, 2_000);

    expect((after as PlayingState).remainingMs).toBe(0);
  });

  it("clamps remainingMs at zero exactly when elapsed equals remaining", () => {
    // Boundary: elapsed == remaining lands on 0, not a negative value.
    const before = playing(1_000);

    const after = tickTimer(before, 1_000);

    expect((after as PlayingState).remainingMs).toBe(0);
  });

  it("never produces a negative remainingMs", () => {
    // Property 7: remainingMs is never below zero regardless of how large the
    // elapsed time is.
    const before = playing(100);

    const after = tickTimer(before, 10_000_000);

    expect((after as PlayingState).remainingMs).toBeGreaterThanOrEqual(0);
    expect((after as PlayingState).remainingMs).toBe(0);
  });

  it("keeps the state in Playing (the loss-on-expiry transition belongs to reduce, not tickTimer)", () => {
    // R3.3: reaching zero does NOT itself flip to Lost here; `tickTimer` only
    // decrements and clamps. The Playing -> Lost transition is handled in
    // `reduce` (Task 9).
    const before = playing(250);

    const after = tickTimer(before, 5_000);

    expect(after.status).toBe("Playing");
  });

  it("yields displayed seconds equal to max(0, floor(remainingMs / 1000))", () => {
    // R3.2 / Property 7: displayed remaining seconds are the floored,
    // non-negative projection of remainingMs. 29999ms -> 29 seconds.
    const after = tickTimer(playing(30_000), 1) as PlayingState;

    expect(after.remainingMs).toBe(29_999);
    expect(displayedSeconds(after.remainingMs)).toBe(29);
  });

  it("yields non-negative displayed seconds once the timer is clamped at zero", () => {
    // R3.2: the displayed time is a non-negative integer number of seconds even
    // after the timer has run out.
    const after = tickTimer(playing(300), 9_000) as PlayingState;

    expect(after.remainingMs).toBe(0);
    expect(displayedSeconds(after.remainingMs)).toBe(0);
  });

  it("does not mutate the input state (returns a new immutable state)", () => {
    // Core purity: transitions produce new values rather than mutating.
    const before = playing(4_000);

    tickTimer(before, 1_000);

    expect(before.remainingMs).toBe(4_000);
  });
});
