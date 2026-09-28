import { Fn } from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";

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
  /** The environment (dev or prod) this site is hosted for. */
  readonly environment: EnvironmentConfig;
}

/**
 * Static hosting for the React SPA (task 1.5, R12): **AWS Amplify Hosting** with
 * branch-based environments, replacing the earlier S3 + CloudFront path (task 1.3).
 *
 * The settled design's baseline stack (D7, "Deployment Gates & Environments") hosts the
 * frontend on Amplify Hosting and maps environments to Git branches — `main` = prod, a
 * long-lived `staging` branch = dev. This construct provisions the Amplify **app** and the
 * one **branch** this environment maps to (see {@link EnvironmentConfig.hostingBranch}).
 *
 * **Deploys without a live repository connection.** Amplify's Git-branch CI (auto-build on
 * push) needs a connected repository and an access token, and neither is available in this
 * environment. Deliberately, the app is created with **no** `repository`/`accessToken`, so
 * `cdk deploy` succeeds and the branch can host a **manually or asset-deployed** placeholder
 * build — which is exactly what task 1.4's G0 gate needs. Connecting the GitHub repository
 * and enabling auto-build on push is a clearly-scoped follow-up (see the comment on the
 * branch below); it is intentionally not wired here because it cannot be done without the
 * repo connection.
 *
 * **SPA routing.** A single 200-rewrite maps any unmatched deep link to `index.html`, the
 * Amplify equivalent of the CloudFront 403/404 fallback the previous construct used.
 *
 * **Least privilege (R11).** The app is given a dedicated service role assumable only by the
 * Amplify service principal, with no attached policies — hosting a static build needs none.
 * Permissions are added only if a later capability requires them, so there is no broad grant
 * to walk back.
 *
 * The branch's default Amplify domain is surfaced by {@link PlatformStack} as the `SiteUrl`
 * stack output so the deploy pipeline (and task 1.4's smoke check) can find where the site
 * is served.
 */
export class StaticSiteHosting extends Construct {
  /** The Amplify Hosting app that serves the SPA. */
  public readonly app: amplify.CfnApp;

  /** The Amplify branch (mapped to this environment) that hosts the deployed build. */
  public readonly branch: amplify.CfnBranch;

  /** The service role the Amplify app assumes; least privilege (no attached policies). */
  public readonly serviceRole: iam.Role;

  public constructor(scope: Construct, id: string, props: StaticSiteHostingProps) {
    super(scope, id);

    // A dedicated service role, assumable only by the Amplify service. Hosting a static
    // build requires no permissions, so no policies are attached — additions come only when
    // a concrete capability needs them (least privilege, R11).
    this.serviceRole = new iam.Role(this, "ServiceRole", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: `Amplify Hosting service role for the Maze Game Platform SPA (${props.environment.name}).`,
    });

    this.app = new amplify.CfnApp(this, "App", {
      name: `maze-game-platform-${props.environment.name}`,
      description: `Maze Game Platform SPA (${props.environment.name})`,
      // WEB is Amplify's platform for single-page / static web apps.
      platform: "WEB",
      iamServiceRole: this.serviceRole.roleArn,
      // Deliberately no `repository`/`accessToken`/`oauthToken`: the repo connection and
      // token are unavailable here, and omitting them lets `cdk deploy` succeed and the
      // branch host a manually/asset-deployed placeholder (task 1.4 / G0). Connecting the
      // repository is a follow-up.
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

    this.branch = new amplify.CfnBranch(this, "Branch", {
      appId: this.app.attrAppId,
      branchName: props.environment.hostingBranch,
      description: `Maze Game Platform ${props.environment.name} branch environment.`,
      // No connected repository yet, so there is nothing to auto-build on push. The branch
      // hosts a manually/asset-deployed build until the GitHub repo connection is added as a
      // follow-up, at which point auto-build on push can be enabled here.
      enableAutoBuild: false,
    });
  }

  /**
   * The public HTTPS URL at which the SPA is served: the branch's default Amplify domain,
   * `https://<branchName>.<appId>.amplifyapp.com`. Built with CloudFormation intrinsics
   * because the app id is only known at deploy time.
   */
  public get url(): string {
    return Fn.join("", [
      "https://",
      this.branch.branchName,
      ".",
      this.app.attrAppId,
      ".amplifyapp.com",
    ]);
  }
}
