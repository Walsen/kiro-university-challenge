/**
 * Build the shared maze-core package (maze-game-platform task 3.1).
 *
 * The Phase 1 pure core in `src/core` is reused UNCHANGED. This script only
 * *packages* it so both consumers can import it as `maze-game/core`:
 *   - the client (React SPA), and
 *   - the server-side Lambdas (a Node runtime).
 *
 * Two artifacts are produced in `dist/package/core` (a directory distinct from
 * the browser SPA app build in `dist`, so the two never clobber each other):
 *   1. `index.js`  — a single, self-contained ES module bundled with esbuild.
 *      The TypeScript core is compiled with `moduleResolution: "Bundler"`, so
 *      it emits extensionless relative imports (`from "./types"`). A bundler
 *      resolves those; Node's native ESM resolver does not. Bundling to one
 *      file makes the entry point runnable directly under Node/Lambda without
 *      relying on the consumer's bundler, satisfying the "imports and runs in a
 *      Node/Lambda context" acceptance criterion.
 *   2. `index.d.ts` — type declarations emitted by `tsc` (see the npm
 *      `build:core:types` script), so TypeScript consumers get full types.
 *
 * The core stays pure: this script does no code transformation beyond module
 * bundling, targets Node, and touches nothing under `src/core`.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

/** Node 22 is the declared runtime (see package.json "engines"). */
const NODE_TARGET = "node22";

await build({
  entryPoints: [resolve(projectRoot, "src/core/index.ts")],
  outfile: resolve(projectRoot, "dist/package/core/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: NODE_TARGET,
  // The core is pure and self-contained; nothing is marked external.
  sourcemap: true,
  logLevel: "info",
});
