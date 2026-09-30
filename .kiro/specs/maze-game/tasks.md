# Implementation Plan: Maze Game

## Overview

This plan converts the maze-game design into incremental, test-first coding tasks in **TypeScript (strict mode)** using **Vitest** and **fast-check** for tests, **ESLint + Prettier** for quality, an **HTML Canvas** renderer, and **GitHub Actions** for CI.

The approach follows the workspace engineering standards. Every logic task follows **Red → Green → Refactor**: a failing test is written before the implementation it specifies. Pure core logic (domain types, `validateMaze`, `resolveMove`, `tickTimer`, `parseTimeLimit`, `reduce`, maze generation) is built first, then impure edge adapters (`CanvasRenderer`, `KeyboardInputSource`, `SystemClock`), then the `GameStore`/`GameController` orchestration, and finally the composition root that wires everything together. Each step builds on the previous one so no code is left orphaned.

The 14 correctness properties from the design are implemented as `fast-check` property tests running **at least 100 iterations** each, tagged in the format `// Feature: maze-game, Property N: ...`. Core logic modules target **≥ 90% line and branch coverage**.

## Tasks

- [x] 1. Scaffold the project, tooling, and CI
  - [x] 1.1 Initialize TypeScript project with strict configuration
    - Create `package.json` with dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `fast-check`, `eslint`, `typescript-eslint`, `prettier`, and a Canvas/DOM test environment (`jsdom`)
    - Create `tsconfig.json` with `"strict": true`, `"noImplicitAny": true`, and `"noUncheckedIndexedAccess": true`
    - Create the source layout: `src/core/`, `src/app/`, `src/edges/`, `src/main.ts`, and a matching `tests/` or co-located `*.test.ts` convention
    - Add npm scripts: `lint`, `typecheck`, `test`, `test:coverage`, `build`
    - Configure Vitest with jsdom environment and a coverage threshold of 90% scoped to `src/core/**`
    - _Requirements: engineering standards (Language & Tooling, CI)_

  - [x] 1.2 Configure ESLint and Prettier
    - Add `eslint.config.js` (typescript-eslint, type-aware rules) and `.prettierrc`
    - Ensure `npm run lint` reports zero errors on the scaffold
    - _Requirements: engineering standards (Clean Code, CI)_

  - [x] 1.3 Add GitHub Actions CI workflow
    - Create `.github/workflows/ci.yml` triggered on push and pull_request
    - Run, in order: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run build`
    - Ensure the pipeline fails if any step fails
    - _Requirements: engineering standards (CI, Definition of Done)_

- [x] 2. Define the pure core domain model
  - [x] 2.1 Create core domain types
    - In `src/core/types.ts` define `CellKind`, `CellRole`, `Position`, `Direction`, `Maze`, and the `TimeLimit` branded type with `MIN_TIME_LIMIT_SECONDS`, `MAX_TIME_LIMIT_SECONDS`, `DEFAULT_TIME_LIMIT_SECONDS` constants
    - Define the `GameStatus` union and the `IdleState`/`PlayingState`/`WonState`/`LostState` discriminated union (`GameState`), plus `GameAction`, `GameConfig`, `GameResult`, `MazeValidationError`, and result types (`MazeValidationResult`, `MazeResult`, `TimeLimitResult`)
    - Model all fields as `readonly`; keep illegal states unrepresentable
    - _Requirements: 1.4, 7.1; design Data Models_

- [x] 3. Implement time-limit parsing (pure)
  - [x] 3.1 Write failing tests for `parseTimeLimit`
    - Assert `parseTimeLimit(undefined)` returns the 60s default (example test, R7.2)
    - _Requirements: 7.2_

  - [x] 3.2 Implement `parseTimeLimit`
    - In `src/core/parseTimeLimit.ts`, accept `unknown`, validate integer within [30, 600], return `ok:true` with a branded `TimeLimit` or `ok:false` with the default value and a `reason`
    - _Requirements: 7.1, 7.3, 7.4_

  - [x]* 3.3 Write property test: valid time limits accepted unchanged
    - **Property 13: Valid time limits are accepted unchanged**
    - **Validates: Requirements 7.1, 7.4**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 13: ...`

  - [x]* 3.4 Write property test: invalid time limits fall back to default with a reason
    - **Property 14: Invalid time limits fall back to the default with a reason**
    - **Validates: Requirements 7.3**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 14: ...`

- [x] 4. Implement maze validation (pure)
  - [x] 4.1 Write failing tests for `validateMaze`
    - Add known solvable and unsolvable maze fixtures; assert correct `MazeValidationError` for zero/multiple starts, zero/multiple exits, start-equals-exit, and no adjacent-path route
    - _Requirements: 1.4, 1.5, 1.6_

  - [x] 4.2 Implement `validateMaze`
    - In `src/core/validateMaze.ts`, verify exactly one start and one exit, distinct start/exit, both path cells, and a 4-directionally adjacent path route from start to exit (BFS/DFS)
    - Return a typed `MazeValidationResult`; do not throw for expected invalid input
    - _Requirements: 1.4, 1.5, 1.6_

  - [x]* 4.3 Write property test: invalid mazes are rejected
    - **Property 2: Invalid mazes are rejected and no session starts**
    - **Validates: Requirements 1.6**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 2: ...`

