import { describe, expect, it } from "vitest";

import { parseTimeLimit } from "./parseTimeLimit";
import { DEFAULT_TIME_LIMIT_SECONDS } from "./types";

/**
 * Example-based unit tests for `parseTimeLimit`.
 *
 * Red step (Task 3.1): these specify behavior before the implementation in
 * `parseTimeLimit.ts` exists, so they are expected to fail until Task 3.2.
 */
describe("parseTimeLimit", () => {
  it("falls back to the 60-second default when no time limit is provided", () => {
    // R7.2: WHERE no Player-specified Time_Limit is provided, apply a default
    // of 60 seconds. An absent value arrives as `undefined`.
    const result = parseTimeLimit(undefined);

    expect(result.value).toBe(DEFAULT_TIME_LIMIT_SECONDS);
    expect(DEFAULT_TIME_LIMIT_SECONDS).toBe(60);
  });
});
