import { Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  type EnvironmentConfig,
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
  /** The environment this deploy role serves (dev or prod). */
  readonly environment: EnvironmentConfig;
  /**
   * The IAM OIDC provider for GitHub Actions. GitHub's OIDC provider is a single
   * account-level resource shared by every environment's role, so it is created once and
   * passed in rather than created per role.
   */
  readonly provider: iam.IOpenIdConnectProvider;
  /** Overridable CDK bootstrap qualifier; defaults to the standard `hnb659fds`. */
  readonly bootstrapQualifier?: string;
}

/**
 * A least-privilege IAM role that GitHub Actions assumes, via OIDC, to run `cdk deploy`
 * for one environment.
 *
 * Least privilege has two dimensions here:
 *
 *  - **Who may assume it** — the trust policy accepts only tokens from GitHub's OIDC
 *    provider, carrying the `sts.amazonaws.com` audience, and whose `sub` claim matches one
 *    of this environment's allowed refs (e.g. only `main` for prod). No long-lived keys and
 *    no other repository can assume it.
 *  - **What it may do** — the role holds no service permissions of its own. It may only
 *    assume the CDK bootstrap roles, which are themselves scoped by the bootstrap template.
 *    All real infrastructure changes flow through those roles, so the deploy identity is a
 *    narrow, auditable entry point rather than a standing administrator.
 */
export class GitHubOidcDeployRole extends iam.Role {
  public constructor(scope: Construct, id: string, props: GitHubOidcDeployRoleProps) {
    const { environment, provider } = props;
    const qualifier = props.bootstrapQualifier ?? DEFAULT_CDK_BOOTSTRAP_QUALIFIER;

    super(scope, id, {
      roleName: `maze-game-platform-gha-deploy-${environment.name}`,
      description: `GitHub Actions OIDC deploy role for the ${environment.name} environment (cdk deploy only).`,
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          [`${OIDC_CLAIM_PREFIX}:aud`]: GITHUB_OIDC_AUDIENCE,
        },
        // `sub` is matched with StringLike so a `pull_request` entry (which GitHub emits
        // without a trailing ref segment) and exact branch refs both work; each allowed
        // value is still fully qualified with the repository, so this is not a wildcard
        // on the repo.
        StringLike: {
          [`${OIDC_CLAIM_PREFIX}:sub`]: [...environment.allowedSubjects],
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
