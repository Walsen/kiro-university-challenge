# Engineering Standards

These standards apply to all code in this project. They enforce clean programming,
SOLID design, design patterns, Test-Driven Development (TDD), and Continuous
Integration (CI). Follow them when writing, reviewing, or refactoring code.

## Language & Tooling

- Language: **TypeScript** with `strict` mode enabled (`strict: true` in `tsconfig.json`).
- No implicit `any`. Prefer explicit, precise types. (Domain-modeling detail — immutability,
  branded types, making illegal states unrepresentable — lives in the data-model steering
  doc, `#[[file:data-model.md]]`.)
- Lint with **ESLint** (typescript-eslint) and format with **Prettier**. Zero lint errors in committed code.
- Test tooling (Vitest, fast-check) and how to use it are defined in the testing steering
  doc, `#[[file:testing.md]]`.
- Local toolchain and how commands are run (Devbox) are defined in the dev-environment
  steering doc, `#[[file:dev-environment.md]]`.

## Clean Code

- Use intention-revealing names. A name should explain *why* it exists and *what* it does.
- Functions do one thing. Keep them small; extract until each function reads like a sentence.
- Prefer pure functions for game logic (deterministic given inputs) to keep logic testable and reliable.
- No magic numbers or strings. Extract to named constants (e.g., `DEFAULT_TIME_LIMIT_SECONDS = 60`).
- Comments explain *why*, not *what*. Delete commented-out code.
- Fail fast: validate inputs at boundaries and return typed errors early.
- Isolating side effects at the edges and keeping core logic pure is an architectural rule;
  the layering that enforces it is in `#[[file:architecture.md]]`.

## SOLID Principles

- **S — Single Responsibility**: Separate maze generation, game state, movement rules, timing, rendering, and input handling.
- **O — Open/Closed**: Extend via new implementations behind interfaces (e.g., `MazeGenerator`), not by editing tested code.
- **L — Liskov Substitution**: Any implementation must be usable wherever its interface is expected, without surprises.
- **I — Interface Segregation**: Prefer small, focused interfaces (e.g., separate `Renderer` and `InputSource`).
- **D — Dependency Inversion**: Game logic depends on abstractions, not concrete Canvas/DOM classes. Inject dependencies.

## Design Patterns

Apply patterns where they reduce complexity, never for their own sake. The concrete
pattern choices (Strategy, State, Observer, Factory, Command, Dependency Injection) and how
they map onto the layers are defined in the architecture steering doc — see
`#[[file:architecture.md]]`. Do not restate them here; that doc is the single source.

## Test-Driven Development (TDD) & Testing

TDD (Red → Green → Refactor), property-based testing conventions, determinism rules, and the
≥ 90% core-coverage bar are defined in the testing steering doc — see
`#[[file:testing.md]]`. It is the single source for how we test; this section intentionally
does not duplicate it.

The Definition of Done below still treats "tests written first and passing" as mandatory.

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
- CI runs these npm scripts directly. Local runs use the same scripts via Devbox; that
  local/CI boundary is defined in `#[[file:dev-environment.md]]`.

## Definition of Done

- Tests were written first and now pass (Red -> Green -> Refactor followed).
- Lint, type checks, and build pass locally and in CI.
- Core logic is covered by unit and property-based tests.
- Code adheres to the clean code and SOLID guidance above.
