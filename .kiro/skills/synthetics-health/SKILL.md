---
name: synthetics-health
description: Check whether the CloudWatch Synthetics canaries report the Maze Game Platform as healthy, using the CloudWatch Application Signals MCP tools. Use when the user asks if the app is healthy, if the canaries are green, or to check the read-only and full-flow synthetic monitors.
---

# Synthetics Health (Maze Game Platform)

Report whether the deployed backend is healthy according to its CloudWatch Synthetics
canaries, using the CloudWatch Application Signals MCP tools. MCP-based (not shell/CLI), so
it works whether or not the local Devbox shell is active.

## When to use

- "Is the app healthy?" / "Are the canaries green?"
- "Check synthetics" / "did the last canary run pass?"
- After a deploy, to confirm the monitors still report healthy.

## Backend context

- Region: **us-east-1**. Stack: `MazeGamePlatform`.
- Two canaries observe the shared backend (from the observability task):
  - **`maze-platform-readonly`** — 5-minute read-only availability/latency check (public
    leaderboard read + health liveness).
  - **`maze-platform-fullflow`** — 30-minute full user flow (sign in → submit a score → read
    it back → leaderboard → self-clean), run as the reserved synthetic account.
- Latency/availability budgets to judge against: leaderboard top-50 p95 < 300 ms,
  freshness < 2 s (the read-only canary and its CloudWatch alarms track these).

## How to run it

1. Use the CloudWatch Application Signals MCP tools:
   - `list_canaries` to see both canaries and their current status/last-run state, and
   - `analyze_canary_failures` (with `canary_name` = `maze-platform-readonly` or
     `maze-platform-fullflow`) when a canary is failing, to get root-cause detail.
2. Report each canary's **last-run result** (PASSED / FAILED), when it last ran, and its
   schedule. If either failed, drill into it with `analyze_canary_failures` and summarize the
   likely cause (which step failed, error/latency).

## Reporting

- Give a one-line verdict first: **healthy** (both canaries green) or **unhealthy** (name
  which canary failed).
- Then per canary: name, last-run status, last-run time.
- For a failure, add the failing step and the probable cause, and (if useful) point at the
  X-Ray traces skill to dig into the underlying request path.
- Note the time of the check and that a canary result reflects its last scheduled run, not
  necessarily this instant.

## Notes

- Read-only. It does not change any resource.
- If the full-flow canary fails on auth, remember its synthetic account/password is
  provisioned out of band (SSM) and `COGNITO_DEFAULT` email is limited — an auth failure may
  be an account/credential issue, not an app regression.
- If the MCP tools are unavailable, say so rather than silently falling back to the CLI.
