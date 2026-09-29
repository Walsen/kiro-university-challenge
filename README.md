# Maze Game

[![CI](https://github.com/Walsen/kiro-university-challenge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Walsen/kiro-university-challenge/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tested with Vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18.svg?logo=vitest&logoColor=white)](https://vitest.dev/)
[![PBT: fast-check](https://img.shields.io/badge/PBT-fast--check-8A2BE2.svg)](https://fast-check.dev/)

> A single-player maze game where you race an avatar from start to exit before a countdown
> timer runs out — built as the foundation for a multiplayer, score-tracking game platform
> on AWS.

<!-- The CI badge shows "no status" until the GitHub Actions workflow (.github/workflows/ci.yml)
     is added in Phase 1; it turns green on the first successful run. -->

## Overview

The Maze Game renders a grid maze, places an avatar on the start cell and a marker on the
exit, accepts four-directional movement, enforces wall collisions, counts down a
configurable timer, and reports a win or loss. The first version is single-player and runs
entirely in the browser.

It is engineered as a learning-grade reference project: **TypeScript in strict mode**, a
**hexagonal (ports and adapters)** architecture with a pure, deterministic core, and a
**test-first** workflow that combines example-based unit tests with **property-based tests**
(fast-check). The core game rules are pure functions over immutable data, so they are fully
testable without a browser.

## Status

Early setup. The single-player feature is fully specified (requirements, design, tasks) and
the project standards are captured as steering docs; implementation has not started yet.

## Roadmap

The product is delivered in phases; each phase is backed by its own spec.

- **Phase 1 — Single-player core.** Browser-only maze game: generate/validate a maze, move
  the avatar, enforce the countdown, detect win/loss, start new sessions. Client-only, no
  backend. _(Specified; implementation next.)_
- **Phase 2a — Concurrent players + leaderboard.** Real accounts, persistent scores, and a
  shared leaderboard, with many players each running their own maze concurrently.
- **Phase 2b — Real-time shared sessions.** Multiple players racing in the same maze in real
  time. Modern, attractive UI and fluid gameplay are first-class goals throughout.

The target platform for Phase 2 is **AWS**; the specific services and the criteria that
would make us change them are recorded in [`docs/aws-decisions.md`](./docs/aws-decisions.md).

## Tech Stack

- **Language:** TypeScript (`strict` mode).
- **Testing:** Vitest (runner) + fast-check (property-based tests); ≥ 90% coverage on core
  logic.
- **Quality:** ESLint (typescript-eslint) + Prettier; zero lint errors in committed code.
- **Rendering:** HTML Canvas (Phase 1).
- **Local toolchain:** [Devbox](https://www.jetify.com/devbox) for local tasks (jq, yq, hg,
  awscli2, Node.js as needed).
- **CI:** GitHub Actions (`lint` → `typecheck` → `test:coverage` → `build`).
- **Phase 2 platform:** AWS (Cognito, DynamoDB, Lambda/API Gateway/AppSync — proposed).

## Getting Started

> Prerequisite: [Devbox](https://www.jetify.com/devbox) installed. Local dependencies are
> managed through Devbox per the dev-environment standard; see
> [`.kiro/steering/dev-environment.md`](./.kiro/steering/dev-environment.md).

```bash
# enter the reproducible dev shell
devbox shell

# install project dependencies (once the project is scaffolded)
npm ci
```

Common scripts (available once the project is scaffolded in Phase 1):

```bash
npm run lint          # ESLint, zero-error policy
npm run typecheck     # tsc --noEmit
npm run test          # Vitest
npm run test:coverage # Vitest with coverage (≥ 90% on core)
npm run build         # production build
```

## Project Structure

```
.
├── README.md                 # this file
├── LICENSE
├── docs/                     # in-depth reference documents
│   ├── architecture.md       # full software architecture + component diagram
│   └── aws-decisions.md      # AWS/deployment decision record + pivot criteria
├── .kiro/
│   ├── specs/maze-game/      # requirements, design, and task plan for Phase 1
│   └── steering/             # always-on engineering standards & conventions
└── src/                      # source (added during Phase 1)
    ├── core/                 # pure domain logic (no I/O)
    ├── app/                  # orchestration (store, controller)
    └── edges/                # impure adapters (canvas, input, clock)
```

### Shared maze core package

The Phase 1 pure core (`src/core`) is reused **unchanged** by both the browser client and
the Phase 2 server-side Lambdas, so score validation and authoritative shared-session state
run exactly the same rules as gameplay. It is exposed as the `maze-game/core` package
subpath:

```ts
import { DefaultMazeFactory, RecursiveBacktrackerGenerator, reduce } from "maze-game/core";
```

```bash
npm run build:core   # emit the shared core to dist/package/core (bundled ESM + .d.ts)
```

`build:core` produces a single self-contained ES module (via esbuild) plus type
declarations (via `tsc`), so the entry point imports and runs directly under Node/Lambda
without a bundler. It builds into `dist/package/core`, kept separate from the browser app
build in `dist/` so the two never collide. No rule logic in `src/core` is modified.

## Documentation

In-depth reference documents live in [`docs/`](./docs). They expand on the always-on
steering docs in `.kiro/steering/`: steering docs are the short, enforceable summaries;
the docs below are the detailed records and rationale.

- [`docs/architecture.md`](./docs/architecture.md) — Full software architecture: hexagonal
  (ports and adapters), the `core` / `app` / `edges` layers, the dependency rule, the
  patterns in use, and a component-integration Mermaid diagram. Software architecture only.
- [`docs/aws-decisions.md`](./docs/aws-decisions.md) — Full cloud/deployment decision record:
  the recommended AWS services, when each choice is settled (the decision timeline), and the
  discriminators that would make us pivot. No AWS choice is settled yet.

The feature specification (requirements, design, tasks) is under
[`.kiro/specs/maze-game/`](./.kiro/specs/maze-game).

### Relationship to steering

| Topic | Steering (summary, always on) | Docs (full detail) |
| --- | --- | --- |
| Engineering standards | `.kiro/steering/engineering-standards.md` | — |
| Testing | `.kiro/steering/testing.md` | — |
| Software architecture | `.kiro/steering/architecture.md` | `docs/architecture.md` |
| Data model | `.kiro/steering/data-model.md` | — |
| Dev environment | `.kiro/steering/dev-environment.md` | — |
| Cloud/AWS direction & decisions | `.kiro/steering/business-model.md` | `docs/aws-decisions.md` |

Steering remains the source of truth for enforceable rules; when a rule needs its full
justification or history, it links into `docs/`.

## License

Licensed under the Apache License 2.0. See [`LICENSE`](./LICENSE) for the full text.
