import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { parseTimeLimit } from "./parseTimeLimit";
import {
  DEFAULT_TIME_LIMIT_SECONDS,
  MAX_TIME_LIMIT_SECONDS,
  MIN_TIME_LIMIT_SECONDS,
} from "./types";

/**
 * Property-based test for Correctness Property 14 (maze-game design).
 *
 * For any value that is not an integer or is outside [30, 600], `parseTimeLimit`
 * rejects it: it returns `ok: false` with a value equal to
 * `DEFAULT_TIME_LIMIT_SECONDS` and a reason of `not-integer` or `out-of-range`.
 *
 * Per the implementation contract, the reason is category-specific:
 * - out-of-range *integers* (< 30 or > 600) → `out-of-range`;
 * - anything that is not an integer (floats, NaN, ±Infinity, or a non-number
 *   type entirely) → `not-integer`.
 * The generators below cover that invalid space and each asserts the specific
 * reason the category must produce, not merely membership in the reason set.
 *
 * Runs ≥ 100 iterations (fast-check default is 100; set explicitly here).
 *
 * Validates: Requirements 7.3
 */

const NUM_RUNS = 100;

/** Out-of-range integers: integers strictly below MIN or strictly above MAX. */
const outOfRangeIntegerArb: fc.Arbitrary<number> = fc.oneof(
  // Below the minimum, including negatives and zero.
  fc.integer({ min: -100_000, max: MIN_TIME_LIMIT_SECONDS - 1 }),
  // Above the maximum.
  fc.integer({ min: MAX_TIME_LIMIT_SECONDS + 1, max: 1_000_000 }),
);

/**
 * Non-integer finite numbers (floats with a fractional part), drawn from both
 * inside and outside the [30, 600] band so the fractional part — not the range
 * — is what makes them invalid.
 */
const nonIntegerFloatArb: fc.Arbitrary<number> = fc
  .double({ min: -1000, max: 2000, noNaN: true })
  .filter((n) => !Number.isInteger(n));

/** Special numeric values that are numbers but never integers. */
const nonIntegerSpecialNumberArb: fc.Arbitrary<number> = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
);

/** Non-number types: strings, booleans, null, undefined, and objects. */
const nonNumberArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.object(),
  fc.array(fc.anything()),
);

describe("parseTimeLimit — Property 14: invalid time limits fall back to the default with a reason", () => {
  // Feature: maze-game, Property 14: Invalid time limits fall back to the default with a reason
  it("rejects out-of-range integers with reason 'out-of-range' and the default value", () => {
    fc.assert(
      fc.property(outOfRangeIntegerArb, (input) => {
        const result = parseTimeLimit(input);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return; // unreachable given the assertion above; narrows the type
        }
        expect(result.value).toBe(DEFAULT_TIME_LIMIT_SECONDS);
        expect(result.reason).toBe("out-of-range");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: maze-game, Property 14: Invalid time limits fall back to the default with a reason
  it("rejects non-integer numbers (floats, NaN, ±Infinity) with reason 'not-integer' and the default value", () => {
    const nonIntegerNumberArb = fc.oneof(
      nonIntegerFloatArb,
      nonIntegerSpecialNumberArb,
    );

    fc.assert(
      fc.property(nonIntegerNumberArb, (input) => {
        const result = parseTimeLimit(input);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.value).toBe(DEFAULT_TIME_LIMIT_SECONDS);
        expect(result.reason).toBe("not-integer");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: maze-game, Property 14: Invalid time limits fall back to the default with a reason
  it("rejects non-number types with reason 'not-integer' and the default value", () => {
    fc.assert(
      fc.property(nonNumberArb, (input) => {
        const result = parseTimeLimit(input);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.value).toBe(DEFAULT_TIME_LIMIT_SECONDS);
        expect(result.reason).toBe("not-integer");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: maze-game, Property 14: Invalid time limits fall back to the default with a reason
  it("for any invalid input, returns ok:false with the default value and a reason in {not-integer, out-of-range}", () => {
    const anyInvalidArb: fc.Arbitrary<unknown> = fc.oneof(
      outOfRangeIntegerArb,
      nonIntegerFloatArb,
      nonIntegerSpecialNumberArb,
      nonNumberArb,
    );

    fc.assert(
      fc.property(anyInvalidArb, (input) => {
        const result = parseTimeLimit(input);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }
        expect(result.value).toBe(DEFAULT_TIME_LIMIT_SECONDS);
        expect(["not-integer", "out-of-range"]).toContain(result.reason);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
