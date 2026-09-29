import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type BundlingOptions } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Construct } from "constructs";

/**
 * The directory holding the server Lambda entry files (`src/server/lambda`),
 * resolved relative to this construct so `cdk synth`/`deploy` finds the sources
 * to bundle regardless of the working directory. `infra/` sits alongside `src/`,
 * so the entries are one level up.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LAMBDA_ENTRY_DIR = path.join(REPO_ROOT, "src", "server", "lambda");

/**
 * The repo-root dependency lockfile. `NodejsFunction` bundles entries relative to
 * a project root; the entries live under `src/` (one level up from `infra/`), so
 * the project root must be the repo root, which pointing at its lockfile
 * establishes. Without this, `NodejsFunction` rejects an entry outside `infra/`.
 */
const DEPS_LOCK_FILE = path.join(REPO_ROOT, "package-lock.json");

/**
 * The environment variable the service Lambdas read the single-table name from.
 * Must match `MAZE_TABLE_NAME` in `src/server/lambda/context.ts` and the
 * PostConfirmation trigger, so the adapters target this environment's table
 * without a hardcoded name.
 */
const TABLE_NAME_ENV = "MAZE_TABLE_NAME";

/**
 * How long a service handler may run. A score submission replays a maze through
 * the shared core plus two conditional DynamoDB writes; a few seconds is ample
 * and bounds a stuck invocation.
 */
const HANDLER_TIMEOUT = Duration.seconds(10);

/** Bounded log retention: enough to investigate a deploy, not an unbounded cost. */
const LOG_RETENTION = logs.RetentionDays.ONE_WEEK;

/**
 * Shared esbuild bundling options for every service Lambda. `@aws-sdk/*` is left
 * external because the Node 22 Lambda runtime already provides the AWS SDK v3,
 * so bundling it would only bloat the artifact.
 */
const BUNDLING: BundlingOptions = {
  externalModules: ["@aws-sdk/*"],
  target: "node22",
};

export interface ServiceApiProps {
  /** The HTTP API the feature routes are added to (shares the health API). */
  readonly httpApi: apigwv2.HttpApi;
  /** The JWT authorizer guarding the authenticated routes. */
  readonly authorizer: HttpUserPoolAuthorizer;
  /** The single DynamoDB table the score/leaderboard adapters read and write. */
  readonly table: dynamodb.Table;
}

/**
 * The score, personal-history, and leaderboard service Lambdas plus their HTTP
 * API routes and least-privilege DynamoDB grants (tasks 7.1–7.3, wired for the
 * walking skeleton in task 8).
 *
 * This construct is the "add feature routes behind the same API and authorizer"
 * that {@link ApiHttp} anticipates (Open/Closed): it does not touch the health
 * route, it extends the existing {@link apigwv2.HttpApi} with five new routes,
 * each backed by an **esbuild-bundled** {@link NodejsFunction} whose code is a
 * thin composition-root entry in `src/server/lambda`. The pure handlers those
 * entries wire up depend only on the `ScoreRepository` / `LeaderboardQuery`
 * ports; this construct supplies the real DynamoDB-backed implementations by
 * setting the table name and granting each function exactly the table access it
 * needs.
 *
 * Routes (design "API surface"):
 *  - `POST /scores`          — JWT-authorized; validate + persist a run (R4).
 *  - `GET  /scores/me`       — JWT-authorized; the caller's own history (R5.1).
 *  - `GET  /scores/me/best`  — JWT-authorized; the caller's best for a scope (R5.2).
 *  - `GET  /leaderboard`     — **public**; top-N standings, display names only (R6.1).
 *  - `GET  /leaderboard/me`  — JWT-authorized; the caller's own rank (R6.3).
 *
 * Least privilege (R11.1). Grants are scoped per function to the minimum access:
 *  - the score Lambda gets read+write (it puts scores and the personal-best item);
 *  - the personal-history and own-rank Lambdas get read-only;
 *  - the public leaderboard Lambda gets read-only.
 * CDK's `grantRead*Data` scope the actions to this table and its indexes only —
 * no `dynamodb:*`, no wildcard resource — so there is no broad grant to walk back.
 */
export class ServiceApi extends Construct {
  /** The `POST /scores` handler (validate + persist). */
  public readonly scoreHandler: NodejsFunction;

  /** The `GET /scores/me` handler (own history). */
  public readonly personalHistoryHandler: NodejsFunction;

  /** The `GET /scores/me/best` handler (own personal best). */
  public readonly personalBestHandler: NodejsFunction;

  /** The public `GET /leaderboard` handler (top-N). */
  public readonly leaderboardHandler: NodejsFunction;

  /** The `GET /leaderboard/me` handler (own rank). */
  public readonly ownRankHandler: NodejsFunction;

  /** The `DELETE /account/me` handler (erase the caller's own account, R11.5). */
  public readonly deleteAccountHandler: NodejsFunction;

