import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type BundlingOptions } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Construct } from "constructs";

import type { RealtimeChannel } from "./realtime-channel.js";

/** The repo root (one level up from `infra/`); the entries live under it. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The server Lambda entry directory (`src/server/lambda`). */
const LAMBDA_ENTRY_DIR = path.join(REPO_ROOT, "src", "server", "lambda");

/** Repo-root lockfile so `NodejsFunction` accepts an entry outside `infra/`. */
const DEPS_LOCK_FILE = path.join(REPO_ROOT, "package-lock.json");

/** Must match `MAZE_TABLE_NAME` read by the Session composition root. */
const TABLE_NAME_ENV = "MAZE_TABLE_NAME";

/**
 * Must match `REALTIME_HTTP_DNS` read by the Session composition root: the
 * AppSync Events HTTP endpoint the server SigV4-signs and publishes updates to.
 */
const REALTIME_HTTP_DNS_ENV = "REALTIME_HTTP_DNS";

/**
 * How long the Session handler may run: load authoritative state, resolve one
 * move through the pure core, one conditional-free write, and one publish. A few
 * seconds is ample and bounds a stuck invocation.
 */
const HANDLER_TIMEOUT = Duration.seconds(10);

/** Bounded log retention, matching the other service Lambdas. */
const LOG_RETENTION = logs.RetentionDays.ONE_WEEK;

/**
 * `@aws-sdk/*` is provided by the Node 22 runtime, so keep it external. The
 * signing libraries the composition root uses (`@smithy/*`, `@aws-crypto/*`) are
 * NOT `@aws-sdk/*`, so esbuild bundles the pinned versions into the artifact —
 * deliberate, so the signer version is deterministic rather than whatever the
 * runtime happens to ship.
 */
const BUNDLING: BundlingOptions = {
  externalModules: ["@aws-sdk/*"],
  target: "node22",
};

export interface SessionApiProps {
  /** The single DynamoDB table the session repository reads and writes. */
  readonly table: dynamodb.Table;
  /** The AppSync Events realtime transport the server publishes updates to. */
  readonly realtime: RealtimeChannel;
}

/**
 * The server-authoritative Session service Lambda for shared sessions (task
 * 16.4, Phase 2b, R8/R9).
 *
 * This construct provisions the one function that owns a Shared_Session's
 * authoritative state: it creates a session with a **server-owned** maze (R8.1),
 * enforces capacity / ended on join (R8.3), resolves each intended move against
 * authoritative state via the shared core (R9.2/R9.3), and publishes the
 * resulting authoritative diff to the session channel (R9.1). The pure logic and
 * the adapters live in `src/server`; this construct only wires the runtime and
 * its least-privilege grants (hexagonal boundary — IaC never contains rules).
 *
 * Least privilege (R11.1):
 *  - **DynamoDB**: read+write on the single table only — the handler `Get`s and
 *    `Put`s the session-state item (`PK = SESSION#<id>`, `SK = STATE`). CDK's
 *    `grantReadWriteData` scopes the actions to this table and its indexes; no
 *    `dynamodb:*`, no wildcard resource.
 *  - **AppSync Events**: publish only, via {@link RealtimeChannel.grantPublish}
 *    — the server fans out authoritative updates as the IAM principal (R9.2); it
 *    is not granted connect/subscribe, which are the client's Cognito-authed
 *    concern.
 *
 * The AppSync HTTP endpoint is injected as an environment variable so the
 * composition root signs and publishes to the right API without a hardcoded
 * hostname (the value is a CloudFormation token resolved at deploy time).
 */
export class SessionApi extends Construct {
  /** The Session service Lambda (join, resolve moves, publish updates). */
  public readonly handler: NodejsFunction;

  public constructor(scope: Construct, id: string, props: SessionApiProps) {
    super(scope, id);

    const { table, realtime } = props;

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new NodejsFunction(this, "Handler", {
      functionName: "maze-game-platform-session",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(LAMBDA_ENTRY_DIR, "session.handler.ts"),
      projectRoot: REPO_ROOT,
      depsLockFilePath: DEPS_LOCK_FILE,
      handler: "handler",
      timeout: HANDLER_TIMEOUT,
      environment: {
        // Resolved to concrete values at deploy time (never hardcoded).
        [TABLE_NAME_ENV]: table.tableName,
        [REALTIME_HTTP_DNS_ENV]: realtime.httpDns,
      },
      bundling: BUNDLING,
      logGroup,
      // X-Ray active tracing (D8): the SDK v3 client instrumentation for the
      // DynamoDB subsegment is application code in the composition root, not here.
      tracing: lambda.Tracing.ACTIVE,
      description: "Server-authoritative shared-session Lambda for the shared backend.",
    });

    // Read+write the single table: the handler Gets and Puts the session-state
    // item. Scoped to this table and its indexes only (R11.1).
    table.grantReadWriteData(this.handler);

    // Publish authoritative updates to the realtime API as the IAM principal
    // (R9.2). Publish only — the server does not connect/subscribe as a client.
    realtime.grantPublish(this.handler);
  }
}
