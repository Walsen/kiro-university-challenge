/**
 * Per-environment configuration for the Maze Game Platform CDK app.
 *
 * The platform runs as two isolated environments — `dev` and `prod` — per the baseline
 * stack in `docs/aws-decisions.md` (D6). Each environment gets its own CloudFormation
 * stack (`MazeGamePlatform-<env>`) and its own GitHub Actions deploy role, so a dev
 * deployment can never touch prod.
 */

/** The environments the platform is deployed to. */
export const ENVIRONMENT_NAMES = ["dev", "prod"] as const;

export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/**
 * The GitHub repository (in `owner/name` form) whose Actions workflows are trusted to
 * assume the deploy roles. The OIDC trust policy is scoped to this repository so that no
 * other repository's workflow can assume a role in this account.
 */
export const GITHUB_REPO = "Walsen/kiro-university-challenge";

/**
 * GitHub's public OIDC identity provider URL. Tokens minted by GitHub Actions are issued
 * by this provider; the IAM OIDC provider is registered against it.
 */
export const GITHUB_OIDC_PROVIDER_URL = "https://token.actions.githubusercontent.com";

/**
 * The audience (`aud`) claim GitHub tokens carry when using the official
 * `aws-actions/configure-aws-credentials` action with `sts.amazonaws.com`.
 */
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";

export interface EnvironmentConfig {
  /** Logical environment name, used in stack IDs and role names. */
  readonly name: EnvironmentName;
  /** The CloudFormation stack name for this environment. */
  readonly stackName: string;
  /**
   * The OIDC `sub` claims (GitHub refs) allowed to assume this environment's deploy role.
   * Keeping this per-environment is what makes the trust policy least-privilege: only
   * `main` may deploy to prod, while dev also accepts pull-request workflows for pre-merge
   * integration. Every value is fully qualified with the repository — never a bare
   * wildcard.
   */
  readonly allowedSubjects: readonly string[];
  /**
   * The Git branch this environment's Amplify Hosting frontend maps to. The settled design
   * (D7, "Deployment Gates & Environments") pins `main` to prod and hosts staging on a
   * long-lived branch, so dev is served from `staging` and prod from `main`.
   */
  readonly hostingBranch: string;
}

const CONFIGS: Readonly<Record<EnvironmentName, EnvironmentConfig>> = {
  dev: {
    name: "dev",
    stackName: "MazeGamePlatform-dev",
    // Dev accepts pushes to main and any pull request, so the deploy-first integration
    // pipeline can exercise the dev stack before a change is merged.
    allowedSubjects: [
      `repo:${GITHUB_REPO}:ref:refs/heads/main`,
      `repo:${GITHUB_REPO}:pull_request`,
    ],
    // Dev is served from the long-lived staging branch (design D7).
    hostingBranch: "staging",
  },
  prod: {
    name: "prod",
    stackName: "MazeGamePlatform-prod",
    // Prod is only ever deployed from the main branch, gated by the pipeline.
    allowedSubjects: [`repo:${GITHUB_REPO}:ref:refs/heads/main`],
    // Prod is served from main (design D7: `main` = prod).
    hostingBranch: "main",
  },
};

/** Returns the configuration for a known environment. */
export function configFor(name: EnvironmentName): EnvironmentConfig {
  return CONFIGS[name];
}

/** Type guard: is `value` one of the known environment names? */
export function isEnvironmentName(value: string): value is EnvironmentName {
  return (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}