  public constructor(scope: Construct, id: string, props: ServiceApiProps) {
    super(scope, id);

    const { httpApi, authorizer, table } = props;

    // Write side: validate + persist a score and maintain the personal-best item.
    this.scoreHandler = this.makeFunction("ScoreHandler", "scores.handler.ts", table);
    table.grantReadWriteData(this.scoreHandler);

    // Read side: the caller's own scores. Read-only is sufficient.
    this.personalHistoryHandler = this.makeFunction(
      "PersonalHistoryHandler",
      "personalHistory.handler.ts",
      table,
    );
    table.grantReadData(this.personalHistoryHandler);

    this.personalBestHandler = this.makeFunction(
      "PersonalBestHandler",
      "personalBest.handler.ts",
      table,
    );
    table.grantReadData(this.personalBestHandler);

    // Read side: public top-N and authenticated own-rank. Both read the GSI and
    // the profile items; read-only is sufficient.
    this.leaderboardHandler = this.makeFunction(
      "LeaderboardHandler",
      "leaderboard.handler.ts",
      table,
    );
    table.grantReadData(this.leaderboardHandler);

    this.ownRankHandler = this.makeFunction("OwnRankHandler", "ownRank.handler.ts", table);
    table.grantReadData(this.ownRankHandler);

    // Erase side: delete every item under the caller's own account partition
    // (profile + scores + personal bests) on request (R11.5). It enumerates the
    // partition (Query) and removes items (BatchWriteItem/DeleteItem), so its
    // grant is exactly those actions on this table plus its indexes — NOT
    // grantReadWriteData, which would also permit PutItem/UpdateItem this
    // function never needs. Least privilege (R11.1): only the delete Lambda can
    // destroy data, and only these actions.
    this.deleteAccountHandler = this.makeFunction(
      "DeleteAccountHandler",
      "deleteAccount.handler.ts",
      table,
    );
    table.grant(
      this.deleteAccountHandler,
      "dynamodb:Query",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
    );
    // BatchWriteItem/DeleteItem target the base table; Query also reads the
    // partition. `grant` scopes the resource to this table and its indexes only
    // (no wildcard resource, no dynamodb:*), so there is no broad grant to walk
    // back.

    // Authenticated routes: the JWT authorizer runs first, so an absent/invalid
    // token is 401 at the edge before the handler runs (R4.3, R5.3).
    this.addRoute(httpApi, "POST", "/scores", this.scoreHandler, authorizer);
    this.addRoute(httpApi, "GET", "/scores/me", this.personalHistoryHandler, authorizer);
    this.addRoute(
      httpApi,
      "GET",
      "/scores/me/best",
      this.personalBestHandler,
      authorizer,
    );
    this.addRoute(httpApi, "GET", "/leaderboard/me", this.ownRankHandler, authorizer);
    // Authenticated: the account to erase is the JWT sub only; a caller can
    // delete only its own account (R11.2, R11.5).
    this.addRoute(
      httpApi,
      "DELETE",
      "/account/me",
      this.deleteAccountHandler,
      authorizer,
    );

    // Public route: no authorizer. Anyone may read the ranking; the handler
    // projects away the private identifier so only display name + time + rank
    // leave the boundary (R6.2, R11.3).
    this.addRoute(httpApi, "GET", "/leaderboard", this.leaderboardHandler);
  }

  /**
   * Build one esbuild-bundled service Lambda from its entry file, with the table
   * name injected, bounded timeout, and an owned log group of bounded retention.
   */
  private makeFunction(
    id: string,
    entryFile: string,
    table: dynamodb.Table,
  ): NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    return new NodejsFunction(this, id, {
      functionName: `maze-game-platform-${kebab(id)}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(LAMBDA_ENTRY_DIR, entryFile),
      projectRoot: REPO_ROOT,
      depsLockFilePath: DEPS_LOCK_FILE,
      handler: "handler",
      timeout: HANDLER_TIMEOUT,
      environment: {
        // The adapters target the shared table by name; the value is a CloudFormation
        // token resolved at deploy time (never hardcoded).
        [TABLE_NAME_ENV]: table.tableName,
      },
      bundling: BUNDLING,
      logGroup,
      // X-Ray active tracing (D8): CDK wires the managed AWSXRayDaemonWriteAccess policy
      // onto each function's execution role. The SDK v3 client instrumentation that turns
      // DynamoDB (and Cognito) calls into subsegments is application code in the Lambda
      // composition roots (`src/server/lambda`), not this IaC task.
      tracing: lambda.Tracing.ACTIVE,
      description: `${id} for the shared Maze Game Platform API.`,
    });
  }

  /** Add one route to the HTTP API, optionally guarded by the JWT authorizer. */
  private addRoute(
    httpApi: apigwv2.HttpApi,
    method: "GET" | "POST" | "DELETE",
    routePath: string,
    handler: NodejsFunction,
    authorizer?: HttpUserPoolAuthorizer,
  ): void {
    const integrationId = `${routePath.replace(/[^a-zA-Z0-9]/g, "")}${method}Integration`;
    httpApi.addRoutes({
      path: routePath,
      methods: [apigwv2.HttpMethod[method]],
      integration: new HttpLambdaIntegration(integrationId, handler),
      ...(authorizer === undefined ? {} : { authorizer }),
    });
  }
}

/** Turn a PascalCase construct id into a kebab-case function-name segment. */
function kebab(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
