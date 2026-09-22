# Engineering Standards

These standards apply to all code in this project. They enforce clean programming,
SOLID design, design patterns, Test-Driven Development (TDD), and Continuous
Integration (CI). Follow them when writing, reviewing, or refactoring code.

## Language & Tooling

- Language: **TypeScript** with `strict` mode enabled (`strict: true` in `tsconfig.json`).
- No implicit `any`. Prefer explicit, precise types. Model illegal states as unrepresentable.
- Lint with **ESLint** (typescript-eslint) and format with **Prettier**. Zero lint errors in committed code.
- Test runner: **Vitest** (fast, TS-native). Property-based tests via **fast-check**.

## Clean Code

- Use intention-revealing names. A name should explain *why* it exists and *what* it does.
- Functions do one thing. Keep them small; extract until each function reads like a sentence.
- Prefer pure functions for game logic (deterministic given inputs) to keep logic testable and reliable.
- No magic numbers or strings. Extract to named constants (e.g., `DEFAULT_TIME_LIMIT_SECONDS = 60`).
- Isolate side effects (rendering, input, timers) at the edges; keep core logic pure.
- Comments explain *why*, not *what*. Delete commented-out code.
- Fail fast: validate inputs at boundaries and return typed errors early.

## SOLID Principles

- **S — Single Responsibility**: Separate maze generation, game state, movement rules, timing, rendering, and input handling.
- **O — Open/Closed**: Extend via new implementations behind interfaces (e.g., `MazeGenerator`), not by editing tested code.
- **L — Liskov Substitution**: Any implementation must be usable wherever its interface is expected, without surprises.
- **I — Interface Segregation**: Prefer small, focused interfaces (e.g., separate `Renderer` and `InputSource`).
- **D — Dependency Inversion**: Game logic depends on abstractions, not concrete Canvas/DOM classes. Inject dependencies.

## Design Patterns

Apply patterns where they reduce complexity, never for their own sake.

- **Strategy**: Swap maze-generation algorithms behind a `MazeGenerator` interface.
- **State**: Model the game lifecycle (`Idle`, `Playing`, `Won`, `Lost`) as explicit states with defined transitions.
- **Observer / Event Emitter**: Decouple game state changes from rendering and UI updates.
- **Factory**: Centralize construction of mazes and game sessions.
- **Command**: Represent movement input (up/down/left/right) as commands the controller processes.
- **Dependency Injection**: Pass collaborators in rather than instantiating them internally.

## Test-Driven Development (TDD)

Follow **Red -> Green -> Refactor** for all logic:

1. **Red**: Write a failing test specifying the behavior before writing implementation.
2. **Green**: Write the minimum code to make the test pass.
3. **Refactor**: Improve the design while keeping tests green.

Rules:
- No production logic without a failing test first.
- Every acceptance criterion in the spec maps to at least one test.
- Use **property-based tests** for invariants (e.g., "the avatar never occupies a wall cell", "a generated maze always has a start-to-exit path", "the timer never goes negative").
- Keep unit tests fast and deterministic. Fake side-effecting collaborators (Canvas, timers, input).
- Cover all important functions: maze generation, movement/collision rules, timer countdown, win/loss detection, session reset. Target >= 90% coverage on core logic.

## Continuous Integration (CI)

- Provide npm scripts: `lint`, `typecheck`, `test`, `test:coverage`, `build`.
- Add a **GitHub Actions** workflow (`.github/workflows/ci.yml`) that runs on every push and pull request:
  1. `npm ci`
  2. `npm run lint`
  3. `npm run typecheck`
  4. `npm run test:coverage`
  5. `npm run build`
- The pipeline must fail if lint, type checks, tests, or the build fail.
- Do not merge code with failing CI. Keep main always green.

## Definition of Done

- Tests were written first and now pass (Red -> Green -> Refactor followed).
- Lint, type checks, and build pass locally and in CI.
- Core logic is covered by unit and property-based tests.
- Code adheres to the clean code and SOLID guidance above.
