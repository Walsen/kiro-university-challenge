# Architecture

This document defines the architectural style for the project and how code is organized.
It applies when creating, structuring, or refactoring modules. It builds on the
engineering standards (SOLID, design patterns, TDD) and gives them a concrete shape.

> **Scope: software architecture only.** This doc covers module structure, ports/adapters,
> the dependency rule, and runtime component integration. **Cloud/deployment architecture is
> out of scope here** — Phase 1 is client-only with nothing to deploy beyond static assets,
> and the AWS/deployment decisions (with their timeline and pivot criteria) live in the
> business-model steering doc and, in full, in `docs/aws-decisions.md`. The full,
> in-extenso version of this software architecture is in `docs/architecture.md`.

## Style: Hexagonal (Ports and Adapters)

The project follows a **hexagonal architecture**, also called **ports and adapters**. This
style fits an interactive game well: the game rules are the valuable, long-lived core, and
the browser concerns (Canvas rendering, keyboard input, wall-clock timing) are
replaceable details that must never leak into the rules.

The guiding principle is a strict separation between **pure core logic** and **impure edge
adapters**. All game rules — maze validation, movement and collision resolution, timer
countdown, win/loss detection, session lifecycle — are pure, deterministic functions over
immutable data. Side effects live only at the edges, behind interfaces, and are injected
into the core.

## Layers

Code is organized into three layers, matching the maze-game design:

1. **Core (pure)** — `src/core/`
   - Domain types and rule functions. No I/O, no `Date.now()`, no DOM, no `Math.random()`
     reached directly.
   - Deterministic given inputs. Randomness and time enter only through injected
     abstractions (`rng: () => number`, `Clock`).
   - Examples: `types`, `validateMaze`, `resolveMove`, `tickTimer`, `parseTimeLimit`,
     `reduce`, maze generation, and the session factory.

2. **Application (orchestration)** — `src/app/`
   - Holds the current state, applies pure core transitions, and emits change events.
   - Depends only on core types and on injected edge **ports** (`Clock`, `MazeGenerator`,
     `Renderer`, `InputSource`). Never on `window`, `Date`, `KeyboardEvent`, or
     `CanvasRenderingContext2D`.
   - Examples: `GameStore` (State + Observer), `GameController` (routing).

3. **Edges (impure adapters)** — `src/edges/`
   - The only modules that touch the browser or the outside world.
   - Each implements a port defined for the core/application to depend on.
   - Examples: `CanvasRenderer` implements `Renderer`, `KeyboardInputSource` implements
     `InputSource`, `SystemClock` implements `Clock`.

## Component Integration Diagram

A component-integration diagram (ports-and-adapters structure plus the runtime flow of one
move and one timer tick) is maintained in `docs/architecture.md`, alongside the in-extenso
walkthrough. It is kept there rather than in this steering doc to avoid duplication.

## Ports and Adapters

- **Ports** are the small, focused interfaces the inside depends on: `Clock`, `Renderer`,
  `InputSource`, `MazeGenerator`. Keep them segregated (Interface Segregation) — `Renderer`
  and `InputSource` are separate, and timing is its own `Clock`.
- **Adapters** are the concrete edge implementations of those ports. New adapters (a
  different renderer, a touch input source, a network clock) are added as new
  implementations, never by editing tested core code (Open/Closed).

## Dependency Rule

- Dependencies point **inward**. Edges depend on the application and core; the application
  depends on the core; the core depends on nothing outside itself.
- The core and application depend on **abstractions**, not concretions (Dependency
  Inversion). Concrete adapters are constructed in a single **composition root**
  (`src/main.ts`) and injected. Tests inject fakes (`FakeClock`, mock `Renderer`) in their
  place.
- No import from `core/` may reference `app/` or `edges/`. No import from `app/` may
  reference `edges/`. Enforce this direction in review.

This layering is the concrete expression of the SOLID principles stated in the engineering
standards (`#[[file:engineering-standards.md]]`) — Single Responsibility per module,
Open/Closed via new adapters, and Dependency Inversion via injected ports. This doc is the
single source for the *structure*; that doc is the single source for the *principles*.

## Patterns in Use

This doc is the single source for the project's design-pattern choices. Apply patterns where
they reduce complexity, never for their own sake. The design uses:

- **Strategy** — swap maze-generation algorithms behind `MazeGenerator`.
- **State** — model the game lifecycle (`Idle`, `Playing`, `Won`, `Lost`) as explicit
  states with defined transitions.
- **Observer / Event Emitter** — decouple state changes (`GameStore`) from rendering/UI.
- **Factory** — centralize construction of mazes (`MazeFactory`) and sessions
  (`GameSessionFactory`).
- **Command** — represent movement input as `MoveCommand` data.
- **Dependency Injection** — pass collaborators in; never instantiate them internally.

The domain types these patterns operate on (e.g. the `GameState` union for the State
pattern) are defined in the data-model steering doc, `#[[file:data-model.md]]`.

## Consequences for Testing

Keeping rules pure and side effects injected is what makes the core fully unit- and
property-testable without a DOM. The testing approach that exploits this — property-based
tests over the pure core, mock-based tests for edge adapters, a smoke test for the
composition root — is defined in the testing steering doc, `#[[file:testing.md]]`.
