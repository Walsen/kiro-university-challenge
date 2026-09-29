# AWS & Deployment Decisions (in extenso)

This document is the full record of the platform's cloud decisions: what is recommended,
**when** each choice is settled, and **what would make us pivot**. It expands the AWS
direction summarized in the `business-model` steering doc, which stays intentionally
high-level. This document is the detailed reference and decision log.

Status of every choice below is **RECOMMENDED / NOT YET SETTLED** unless marked otherwise.
Choices are settled at the design gate of the phase that first depends on them (see
[Decision Timeline](#decision-timeline)).

## Guiding Principles

- **Full AWS.** Identity, persistence, real-time, and compute stay within AWS. Multiple
  languages are acceptable where they are the right tool; the game core stays TypeScript
  per the engineering standards.
- **Serverless-first.** Prefer pay-per-use, low-ops managed services unless a workload
  argues otherwise.
- **Settle late, but not too late.** A choice is settled at the start of the phase whose
  design first depends on it — not earlier (premature lock-in), not later (building on
  sand). **Exception:** the deploy pipeline and IaC are settled *first* in Phase 2 to enable
  early integration (see below).
- **The cloud lives at the edges.** New AWS capabilities are added as ports + adapters
  around the pure core (see [`architecture.md`](./architecture.md)), never as changes to
  the game rules.
- **Deploy-first, integrate continuously.** Stand up a deployable end-to-end skeleton before
  building feature depth, and verify each cloud seam against a real dev stack as soon as it
  exists — the infrastructure analogue of the in-process integration checkpoints in the
  maze-game design. This is why IaC/pipeline is pulled ahead of the other Phase 2 choices.

## Early-Integration Strategy (Phase 2)

Phase 1 integrates in-process (no infrastructure). Phase 2 introduces seams that cross a
network or cloud boundary, and those are integrated **deploy-first** rather than at the end
of the build:

1. **IaC + a dev environment + a deploy pipeline come first** — before any feature service.
   You cannot integrate against a real stack you cannot repeatably deploy.
2. **A thin vertical slice (walking skeleton) deploys before feature depth.** For Phase 2a:
   authenticate → submit one score → read it back → see it on a leaderboard, deployed end to
   end, before broadening the feature set. Each new capability extends a *deployed* system.
3. **Each cloud seam is an explicit integration test point** against the real dev stack:
   - **client ↔ API** — contract/integration test at the API boundary,
   - **API ↔ DynamoDB** — integration test against a real (dev) table,
   - **client ↔ Cognito (auth)** — auth-flow test against a real dev user pool,
   - **client ↔ real-time channel** (Phase 2b) — live pub/sub round-trip test.

These mirror Integration Points A–D of Phase 1, one boundary out: verify the seam as early
as it exists, keep the deployed dev stack green, and never defer integration to a big-bang
step at the end.

## Phasing Recap

- **Phase 1 — single-player core** (existing `maze-game` spec): client-only, no backend.
  The only infrastructure need is static asset hosting.
- **Phase 2a — concurrent players + leaderboard**: first backend, persistence, and identity.
- **Phase 2b — real-time shared sessions**: live, server-authoritative same-maze racing.

## Decisions

### D0. Static hosting (Phase 1)

- **Recommendation:** S3 + CloudFront (or any static host) for the built Phase 1 client
  bundle.
- **Status:** low-stakes, reversible; settle when Phase 1 needs deploying.
- **Rationale:** Phase 1 is a bare static client with no branch/environment needs.
- **Note:** the **Phase 2 frontend** is hosted on **Amplify Hosting** instead, in a
  **single Amplify app** whose Git branches identify the environment (`main` = prod,
  `staging` = staging) — see D7. Phase 1 may stay on S3+CloudFront or fold into the Amplify
  app when Phase 2 lands.

### D1. Identity / accounts

- **Recommendation:** Amazon **Cognito** (user pools).
- **Settled at:** Phase 2a design gate (identity blocks anything with a user).
- **Rationale:** AWS-native CIAM; integrates with API Gateway/AppSync/IAM; generous free
  tier for monthly active users; keeps identity inside AWS per the full-AWS direction.
- **Pivot discriminators:**
  - Auth UX/feature needs exceed Cognito's flows (passwordless-first, B2B orgs, deep
    customization) → consider Auth0 / Clerk / Keycloak.
  - Portability / multi-cloud becomes a stated goal → Cognito's lock-in argues against it.
    (Current "full AWS" stance argues *for* Cognito.)

### D2. Score persistence

- **Recommendation:** Amazon **DynamoDB** as the durable, serverless source of truth for
  player records and scores.
- **Settled at:** Phase 2a design gate.
- **Rationale:** serverless, single-digit-ms, scales with spiky play traffic; Global Tables
  available if multi-region is ever needed.
- **Pivot discriminators:**
  - Rich relational/ad-hoc query needs emerge → consider Aurora Serverless (Postgres).
  - Complex multi-entity transactional patterns dominate → re-evaluate the data store.

### D3. Leaderboard ranking (highest-uncertainty decision)

- **Recommendation:** DynamoDB as source of truth **plus a ranking mechanism**; choose
  between ElastiCache for **Redis sorted sets** (O(log N) exact rank) and a **write-sharded
  GSI** pattern at the 2a design gate.
- **Settled at:** Phase 2a design gate.
- **Rationale:** DynamoDB alone cannot compute top-N or "my rank" without workarounds,
  because ranking the whole keyspace is not a native key operation. Redis sorted sets are
  purpose-built for ranking; a sharded GSI keeps everything serverless at the cost of exact
  arbitrary rank.
- **Pivot discriminators:**
  - **Do we need arbitrary exact rank ("you are #4,213"), and at what player count?** Large
    scale + exact rank → Redis. "Top 100 + personal best" at modest scale → GSI is enough.
  - **Is an always-on Redis cluster worth its cost/ops** versus staying fully serverless?
    Tight budget or low ops appetite → favor the GSI pattern.

### D4. Compute / API

- **Recommendation:** serverless — **Lambda** behind **API Gateway** (REST) and/or
  **AppSync** (GraphQL).
- **Settled at:** Phase 2a design gate.
- **Rationale:** matches spiky, event-driven play traffic and the pay-per-use posture.
- **Pivot discriminators:**
  - Sustained high-throughput or long-lived connections dominate → consider containers
    (ECS/Fargate).
  - Cold-start latency violates the fluidity goal on critical paths → provisioned
    concurrency or containers.

### D5. Real-time transport (Phase 2b)

- **Recommendation:** **AWS AppSync Events** (serverless WebSockets pub/sub) as the default;
  **API Gateway WebSocket APIs** as the alternative for tighter control.
- **Settled at:** Phase 2b design gate.
- **Rationale:** managed serverless real-time fan-out fits leaderboard-style and moderate
  shared-session concurrency without running socket servers.
- **Pivot discriminators:**
  - **Latency budget and players-per-session:** tight low-latency same-maze racing with many
    players → API Gateway WebSockets with custom state, or eventually GameLift.
  - Connection scale or cold starts break the fluidity goal → re-evaluate transport.

### D6. IaC, environments & deploy pipeline (settled FIRST in Phase 2)

- **Recommendation:** **AWS CDK (TypeScript)** for the **backend** IaC, deployed as a
  **single, shared, environment-agnostic backend stack** named `MazeGamePlatform` (one
  Cognito user pool, one DynamoDB table, one HTTP API + Lambdas, one GitHub OIDC deploy
  role — not duplicated per environment), and a **GitHub Actions** deploy pipeline that
  authenticates to AWS via **OIDC** (short-lived role assumption, no long-lived access keys
  in secrets). The **frontend** is provided by **Amplify Hosting** as a **single app** whose
  Git branches identify the environment (`main` = prod, `staging` = staging), both branches
  serving that same shared backend (see D7); backend and frontend are a **hybrid** — Amplify
  for the SPA, CDK for Cognito/API/Lambda/DynamoDB/AppSync.
- **Data posture:** because the single table and user pool are now the real source of truth
  (not disposable per-environment scratch), the backend stack uses a prod-grade posture:
  `RemovalPolicy.RETAIN` and point-in-time recovery on the DynamoDB table, and retain on the
  Cognito user pool.
- **Settled at:** **the very start of Phase 2**, ahead of D1–D5 — this is the deviation from
  "settle late." Early, deploy-first integration is impossible without a repeatable deploy,
  so IaC + a dev environment + the pipeline are the first Phase 2 work item.
- **Rationale:**
  - CDK keeps infrastructure in **TypeScript**, the same language as the core, so the team
    works in one language and gets type-safe, reusable constructs. For an AWS-only team this
    is the more productive choice; Terraform's main edge (multi-cloud, ops-heavy orgs) does
    not apply here.
    ([CDK vs Terraform, 2026](https://towardsthecloud.com/blog/aws-cdk-vs-terraform) —
    rephrased for compliance with licensing restrictions.)
  - GitHub Actions + AWS **OIDC** is the current standard for CI/CD auth: the workflow
    receives a short-lived token exchanged for temporary credentials, so nothing long-lived
    sits in GitHub secrets.
    ([configure-aws-credentials](https://github.com/marketplace/actions/configure-aws-credentials-action-for-github-actions)
    — rephrased for compliance.)
- **Pivot discriminators:**
  - Multi-cloud or an ops-heavy team with existing Terraform standards → Terraform (CDKTF
    keeps TypeScript if desired).
  - A single-service serverless footprint that never grows → SAM/SST could be lighter, but
    CDK still covers it.

### D7. Frontend hosting, branch environments & deployment gates (settled FIRST in Phase 2)

- **Recommendation:** host the Phase 2 SPA on **AWS Amplify Hosting** as **one app** named
  `maze-game-platform`, using its **branch-based environment model** where the **Git branch
  identifies the environment**, not the app name: the `staging` branch deploys the staging
  frontend and `main` deploys prod. **Both branches serve the same single shared backend**
  (D6). Promotion to prod is a **manual-approval gate**.
- **Settled at:** **the very start of Phase 2**, alongside D6. Deployment gates must exist
  before feature work begins; defining them late reverts delivery to cascade/waterfall, which
  is exactly what deploy-first is meant to prevent.
- **Rationale:**
  - A single Amplify app with branch-mapped environments gives PR previews and gated
    promotion out of the box, so staging vs prod is a branch inside one app rather than a
    separate app per environment or bespoke pipeline plumbing.
  - Keeping the **backend on CDK** (a hybrid) preserves the IaC-in-TypeScript decision (D6)
    and avoids re-platforming Cognito/API/Lambda/DynamoDB/AppSync under Amplify's backend
    tooling. Every frontend branch points at the **same single CDK-deployed backend**.
- **Environment model & shared-backend tradeoff:** the environment is the Git branch inside
  one Amplify app, and every branch talks to the one shared backend. Because there is one
  backend and one database, **staging and prod share live data** — the same DynamoDB table
  and the same leaderboard. Staging is effectively a frontend preview of the same live
  backend. This **replaces the earlier guarantee that a dev deployment could never touch
  prod**: isolation is now **per-account within the single backend** (R11.2), not
  per-environment. A future optional **per-branch data namespace** could reintroduce a data
  seam if it is ever needed, but that is out of scope now.
- **Environment model & gates:**

  | Gate | Branch → environment | Trigger | Blocking exit criteria (summary) |
  | --- | --- | --- | --- |
  | **G0** Pipeline works | first setup | first setup | OIDC pipeline + single shared backend + one Amplify app with branch envs provisioned; a trivial deploy succeeds |
  | **G1** Walking skeleton | `staging` branch | thin slice ready | staging frontend deployed against the shared backend; all cloud-seam integration tests green against the real deployed backend |
  | **G2** Phase 2a → prod | `staging` → `main` | 2a feature-complete | all 2a seam tests green, ≥90% core coverage, load budgets met, security (R11) done, **manual approval**, rollback plan |
  | **G3** Phase 2b → prod | `staging` → `main` | 2b feature-complete | realtime seam tests green, latency budget met, results persist to the shared leaderboard, **manual approval** |

- **Pivot discriminators:**
  - If the backend footprint or team wants a single tool, Amplify can also own the backend —
    revisit only if the hybrid's two-tool overhead outweighs its benefit.
  - Strict data-residency or networking control the SPA host cannot meet → fall back to
    S3+CloudFront with a custom pipeline (the D0 mechanism), keeping the same gate model.
  - Existing org IaC standards, if any, win.

### D8. Observability & Monitoring

- **Recommendation:** instrument the single shared backend with **AWS X-Ray distributed
  tracing** and watch it with **CloudWatch Synthetics canaries** plus **CloudWatch alarms**.
- **Settled at:** alongside the shared backend it observes — provisioned as the backend
  Lambdas/API and the leaderboard read path come online (Phase 2a), extended to the realtime
  path in Phase 2b.
- **X-Ray distributed tracing:** enable **active tracing** on the API Gateway (HTTP API) and
  on **all** Lambdas — score, personal-history, leaderboard, own-rank, delete-account,
  profile-on-signup, and in Phase 2b the Session Lambda and the AppSync path. AWS SDK v3
  clients are instrumented so DynamoDB (and Cognito) calls surface as **subsegments**, and the
  managed X-Ray write permission is granted **per function**. This is an **edge/monitoring
  concern**: the pure `src/core` is **not traced or modified** — tracing lives at the
  adapters and composition roots, consistent with the hexagonal rule that the cloud lives at
  the edges (see [`architecture.md`](./architecture.md)).
- **Privacy (R11.4):** traces and annotations carry **`accountId` only** — never credentials,
  tokens, email, or other PII — matching the logging posture already stated for the backend.
- **CloudWatch Synthetics canaries (choice "1.C"):**
  1. an always-on **read-only** canary hitting the public `GET /leaderboard` plus a health
     probe every **5 minutes**;
  2. an **occasional full-flow** canary (sign in → submit a validated score → read it back →
     see it on the leaderboard) every **30 minutes** that uses a **reserved synthetic account**
     and cleans up its own scores via the account-deletion path (task 11.2).
  **CloudWatch alarms** watch availability and the leaderboard latency/freshness budgets
  (top-50 p95 < 300 ms, freshness < 2 s — the same budgets R6.4/R6.5/R7.2 already state). The
  cadence values are **adjustable defaults**, not fixed commitments.
- **Shared-backend consequence:** because there is one backend and one live leaderboard, the
  full-flow canary **writes a synthetic entry to the one live leaderboard on each run**. This
  is mitigated by the reserved synthetic account plus its self-cleanup via the
  account-deletion path, but it is an accepted consequence of the single-backend / shared-data
  model (D6/D7).
- **Local inspection:** the repo distributes a workspace MCP server (**AWS CloudWatch
  Application Signals MCP**) so developers can query traces, canary results, and service
  audits locally; see the `dev-environment` steering doc. MCP is a local developer aid, not
  part of CI or the deployed system.
- **Costs** (adopted-default figures, US regions, **adjustable later**):
  - **Synthetics** ≈ $0.0012 per canary run. The 5-minute read-only canary ≈ 8,640 runs/mo
    ≈ **$10.37/mo**; the 30-minute full-flow canary ≈ 1,440 runs/mo ≈ **$1.73/mo**; total
    **Synthetics ≈ $12/mo**, dominated by the canary cadence (so tuning cadence is the main
    cost lever).
  - **X-Ray:** the first 100k traces recorded/mo are free, then $5 per additional 1M traces
    recorded; at current scale ≈ **$0/mo**.
  - **CloudWatch alarms** ≈ **$0.10 each/mo**.
  - ([CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing),
    [X-Ray pricing](https://aws.amazon.com/xray/pricing) — Content was rephrased for
    compliance with licensing restrictions.)
- **Pivot discriminators:**
  - Trace/canary volume grows enough that X-Ray or Synthetics cost becomes material → tune
    canary cadence (the dominant lever), sample traces, or narrow annotations.
  - Deeper service-level insight is needed → adopt CloudWatch Application Signals / ADOT
    beyond raw X-Ray.
  - The synthetic leaderboard entry becomes undesirable on the shared backend → introduce the
    optional per-branch data namespace noted in D7, or a dedicated canary scope.

## Decision Timeline

| Decision | Settled at | Depends on |
| --- | --- | --- |
| D0 Static hosting | When Phase 1 deploys | Phase 1 client build |
| **D6 Single shared backend IaC & pipeline** | **Phase 2 start (first)** | nothing — enables everything else |
| **D7 Frontend hosting (one app, branch envs) & gates** | **Phase 2 start (first)** | nothing — must exist before feature work |
| D1 Identity (Cognito) | Phase 2a design gate | D6, first authenticated user |
| D2 Score persistence (DynamoDB) | Phase 2a design gate | D6, first persisted score |
| D3 Leaderboard ranking | Phase 2a design gate | D2 |
| D4 Compute/API (Lambda) | Phase 2a design gate | D6, first backend endpoint |
| D5 Real-time transport | Phase 2b design gate | shared-session requirement |
| D8 Observability & monitoring | With the backend it observes (Phase 2a; extended 2b) | D6, D4 (Lambdas/API to trace), D6/D3 (leaderboard to canary) |

Principle restated: **settle a choice at the start of the phase whose design first depends
on it, and no sooner** — with D6 the deliberate exception, settled first so integration can
start against a real deployed stack.

## Proposed Baseline Stack (Phase 2a target to integrate against)

Early integration needs a concrete stack to deploy into. This is that baseline — enough to
stand up the walking skeleton and exercise every seam — proposed now so integration has a
target. It stays revisitable per the pivot discriminators above; adopting it does not close
D1–D5, it gives them a default.

| Concern | Baseline choice | Notes |
| --- | --- | --- |
| Backend IaC | AWS CDK (TypeScript) | one shared, environment-agnostic stack `MazeGamePlatform` (no per-env duplication) |
| CI/CD | GitHub Actions + AWS OIDC | short-lived role assumption; no static keys |
| Frontend hosting | AWS Amplify Hosting | one app `maze-game-platform`; branch = environment (`main` = prod, `staging` = staging); gated (D7) |
| Environments & gates | `staging` branch → `main` (prod) | gates G0–G3; manual approval into prod (D7); both branches serve the shared backend |
| Identity | Amazon Cognito user pool | one shared pool; real accounts; JWT verified at the API; retain on delete |
| API / compute | API Gateway (HTTP API) + Lambda (TypeScript) | serverless, pay-per-use |
| Persistence | DynamoDB (on-demand) | one shared single-table for players + scores; `RETAIN` + point-in-time recovery |
| Leaderboard ranking | start with a DynamoDB GSI | add Redis only if exact large-scale rank is needed (D3) |
| Real-time (2b) | AWS AppSync Events | added in Phase 2b, not 2a |
| Region | single region for dev | residency reviewed before prod (PII) |

**Walking-skeleton slice to deploy first (Phase 2a):** a signed-in user submits one score
through API Gateway → Lambda → DynamoDB, reads it back, and sees it on a leaderboard read
path — deployed end to end via CDK from a GitHub Actions OIDC pipeline, with an integration
test on each seam (auth, client↔API, API↔DynamoDB). Feature depth is built on top of this
deployed slice.

> This baseline is intentionally the smallest thing that lets every Phase 2a seam be
> integrated against real infrastructure. It is a starting point, not a commitment; the
> per-decision pivot discriminators still govern any change.

## Cross-Cutting Discriminators

These can move several decisions at once:

- **Cost ceiling.** A tight budget favors serverless + DynamoDB-only and pushes back on
  always-on Redis.
- **Team familiarity / time-to-ship.** In a university-challenge context, simpler managed
  services that ship faster may outweigh theoretically optimal ones.
- **Region / data residency.** Real accounts mean PII; residency requirements affect region
  and possibly service choice.
- **Fluidity / latency budget.** The explicit "fluid gameplay" goal is the hard constraint
  that most directly discriminates the real-time (D5) and compute (D4) choices.

## Change Log

- _Initial draft_ — captures the decisions, timeline, and pivot criteria agreed during
  steering setup. No AWS choice is settled yet; all are recommendations pending each phase's
  design gate.
- _Early-integration revision_ — adopted a deploy-first / walking-skeleton strategy; pulled
  D6 (IaC, environments, pipeline) to the front of Phase 2 as the enabler; concretized D6 to
  CDK (TypeScript) + GitHub Actions OIDC; added the per-seam cloud integration test points
  and a proposed baseline stack to integrate against. Recommendations remain revisitable via
  the pivot discriminators.
- _Amplify + gates revision_ — moved the Phase 2 frontend to **Amplify Hosting** with a
  branch-based environment model (PR preview → staging → prod), keeping the backend on CDK
  (hybrid); added **D7** and an explicit deployment-gate model (**G0–G3**) with a
  manual-approval gate into prod; updated D6 to per-environment stacks aligned to the branch
  model, and the baseline stack table accordingly. Gates are front-loaded (settled first) to
  prevent a cascade/waterfall slide.
- _Single-backend + one-app revision_ — replaced the per-environment topology with a
  **single shared backend** (one Cognito pool, one DynamoDB table, one HTTP API + Lambdas,
  one GitHub OIDC deploy role — the environment-agnostic `MazeGamePlatform` stack) and **one
  Amplify app** (`maze-game-platform`) whose **Git branch identifies the environment**
  (`main` = prod, `staging` = staging), both branches serving that shared backend. **Dropped
  the per-environment backend isolation** (the earlier "a dev deployment can never touch
  prod" guarantee); isolation is now per-account within the single backend (R11.2). **Accepted
  that staging and prod share live data** — the same DynamoDB table and leaderboard — with a
  future per-branch data namespace noted as an out-of-scope option. Set a prod-grade data
  posture (`RETAIN` + point-in-time recovery on the table, retain on the pool). Updated D0,
  D6, D7 (incl. the gate table), the Decision Timeline, and the baseline stack table; the
  hybrid Amplify(frontend)+CDK(backend) split and gates G0–G3 with manual approval into prod
  are unchanged.
- _Observability revision_ — added **D8 (Observability & Monitoring)**: **AWS X-Ray** active
  tracing across API Gateway and all Lambdas (SDK v3 clients instrumented for DynamoDB/Cognito
  subsegments, per-function X-Ray write grant, `accountId`-only annotations per R11.4, pure
  `src/core` untraced), and **CloudWatch Synthetics canaries** (a 5-min read-only
  leaderboard+health canary and a 30-min full-flow canary using a reserved synthetic account
  with self-cleanup) with **CloudWatch alarms** on availability and the leaderboard
  p95/freshness budgets. Recorded adopted-default cost figures (Synthetics ≈ $12/mo, X-Ray
  ≈ $0/mo at current scale, alarms ≈ $0.10 each/mo) with cadence noted as adjustable, and the
  shared-backend consequence that the full-flow canary writes a synthetic entry to the one
  live leaderboard each run. Noted the locally distributed CloudWatch Application Signals MCP
  server as a developer aid. Added a Decision Timeline row for D8; no earlier decision changed.
