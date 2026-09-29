import { CfnOutput, Stack, Tags } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { ApiHttp } from "./api-http.js";
import { DataStore } from "./data-store.js";
import { GitHubOidcDeployRole } from "./github-oidc-deploy-role.js";
import { IdentityUserPool } from "./identity-user-pool.js";
import { ProfileSignUpTrigger } from "./profile-signup-trigger.js";
import { RealtimeChannel } from "./realtime-channel.js";
import { ServiceApi } from "./service-api.js";
import { SessionApi } from "./session-api.js";
import { StaticSiteHosting } from "./static-site-hosting.js";
import { SyntheticsMonitoring } from "./observability.js";
import {
  SYNTHETIC_CANARY_CREDENTIAL_PARAM,
  SYNTHETIC_CANARY_USERNAME,
} from "./config.js";

/** Props for {@link PlatformStack}. */
export interface PlatformStackProps extends StackProps {
  /**
   * The shared, account-level GitHub OIDC provider the deploy role trusts. Created once in
   * the app (see {@link OidcProviderStack}) and injected, because an IAM OIDC provider for
   * a given issuer is unique per account.
   */
  readonly oidcProvider: iam.IOpenIdConnectProvider;
}

/**
 * The single, shared, environment-agnostic backend stack for the Maze Game Platform
 * (Phase 2), named `MazeGamePlatform`.
 *
 * There is exactly **one** backend (D6): one Cognito user pool, one DynamoDB table, one
 * HTTP API + Lambdas, and one GitHub OIDC deploy role — none suffixed with an environment
 * name. The **environment is identified by the Amplify Git branch** inside the one Amplify
 * app (D7): `main` serves prod and `staging` serves staging, and **both branches serve this
 * same shared backend**. There is no per-environment stack and no `isProd` branching; the
 * single backend always runs with a prod-grade data posture (table `RETAIN` + point-in-time
 * recovery, user pool `RETAIN`).
 *
 * The stack wires the **GitHub Actions OIDC deploy role**: the identity the CI pipeline
 * assumes (via a short-lived OIDC token, no long-lived keys) to run
 * `cdk deploy MazeGamePlatform`.
 *
 * Observability (D8): X-Ray active tracing is enabled on every Lambda and on the HTTP API
 * stage (see the constructs), so a request produces an end-to-end trace. The AWS SDK v3
 * client instrumentation that surfaces DynamoDB/Cognito calls as subsegments is application
 * code in the Lambda composition roots (`src/server/lambda`), not this IaC. The pure
 * `src/core` is neither traced nor modified.
 *
 * Least privilege from the start (R11): the deploy role holds no standing service
 * permissions of its own — it may only assume the CDK bootstrap roles — and every construct
 * grants only the IAM it needs.
 */
export class PlatformStack extends Stack {
  /** The single GitHub Actions OIDC deploy role for the shared backend. */
  public readonly deployRole: iam.Role;

  /** Static hosting (one AWS Amplify app + one branch per environment) for the SPA. */
  public readonly staticSite: StaticSiteHosting;

  /** Cognito identity (user pool + SPA app client) for accounts and auth. */
  public readonly identity: IdentityUserPool;

  /** The HTTP API edge with a Cognito JWT authorizer on protected routes. */
  public readonly api: ApiHttp;

  /** The DynamoDB single table (profiles, scores, personal bests) + leaderboard GSI. */
  public readonly dataStore: DataStore;

  /** The score, personal-history, and leaderboard service Lambdas + their routes. */
  public readonly serviceApi: ServiceApi;

  /** The Cognito PostConfirmation trigger that writes the account's profile item. */
  public readonly profileSignUpTrigger: ProfileSignUpTrigger;

  /** The Synthetics canaries + CloudWatch alarms that observe the shared backend (D8). */
  public readonly observability: SyntheticsMonitoring;

  /** The AppSync Events realtime transport for shared sessions (Phase 2b, R9.1). */
  public readonly realtime: RealtimeChannel;

  /** The server-authoritative Session service Lambda for shared sessions (Phase 2b, R8/R9). */
  public readonly sessionApi: SessionApi;

