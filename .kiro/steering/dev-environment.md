# Development Environment

These standards govern the local development environment for this project. They apply
whenever tooling is installed or a command is run on a developer machine. The goal is a
reproducible, isolated toolchain so every contributor and every CI-parity local run uses
the same versions.

## Devbox as the Dependency Manager

- Use **[Devbox](https://www.jetify.com/devbox)** as the chain dependency manager for
  **local tasks only**. Devbox provides an isolated, reproducible shell backed by Nix,
  without polluting the global system.
- All local development dependencies MUST be declared in `devbox.json` at the repository
  root and pinned via the committed `devbox.lock`. Do not rely on globally installed
  tools.
- Run local commands inside the Devbox environment, either through an interactive shell
  (`devbox shell`) or non-interactively (`devbox run <script>` / `devbox run -- <command>`).
- **Scope: local only.** Devbox is not the mechanism for CI, container images, or
  production. CI continues to run the npm scripts (`lint`, `typecheck`, `test:coverage`,
  `build`) directly per the engineering standards. Do not add Devbox as a required step in
  `.github/workflows/ci.yml`.
- Keep `devbox.json` and `devbox.lock` committed to version control so the environment is
  reproducible across machines.

## Required Tools

Declare these packages in `devbox.json`. Pin them to explicit versions where practical so
the lockfile stays deterministic.

- **jq** — command-line JSON processor. Use for parsing and transforming JSON in scripts.
- **yq** — command-line YAML/JSON/XML processor. Use for reading and editing YAML
  (e.g., CI workflow files, config) in scripts.
- **hg** (Mercurial) — version control client, available for any Mercurial-based
  workflows or dependencies.
- **awscli2** — the AWS CLI v2, for any AWS interactions performed locally.
- **Node.js / JavaScript dev tools** — include only **if required** by the work at hand.
  This project's engineering standards target a TypeScript/Vitest toolchain, so when local
  JS/TS tooling is needed, provide Node.js through Devbox rather than a global install, and
  let project dependencies (TypeScript, Vitest, ESLint, Prettier, etc.) be managed by the
  Node package manager within the Devbox shell.

## Conventions

- Prefer `devbox add <package>` to add a tool so `devbox.json` and `devbox.lock` are
  updated together, rather than editing `devbox.json` by hand.
- Expose common workflows as Devbox scripts in `devbox.json` (for example, wrapping the
  npm scripts) so local runs are consistent and discoverable.
- Do not introduce an alternative local dependency manager (Homebrew, asdf, global npm
  installs, etc.) for tools that Devbox can provide. Keep a single source of truth for the
  local toolchain.
- When documenting setup steps in the README or elsewhere, assume a contributor runs
  commands from within `devbox shell`.

## Workspace MCP Servers (local developer aid)

The repo also distributes a workspace `.kiro/settings/mcp.json` declaring AWS MCP servers so
contributors can inspect the deployed backend locally (traces, canary results, service audits,
and cost/pricing lookups). These sit alongside — not inside — the Devbox toolchain: Devbox
remains the single source of truth for the local *toolchain*, and MCP is a local *inspection*
aid layered on top.

- **AWS CloudWatch Application Signals** (`cloudwatch-applicationsignals`) — **enabled**;
  supports the D8 observability workflow (query X-Ray traces, canary results, and service
  audits). Its read-only tools are `autoApprove`d.
- **Billing & Cost Management** (`billing-cost-management`) — **enabled**, for local cost and
  usage inspection.
- **AWS Pricing** (`aws-pricing`) — **present but disabled by default**; enable it locally only
  when a pricing lookup is needed.

Conventions for these servers:

- **Read-only tools are `autoApprove`d** so routine inspection needs no per-call confirmation;
  any tool not on that list still prompts.
- **Credentials come from the contributor's own environment** — no AWS profile or key is
  committed. The servers default `AWS_REGION` to `us-east-1`; override it in your environment
  if you work in another region.
- **MCP is a local developer aid only.** It is **not** part of CI or the deployed system (the
  same local-only scope as Devbox), so nothing here changes what runs in the pipeline or in
  production.

## Example `devbox.json`

```json
{
  "packages": [
    "jq@latest",
    "yq@latest",
    "hg@latest",
    "awscli2@latest",
    "nodejs@latest"
  ],
  "shell": {
    "scripts": {
      "lint": "npm run lint",
      "typecheck": "npm run typecheck",
      "test": "npm run test",
      "test:coverage": "npm run test:coverage",
      "build": "npm run build"
    }
  }
}
```

> Node.js is listed here for convenience; include it only when the local work requires
> JavaScript/TypeScript tooling. Pin versions explicitly (for example, `nodejs@20`) when a
> specific version matters for reproducibility.
