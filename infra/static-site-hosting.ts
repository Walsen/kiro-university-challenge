import { Fn } from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { BRANCH_ENVIRONMENTS, type BranchEnvironment } from "./config.js";

/**
 * The one Amplify app's name. Environment-agnostic (no `-dev`/`-prod` suffix) because the
 * environment is identified by the Git branch inside this single app, not the app name (D7).
 */
const AMPLIFY_APP_NAME = "maze-game-platform";

/**
 * The document a single-page app falls back to so client-side routing owns the path. A
 * request for a deep link matches no built asset; Amplify rewrites it to this document with
 * a 200 so the app boots and its router resolves the route.
 */
const SPA_ENTRY_DOCUMENT = "/index.html";

/**
 * Amplify's SPA rewrite source: any path that is not a file with a known web extension is
 * an application route, not an asset, and is rewritten to the entry document. This is the
 * pattern Amplify documents for single-page apps.
 */
const SPA_REWRITE_SOURCE =
  "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>";

export interface StaticSiteHostingProps {
  /**
   * The branch → environment mapping this app hosts. Defaults to {@link BRANCH_ENVIRONMENTS}
   * (`main` = prod, `staging` = staging); injectable so tests can vary it.
   */
  readonly branchEnvironments?: readonly BranchEnvironment[];
}

/**
 * Static hosting for the React SPA (R12): **one AWS Amplify Hosting app** with **two
 * branch-based environments**, per the settled design (D7).
 *
 * The environment is the **Git branch inside a single app**, not a separate app per
 * environment: `main` serves prod and `staging` serves staging, and **both branches serve
 * the same single shared backend** (D6). This construct provisions the one Amplify **app**
 * (`maze-game-platform`) and one {@link amplify.CfnBranch} per entry in the branch mapping.
 *
 * **Deploys without a live repository connection.** Amplify's Git-branch CI (auto-build on
 * push) needs a connected repository and an access token, and neither is available in this
 * environment. Deliberately, the app is created with **no** `repository`/`accessToken`, so
 * `cdk deploy` succeeds and each branch can host a **manually or asset-deployed** placeholder
 * build — which is exactly what the G0 gate needs. Connecting the GitHub repository and
 * enabling auto-build on push is a clearly-scoped follow-up (see the comment on the branches
 * below); it is intentionally not wired here because it cannot be done without the repo
 * connection.
 *
 * **SPA routing.** A single 200-rewrite maps any unmatched deep link to `index.html`, the
 * Amplify equivalent of the CloudFront 403/404 fallback the previous construct used.
 *
 * **Least privilege (R11).** The app is given a dedicated service role assumable only by the
 * Amplify service principal, with no attached policies — hosting a static build needs none.
 * Permissions are added only if a later capability requires them, so there is no broad grant
 * to walk back.
 *
 * Each branch's default Amplify domain is surfaced by {@link PlatformStack} as a per-branch
 * `SiteUrl-<environment>` stack output so the deploy pipeline (and smoke checks) can find
 * where each environment is served. Use {@link urlFor} to read a specific branch's URL.
 */
export class StaticSiteHosting extends Construct {
  /** The single Amplify Hosting app that serves the SPA for every branch environment. */
  public readonly app: amplify.CfnApp;

  /** The service role the Amplify app assumes; least privilege (no attached policies). */
  public readonly serviceRole: iam.Role;

  /** The branch → environment mapping this app hosts. */
  public readonly branchEnvironments: readonly BranchEnvironment[];

  /** The Amplify branches, keyed by environment name, for per-environment outputs. */
  private readonly branchesByEnvironment: ReadonlyMap<string, amplify.CfnBranch>;

  public constructor(scope: Construct, id: string, props?: StaticSiteHostingProps) {
    super(scope, id);

    this.branchEnvironments = props?.branchEnvironments ?? BRANCH_ENVIRONMENTS;

    // A dedicated service role, assumable only by the Amplify service. Hosting a static
    // build requires no permissions, so no policies are attached — additions come only when
    // a concrete capability needs them (least privilege, R11).
    this.serviceRole = new iam.Role(this, "ServiceRole", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: "Amplify Hosting service role for the Maze Game Platform SPA.",
    });

    this.app = new amplify.CfnApp(this, "App", {
      name: AMPLIFY_APP_NAME,
      description: "Maze Game Platform SPA (one app; branch = environment)",
      // WEB is Amplify's platform for single-page / static web apps.
      platform: "WEB",
      iamServiceRole: this.serviceRole.roleArn,
      // Deliberately no `repository`/`accessToken`/`oauthToken`: the repo connection and
      // token are unavailable here, and omitting them lets `cdk deploy` succeed and each
      // branch host a manually/asset-deployed placeholder (G0). Connecting the repository
      // is a follow-up.
      customRules: [
        // SPA client-side routing: rewrite any non-asset deep link to the entry document
        // with a 200 so the app boots and its router owns the path.
        {
          source: SPA_REWRITE_SOURCE,
          target: SPA_ENTRY_DOCUMENT,
          status: "200",
        },
      ],
    });

    // One branch per environment (D7): `main` = prod, `staging` = staging. Both point at
    // the same shared backend; the branch is what distinguishes the environment.
    const branchesByEnvironment = new Map<string, amplify.CfnBranch>();
    for (const { branchName, environment } of this.branchEnvironments) {
      const branch = new amplify.CfnBranch(this, `Branch-${environment}`, {
        appId: this.app.attrAppId,
        branchName,
        description: `Maze Game Platform ${environment} branch environment (serves the shared backend).`,
        // No connected repository yet, so there is nothing to auto-build on push. Each
        // branch hosts a manually/asset-deployed build until the GitHub repo connection is
        // added as a follow-up, at which point auto-build on push can be enabled here.
        enableAutoBuild: false,
      });
      branchesByEnvironment.set(environment, branch);
    }
    this.branchesByEnvironment = branchesByEnvironment;
  }

  /**
   * The public HTTPS URL at which the given environment's branch serves the SPA: the
   * branch's default Amplify domain, `https://<branchName>.<appId>.amplifyapp.com`. Built
   * with CloudFormation intrinsics because the app id is only known at deploy time.
   */
  public urlFor(environment: string): string {
    const branch = this.branchesByEnvironment.get(environment);
    if (branch === undefined) {
      throw new Error(`No Amplify branch is configured for environment "${environment}".`);
    }
    return Fn.join("", [
      "https://",
      branch.branchName,
      ".",
      this.app.attrAppId,
      ".amplifyapp.com",
    ]);
  }
}
