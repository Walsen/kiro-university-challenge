---
name: xray-traces
description: Fetch and summarize current AWS X-Ray traces for the Maze Game Platform backend, faults first. Use when the user asks to see recent traces, investigate a slow or failing request, or inspect the API → Lambda → DynamoDB/AppSync call path.
---

# X-Ray Traces (Maze Game Platform)

Retrieve and summarize recent distributed traces for the deployed backend using the
CloudWatch Application Signals / X-Ray MCP tools. This is MCP-based (not shell/CLI), so it
works whether or not the local Devbox shell is active.

## When to use

- "Show me the current/recent X-Ray traces."
- "Any errors or faults in the last N minutes?"
- "Trace a slow request" / "why did this request fail" — follow a request across the
  API Gateway → Lambda → DynamoDB / AppSync call path.

## Backend context

- Region: **us-east-1**. Account: **862307432587**.
- Stack: `MazeGamePlatform` (single shared backend). Traced components: the HTTP API
  (API Gateway) and every Lambda (score, personal-best, leaderboard, own-rank,
  delete-account, profile-signup trigger, session), which the observability task instrumented
  with active X-Ray tracing.
- Prod frontend: `https://main.d2whp2v3n3kz6g.amplifyapp.com` (hosted on the console Amplify
  app; not traced — tracing is backend only).

## How to run it

1. **Default to faults/errors first.** Look back over the last **15 minutes** unless the user
   gives a different window, and prioritize traces with faults (5xx) or errors (4xx) over
   healthy ones — those are what matter for troubleshooting.
2. Use the CloudWatch Application Signals MCP tools:
   - `search_transaction_spans` to query recent spans (Transaction Search) when available, or
   - `get_xray_trace` to fetch a specific trace by ID (accepts OTel or X-Ray formats) once you
     have a trace ID from an incident, a log, or a span search.
   - When investigating a service/operation broadly, `audit_service_operations` /
     `audit_services` can surface trace-backed findings.
3. If a trace ID is already known (e.g. from `telemetry_correlation.trace_id` on an incident),
   go straight to `get_xray_trace`.

## Reporting

- Lead with **faults and errors**: which operation, the exception/status, and where in the
  call path time was spent or the failure occurred.
- Show the call path (API → Lambda → downstream) with per-segment latency and any
  fault/error/throttle flags.
- Note the time window actually covered, and say if X-Ray sampling means a trace may be
  missing (X-Ray samples ~5%; suggest Transaction Search / span search for 100% coverage).
- Keep it concise: a short summary of what's wrong (or "no faults in the window"), then
  detail only for the traces that matter.

## Notes

- This is read-only observability. It does not change any resource.
- If the MCP tools are unavailable in the current environment, say so rather than falling back
  silently; a shell/CLI fallback (`aws xray get-trace-summaries`) exists but requires Devbox
  and is out of scope for this MCP-based skill.
