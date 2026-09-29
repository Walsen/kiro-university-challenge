/**
 * Vitest global setup for the React UI tests.
 *
 * Registers the `@testing-library/jest-dom` custom matchers (e.g.
 * `toBeInTheDocument`, `toBeDisabled`) on Vitest's `expect`, and cleans up the
 * rendered DOM between tests so each render/smoke test is isolated and
 * deterministic (testing steering "Determinism"). This file runs before every
 * test file via `setupFiles` in `vitest.config.ts`.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
