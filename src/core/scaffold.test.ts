import { describe, expect, it } from "vitest";

// Temporary scaffold smoke test so the runner has a passing spec before the
// core tasks add real tests. Removed once parseTimeLimit tests land (Task 3).
describe("scaffold", () => {
  it("runs the test runner", () => {
    expect(true).toBe(true);
  });
});
