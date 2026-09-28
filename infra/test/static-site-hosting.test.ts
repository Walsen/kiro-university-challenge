import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { configFor } from "../config.js";
import { OidcProviderStack } from "../oidc-provider-stack.js";
import { PlatformStack } from "../platform-stack.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

/** Synthesizes a single environment's platform stack (with a shared OIDC provider). */
function templateFor(name: "dev" | "prod"): Template {
  const app = new App();
  const oidc = new OidcProviderStack(app, "Oidc", { env: TEST_ENV });
  const stack = new PlatformStack(app, configFor(name).stackName, {
    env: TEST_ENV,
    environment: configFor(name),
    oidcProvider: oidc.provider,
  });
  return Template.fromStack(stack);
}

describe("static hosting — Amplify Hosting app (R12)", () => {
  it("creates exactly one Amplify app for the SPA", () => {
    templateFor("dev").resourceCountIs("AWS::Amplify::App", 1);
  });

  it("hosts a WEB (SPA) platform app", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::Amplify::App",
      Match.objectLike({ Platform: "WEB" }),
    );
  });

  it("rewrites SPA client-side routes: 404 falls back to index.html with a 200", () => {
    // Amplify's SPA redirect is a 200-rewrite of any unmatched deep link to the entry
    // document, so the app boots and its client-side router owns the path.
    templateFor("dev").hasResourceProperties(
      "AWS::Amplify::App",
      Match.objectLike({
        CustomRules: Match.arrayWith([
          Match.objectLike({
            Target: "/index.html",
            Status: "200",
          }),
        ]),
      }),
    );
  });

  it("does not wire a live repository connection or an access token into the app", () => {
    // Amplify's Git-branch CI needs a connected repo + token that is not available in this
    // environment; the app must synth and deploy without one so G0 (task 1.4) can serve a
    // placeholder from a manually/asset-deployed build. Auto-build-on-push is a follow-up.
    const template = templateFor("dev");
    const apps = template.findResources("AWS::Amplify::App") as Record<
      string,
      { Properties: Record<string, unknown> }
    >;
    const props = Object.values(apps)[0]!.Properties;
    expect(props.Repository).toBeUndefined();
    expect(props.AccessToken).toBeUndefined();
    expect(props.OauthToken).toBeUndefined();
  });
});

describe("static hosting — Amplify branch environments (R12, D7)", () => {
  it("creates exactly one branch for the environment", () => {
    templateFor("dev").resourceCountIs("AWS::Amplify::Branch", 1);
  });

  it("maps dev to the staging branch and prod to the main branch", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::Amplify::Branch",
      Match.objectLike({ BranchName: "staging" }),
    );
    templateFor("prod").hasResourceProperties(
      "AWS::Amplify::Branch",
      Match.objectLike({ BranchName: "main" }),
    );
  });

  it("does not auto-build the branch (no connected repo to build from yet)", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::Amplify::Branch",
      Match.objectLike({ EnableAutoBuild: false }),
    );
  });
});

describe("static hosting — Amplify service role (R11 least privilege)", () => {
  it("gives the app a service role assumable only by the Amplify service", () => {
    const template = templateFor("dev");
    template.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "sts:AssumeRole",
              Principal: Match.objectLike({ Service: "amplify.amazonaws.com" }),
            }),
          ]),
        }),
      }),
    );
  });

  it("wires that role onto the Amplify app via IAMServiceRole", () => {
    const template = templateFor("dev");
    const apps = template.findResources("AWS::Amplify::App") as Record<
      string,
      { Properties: Record<string, unknown> }
    >;
    const props = Object.values(apps)[0]!.Properties;
    expect(props.IAMServiceRole).toBeDefined();
  });
});

describe("static hosting — the retired CloudFront/S3 path is gone (task 1.5)", () => {
  it("provisions no CloudFront distribution", () => {
    templateFor("dev").resourceCountIs("AWS::CloudFront::Distribution", 0);
  });

  it("provisions no Origin Access Control", () => {
    templateFor("dev").resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);
  });

  it("provisions no S3 site bucket", () => {
    templateFor("dev").resourceCountIs("AWS::S3::Bucket", 0);
  });
});

describe("static hosting — site URL output (R12)", () => {
  it("outputs the Amplify branch default domain URL for each environment", () => {
    for (const name of ["dev", "prod"] as const) {
      const template = templateFor(name);
      const outputs = template.findOutputs("*") as Record<
        string,
        { Value: unknown; Description?: string }
      >;
      const siteUrl = Object.entries(outputs).find(([key]) => key.startsWith("SiteUrl"));
      expect(siteUrl, `site URL output for ${name}`).toBeDefined();
      // The URL is an https:// address built from the branch's default Amplify domain.
      expect(JSON.stringify(siteUrl?.[1].Value)).toContain("https://");
      expect(JSON.stringify(siteUrl?.[1].Value)).toContain("amplifyapp.com");
    }
  });
});
