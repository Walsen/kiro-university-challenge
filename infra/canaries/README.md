# Synthetics canary scripts (task 9.2, D8)

These are the CloudWatch Synthetics canary handler scripts that
`infra/observability.ts` (`SyntheticsMonitoring`) packages as `Code.fromAsset(...)` and
schedules against the deployed `MazeGamePlatform` backend. They are **edge/monitoring**
code — the pure `src/core` is neither imported nor modified.

Each canary follows the Synthetics "nodejs puppeteer" asset layout: the handler lives at
`<canary>/nodejs/node_modules/<script>.js` and the CDK `Test` names the handler
`<script>.handler`.

## `readonly/` — read-only availability + latency canary (every 5 min)

Unauthenticated, holds no credentials, never writes. Two steps:

1. `GET /leaderboard?<mazeParams>` must be `200` with a well-formed `{ standings: [] }`
   body — the primary availability signal and the leaderboard **p95 latency** signal the
   alarms evaluate (R6.4/R6.5).
2. `GET /health` (JWT-protected) is probed **without** a token and must return `401` —
   a liveness check that the edge is reachable and the authorizer is live. No token is
   baked into this canary.

## `fullflow/` — full-flow walking-skeleton canary (every 30 min)

Walks sign in → submit a validated score → read back (`GET /scores/me`) → see it on
`GET /leaderboard` → self-clean via `DELETE /account/me` (task 12.2, R11.5), using a
**reserved synthetic account**.

- **Credentials are sourced at runtime from SSM Parameter Store**, never committed. The
  construct grants the canary role read on exactly one SecureString parameter and passes
  its **name** in `MAZE_SYNTHETIC_CREDENTIAL_PARAM`; the script fetches the value with
  `ssm:GetParameter` (WithDecryption). Until the value is provisioned the canary fails
  closed.
- A **valid** run is rebuilt the same way `src/server/handlers/scoresApi.integration.test.ts`
  does: identical seeded `mulberry32` PRNG + recursive-backtracker generation, then a BFS
  solve — so the server's replay accepts it.

### Deploy-time follow-ups (not done by this IaC task)

1. **Provision the synthetic account** in the shared Cognito pool (a reserved
   `@example.com` user, confirmed administratively) — it must pre-exist for sign-in.
2. **Set the SSM SecureString value** (`MAZE_SYNTHETIC_CREDENTIAL_PARAM`, created empty by
   CDK) to that account's password, out of band.
3. **Bundle the SRP helper** the full-flow canary requires
   (`amazon-user-pool-srp-client`) into the `fullflow/nodejs/node_modules/` asset, since
   the Cognito pool enables only the SRP auth flow (plaintext `USER_PASSWORD_AUTH` is
   deliberately disabled). The AWS SDK v3 clients are provided by the Synthetics runtime.
