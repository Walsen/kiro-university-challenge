# Implementation Plan: Maze Game Platform (Phase 2)

## Overview

This plan converts the Phase 2 design into incremental, deploy-first coding tasks. It follows
the workspace steering: hexagonal boundaries (the Phase 1 pure core is reused unchanged, new
capabilities are ports + AWS adapters), TDD (Red → Green → Refactor) with property-based tests
for new pure logic, ≥ 90% coverage on core logic, and integration verified at each seam.

**Deploy-first ordering.** The backend IaC (CDK), the **Amplify Hosting branch environments**,
and the OIDC deploy pipeline come first. Then a thin end-to-end **walking skeleton** (sign in →
submit a validated score → read it back → see it on the leaderboard) is deployed before feature
depth. Each cloud seam is integration-tested against a real deployed environment as soon as it
exists.

**Deployment gates (front-loaded — define and pass these before feature work; otherwise this
plan degrades to cascade).** Frontend hosting uses **Amplify Hosting's branch-based
environments** (`main` = prod, staging on a long-lived branch); the backend is deployed
per-environment by **CDK** (hybrid). Environments flow **branch (staging) → `main` (prod)**,
with a **manual-approval gate** into prod. See design "Deployment Gates & Environments" and
`docs/aws-decisions.md` D7.

| Gate | From → to | Task | Blocking exit criteria |
| --- | --- | --- | --- |
| **G0** Pipeline works | — → dev (staging branch) | 1 (esp. 1.4, required) | OIDC pipeline runs `cdk deploy dev` successfully end-to-end **and** the Amplify-hosted frontend deploy succeeds and serves a placeholder; static hosting reconciled to Amplify Hosting (see 1.5) |
| **G1** Walking skeleton | dev/staging branch → prod (`main`) | 8 | thin end-to-end slice (sign in → submit one validated score → read it back → see it on the leaderboard) deployed to dev/staging; all four cloud-seam integration tests green against it — client↔Cognito (4.3), adapters↔DynamoDB (6.5), client↔API (7.4), and the score-validation/tampered-submission seam (7.4) |
| **G2** Phase 2a → prod | dev/staging → prod (`main`) | 13 | every 2a seam test green; ≥ 90% core coverage; load budgets met (top-50 p95 < 300 ms, freshness < 2 s, 1,000 concurrent target); security/privacy (R11 — 11.1–11.3) done; **manual approval**; rollback plan stated |
| **G3** Phase 2b → prod | dev/staging → prod (`main`) | 17 | realtime seam tests green; realtime update p95 < 250 ms; shared-session results persist to the shared leaderboard; ≥ 90% core coverage; **manual approval**; rollback plan stated |

**G0 is a hard prerequisite:** no feature task (2+) begins until G0 passes.

**Language & tooling.** Backend Lambdas and IaC are **TypeScript** (CDK). The client is a
**React SPA** embedding the unchanged Phase 1 Canvas core. Tests use Vitest + fast-check;
adapters are tested against local fakes for speed and against the real dev stack at the
integration seams.

**Increments.** Tasks 1–13 deliver **Phase 2a** (accounts, scores, leaderboard, concurrency,
UI). Tasks 14–17 deliver **Phase 2b** (real-time shared sessions) and depend on 2a.

