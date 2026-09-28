/**
 * `tickTimer` — the pure core timer rule.
 *
 * Decreases a `PlayingState`'s `remainingMs` by the elapsed milliseconds and
 * clamps the result at zero so the timer never goes negative (design
 * Correctness Property 7; R3.2, R3.3). Its scope is deliberately narrow: it
 * only decrements and clamps. The Playing -> Lost on-expiry transition is the
 * responsibility of `reduce` (see the design's transition rules), NOT this
 * function, so reaching zero here keeps the state in `Playing`.
 *
 * Pure and immutable: it returns a new state and never mutates its input.
 * Non-`Playing` states have no running timer, so they are returned unchanged.
 */
import type { GameState, PlayingState } from "./types";

/** The timer floor: `remainingMs` is clamped here and never goes below it. */
const MIN_REMAINING_MS = 0;

export function tickTimer(state: GameState, elapsedMs: number): GameState {
  if (state.status !== "Playing") {
    return state;
  }

  const remainingMs = Math.max(MIN_REMAINING_MS, state.remainingMs - elapsedMs);

  const next: PlayingState = { ...state, remainingMs };
  return next;
}