- [x] 5. Implement maze generation (Strategy) and factory (Factory)
  - [x] 5.1 Write failing tests for the maze generator
    - Define the `MazeGenerator` interface in `src/core/MazeGenerator.ts`; test `RecursiveBacktrackerGenerator` with a seeded `rng` for deterministic output
    - Assert generated mazes pass `validateMaze` for representative dimensions
    - _Requirements: 1.4, 1.5_

  - [x] 5.2 Implement `RecursiveBacktrackerGenerator`
    - In `src/core/RecursiveBacktrackerGenerator.ts`, generate a maze from injected `rng: () => number` with a guaranteed start-to-exit path
    - _Requirements: 1.4, 1.5_

  - [x]* 5.3 Write property test: generated mazes are valid and solvable
    - **Property 1: Generated mazes are always valid and solvable**
    - **Validates: Requirements 1.4, 1.5**
    - fast-check, ≥ 100 iterations over dimensions and seeds; tag `// Feature: maze-game, Property 1: ...`

  - [x] 5.4 Implement `MazeFactory`
    - In `src/core/MazeFactory.ts`, call the injected `MazeGenerator`, run `validateMaze`, and return `MazeResult` (`ok:false` with error on failure — fail fast at the boundary)
    - _Requirements: 1.6_

  - [x]* 5.5 Write unit tests for `MazeFactory` error path
    - Inject a generator that yields an invalid maze; assert `create` returns `ok:false` with the matching error
    - _Requirements: 1.6_

- [x] 6. Checkpoint - core parsing, validation, and generation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement movement and timer rules (pure)
  - [x] 7.1 Write failing tests for `resolveMove`
    - Cover valid one-cell move, wall block, out-of-bounds block, move-in-progress ignore, win onto exit with time remaining, no-win onto exit at/below zero time, and rejection in ended/idle states
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 4.1, 4.2, 4.4, 4.5_

  - [x] 7.2 Implement `resolveMove`
    - In `src/core/resolveMove.ts`, compute the target cell, block invalid moves (unchanged state + blocked signal), transition to `Won` with captured `elapsedMs` when entering the exit while `remainingMs > 0`, and reject moves when not in an active `PlayingState`
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 4.1, 4.2, 4.5_

  - [x]* 7.3 Write property test: a valid move advances exactly one cell
    - **Property 4: A valid move advances the avatar exactly one cell**
    - **Validates: Requirements 2.1**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 4: ...`

  - [x]* 7.4 Write property test: the avatar never enters a wall or out-of-bounds cell
    - **Property 5: The avatar never enters a wall or out-of-bounds cell**
    - **Validates: Requirements 2.2, 2.3**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 5: ...`

  - [x]* 7.5 Write property test: a move while a move is in progress is ignored
    - **Property 6: A move while a move is in progress is ignored**
    - **Validates: Requirements 2.5**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 6: ...`

  - [x]* 7.6 Write property test: reaching the exit with time remaining wins and captures elapsed time
    - **Property 10: Reaching the exit with time remaining wins and captures elapsed time**
    - **Validates: Requirements 4.1, 4.2, 3.5**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 10: ...`

  - [x]* 7.7 Write property test: reaching the exit without time remaining does not win
    - **Property 11: Reaching the exit without time remaining does not win**
    - **Validates: Requirements 4.5**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 11: ...`

  - [x] 7.8 Write failing tests for `tickTimer`
    - Cover monotonic non-increasing `remainingMs`, clamping at zero, and displayed seconds `max(0, floor(remainingMs/1000))`
    - _Requirements: 3.2, 3.3_

  - [x] 7.9 Implement `tickTimer`
    - In `src/core/tickTimer.ts`, decrease `remainingMs` by elapsed, clamp at 0 (never negative)
    - _Requirements: 3.2, 3.3_

  - [x]* 7.10 Write property test: the timer never goes negative and displayed seconds are non-negative
    - **Property 7: The timer never goes negative and displayed seconds are non-negative**
    - **Validates: Requirements 3.2**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 7: ...`

