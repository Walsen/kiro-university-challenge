/**
 * Pure validator for a player-specified time limit (R7.1, R7.3, R7.4).
 *
 * Untrusted external input (e.g. a URL param or form field) arrives as
 * `unknown` and is parsed here before use. A valid value is an integer within
 * [MIN_TIME_LIMIT_SECONDS, MAX_TIME_LIMIT_SECONDS] and is returned as a branded
 * `TimeLimit`. Invalid input is rejected with the default limit and a typed
 * `reason`, rather than throwing. This is the only place a `TimeLimit` is
 * produced, so an out-of-range number can never reach the timer.
 *
 * Pure: no I/O, no DOM, no access to time or randomness.
 */
import {
  DEFAULT_TIME_LIMIT_SECONDS,
  MAX_TIME_LIMIT_SECONDS,
  MIN_TIME_LIMIT_SECONDS,
  type TimeLimit,
  type TimeLimitResult,
} from "./types";

/**
 * Brand a plain number as a `TimeLimit`. The single cast lives here so the
 * unsafe assertion is confined to the validated path in `parseTimeLimit`.
 */
function asTimeLimit(seconds: number): TimeLimit {
  return seconds as TimeLimit;
}

const DEFAULT_TIME_LIMIT = asTimeLimit(DEFAULT_TIME_LIMIT_SECONDS);

export function parseTimeLimit(input: unknown): TimeLimitResult {
  if (typeof input !== "number" || !Number.isInteger(input)) {
    return { ok: false, value: DEFAULT_TIME_LIMIT, reason: "not-integer" };
  }

  if (input < MIN_TIME_LIMIT_SECONDS || input > MAX_TIME_LIMIT_SECONDS) {
    return { ok: false, value: DEFAULT_TIME_LIMIT, reason: "out-of-range" };
  }

  return { ok: true, value: asTimeLimit(input) };
}
