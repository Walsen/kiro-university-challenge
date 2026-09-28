import { CfnOutput, Stack, Tags } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { ApiHttp } from "./api-http.js";
import type { EnvironmentConfig } from "./config.js";
import { DataStore } from "./data-store.js";
import { GitHubOidcDeployRole } from "./github-oidc-deploy-role.js";
import { IdentityUserPool } from "./identity-user-pool.js";
import { StaticSiteHosting } from "./static-site-hosting.js";

/** Props for {@link PlatformStack}, carrying the environment it targets. */
export interface PlatformStackProps extends StackProps {
  /** The environment (dev or prod) this stack instance represents. */
  readonly environment: EnvironmentConfig;
  /**
   * The shared, account-level GitHub OIDC provider the deploy role trusts. Created once in
   * the app (see {@link OidcProviderStack}) and injected, because an IAM OIDC provider for
   * a given issuer is unique per account.
   */
  readonly oidcProvider: iam.IOpenIdConnectProvider;
}

/**
 * The per-environment baseline stack for the Maze Game Platform (Phase 2).
 *
 * This is the deploy-first foundation (task 1.1): one real, synthesizable stack per
 * environment (`MazeGamePlatform-dev`, `MazeGamePlatform-prod`) that later tasks extend
 * in place — Amplify Hosting for the SPA (1.5, reconciled from 1.3's S3 + CloudFront),
 * Cognito (2.1), the API (2.2), and DynamoDB (6.1).
 *
 * Task 1.2 adds this environment's **GitHub Actions OIDC deploy role**: the identity the
 * CI pipeline assumes (via a short-lived OIDC token, no long-lived keys) to run
 * `cdk deploy <env>`.
 *
 * Least privilege from the start (R11): the deploy role holds no standing service
 * permissions of its own — it may only assume the CDK bootstrap roles — and every
 * construct added later must grant only the IAM it needs. Starting from this posture means
 * there are no broad grants to walk back.
 */
export class PlatformStack extends Stack {
  /** The environment (dev or prod) this stack instance represents. */
  public readonly environmentConfig: EnvironmentConfig;

  /** The GitHub Actions OIDC deploy role for this environment. */
  public readonly deployRole: iam.Role;

  /** Static hosting (AWS Amplify Hosting app + branch environment) for the SPA. */
  public readonly staticSite: StaticSiteHosting;

  /** Cognito identity (user pool + SPA app client) for accounts and auth. */
  public readonly identity: IdentityUserPool;

  /** The HTTP API edge with a Cognito JWT authorizer on protected routes. */
  public readonly api: ApiHttp;

  /** The DynamoDB single table (profiles, scores, personal bests) + leaderboard GSI. */
  public readonly dataStore: DataStore;

  public constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    this.environmentConfig = props.environment;

    // Tag every resource in the stack so environments are distinguishable in the console
    // and in cost reporting, and so a change targeting the wrong environment is visible.
    Tags.of(this).add("Project", "MazeGamePlatform");
    Tags.of(this).add("Environment", props.environment.name);

    this.deployRole = new GitHubOidcDeployRole(this, "GitHubDeployRole", {
      environment: props.environment,
      provider: props.oidcProvider,
    });

    new CfnOutput(this, "DeployRoleArn", {
      value: this.deployRole.roleArn,
      description: `ARN of the GitHub Actions OIDC deploy role for ${props.environment.name}. Use as the workflow's role-to-assume.`,
      exportName: `MazeGamePlatform-DeployRoleArn-${props.environment.name}`,
    });

    // Task 1.5: static hosting for the SPA on AWS Amplify Hosting (branch environments),
    // reconciled from the earlier S3 + CloudFront path (task 1.3) to match the settled
    // design. Added to the same per-environment stack so a single `cdk deploy <env>`
    // provisions the site alongside the rest of the baseline.
    this.staticSite = new StaticSiteHosting(this, "StaticSite", {
      environment: props.environment,
    });

    // Surface where the SPA is served so the deploy pipeline and the task 1.4 smoke check
    // (and later, the client's configured API/base URL) can find the Amplify branch domain.
    new CfnOutput(this, "SiteUrl", {
      value: this.staticSite.url,
      description: `Public HTTPS URL of the ${props.environment.name} SPA (Amplify Hosting ${props.environment.hostingBranch} branch domain).`,
      exportName: `MazeGamePlatform-SiteUrl-${props.environment.name}`,
    });

    // Task 2.1: Cognito identity for accounts, sign-in, and recovery. Added to the same
    // per-environment stack so a single `cdk deploy <env>` provisions it alongside the
    // rest of the baseline. The API's JWT authorizer (task 2.2) will validate tokens
    // against this pool.
    this.identity = new IdentityUserPool(this, "Identity", {
      environment: props.environment,
    });

    // Surface the pool and client identifiers so the SPA build and the API's JWT
    // authorizer can be configured to target this environment's pool.
    new CfnOutput(this, "UserPoolId", {
      value: this.identity.userPool.userPoolId,
      description: `Cognito user pool ID for ${props.environment.name}. Configure the SPA and the API JWT authorizer against it.`,
      exportName: `MazeGamePlatform-UserPoolId-${props.environment.name}`,
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: this.identity.userPoolClient.userPoolClientId,
      description: `Cognito SPA app client ID for ${props.environment.name}. The SPA authenticates through this public client.`,
      exportName: `MazeGamePlatform-UserPoolClientId-${props.environment.name}`,
    });

    // Task 2.2: the HTTP API edge with a Cognito JWT authorizer. Added to the same
    // per-environment stack, and wired to this environment's user pool + app client so the
    // authorizer validates tokens issued by them (R2, R4.3, R5.3, R11).
    this.api = new ApiHttp(this, "Api", {
      environment: props.environment,
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
    });

    // Surface the API base URL so the SPA build (and the seam tests) can target this
    // environment's API.
    new CfnOutput(this, "ApiUrl", {
      value: this.api.url,
      description: `Base HTTPS URL of the ${props.environment.name} HTTP API. The SPA sends bearer-JWT requests here.`,
      exportName: `MazeGamePlatform-ApiUrl-${props.environment.name}`,
    });

    // Task 6.1: the DynamoDB single table + leaderboard GSI. Added to the same
    // per-environment stack so a single `cdk deploy <env>` provisions it alongside the
    // rest of the baseline. The score/leaderboard Lambdas (tasks 6.3/6.4, 7) reach it via
    // the repository adapters and are granted only the IAM they need.
    this.dataStore = new DataStore(this, "DataStore", {
      environment: props.environment,
    });

    // Surface the table name so the score/leaderboard services can be configured to target
    // this environment's table (and the seam tests can address it).
    new CfnOutput(this, "TableName", {
      value: this.dataStore.tableName,
      description: `DynamoDB single-table name for ${props.environment.name}. Configure the score and leaderboard services against it.`,
      exportName: `MazeGamePlatform-TableName-${props.environment.name}`,
    });
  }
}