  public constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    // Tag every resource so the shared backend is distinguishable in the console and in
    // cost reporting. There is no per-environment Environment tag — the environment is the
    // Amplify branch, not the backend — so the backend is tagged as the shared platform.
    Tags.of(this).add("Project", "MazeGamePlatform");
    Tags.of(this).add("Environment", "shared");

    this.deployRole = new GitHubOidcDeployRole(this, "GitHubDeployRole", {
      provider: props.oidcProvider,
    });

    new CfnOutput(this, "DeployRoleArn", {
      value: this.deployRole.roleArn,
      description:
        "ARN of the GitHub Actions OIDC deploy role for the shared backend. Use as the workflow's role-to-assume.",
      exportName: "MazeGamePlatform-DeployRoleArn",
    });

    // Static hosting: one Amplify app whose branches identify the environment (D7). Added
    // to the shared backend stack so a single `cdk deploy` provisions the site alongside
    // the rest of the backend.
    this.staticSite = new StaticSiteHosting(this, "StaticSite");

    // Surface where each environment's branch is served so the deploy pipeline and smoke
    // checks (and later, the client's configured API/base URL) can find the branch domains.
    // One output per branch environment (e.g. `SiteUrl-prod`, `SiteUrl-staging`).
    for (const { environment } of this.staticSite.branchEnvironments) {
      new CfnOutput(this, `SiteUrl-${environment}`, {
        value: this.staticSite.urlFor(environment),
        description: `Public HTTPS URL of the ${environment} SPA (Amplify branch domain; serves the shared backend).`,
        exportName: `MazeGamePlatform-SiteUrl-${environment}`,
      });
    }

    // Cognito identity for accounts, sign-in, and recovery. The API's JWT authorizer
    // validates tokens against this one shared pool.
    this.identity = new IdentityUserPool(this, "Identity");

    // Surface the pool and client identifiers so the SPA build and the API's JWT
    // authorizer can be configured against the shared pool.
    new CfnOutput(this, "UserPoolId", {
      value: this.identity.userPool.userPoolId,
      description:
        "Cognito user pool ID for the shared backend. Configure the SPA and the API JWT authorizer against it.",
      exportName: "MazeGamePlatform-UserPoolId",
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: this.identity.userPoolClient.userPoolClientId,
      description:
        "Cognito SPA app client ID for the shared backend. The SPA authenticates through this public client.",
      exportName: "MazeGamePlatform-UserPoolClientId",
    });

    // The HTTP API edge with a Cognito JWT authorizer, wired to the shared user pool +
    // app client so the authorizer validates tokens issued by them (R2, R4.3, R5.3, R11).
    this.api = new ApiHttp(this, "Api", {
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
    });

    // Surface the API base URL so the SPA build (and the seam tests) can target the API.
    new CfnOutput(this, "ApiUrl", {
      value: this.api.url,
      description:
        "Base HTTPS URL of the shared HTTP API. The SPA sends bearer-JWT requests here.",
      exportName: "MazeGamePlatform-ApiUrl",
    });

    // The DynamoDB single table + leaderboard GSI. The score/leaderboard Lambdas reach it
    // via the repository adapters and are granted only the IAM they need.
    this.dataStore = new DataStore(this, "DataStore");

    // Surface the table name so the score/leaderboard services can be configured against
    // the shared table (and the seam tests can address it).
    new CfnOutput(this, "TableName", {
      value: this.dataStore.tableName,
      description:
        "DynamoDB single-table name for the shared backend. Configure the score and leaderboard services against it.",
      exportName: "MazeGamePlatform-TableName",
    });

    // The score, personal-history, and leaderboard service Lambdas, added as new routes
    // behind the SAME HTTP API and JWT authorizer the health probe uses (Open/Closed — the
    // health route is untouched). Each is granted only the DynamoDB access it needs (R11).
    this.serviceApi = new ServiceApi(this, "ServiceApi", {
      httpApi: this.api.httpApi,
      authorizer: this.api.authorizer,
      table: this.dataStore.table,
    });

    // The profile-on-signup path: a Cognito PostConfirmation trigger writes the account's
    // PROFILE item so the leaderboard can resolve a public display name (R6.2). Depends on
    // both the user pool and the table, so it is wired here at the composition root rather
    // than inside either construct.
    this.profileSignUpTrigger = new ProfileSignUpTrigger(this, "ProfileSignUpTrigger", {
      userPool: this.identity.userPool,
      table: this.dataStore.table,
    });

