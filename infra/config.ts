/**
 * Configuration for the Maze Game Platform CDK app.
 *
 * The platform runs as a **single, shared, environment-agnostic backend** — one
 * CloudFormation stack named `MazeGamePlatform` with one Cognito user pool, one DynamoDB
 * table, one HTTP API + Lambdas, and one GitHub OIDC deploy role (see
 * `docs/aws-decisions.md` D6). The **environment is identified by the Amplify Git branch**,
 * not by the stack: one Amplify app (`maze-game-platform`) serves both `main` (prod) and
 * `staging` (staging) branches from that same shared backend (D7). There is therefore no
 * per-environment stack duplication and no `isProd` branching in the backend — the single
 * backend is always run with a prod-grade data posture.
 */

/**
 * The single backend stack name. Environment-agnostic (no `-dev`/`-prod` suffix) because
 * there is exactly one shared backend (D6).
 */
export const STACK_NAME = "MazeGamePlatform";

/**
 * The GitHub Actions OIDC deploy role name. One role, unsuffixed, trusted to deploy the
 * single backend (D6).
 */
export const DEPLOY_ROLE_NAME = "maze-game-platform-gha-deploy";

/**
 * The GitHub repository (in `owner/name` form) whose Actions workflows are trusted to
 * assume the deploy role. The OIDC trust policy is scoped to this repository so that no
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

/**
 * GitHub can be configured (org/repo setting) to include numeric actor/enterprise IDs in
 * the OIDC `sub`, making it `repo:<owner>@<ownerId>/<name>@<repoId>:ref:...` rather than
 * the plain `repo:<owner>/<name>:ref:...`. This repo has that customization enabled, so the
 * trust subjects must tolerate the `@<id>` segments. The owner and repo NAMES stay pinned;
 * only the numeric IDs are wildcarded (matched via StringLike), so this remains scoped to
 * exactly this repository — not a bare wildcard.
 */
const [GITHUB_REPO_OWNER, GITHUB_REPO_NAME] = GITHUB_REPO.split("/");
const GITHUB_REPO_SUBJECT = `${GITHUB_REPO_OWNER}@*/${GITHUB_REPO_NAME}@*`;

/**
 * The OIDC `sub` claims (GitHub refs) allowed to assume the single deploy role. Both
 * environment branches deploy the same shared backend, so `main` (prod) and `staging`
 * (staging) are both allowed, plus `pull_request` workflows for pre-merge integration.
 *
 * Two subject forms are allowed so the trust works whether or not GitHub's "include
 * actor/enterprise IDs in the subject" customization is enabled:
 *   - the **plain** form `repo:<owner>/<name>:...` (customization off), and
 *   - the **ID-inclusive** form `repo:<owner>@<id>/<name>@<id>:...` (customization on) —
 *     this repo's actual token format, with the numeric IDs wildcarded.
 * Only the numeric ID segments are wildcarded; the owner and repo NAMES stay pinned, so
 * every value is still fully qualified with this repository — never a bare wildcard.
 */
export const DEPLOY_ALLOWED_SUBJECTS: readonly string[] = [
  // Plain subject form (customization off)
  `repo:${GITHUB_REPO}:ref:refs/heads/main`,
  `repo:${GITHUB_REPO}:ref:refs/heads/staging`,
  `repo:${GITHUB_REPO}:pull_request`,
  // ID-inclusive subject form (customization on) — this repo's actual token format
  `repo:${GITHUB_REPO_SUBJECT}:ref:refs/heads/main`,
  `repo:${GITHUB_REPO_SUBJECT}:ref:refs/heads/staging`,
  `repo:${GITHUB_REPO_SUBJECT}:pull_request`,
];

// Note: the branch → environment mapping (`main` = prod, `staging` = staging) is now a
// property of the console-managed Amplify app (D7), not of this CDK app. The OIDC deploy
// role's trusted subjects (below) still reference the `main` and `staging` branch refs
// directly, since CI deploys the shared backend from both branches.

/**
 * The reserved synthetic account the full-flow Synthetics canary signs in as (D8). A
 * dedicated, reserved identity on the reserved `@example.com` domain so its writes to the
 * one live leaderboard are recognizable and self-cleaned each run. It must be provisioned
 * (and administratively confirmed) in the shared Cognito pool out of band before the
 * full-flow canary can pass — see `infra/canaries/README.md`. Not a secret: the password
 * lives in SSM (below), never here.
 */
export const SYNTHETIC_CANARY_USERNAME = "maze-synthetic-canary@example.com";

/**
 * The **name** of the SSM Parameter Store SecureString holding the reserved synthetic
 * account's password. The full-flow canary reads its value at runtime with
 * `ssm:GetParameter`; CDK only references the parameter by name and grants the canary role
 * read on it, so no secret material is ever in the template or the repo (R11.4). The value
 * is provisioned out of band at deploy time.
 */
export const SYNTHETIC_CANARY_CREDENTIAL_PARAM =
  "/maze-game-platform/synthetic-canary/password";
