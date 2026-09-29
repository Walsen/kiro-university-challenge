/**
 * Unit tests for `SystemClock` (edge adapter for the `Clock` port).
 *
 * `SystemClock.now()` wraps the global `performance.now()` to expose a
 * monotonic millisecond time source, the timing input that drives the
 * countdown timer's elapsed-time deltas (R3.1). These tests stub
 * `performance.now` so they are deterministic and never read the wall clock.
 *
 * _Requirements: 3.1_
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemClock } from "./SystemClock";

describe("SystemClock.now", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the numeric value from performance.now", () => {
    vi.spyOn(performance, "now").mockReturnValue(1234.5);
    expect(new SystemClock().now()).toBe(1234.5);
  });

  it("returns a number", () => {
    // Real performance.now is left in place here; only the type is asserted.
    expect(typeof new SystemClock().now()).toBe("number");
  });

  it("reflects a monotonic non-decreasing sequence as the source advances", () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(20);
    const clock = new SystemClock();

    const first = clock.now();
    const second = clock.now();
    const third = clock.now();

    expect(first).toBe(10);
    expect(second).toBe(20);
    expect(third).toBe(20);
    expect(second).toBeGreaterThanOrEqual(first);
    expect(third).toBeGreaterThanOrEqual(second);
  });
});