    // Observability (D8, task 9.2): the read-only (5-min) and full-flow (30-min) Synthetics
    // canaries plus the CloudWatch alarms over availability and the leaderboard
    // latency/freshness budgets (R6.4/R6.5/R7.2). This is an edge/monitoring concern — it
    // probes the deployed API from outside and never touches the pure core. The full-flow
    // canary's synthetic-account password is sourced from SSM at runtime (referenced by
    // name here, provisioned out of band); no secret is committed (R11.4).
    this.observability = new SyntheticsMonitoring(this, "Observability", {
      apiBaseUrl: this.api.url,
      leaderboardPath: "/leaderboard",
      healthPath: "/health",
      userPoolId: this.identity.userPool.userPoolId,
      userPoolClientId: this.identity.userPoolClient.userPoolClientId,
      syntheticUsername: SYNTHETIC_CANARY_USERNAME,
      syntheticCredentialParameterName: SYNTHETIC_CANARY_CREDENTIAL_PARAM,
    });

    // Surface the canary names and the artifacts bucket so the deploy gate (G2) and local
    // inspection (the CloudWatch Application Signals MCP) can find them.
    new CfnOutput(this, "ReadonlyCanaryName", {
      value: this.observability.readonlyCanary.canaryName,
      description:
        "Name of the 5-minute read-only availability/latency Synthetics canary (public leaderboard + health liveness).",
      exportName: "MazeGamePlatform-ReadonlyCanaryName",
    });

    new CfnOutput(this, "FullFlowCanaryName", {
      value: this.observability.fullFlowCanary.canaryName,
      description:
        "Name of the 30-minute full-flow Synthetics canary (sign in → submit → read back → leaderboard → self-clean).",
      exportName: "MazeGamePlatform-FullFlowCanaryName",
    });

    // Real-time transport (Phase 2b, task 15.1, R9.1): the AppSync Events API + shared-
    // session channel namespace. Clients connect/subscribe with the SAME shared Cognito
    // pool the HTTP API uses (one identity across both edges, R11); the server publishes
    // authoritatively via IAM. The `SessionChannel` adapter (15.2) and the publishing
    // Session Lambda (16) are separate — this only provisions the serverless transport.
    this.realtime = new RealtimeChannel(this, "Realtime", {
      userPool: this.identity.userPool,
    });

    // Surface the realtime endpoints so the client SDK (subscribe over WebSocket) and the
    // server publisher (publish over HTTP) can be configured against the shared API.
    new CfnOutput(this, "RealtimeHttpDns", {
      value: this.realtime.httpDns,
      description:
        "AppSync Events HTTP endpoint hostname for the shared backend. The server publishes authoritative session updates here.",
      exportName: "MazeGamePlatform-RealtimeHttpDns",
    });

    new CfnOutput(this, "RealtimeDns", {
      value: this.realtime.realtimeDns,
      description:
        "AppSync Events real-time (WebSocket) endpoint hostname for the shared backend. Clients subscribe to session channels here.",
      exportName: "MazeGamePlatform-RealtimeDns",
    });

    // The server-authoritative Session service (Phase 2b, task 16.4): the Lambda that
    // creates a session with a server-owned maze, enforces capacity/ended on join, resolves
    // moves against authoritative state via the shared core, and publishes authoritative
    // diffs to the session channel. It reads/writes the shared table (session-state item)
    // and is granted publish on the realtime API as the IAM server principal (R9.2). The
    // pure logic and adapters live in `src/server`; this only wires the runtime and its
    // least-privilege grants.
    this.sessionApi = new SessionApi(this, "SessionApi", {
      table: this.dataStore.table,
      realtime: this.realtime,
    });

    // Surface the Session Lambda name so the realtime channel handler wiring (task 17.3
    // integration) and local inspection can find it.
    new CfnOutput(this, "SessionHandlerName", {
      value: this.sessionApi.handler.functionName,
      description:
        "Name of the server-authoritative Session Lambda (join, resolve moves, publish updates).",
      exportName: "MazeGamePlatform-SessionHandlerName",
    });
  }
}
