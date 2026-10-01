# Kiro Dynamic Workflows

This folder holds **Kiro Dynamic Workflow** definitions — sandboxed `ctx`-DSL
Python scripts that a KiroCrew session runs as a multi-phase, inspectable,
restartable orchestration (Workflows tab). They are version-controlled here so
the team runs the same orchestration the same way.

## What a Dynamic Workflow is

A script with a pure-literal `META` dict and an `async def workflow(ctx)`
entrypoint. The sandbox allows only safe builtins and the `ctx` surface
(`ctx.agent`, `ctx.parallel`, `ctx.pipeline`, `ctx.phase`, `ctx.log`,
`ctx.args`, `ctx.budget`) — no imports, no I/O. The model only runs at the leaf
`ctx.agent(...)` calls; the Python is deterministic scaffolding. Each phase is a
restart point: `workflow_rerun_subtree` replays the unchanged prefix from cache
and re-executes only from the step you name.

## Workflows here

### `spec-implementation-fanout.py`
Decomposes `.kiro/specs/<spec>/tasks.md` into independent, layer-ordered groups,
implements the dependency-free groups in parallel (test-first), runs the repo's
offline gate (`npm run lint && npm run typecheck && npm run test:coverage`,
≥90% core coverage per `.kiro/steering/testing.md`), then synthesizes a
PR-per-group plan.

- **Args:** `{"spec": "maze-game", "max_groups": 4}`
- **Credentials:** none — fully offline.
- **Restart value:** if the coverage gate fails for one group, rerun from the
  `implement` phase for just that group.

## How to run

From a KiroCrew chat scoped to this repo, either:

- ask: *"run the saved workflow at `.kiro/workflows/spec-implementation-fanout.py`
  with spec maze-game"*, or
- use the `workflow_run` tool with `source` set to the file contents and `args`
  as above.

A run streams to the chat's **Workflows** panel and injects its result back into
the chat on completion. Watch with `workflow_status` / `workflow_result`;
restart a phase with `workflow_rerun_subtree`.

> These scripts were validated against KiroCrew's `kiro_crew.workflows.validate`
> (static AST + ctx-surface checks) before commit.