- [x] 8. Checkpoint - movement and timer rules
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement the state reducer and session factory (pure)
  - [x] 9.1 Write failing tests for `reduce`
    - Cover `StartSession` (fresh state), `Move` delegation to `resolveMove`, `Tick` delegation to `tickTimer` with loss-on-expiry, `MoveAnimationComplete`, and frozen state after Won/Lost
    - _Requirements: 3.3, 3.4, 3.5, 4.4, 6.5_

  - [x] 9.2 Implement `reduce`
    - In `src/core/reduce.ts`, apply pure transitions: delegate `Move` to `resolveMove`, `Tick` to `tickTimer` with `Playing → Lost` on reaching zero while not on exit, ignore `Tick`/`Move` in `Won`/`Lost`, and start the timer on the first accepted move
    - _Requirements: 3.3, 3.4, 3.5, 4.4, 6.3_

  - [x] 9.3 Implement `GameSessionFactory`
    - In `src/core/GameSessionFactory.ts`, build a fresh `PlayingState`: avatar on start, `remainingMs = timeLimit * 1000`, `timerStarted: false`, cleared prior result
    - _Requirements: 1.2, 6.2, 6.3, 6.5, 7.4_

  - [x]* 9.4 Write property test: a fresh session resets avatar, timer, and status with no leaked state
    - **Property 3: A fresh session resets avatar, timer, and status with no leaked state**
    - **Validates: Requirements 1.2, 6.2, 6.3, 6.5, 7.4**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 3: ...`

  - [x]* 9.5 Write property test: time expiring while not on the exit ends the session as a loss
    - **Property 8: Time expiring while not on the exit ends the session as a loss**
    - **Validates: Requirements 3.3**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 8: ...`

  - [x]* 9.6 Write property test: ended sessions freeze the timer
    - **Property 9: Ended sessions freeze the timer**
    - **Validates: Requirements 3.4, 3.5**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 9: ...`

  - [x]* 9.7 Write property test: any move after the session ends is rejected
    - **Property 12: Any move after the session ends is rejected**
    - **Validates: Requirements 4.4**
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game, Property 12: ...`

- [x] 10. Checkpoint - complete pure core with ≥ 90% coverage
  - Ensure all tests pass and `npm run test:coverage` meets the 90% threshold on `src/core/**`, ask the user if questions arise.

  - [x] 10.1 Integration checkpoint - core reducer pipeline (Integration Point A)
    - **Blocking integration gate.** Compose the *real* pure core end-to-end with no edges:
      `reduce` + `resolveMove` + `tickTimer` + `GameSessionFactory` + a real generated maze.
    - Drive a full session through pure `dispatch`: `StartSession` → a sequence of `Move`s
      along a known solvable path → `Tick`s to expiry (assert loss); and a separate run that
      reaches the exit with time remaining (assert win with captured elapsed time).
    - Deterministic: seeded `rng`, no `Clock`. Verifies the core functions honor each other's
      contracts before any edge exists.
    - _Requirements: 1.2, 2.1, 2.2, 3.3, 4.1; design "Integration testing" Point A_

