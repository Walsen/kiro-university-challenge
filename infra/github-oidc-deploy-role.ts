import { Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import {
  DEPLOY_ALLOWED_SUBJECTS,
  DEPLOY_ROLE_NAME,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
} from "./config.js";

/**
 * The CDK bootstrap qualifier. CDK's bootstrap stack provisions a fixed set of IAM roles
 * named `cdk-<qualifier>-<purpose>-<account>-<region>`; the default qualifier is
 * `hnb659fds`. A deploy role only needs to *assume* those bootstrap roles — it never needs
 * standing administrative permissions of its own.
 */
const DEFAULT_CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";

/** The bootstrap role purposes a `cdk deploy` needs to assume. */
const CDK_BOOTSTRAP_ROLE_PURPOSES = [
  "deploy-role",
  "file-publishing-role",
  "image-publishing-role",
  "lookup-role",
] as const;

/**
 * The condition-key prefix for GitHub's OIDC provider. IAM condition keys on an OIDC
 * principal are prefixed with the provider host, so `aud`/`sub` claims are addressed as
 * `token.actions.githubusercontent.com:aud` etc.
 */
const OIDC_CLAIM_PREFIX = GITHUB_OIDC_PROVIDER_URL.replace(/^https:\/\//, "");

export interface GitHubOidcDeployRoleProps {
  /**
   * The IAM OIDC provider for GitHub Actions. GitHub's OIDC provider is a single
   * account-level resource, so it is created once and passed in rather than created here.
   */
  readonly provider: iam.IOpenIdConnectProvider;
  /** Overridable CDK bootstrap qualifier; defaults to the standard `hnb659fds`. */
  readonly bootstrapQualifier?: string;
}

/**
 * The single least-privilege IAM role that GitHub Actions assumes, via OIDC, to run
 * `cdk deploy` for the one shared backend.
 *
 * There is one deploy role because there is one shared backend (D6): both the `main` (prod)
 * and `staging` (staging) branch workflows deploy the same `MazeGamePlatform` stack, so the
 * role trusts both branch refs plus `pull_request` for pre-merge integration.
 *
 * Least privilege has two dimensions here:
 *
 *  - **Who may assume it** — the trust policy accepts only tokens from GitHub's OIDC
 *    provider, carrying the `sts.amazonaws.com` audience, and whose `sub` claim matches one
 *    of the allowed refs (this repo's `main`, `staging`, or a pull request). No long-lived
 *    keys and no other repository can assume it.
 *  - **What it may do** — the role holds no service permissions of its own. It may only
 *    assume the CDK bootstrap roles, which are themselves scoped by the bootstrap template.
 *    All real infrastructure changes flow through those roles, so the deploy identity is a
 *    narrow, auditable entry point rather than a standing administrator.
 */
export class GitHubOidcDeployRole extends iam.Role {
  public constructor(scope: Construct, id: string, props: GitHubOidcDeployRoleProps) {
    const { provider } = props;
    const qualifier = props.bootstrapQualifier ?? DEFAULT_CDK_BOOTSTRAP_QUALIFIER;

    super(scope, id, {
      roleName: DEPLOY_ROLE_NAME,
      description:
        "GitHub Actions OIDC deploy role for the shared Maze Game Platform backend (cdk deploy only).",
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          [`${OIDC_CLAIM_PREFIX}:aud`]: GITHUB_OIDC_AUDIENCE,
        },
        // `sub` is matched with StringLike so a `pull_request` entry (which GitHub emits
        // without a trailing ref segment) and exact branch refs both work; each allowed
        // value is still fully qualified with the repository, so this is not a wildcard
        // on the repo.
        StringLike: {
          [`${OIDC_CLAIM_PREFIX}:sub`]: [...DEPLOY_ALLOWED_SUBJECTS],
        },
      }),
    });

    const stack = Stack.of(this);

    // Grant only the ability to assume the CDK bootstrap roles for this account/region —
    // no direct service permissions live on the deploy identity itself.
    const bootstrapRoleArns = CDK_BOOTSTRAP_ROLE_PURPOSES.map(
      (purpose) =>
        `arn:${stack.partition}:iam::${stack.account}:role/cdk-${qualifier}-${purpose}-${stack.account}-${stack.region}`,
    );

    this.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoleArns,
      }),
    );
  }
}
