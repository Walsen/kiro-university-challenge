# Testing

This document defines how the project is tested. It applies whenever tests are written,
changed, or reviewed. It operationalizes the TDD and coverage requirements from the
engineering standards and the testing strategy from the maze-game design.

## Test-Driven Development

Follow **Red → Green → Refactor** for all logic:

1. **Red** — write a failing test that specifies the behavior before any implementation.
2. **Green** — write the minimum code to make the test pass.
3. **Refactor** — improve the design while keeping tests green.

Rules:
- No production logic is written without a failing test first.
- Every acceptance criterion in a spec maps to at least one test.
- Keep unit tests fast and deterministic. Fake side-effecting collaborators (Canvas, timers,
  input, network) rather than exercising the real thing.

## Tooling

- **Vitest** is the test runner (TypeScript-native, fast).
- **fast-check** provides property-based tests.
- **ESLint + Prettier** are enforced; committed test code has zero lint errors.
- Coverage is reported via Vitest's coverage provider through `npm run test:coverage`.

## Test Types

### Example-based unit tests

Use for specific cases, edge cases, integration points, and side-effecting concerns that
are not universal properties: renderer interactions (against a mock `Renderer`), input
mapping, the timer loop (against a `FakeClock`), known fixtures, and wiring.

### Property-based tests (PBT)

Use for invariants that must hold across all valid inputs. Conventions:

- Each correctness property in a design maps to **exactly one** fast-check property test.
- Every property runs a **minimum of 100 iterations**.
- Tag each property test with a comment linking it to the design, in the format:
  `// Feature: <feature>, Property N: <property name>`
- Write **custom arbitraries** to generate valid domain values (e.g. valid mazes,
  `PlayingState`s with the avatar on a random path cell, directions, time-limit inputs
  including floats, out-of-range, and non-numbers).
- Property tests exercise **pure core logic**; inject fakes for any side effects so runs are
  deterministic.

### Integration tests (verify seams continuously)

Unit and property tests verify components in isolation; they do not prove the real
components are wired together correctly. To avoid a "big bang" integration at the end of a
build, **verify each seam as soon as both sides of it exist** — do not defer integration to
a single end-of-build step.

- An integration test composes the **real** components on either side of a seam and fakes
  only what is genuinely external (time via `Clock`, input, the DOM/network).
- Add an integration checkpoint at each crucial seam (e.g. core-pipeline, store ↔ core,
  controller ↔ store ↔ faked edges, and a full-stack smoke test). Treat these checkpoints as
  **blocking gates**, consistent with keeping `main` green.
- A design that has integration points should enumerate them; each maps to at least one
  integration test. For the maze game these are Integration Points A–D in the design's
  "Integration testing" subsection.
- **Phase applicability.** Phase 1 integration is in-process (no infrastructure). Phase 2
  seams that cross a network or cloud boundary (client ↔ API, API ↔ data store, auth,
  real-time) are integrated **deploy-first** against a real dev stack; see
  `docs/aws-decisions.md`. The principle is the same in both phases: verify each seam as
  early as it exists.

## Determinism

- No test depends on wall-clock time or `Math.random` directly.
- Time enters through the `Clock` port (use a `FakeClock` to advance time).
- Randomness enters through an injected `rng: () => number` (seed it for reproducibility).

## Coverage

- Core logic modules (maze generation, `validateMaze`, `resolveMove`, `tickTimer`,
  `parseTimeLimit`, `reduce`, session factory) target **≥ 90% line and branch coverage**.
- Edge adapters are covered by mock-based unit tests.
- The composition root is covered by a smoke test.
- The coverage threshold is enforced in CI and scoped to `src/core/**`.

## Placement and Naming

- Co-locate tests with the code under test using the `*.test.ts` convention, or under a
  `tests/` tree — pick one convention per area and keep it consistent.
- Name tests by the behavior they specify, not the function name alone, so a failing test
  reads as a specification.

## Definition of Done (testing)

This is the testing-specific view of the overall Definition of Done in the engineering
standards (`#[[file:engineering-standards.md]]`); the CI pipeline that enforces it is
defined there too.

- Tests were written first and now pass (Red → Green → Refactor followed).
- Every acceptance criterion is covered by at least one test.
- Core invariants are covered by property-based tests at ≥ 100 iterations each.
- `npm run test:coverage` meets the ≥ 90% core threshold, and lint/typecheck/build pass.
  (Locally these scripts run via Devbox — see `#[[file:dev-environment.md]]`.)
