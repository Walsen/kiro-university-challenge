import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { tickTimer } from "./tickTimer";
import { parseTimeLimit } from "./parseTimeLimit";
import {
  CellKind,
  type Maze,
  type PlayingState,
  type Position,
  type TimeLimit,
} from "./types";

/**
 * Property-based test for Correctness Property 7.
 *
 * Property 7 (design.md): *For any* `PlayingState` and any non-negative
 * elapsed milliseconds, `tickTimer` produces a `remainingMs` that is less than
 * or equal to the previous value and never below zero, and the displayed
 * remaining seconds equal `max(0, floor(remainingMs / 1000))`.
 *
 * The invariants checked here are:
 *   1. the result stays `Playing` (a plain decrement, not a transition — that
 *      is `reduce`'s job),
 *   2. `remainingMs >= 0` (the timer never goes negative), even when the
 *      elapsed time far exceeds the remaining time,
 *   3. `remainingMs <= originalRemainingMs` (the countdown is monotonic
 *      non-increasing),
 *   4. the displayed seconds `max(0, floor(remainingMs / 1000)) >= 0`
 *      (R3.2: remaining time is shown as a non-negative integer of seconds).
 *
 * Determinism (testing steering): every value is derived from fast-check
 * arbitraries — no `Math.random`, no wall-clock time. The elapsed range spans
 * from `0` well past any possible `remainingMs`, so the clamp at zero is
 * exercised. The property runs a minimum of 100 iterations.
 *
 * _Validates: Requirements 3.2_
 */

const PROPERTY_MIN_RUNS = 100;
const MILLISECONDS_PER_SECOND = 1000;

/** Upper bound for generated remaining time: 600s (the max time limit) in ms. */
const MAX_REMAINING_MS = 600 * MILLISECONDS_PER_SECOND;

/**
 * Upper bound for generated elapsed time. Chosen far larger than
 * `MAX_REMAINING_MS` so the generator regularly produces ticks that overshoot
 * the remaining time and force the clamp at zero.
 */
const MAX_ELAPSED_MS = 10 * MAX_REMAINING_MS;

/** The displayed remaining seconds, per the design's formula. */
function displayedSeconds(remainingMs: number): number {
  return Math.max(0, Math.floor(remainingMs / MILLISECONDS_PER_SECOND));
}

/** A valid branded time limit, produced through the only validator that brands one. */
function timeLimit(seconds = 60): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test fixture expected a valid time limit, got ${seconds}`);
  }
  return result.value;
}

/**
 * A minimal 1x2 all-path maze with distinct start and exit. `tickTimer`'s
 * behavior is independent of maze shape (it only touches `remainingMs`), so a
 * fixed tiny maze keeps the state well-formed without constraining the property.
 */
const MINIMAL_MAZE: Maze = {
  rows: 1,
  columns: 2,
  grid: [[CellKind.Path, CellKind.Path]],
  start: { row: 0, column: 0 },
  exit: { row: 0, column: 1 },
};

/**
 * Custom arbitrary for a `PlayingState` paired with a non-negative elapsed-ms
 * tick. `remainingMs` ranges across the whole valid span (including `0`), the
 * avatar sits on the start path cell, and `elapsedMs` ranges from `0` to well
 * beyond any `remainingMs` so overshoot is covered.
 */
const tickCase: fc.Arbitrary<{
  readonly state: PlayingState;
  readonly elapsedMs: number;
}> = fc
  .record({
    remainingMs: fc.integer({ min: 0, max: MAX_REMAINING_MS }),
    elapsedMs: fc.integer({ min: 0, max: MAX_ELAPSED_MS }),
    timerStarted: fc.boolean(),
    moveInProgress: fc.boolean(),
  })
  .map(({ remainingMs, elapsedMs, timerStarted, moveInProgress }) => {
    const avatar: Position = MINIMAL_MAZE.start;
    const state: PlayingState = {
      status: "Playing",
      maze: MINIMAL_MAZE,
      avatar,
      timeLimit: timeLimit(),
      remainingMs,
      timerStarted,
      pausedElapsedMs: 0,
      moveInProgress,
    };
    return { state, elapsedMs };
  });

describe("tickTimer — Property 7: the timer never goes negative and displayed seconds are non-negative", () => {
  // Feature: maze-game, Property 7: The timer never goes negative and displayed seconds are non-negative
  it("clamps remainingMs at zero, never increases it, and yields non-negative displayed seconds", () => {
    fc.assert(
      fc.property(tickCase, ({ state, elapsedMs }) => {
        const next = tickTimer(state, elapsedMs);

        // A plain decrement keeps the state Playing (transitions are reduce's job).
        expect(next.status).toBe("Playing");
        // Narrow the union so we can read remainingMs.
        if (next.status !== "Playing") {
          return;
        }

        // Never below zero, even when the tick overshoots the remaining time.
        expect(next.remainingMs).toBeGreaterThanOrEqual(0);

        // Monotonic non-increasing: the countdown never gains time.
        expect(next.remainingMs).toBeLessThanOrEqual(state.remainingMs);

        // R3.2: the displayed remaining seconds are a non-negative integer.
        const seconds = displayedSeconds(next.remainingMs);
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(seconds)).toBe(true);
      }),
      { numRuns: PROPERTY_MIN_RUNS },
    );
  });
});
