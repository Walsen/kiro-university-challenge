import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseTimeLimit } from "./parseTimeLimit";
import { MAX_TIME_LIMIT_SECONDS, MIN_TIME_LIMIT_SECONDS } from "./types";

/**
 * Property-based test for Correctness Property 13.
 *
 * The design's Property 13 has two halves: (a) `parseTimeLimit` accepts any
 * valid integer time limit unchanged, and (b) a session built from that limit
 * has `remainingMs === limit * 1000`. This file implements the `parseTimeLimit`
 * half (R7.1, R7.4); the session half is exercised where the session factory
 * exists. Per the testing steering, one fast-check property realizes the design
 * property, running a minimum of 100 iterations with a custom arbitrary that
 * constrains generation to the valid input space (integers in [30, 600]).
 *
 * _Validates: Requirements 7.1, 7.4_
 */

const PROPERTY_MIN_RUNS = 100;

/**
 * Custom arbitrary: valid time-limit inputs are integers within the inclusive
 * range [MIN_TIME_LIMIT_SECONDS, MAX_TIME_LIMIT_SECONDS]. Constraining the
 * generator to this domain keeps every example a value the validator must
 * accept, so the property speaks only to the "accepted unchanged" behavior.
 */
const validTimeLimitSeconds: fc.Arbitrary<number> = fc.integer({
  min: MIN_TIME_LIMIT_SECONDS,
  max: MAX_TIME_LIMIT_SECONDS,
});

describe("parseTimeLimit — Property 13: valid time limits accepted unchanged", () => {
  // Feature: maze-game, Property 13: Valid time limits are accepted unchanged
  it("returns ok:true with the input value for any integer in [30, 600]", () => {
    fc.assert(
      fc.property(validTimeLimitSeconds, (seconds) => {
        const result = parseTimeLimit(seconds);

        expect(result.ok).toBe(true);
        expect(result.value).toBe(seconds);
      }),
      { numRuns: PROPERTY_MIN_RUNS },
    );
  });
});