**Adopted defaults** (from the design's Open Design Decisions, confirmed to proceed): React
for the UI; DynamoDB GSI leaderboard baseline (Redis only on the D3 pivot); budgets —
leaderboard top-50 p95 < 300 ms, freshness < 2 s, 2a target 1,000 concurrent players, 2b
realtime p95 < 250 ms; maze parameters = size/difficulty + seed defines a leaderboard scope,
levels/progression deferred beyond Phase 2.

## Tasks

### Tasks — Phase 2a

- [ ] 1. Establish IaC, environments, and the OIDC deploy pipeline (deploy-first foundation)
  - [x] 1.1 Scaffold the CDK (TypeScript) app with per-environment stacks
    - Create a CDK app with `dev` and `prod` stack configurations; wire it into the Devbox/npm
      tooling; add `cdk synth`/`cdk deploy` scripts
    - _Requirements: R11 (least privilege from the start); design "Baseline stack"_
  - [x] 1.2 Configure GitHub Actions → AWS via OIDC
    - Create the OIDC identity provider + per-environment IAM roles (least privilege); add a
      CI deploy job that assumes the role and runs `cdk deploy dev`; no long-lived keys
    - _Requirements: R11; design "Continuous Integration / Deployment"_
  - [x] 1.3 Provision the static hosting stack (S3 + CloudFront)
    - Define S3 + CloudFront for the SPA; output the distribution URL
    - **Note:** this was delivered as S3 + CloudFront, but the settled design mandates **Amplify
      Hosting** branch environments. Reconcile in 1.5 before G0 is satisfied; do not treat the
      hosting foundation as complete until then.
    - _Requirements: R12_
  - [ ] 1.4 Deploy-first exit gate (G0): full pipeline + Amplify frontend live
    - Confirm the OIDC pipeline runs `cdk deploy dev` successfully **end-to-end** **and** the
      **Amplify-hosted** frontend deploy succeeds and serves a placeholder page. This is the
      concrete G0 exit criterion and a hard prerequisite: no service/feature work (task 2+)
      begins until this passes.
    - _Requirements: R11, R12, deploy-first strategy; design "Deploy-First Delivery"_
  - [ ] 1.5 Reconcile static hosting to Amplify Hosting
    - Migrate the SPA frontend from the S3 + CloudFront stack (1.3) to **Amplify Hosting**
      branch environments (`main` = prod, staging on a branch) to match the settled design;
      retire or repurpose the CloudFront path so the plan and the deployed reality agree.
    - _Requirements: R12; design "Deployment Gates & Environments"_

- [x] 2. Provision identity (Cognito) and the API skeleton
  - [x] 2.1 Define the Cognito user pool in CDK
    - User pool with email verification, password policy, forgot-password recovery, failed-
      attempt lockout threshold, and hosted/managed sign-in as configured
    - _Requirements: R1.1, R1.3, R1.4, R1.5, R2.5, R3.1, R3.2, R3.3_
  - [x] 2.2 Define the API Gateway HTTP API with a JWT authorizer
    - HTTP API fronting Lambda; JWT authorizer validates Cognito tokens; a protected health
      route returns 401 without a valid token and 200 with one
    - _Requirements: R2.1, R2.4, R4.3, R5.3, R11.1, R11.2_

- [x] 3. Shared maze-core package for server-side reuse
  - [x] 3.1 Package the Phase 1 `src/core` as a shared, importable module
    - Expose the pure core (maze factory + seeded generator, `reduce`, `resolveMove`,
      `tickTimer`, types) to both the client and the Lambdas without modifying it
    - _Requirements: design "shared maze core package"_
  - [ ]* 3.2 Verify the shared core imports and runs in a Node/Lambda context
    - A test that rebuilds a maze from params + seed and replays a known solvable path to a
      `Won` state, server-side
    - _Requirements: R4.6_

- [x] 4. Auth client integration (AuthProvider port + Cognito adapter)
  - [x] 4.1 Define the `AuthProvider` port
    - In the client, define `AuthProvider`/`AuthSession` per the design; no Cognito types leak
      past the adapter
    - _Requirements: R1, R2, R3_
  - [x] 4.2 Implement `CognitoAuthProvider`
    - sign-up, confirm, sign-in, sign-out, start/complete recovery; store tokens with bounded
      lifetime handling
    - _Requirements: R1.1, R1.2, R2.1, R2.2, R2.3, R3.1, R3.2_
  - [ ]* 4.3 Integration seam test: client ↔ Cognito (real dev pool)
    - Against the dev user pool: sign-up → confirm → sign-in → receive token → sign-out; assert
      invalid credentials fail without revealing the factor (R2.2) and unknown-identifier
      recovery does not disclose existence (R3.4)
    - _Requirements: R1.1, R2.1, R2.2, R3.4; design "integration seams"_

- [ ] 5. Score domain logic (pure, TDD)
  - [x] 5.1 Write failing tests for score validation (server-side replay)
    - Given `mazeParams` + `moves`, the validator returns an authoritative `Won` Score with the
      recomputed time, or a typed rejection for non-winning/malformed/tampered input
    - _Requirements: R4.1, R4.4, R4.6_
  - [x] 5.2 Implement `validateSubmission` using the shared core
    - Rebuild maze from params+seed, replay moves through `reduce`/`resolveMove`, require `Won`,
      take authoritative `elapsedMs`; return typed result
    - _Requirements: R4.1, R4.4, R4.6_
  - [ ]* 5.3 Property test: a submission validates to a Won score iff it is a solvable path within the time limit
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game-platform, Property: score validity`
    - _Requirements: R4.6_
  - [x] 5.4 Write failing tests for leaderboard key encoding + own-rank
    - Ascending-time ordering preserved by the GSI sort key; own-rank counts better times
    - _Requirements: R6.1, R6.3_
  - [x] 5.5 Implement leaderboard key encoding and own-rank computation (pure)
    - Zero-padded time key; deterministic tie-break by accountId
    - _Requirements: R6.1, R6.3_
  - [ ]* 5.6 Property test: leaderboard key encoding preserves ascending-time ordering for any set of times
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game-platform, Property: rank ordering`
    - _Requirements: R6.1_

- [ ] 6. Persistence (ScoreRepository port + DynamoDB adapter + table)
  - [x] 6.1 Define the DynamoDB single-table + leaderboard GSI in CDK
    - Table (on-demand) with PK/SK scheme and GSI1 per the design data model
    - _Requirements: R4.2, R5.1, R6.1_
  - [x] 6.2 Define the `ScoreRepository` and `LeaderboardQuery` ports
    - `putScore`, `personalBest`, `listByAccount`; `topN`, `ownRank`
    - _Requirements: R4, R5, R6_
  - [x] 6.3 Implement `DynamoScoreRepository` (put score, personal-best conditional write, list)
    - Conditional write for personal best (R4.5); idempotent putScore via `idempotencyKey`
      (R7.4); write score + GSI entry together for freshness (R6.5)
    - _Requirements: R4.2, R4.5, R6.5, R7.4_
  - [x] 6.4 Implement `DynamoLeaderboardQuery` (top-N ascending, own-rank)
    - Bounded ascending `Query` for top-N; own-rank via better-time count
    - _Requirements: R6.1, R6.3, R6.4_
  - [ ]* 6.5 Integration seam test: adapters ↔ real dev DynamoDB
    - Put/get/query, conditional personal-best, idempotent duplicate submit, GSI ascending read
    - _Requirements: R4.5, R6.1, R7.4; design "integration seams"_

- [ ] 7. Score + leaderboard services (Lambda wiring)
  - [ ] 7.1 Implement the Score Lambda: `POST /scores`
    - JWT-authorized; validate submission via task 5; persist via task 6; reject invalid (400)
      and unauthenticated (401 at authorizer)
    - _Requirements: R4.1, R4.3, R4.4, R4.6, R7.4_
  - [ ] 7.2 Implement personal-history routes: `GET /scores/me`, `GET /scores/me/best`
    - Return only the caller's scores; enforce per-account isolation
    - _Requirements: R5.1, R5.2, R5.3, R11.2_
  - [ ] 7.3 Implement leaderboard routes: `GET /leaderboard`, `GET /leaderboard/me`
    - Public top-N with display names (not identifiers); authenticated own-rank
    - _Requirements: R6.1, R6.2, R6.3, R11.3_
  - [ ]* 7.4 Integration seam test: client ↔ API (real dev stack)
    - With a real JWT: submit a valid score, read it back, read the leaderboard; assert a
      tampered submission (unearned time) is rejected server-side
    - _Requirements: R4.3, R4.6, R5.1, R6.1; design "integration seams"_

- [ ] 8. Walking skeleton — deploy the thin vertical slice end to end (G1 blocking gate)
  - Deploy the thin end-to-end slice to the dev/staging environment: sign in → submit one
    validated score → read it back → see it on the leaderboard. This is the **G1 blocking gate**
    before feature depth.
  - **G1 exit criteria (all required):** the slice is deployed to dev/staging **and** all four
    cloud-seam integration tests are green against it:
    - client ↔ Cognito (task 4.3)
    - adapters ↔ DynamoDB (task 6.5)
    - client ↔ API (task 7.4)
    - the score-validation / tampered-submission seam (task 7.4)
  - _Requirements: R1, R2, R4, R6; design "Deploy-First Delivery"_

- [ ] 9. Concurrency and resilience (R7)
  - [ ] 9.1 Verify per-account isolation and concurrent-write consistency
    - Concurrent submissions for one account converge to a consistent result with no lost
      valid score; independent players never affect each other's scores
    - _Requirements: R7.1, R7.4_
  - [ ] 9.2 Implement graceful degradation and load posture
    - Return 429/deferral with clear indication beyond capacity; never corrupt accepted scores;
      document the tested concurrent-player target
    - _Requirements: R7.2, R7.3_
  - [ ]* 9.3 Load test the leaderboard and score paths against budgets
    - Assert top-50 p95 < 300 ms and freshness < 2 s at the target concurrency (adopted defaults)
    - _Requirements: R6.4, R6.5, R7.2_

- [ ] 10. Client SDK and React UI (R12)
  - [ ] 10.1 Implement the client Platform SDK over the ports
    - Wrap auth, score submission, personal history, and leaderboard reads behind the client
      ports; surface typed failures
    - _Requirements: R4, R5, R6, R12.5_
  - [ ] 10.2 Build the React SPA shell with the Canvas maze island
    - Auth screens, run setup, score history, leaderboard; embed the unchanged Phase 1 Canvas
      core for gameplay; responsive layout
    - _Requirements: R12.1, R12.2, R12.3_
  - [ ] 10.3 Wire run completion to score submission
    - On a local win, submit the move sequence + seed; reflect submission result and updated
      rank
    - _Requirements: R4.1, R5.2, R6.3_
  - [ ]* 10.4 UI component + accessibility tests
    - Auth/score/leaderboard states; keyboard operability, visible focus, perceivable feedback;
      failure states are explicit (not frozen)
    - _Requirements: R12.3, R12.4, R12.5_

- [ ] 11. Security and privacy hardening (R11)
  - [ ] 11.1 Enforce per-account authorization and public/private data boundaries
    - Every authenticated action restricted to the acting account; only display name + time are
      public; private identifier never exposed
    - _Requirements: R11.2, R11.3_
  - [ ] 11.2 Implement account deletion / data policy
    - Delete or irreversibly anonymize account personal data and private scores on request
    - _Requirements: R11.5_
  - [ ] 11.3 Audit logging and secrets hygiene
    - Ensure logs never record credentials or full tokens; least-privilege IAM reviewed
    - _Requirements: R11.4_

- [ ] 12. Checkpoint — Phase 2a complete on the dev/staging stack (G2 gate criteria)
  - Walking skeleton extended to full 2a features. This checkpoint establishes the **G2**
    blocking criteria that gate promotion to prod (task 13). **All required:**
    - every Phase 2a seam test green against dev/staging (4.3, 6.5, 7.4)
    - ≥ 90% core coverage; lint, typecheck, and build pass in CI
    - load test meets the stated budgets: top-50 p95 < 300 ms, freshness < 2 s, at the
      1,000-concurrent target
    - all security/privacy items done (R11 — tasks 11.1, 11.2, 11.3)
    - **manual approval** obtained
    - a rollback plan is stated
  - Ask the user before promoting to prod.
  - _Requirements: R1–R7, R11, R12_

- [ ] 13. Promote Phase 2a to prod (G2-gated)
  - **Gated on all G2 criteria in task 12 being met** (seam tests green, ≥ 90% core coverage,
    load budgets met, R11 done, manual approval, rollback plan stated). Only then run the gated
    pipeline step to deploy to prod (`main`) via **Amplify Hosting** frontend + `cdk deploy prod`
    backend; smoke-verify auth, score, and leaderboard on prod.
  - _Requirements: R11, R12, deploy-first strategy_

### Tasks — Phase 2b (Real-time shared sessions; depends on 2a)

- [ ] 14. Real-time transport and session channel
  - [ ] 14.1 Provision AppSync Events in CDK
    - Serverless WebSocket pub/sub channel(s) for shared sessions
    - _Requirements: R9.1_
  - [ ] 14.2 Define the `SessionChannel` port and implement `AppSyncEventsChannel`
    - join, publishMove (server-resolved), onUpdate subscribe/unsubscribe
    - _Requirements: R8.1, R9.1_

- [ ] 15. Server-authoritative shared session (pure logic + service)
  - [ ] 15.1 Write failing tests for the authoritative session reducer
    - Moves resolved against authoritative state via the shared core; illegal/out-of-order
      moves rejected leaving position unchanged
    - _Requirements: R9.2, R9.3_
  - [ ] 15.2 Implement the shared-session reducer using the shared core
    - Same maze for all participants; per-participant authoritative positions; status lifecycle
    - _Requirements: R8.1, R8.2, R9.2, R9.3_
  - [ ]* 15.3 Property test: no participant's authoritative position ever enters a wall/out-of-bounds cell
    - fast-check, ≥ 100 iterations; tag `// Feature: maze-game-platform, Property: authoritative legality`
    - _Requirements: R9.3_
  - [ ] 15.4 Implement the Session Lambda (join, resolve moves, publish updates)
    - Create session + server-owned maze; enforce capacity/ended on join; publish diffs
    - _Requirements: R8.1, R8.3, R8.4, R9.1, R9.4, R9.5_

- [ ] 16. Resolve and record shared sessions
  - [ ] 16.1 Implement finish/timeout resolution from authoritative state
    - Record finishing time/rank from authoritative state; time-expiry = not finished
    - _Requirements: R10.1, R10.2, R10.4_
  - [ ] 16.2 Persist qualifying shared-session results via the R4 score path
    - Reuse `ScoreRepository` so shared-session results feed the same leaderboard
    - _Requirements: R10.3_
  - [ ]* 16.3 Integration seam test: client ↔ realtime (real dev stack)
    - Two clients join a session, race, receive live updates within the latency budget; a
      conflicting move is rejected; a disconnect/reconnect restores authoritative state
    - _Requirements: R9.1, R9.3, R9.4, R9.5; design "integration seams"_

- [ ] 17. Checkpoint — Phase 2b complete, promote to prod (G3 gate)
  - Establishes the **G3** blocking criteria that gate promotion of Phase 2b to prod, with the
    same rigor as G2. **All required:**
    - shared-session realtime seam tests green against dev/staging (task 16.3)
    - realtime update p95 < 250 ms (adopted default)
    - shared-session results persist to the shared leaderboard
    - ≥ 90% core coverage; CI green
    - **manual approval** obtained
    - a rollback plan is stated
  - Only then promote to prod (`main`) via **Amplify Hosting** frontend + `cdk deploy prod`
    backend. Ask the user before promoting to prod.
  - _Requirements: R8, R9, R10_

## Notes

- The Phase 1 pure core is **reused unchanged**; it is packaged for server-side use (task 3)
  and imported by both client and Lambdas. No task modifies `src/core` rules.
- Tasks marked `*` are optional test/integration sub-tasks; the engineering standards call for
  them under the Definition of Done. **Task 1.4 is required (not optional)** — it is the G0 exit
  gate.
- Deploy-first: IaC + pipeline (task 1) precede everything and G0 (task 1.4) is a hard
  prerequisite before any feature task (2+); the walking skeleton (task 8) is the G1 blocking
  gate before feature depth; each cloud seam has an integration test against the real dev stack.
- Frontend hosting is **Amplify Hosting** branch environments (`main` = prod, staging on a
  branch). Task 1.3 was delivered as S3 + CloudFront and is reconciled to Amplify Hosting in
  task 1.5.
- New **pure** logic (score validation, leaderboard encoding/own-rank, shared-session reducer)
  is developed test-first with property-based tests, targeting ≥ 90% core coverage. AWS
  adapters are tested against local fakes for speed and the real dev stack at the seams.
- Numeric budgets use the adopted defaults; revisit if real targets are provided.
- Leaderboard uses the DynamoDB GSI baseline; the Redis sorted-set pivot (D3) is a drop-in
  behind `LeaderboardQuery` if exact large-scale rank becomes a requirement.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5"] },
    { "id": 1, "tasks": ["2.1", "2.2", "3.1", "3.2"] },
    { "id": 2, "tasks": ["4.1", "4.2", "5.1", "5.4"] },
    { "id": 3, "tasks": ["4.3", "5.2", "5.3", "5.5", "5.6", "6.1", "6.2"] },
    { "id": 4, "tasks": ["6.3", "6.4", "6.5"] },
    { "id": 5, "tasks": ["7.1", "7.2", "7.3", "7.4"] },
    { "id": 6, "tasks": ["8"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.3", "10.1", "10.2", "11.1", "11.2", "11.3"] },
    { "id": 8, "tasks": ["10.3", "10.4"] },
    { "id": 9, "tasks": ["12"] },
    { "id": 10, "tasks": ["13"] },
    { "id": 11, "tasks": ["14.1", "14.2"] },
    { "id": 12, "tasks": ["15.1", "15.2", "15.3", "15.4"] },
    { "id": 13, "tasks": ["16.1", "16.2", "16.3"] },
    { "id": 14, "tasks": ["17"] }
  ]
}
```