- [x] 11. Implement the application store (State + Observer)
  - [x] 11.1 Write failing tests for `GameStore`
    - Assert `dispatch` applies `reduce`, `getState` returns current state, `subscribe` receives `StateChanged`, `MoveBlocked`, and `InvalidMaze` events, and unsubscribe stops notifications
    - _Requirements: 2.2, 2.3, 5.1, 5.2_

  - [x] 11.2 Implement `GameStore`
    - In `src/app/GameStore.ts`, hold the single `GameState`, apply pure transitions on `dispatch`, and emit `GameEvent`s to observers; never render
    - _Requirements: 1.6, 2.2, 2.3, 5.1, 5.2_

  - [x] 11.3 Integration checkpoint - store + core (Integration Point B)
    - **Blocking integration gate.** Drive the *real* `GameStore` with the *real* `reduce` (no
      stubbed reducer) and assert the emitted `GameEvent`s (`StateChanged`, `MoveBlocked`,
      `InvalidMaze`) match the underlying state transitions across a representative session.
    - Verifies the Observer wiring against real reducer output. _Seam: application ↔ core._
    - _Requirements: 2.2, 2.3, 5.1, 5.2; design "Integration testing" Point B_

- [x] 12. Implement the edge abstractions and adapters
  - [x] 12.1 Define edge interfaces
    - In `src/edges/`, define `Clock`, `Renderer`, `InputSource`, and the `MoveCommand` command type as small, segregated interfaces
    - _Requirements: design Components and Interfaces_

  - [x] 12.2 Implement `SystemClock`
    - In `src/edges/SystemClock.ts`, wrap `performance.now()` behind `Clock`
    - _Requirements: 3.1_

  - [x]* 12.3 Write unit tests for `SystemClock`
    - Verify it returns a monotonic numeric time (mock/stub `performance.now`)
    - _Requirements: 3.1_

  - [x] 12.4 Implement `CanvasRenderer`
    - In `src/edges/CanvasRenderer.ts`, implement `Renderer` against a `CanvasRenderingContext2D`: draw maze grid (distinct path/wall), avatar in start cell, distinct exit marker, remaining time, result message, invalid-maze indication, and `clearResult`; validate the canvas context at construction (fail fast)
    - _Requirements: 1.1, 1.2, 1.3, 2.4, 3.2, 4.3, 5.1, 5.2_

  - [x]* 12.5 Write unit tests for `CanvasRenderer` (mock context)
    - Assert maze/avatar/exit drawn (R1.1–1.3), avatar re-rendered after a move (R2.4), win/loss messages rendered (R4.3, R5.1, R5.2), and `clearResult` clears the result (R5.5, R6.4)
    - _Requirements: 1.1, 1.2, 1.3, 2.4, 4.3, 5.1, 5.2, 5.5, 6.4_

  - [x] 12.6 Implement `KeyboardInputSource`
    - In `src/edges/KeyboardInputSource.ts`, map arrow/WASD keys to `MoveCommand`s and a control activation to the new-session handler; expose `onCommand`, `onNewSession`, `dispose`; validate the target element at construction
    - _Requirements: 2.1, 5.4, 6.1_

  - [x]* 12.7 Write unit tests for `KeyboardInputSource`
    - Simulate key events and control activation; assert correct `MoveCommand`s and new-session callback fire
    - _Requirements: 2.1, 5.4, 6.1_

