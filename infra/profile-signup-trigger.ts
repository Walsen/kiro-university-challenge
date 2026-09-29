import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type BundlingOptions } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Construct } from "constructs";

/** The repo root (one level up from `infra/`); the entries live under it. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The server Lambda entry directory (`src/server/lambda`). */
const LAMBDA_ENTRY_DIR = path.join(REPO_ROOT, "src", "server", "lambda");

/** Repo-root lockfile so `NodejsFunction` accepts an entry outside `infra/`. */
const DEPS_LOCK_FILE = path.join(REPO_ROOT, "package-lock.json");

/** Must match `MAZE_TABLE_NAME` read by the trigger entry. */
const TABLE_NAME_ENV = "MAZE_TABLE_NAME";

/** The one DynamoDB action the trigger performs; nothing more (R11 least privilege). */
const PROFILE_WRITE_ACTION = "dynamodb:PutItem";

/** Bounded timeout: a single conditional-free `Put`; a few seconds is ample. */
const TRIGGER_TIMEOUT = Duration.seconds(10);

/** Bounded log retention, matching the service Lambdas. */
const LOG_RETENTION = logs.RetentionDays.ONE_WEEK;

/** `@aws-sdk/*` is provided by the Node 22 runtime, so keep it external. */
const BUNDLING: BundlingOptions = {
  externalModules: ["@aws-sdk/*"],
  target: "node22",
};

export interface ProfileSignUpTriggerProps {
  /** The Cognito user pool whose PostConfirmation event fires the trigger. */
  readonly userPool: cognito.UserPool;
  /** The single table the trigger writes the `PROFILE` item into. */
  readonly table: dynamodb.Table;
}

/**
 * The profile-on-signup path the walking skeleton needs (task 8, R6.2).
 *
 * The leaderboard resolves a public display name from a `PROFILE` item per
 * account. Nothing created that item before this trigger, so the slice
 * (sign in → submit → leaderboard) would show "Unknown Player" for a real
 * account. This construct attaches a **Cognito PostConfirmation trigger**: the
 * instant Cognito confirms an account, an esbuild-bundled {@link NodejsFunction}
 * writes the account's `PROFILE` item (`PK = ACCT#<sub>`, `SK = PROFILE`,
 * `accountId`, `displayName`) so the leaderboard can show a real name.
 *
 * Minimal and least-privilege (R11): the function is granted **only**
 * `dynamodb:PutItem` on the single table — not `grantWriteData`, which would
 * also allow deletes — because writing the profile item is all it does. The
 * account id comes only from Cognito's verified `sub` attribute; the trigger
 * never trusts a client-supplied identifier.
 */
export class ProfileSignUpTrigger extends Construct {
  /** The PostConfirmation Lambda that writes the profile item. */
  public readonly handler: NodejsFunction;

  public constructor(scope: Construct, id: string, props: ProfileSignUpTriggerProps) {
    super(scope, id);

    const { userPool, table } = props;

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new NodejsFunction(this, "Handler", {
      functionName: "maze-game-platform-profile-signup",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(LAMBDA_ENTRY_DIR, "profileOnSignUp.handler.ts"),
      projectRoot: REPO_ROOT,
      depsLockFilePath: DEPS_LOCK_FILE,
      handler: "handler",
      timeout: TRIGGER_TIMEOUT,
      environment: {
        [TABLE_NAME_ENV]: table.tableName,
      },
      bundling: BUNDLING,
      logGroup,
      // X-Ray active tracing (D8): CDK wires the managed AWSXRayDaemonWriteAccess policy
      // onto the trigger's execution role. The SDK v3 client instrumentation for the
      // DynamoDB subsegment is application code in the trigger's composition root
      // (`src/server/lambda`), not this IaC task.
      tracing: lambda.Tracing.ACTIVE,
      description: "Cognito PostConfirmation profile writer for the shared backend.",
    });

    // Exactly the one action the trigger needs, on this table only (R11).
    table.grant(this.handler, PROFILE_WRITE_ACTION);

    // Fire the trigger after Cognito confirms an account. Adding it here (rather
    // than in IdentityUserPool) keeps the DynamoDB dependency out of the identity
    // construct; the pool is extended in place (Open/Closed).
    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, this.handler);
  }
}
