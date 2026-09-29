/**
 * Unit tests for the shared HTTP-handler helpers, focused on the graceful-
 * degradation / load-posture seam (task 9.2, R7.2, R7.3).
 *
 * These cover the pure pieces that let a handler shed an at-capacity request as
 * a clear, retryable 429 instead of an ambiguous 5xx:
 *  - `isCapacityError` classifies the known DynamoDB throttling signals (by SDK
 *    error `name` or a 429 in `$metadata`) and nothing else.
 *  - `tooManyRequests` shapes a typed 429 with a `Retry-After` hint.
 *  - `CONCURRENT_PLAYER_TARGET` documents the tested target the budgets assert
 *    against (task 9.3 / the G2 checkpoint).
 *
 * No AWS: `isCapacityError` reads an error's shape structurally, so the tests
 * build plain error-shaped objects mirroring what the AWS SDK v3 throws.
 */
import { describe, expect, it } from "vitest";

import {
  CONCURRENT_PLAYER_TARGET,
  isCapacityError,
  tooManyRequests,
} from "./http";

describe("isCapacityError (R7.3 classification)", () => {
  it.each([
    "ProvisionedThroughputExceededException",
    "ThrottlingException",
    "RequestLimitExceeded",
    "TooManyRequestsException",
  ])("treats the DynamoDB throttling signal %s as a capacity error", (name) => {
    // Shape mirrors an AWS SDK v3 service error: a named error object.
    const error = Object.assign(new Error(name), { name });

    expect(isCapacityError(error)).toBe(true);
  });

  it("treats a 429 in $metadata as a capacity error even for an unnamed error", () => {
    const error = { $metadata: { httpStatusCode: 429 } };

    expect(isCapacityError(error)).toBe(true);
  });

  it("does not treat an ordinary/unknown error as a capacity error", () => {
    expect(isCapacityError(new Error("boom"))).toBe(false);
    expect(
      isCapacityError(Object.assign(new Error("nope"), { name: "ValidationException" })),
    ).toBe(false);
    expect(isCapacityError({ $metadata: { httpStatusCode: 500 } })).toBe(false);
  });

  it("does not treat a non-object (null/undefined/string) as a capacity error", () => {
    expect(isCapacityError(null)).toBe(false);
    expect(isCapacityError(undefined)).toBe(false);
    expect(isCapacityError("ThrottlingException")).toBe(false);
  });
});

describe("tooManyRequests (R7.3 clear, retryable indication)", () => {
  it("is a 429 carrying a Retry-After hint and a typed, retryable body", () => {
    const result = tooManyRequests();

    expect(result.statusCode).toBe(429);
    expect(result.headers["retry-after"]).toBe("1");
    expect(result.headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(result.body) as { error: string; retryable: boolean };
    // A machine-readable signal the client can distinguish from a 4xx/5xx.
    expect(payload).toEqual({ error: "capacity_exceeded", retryable: true });
  });
});

describe("load posture (R7.2)", () => {
  it("documents the tested concurrent-player target as the adopted default", () => {
    expect(CONCURRENT_PLAYER_TARGET).toBe(1_000);
  });
});