- [x] 13. Implement the orchestration controller
  - [x] 13.1 Write failing tests for `GameController`
    - Using a `FakeClock`, mock `Renderer`, and fake `InputSource`: assert commands dispatch `Move`, the loop dispatches `Tick` and stops after the session ends, the timer auto-starts after 1s, activating the new-session control dispatches `StartSession`, and the renderer is invoked on `StateChanged`
    - _Requirements: 2.4, 3.1, 3.4, 5.3, 5.4, 5.5, 6.1, 6.3, 6.4_

  - [x] 13.2 Implement `GameController`
    - In `src/app/GameController.ts`, subscribe to `InputSource`, drive `Tick` from the injected `Clock` via the animation loop, stop ticking once ended, subscribe the `Renderer` to the store, and route new-session activation to `StartSession`
    - _Requirements: 2.4, 3.1, 3.4, 5.3, 5.4, 5.5, 6.1, 6.3, 6.4_

  - [x] 13.3 Integration checkpoint - controller + store + faked edges (Integration Point C)
    - **Blocking integration gate.** Compose the *real* `GameController`, *real* `GameStore`,
      and *real* `reduce`, faking only the edges (`FakeClock`, fake `InputSource`, mock
      `Renderer`).
    - Assert: an input `MoveCommand` flows through to a renderer redraw; the tick loop
      dispatches `Tick` and drives a loss, then stops dispatching once ended; activating the
      new-session control starts a fresh session. The "whole machine turns over" test,
      landing before the composition root.
    - _Requirements: 2.4, 3.1, 3.4, 5.4, 6.1, 6.3; design "Integration testing" Point C_

- [x] 14. Wire the composition root
  - [x] 14.1 Implement `main.ts` composition root
    - Construct concrete `SystemClock`, `CanvasRenderer`, `KeyboardInputSource`, `RecursiveBacktrackerGenerator`, `MazeFactory`, `GameStore`, and `GameController`; parse the time limit through `parseTimeLimit`; inject all dependencies; start a session; add a minimal `index.html` with the canvas and new-session control
    - _Requirements: 1.1, 3.1, 5.4, 6.1, 7.2, 7.3_

  - [x] 14.2 Write a composition-root smoke test (Integration Point D)
    - With a jsdom canvas and fake input, assert the fully wired app (real edges included)
      initializes and renders an initial maze without throwing. Final integration gate.
    - Note: promoted from optional to a blocking integration checkpoint (Integration Point D).
    - _Requirements: 1.1; design "Integration testing" Point D_

- [x] 15. Final checkpoint - full suite, coverage, lint, typecheck, and build
  - Ensure `npm run lint`, `npm run typecheck`, `npm run test:coverage`, and `npm run build` all pass with ≥ 90% coverage on core logic, ask the user if questions arise.
  - Verified: lint clean, typecheck clean, build OK, core coverage 98.37% (≥ 90%); full suite 497 passing (12 Phase 2 cloud-integration tests skipped — they need a live AWS stack).

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP, though the engineering standards call for them under the Definition of Done.
- Every task references specific requirements and, where applicable, the design correctness property it implements for full traceability.
- TDD is applied throughout: failing tests precede implementation for all core logic.
- The 14 correctness properties are each realized by a single `fast-check` property test with ≥ 100 iterations, tagged `// Feature: maze-game, Property N: ...`.
- Checkpoints provide incremental validation at natural boundaries.
- Integration checkpoints (tasks 10.1, 11.3, 13.3, and 14.2 = Integration Points A–D) are
  blocking gates that verify each component seam with the real components composed, as soon
  as both sides of the seam exist. They are infra-free (Vitest/jsdom); see the design's
  "Integration testing" subsection. This replaces end-of-build "big bang" integration with
  continuous seam verification.
- Core logic modules (`validateMaze`, `resolveMove`, `tickTimer`, `parseTimeLimit`, `reduce`, generation) target ≥ 90% line and branch coverage.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1", "4.1", "5.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.2"] },
    { "id": 4, "tasks": ["3.3", "3.4", "4.3", "5.3", "5.4", "7.1", "7.8", "12.1"] },
    { "id": 5, "tasks": ["5.5", "7.2", "7.9", "12.2", "12.4", "12.6"] },
    { "id": 6, "tasks": ["7.3", "7.4", "7.5", "7.6", "7.7", "7.10", "9.1", "12.3", "12.5", "12.7"] },
    { "id": 7, "tasks": ["9.2", "9.3"] },
    { "id": 8, "tasks": ["9.4", "9.5", "9.6", "9.7", "10.1", "11.1"] },
    { "id": 9, "tasks": ["11.2", "13.1"] },
    { "id": 10, "tasks": ["11.3", "13.2"] },
    { "id": 11, "tasks": ["13.3", "14.1"] },
    { "id": 12, "tasks": ["14.2"] }
  ]
}
```
