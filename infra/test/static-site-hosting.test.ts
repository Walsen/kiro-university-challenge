import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { STACK_NAME } from "../config.js";
import { OidcProviderStack } from "../oidc-provider-stack.js";
import { PlatformStack } from "../platform-stack.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

/** Synthesizes the single shared backend stack (with a shared OIDC provider). */
function platformTemplate(): Template {
  const app = new App();
  const oidc = new OidcProviderStack(app, "Oidc", { env: TEST_ENV });
  const stack = new PlatformStack(app, STACK_NAME, {
    env: TEST_ENV,
    oidcProvider: oidc.provider,
  });
  return Template.fromStack(stack);
}

describe("static hosting — one Amplify Hosting app (R12, D7)", () => {
  it("creates exactly one Amplify app for the SPA (branch = environment, one app)", () => {
    platformTemplate().resourceCountIs("AWS::Amplify::App", 1);
  });

  it("names the single app maze-game-platform (no environment suffix)", () => {
    platformTemplate().hasResourceProperties(
      "AWS::Amplify::App",
      Match.objectLike({ Name: "maze-game-platform" }),
    );
  });

  it("hosts a WEB (SPA) platform app", () => {
    platformTemplate().hasResourceProperties(
      "AWS::Amplify::App",
      Match.objectLike({ Platform: "WEB" }),
    );
  });

  it("rewrites SPA client-side routes: 404 falls back to index.html with a 200", () => {
    // Amplify's SPA redirect is a 200-rewrite of any unmatched deep link to the entry
    // document, so the app boots and its client-side router owns the path.
    platformTemplate().hasResourceProperties(
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
    // environment; the app must synth and deploy without one so G0 can serve a placeholder
    // from a manually/asset-deployed build. Auto-build-on-push is a follow-up.
    const template = platformTemplate();
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

describe("static hosting — two Amplify branch environments (R12, D7)", () => {
  it("creates exactly two branches (one per environment) on the single app", () => {
    platformTemplate().resourceCountIs("AWS::Amplify::Branch", 2);
  });

  it("maps main to prod and staging to staging, both on the one app", () => {
    const template = platformTemplate();
    const branchNames = Object.values(
      template.findResources("AWS::Amplify::Branch") as Record<
        string,
        { Properties: { BranchName?: string } }
      >,
    )
      .map((b) => b.Properties.BranchName)
      .sort();
    expect(branchNames).toEqual(["main", "staging"]);
  });

  it("does not auto-build the branches (no connected repo to build from yet)", () => {
    const template = platformTemplate();
    const branches = Object.values(
      template.findResources("AWS::Amplify::Branch") as Record<
        string,
        { Properties: { EnableAutoBuild?: boolean } }
      >,
    );
    for (const branch of branches) {
      expect(branch.Properties.EnableAutoBuild).toBe(false);
    }
  });
});

describe("static hosting — Amplify service role (R11 least privilege)", () => {
  it("gives the app a service role assumable only by the Amplify service", () => {
    const template = platformTemplate();
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
    const template = platformTemplate();
    const apps = template.findResources("AWS::Amplify::App") as Record<
      string,
      { Properties: Record<string, unknown> }
    >;
    const props = Object.values(apps)[0]!.Properties;
    expect(props.IAMServiceRole).toBeDefined();
  });
});

describe("static hosting — the retired CloudFront/S3 path is gone", () => {
  it("provisions no CloudFront distribution", () => {
    platformTemplate().resourceCountIs("AWS::CloudFront::Distribution", 0);
  });

  it("provisions no Origin Access Control", () => {
    platformTemplate().resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);
  });

  it("provisions no S3 site bucket (no website-hosting or CloudFront-origin bucket)", () => {
    // The retired path served the SPA from an S3 *website/origin* bucket behind CloudFront.
    // Assert none of that remains — without forbidding unrelated buckets the backend
    // legitimately owns (e.g. the Synthetics canary artifacts bucket, task 9.2), which are
    // not site buckets. A retired site bucket would carry a WebsiteConfiguration and/or a
    // bucket policy granting CloudFront (an OAC/OAI principal) read; none should exist.
    const template = platformTemplate();
    const buckets = template.findResources("AWS::S3::Bucket") as Record<
      string,
      { Properties: Record<string, unknown> }
    >;
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties["WebsiteConfiguration"]).toBeUndefined();
    }
    const policies = template.findResources("AWS::S3::BucketPolicy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;
    const policyJson = JSON.stringify(Object.values(policies));
    expect(policyJson).not.toContain("cloudfront.amazonaws.com");
  });
});

describe("static hosting — per-environment site URL outputs (R12)", () => {
  it("outputs an Amplify branch domain URL for both prod and staging", () => {
    const template = platformTemplate();
    const outputs = template.findOutputs("*") as Record<
      string,
      { Value: unknown; Export?: { Name?: string } }
    >;

    for (const environment of ["prod", "staging"]) {
      const entry = Object.entries(outputs).find(([key]) =>
        key.startsWith(`SiteUrl${environment}`),
      );
      expect(entry, `site URL output for ${environment}`).toBeDefined();
      // The URL is an https:// address built from the branch's default Amplify domain.
      expect(JSON.stringify(entry?.[1].Value)).toContain("https://");
      expect(JSON.stringify(entry?.[1].Value)).toContain("amplifyapp.com");
      expect(entry?.[1].Export?.Name).toBe(`MazeGamePlatform-SiteUrl-${environment}`);
    }
  });
});
