---
inclusion: auto
name: business-model
description: Product vision, business goals, and platform direction for the maze game — concurrent players, persistent scores, real accounts, modern UI, and the AWS target platform. Consult when planning features, writing specs, or making architecture/technology decisions beyond the single-player core.
---

# Business Model & Product Vision

This document captures the product north star for the maze game and the platform it is
growing into. It is the "why" behind the specs. It is intentionally about intent and
direction, not final technical choices — detailed decisions are made per spec in the
design phase. Where it names technologies, they are **recommended directions with
rationale**, not mandates.

## Product Vision

Deliver a maze game that is genuinely fun and competitive: players race through mazes
against the clock, their achievements are remembered, and they can measure themselves
against others. The experience should feel modern, polished, and fluid.

## Delivery Strategy (phased)

The product is built in two phases, each backed by its own spec. The single-player core
ships first and stays intact; the platform features are additive and build on it.

1. **Phase 1 — Single-player core (existing `maze-game` spec).**
   A single-player, browser-based maze game: generate/validate a maze, move an avatar,
   enforce a countdown, detect win/loss, start new sessions. Client-only, in-memory, no
   backend. This executes first and is the foundation.

2. **Phase 2 — Multiplayer scoring platform (new spec, to be created).**
   Adds real accounts, persistent scores, concurrency, and a modern UI on top of the
   Phase 1 core. Delivered in two increments to manage risk:
   - **2a — Concurrent players + leaderboard.** Many independent players each play their
     own maze concurrently; scores are persisted and ranked on a shared leaderboard. This
     is the first concurrency milestone.
   - **2b — Real-time shared sessions.** Multiple players race in the *same* maze in real
     time (server-authoritative shared state, live position/progress updates). This is the
     richer competitive milestone and depends on 2a.

## Business Goals

- **Concurrent players.** Support many players active at the same time — first as
  independent runs with a shared leaderboard (2a), then as real-time shared/competitive
  sessions in the same maze (2b).
- **Persistent scores.** A player's results (best time, completions, ranking) are preserved
  across sessions and devices, tied to their account.
- **Real accounts / identity.** Players sign up and sign in with real accounts. A score
  belongs to an authenticated identity. Support account lifecycle (sign-up, sign-in,
  sign-out, recovery) with privacy and security appropriate to storing personal identity.
- **Modern, attractive UI.** The interface should look and feel current: clean visual
  design, responsive layout, clear feedback, and accessibility. The bare Canvas of the
  single-player core is replaced/wrapped by a styled, modern presentation.
- **Fluid gameplay.** Movement and rendering are smooth and responsive; input feels
  immediate; animations do not stutter. Real-time updates (2b) are low-latency.
- **Genre-complete experience.** Provide what players expect from this kind of game:
  leaderboards/rankings, personal best times and history, difficulty or maze-size options,
  possibly levels/progression, and clear win/lose feedback and replay.

## Target Platform: AWS

The platform is built **fully on AWS**. Multiple languages are acceptable where they are
the right tool; the single-player core stays TypeScript per the engineering standards.
The following are recommended AWS directions to be confirmed in each spec's design phase:

- **Identity / accounts:** Amazon **Cognito** (AWS-native CIAM; integrates with API
  Gateway/AppSync/IAM; free tier covers a large monthly-active-user count). Chosen to keep
  identity inside AWS per the "full AWS" direction. Revisit only if a requirement Cognito
  cannot meet emerges.
- **Score persistence:** Amazon **DynamoDB** as the durable, serverless source of truth for
  scores and player records. Note a known constraint: top-N ranking is not a native
  DynamoDB key operation and needs a ranking strategy.
- **Leaderboard ranking:** pair DynamoDB with a ranking mechanism suited to O(log N) rank
  queries — e.g. **ElastiCache for Redis** (sorted sets) as a ranking index, or a
  write-sharded GSI pattern — decided in the Phase 2a design.
- **Real-time (Phase 2b):** **AWS AppSync Events** (serverless WebSockets pub/sub) or **API
  Gateway WebSocket APIs** for live fan-out of shared-session state. Heavier managed
  session hosting/matchmaking (e.g. GameLift) is likely more than this game needs and is a
  later consideration only if warranted.
- **Compute / API:** serverless-first (**Lambda** behind **API Gateway**/**AppSync**) to
  match the pay-per-use, low-ops posture, unless a workload argues otherwise.
- **Local tooling** for any AWS interaction uses **awscli2** via Devbox, per the
  dev-environment steering. Devbox remains local-only; deployment/IaC is separate.

> Investigation note: the specific choices for UI framework, real-time transport, and
> leaderboard ranking are to be settled during the relevant spec's design phase, weighing
> cost, latency, and operational simplicity. This doc records the direction and rationale,
> not the final decision.
>
> **Full decision record:** the complete list of AWS choices, the timeline of *when* each
> is settled, and the discriminators that would make us pivot are documented in
> `docs/aws-decisions.md`. That file is the source of truth for the decision log; this
> section stays a high-level summary.

## UI Direction (to be investigated per spec)

A modern, attractive, fluid UI is a first-class goal, not a finishing touch. The single
player core renders on a bare Canvas; Phase 2 wraps or replaces that with a styled,
responsive shell. The specific approach (keep Canvas for the maze inside a modern
component framework such as a React-based UI, versus an alternative) is investigated and
decided in the Phase 2 design, with accessibility and performance (fluidity) as explicit
criteria.

## Non-Negotiables Carried From Other Steering

- The single-player **core stays pure and framework-agnostic** (architecture steering).
  Backend, persistence, and networking are new **adapters/services around** that core, not
  changes to it.
- **TDD and property-based testing** apply to new core logic in Phase 2 (testing steering).
- **Security & privacy** matter more once real accounts and personal data exist: protect
  credentials and PII, apply least privilege on AWS, and never log secrets.

## Out of Scope (for now)

- Native mobile apps (web-first).
- In-game chat/voice, social graphs/friends, and monetization — not part of the current
  vision unless added later.
