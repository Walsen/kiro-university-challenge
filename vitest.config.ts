import { defineConfig } from "vitest/config";

const CORE_COVERAGE_THRESHOLD = 90;

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    setupFiles: ["src/ui/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Coverage is enforced on the pure core only, per the engineering standards.
      include: ["src/core/**"],
      // The barrel re-export and co-located test files carry no production logic to cover.
      exclude: ["src/core/index.ts", "src/core/**/*.test.ts", "src/core/**/*.test.tsx"],
      thresholds: {
        lines: CORE_COVERAGE_THRESHOLD,
        branches: CORE_COVERAGE_THRESHOLD,
        functions: CORE_COVERAGE_THRESHOLD,
        statements: CORE_COVERAGE_THRESHOLD,
      },
    },
  },
});
