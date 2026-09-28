import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_REPO,
  configFor,
} from "../config.js";
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

/** Reads the single IAM role's trust-policy first statement from a synthesized template. */
function trustStatement(template: Template): {
  Action: string;
  Condition: {
    StringEquals: Record<string, string>;
    StringLike: Record<string, string[]>;
  };
} {
  const roles = template.findResources("AWS::IAM::Role");
  const properties = Object.values(roles)[0]?.Properties as
    { AssumeRolePolicyDocument?: unknown } | undefined;
  const doc = properties?.AssumeRolePolicyDocument as {
    Statement: Array<{
      Action: string;
      Condition: {
        StringEquals: Record<string, string>;
        StringLike: Record<string, string[]>;
      };
    }>;
  };
  return doc.Statement[0]!;
}

describe("GitHub OIDC identity provider", () => {
  it("imports the existing account-level provider instead of creating one", () => {
    const app = new App();
    const oidc = new OidcProviderStack(app, "Oidc", { env: TEST_ENV });
    const template = Template.fromStack(oidc);

    // The provider is a per-account singleton that already exists in the target account,
    // so the stack references it by ARN rather than synthesizing a new one.
    template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
  });

  it("exposes the imported provider's ARN as a stack output", () => {
    const app = new App();
    const oidc = new OidcProviderStack(app, "Oidc", { env: TEST_ENV });
    const template = Template.fromStack(oidc);

    // The ARN is built from the account/partition tokens at synth, so the output value is
    // an Fn::Join intrinsic rather than a literal. Assert the issuer host appears as a
    // literal fragment — not by string equality, which the tokens would defeat.
    const host = GITHUB_OIDC_PROVIDER_URL.replace(/^https:\/\//, "");
    const outputs = template.findOutputs("GitHubOidcProviderArn");
    const output = Object.values(outputs)[0]!;
    expect(output.Export).toEqual({ Name: "MazeGamePlatform-GitHubOidcProviderArn" });
    expect(JSON.stringify(output.Value)).toContain(`:oidc-provider/${host}`);
  });
});

describe("deploy role — trust policy (who may assume it)", () => {
  it("uses web-identity federation with GitHub's OIDC audience — no long-lived keys", () => {
    const statement = trustStatement(templateFor("dev"));

    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(
      statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"],
    ).toBe(GITHUB_OIDC_AUDIENCE);
  });

  it("dev role trusts this repo's main branch and pull requests only", () => {
    const statement = trustStatement(templateFor("dev"));
    const subs =
      statement.Condition.StringLike["token.actions.githubusercontent.com:sub"]!;

    // Every allowed subject is fully qualified with the repository — never a bare wildcard.
    for (const sub of subs) {
      expect(sub.startsWith(`repo:${GITHUB_REPO}:`)).toBe(true);
    }
    expect(subs).toContain(`repo:${GITHUB_REPO}:ref:refs/heads/main`);
    expect(subs).toContain(`repo:${GITHUB_REPO}:pull_request`);
  });

  it("prod role trusts only the main branch (no pull requests, no other repo)", () => {
    const statement = trustStatement(templateFor("prod"));
    const subs =
      statement.Condition.StringLike["token.actions.githubusercontent.com:sub"];

    expect(subs).toEqual([`repo:${GITHUB_REPO}:ref:refs/heads/main`]);
  });
});

describe("deploy role — permissions (what it may do)", () => {
  it("grants only sts:AssumeRole on the CDK bootstrap roles — no wildcard admin", () => {
    const template = templateFor("dev");
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap((p) => {
      const properties = p.Properties as { PolicyDocument?: unknown } | undefined;
      return (properties?.PolicyDocument as { Statement: Array<Record<string, unknown>> })
        .Statement;
    });

    // Exactly one permission statement, and it is the scoped bootstrap-role assume.
    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    expect(statement.Action).toBe("sts:AssumeRole");
    expect(statement.Effect).toBe("Allow");

    // The account/region are unresolved tokens at synth, so each bootstrap-role ARN is a
    // Fn::Join intrinsic. Assert the four bootstrap purposes appear as literal fragments in
    // the rendered resources — not by string equality, which tokens would defeat.
    const rendered = JSON.stringify(statement.Resource);
    for (const purpose of [
      "deploy-role",
      "file-publishing-role",
      "image-publishing-role",
      "lookup-role",
    ]) {
      expect(rendered).toContain(`:role/cdk-hnb659fds-${purpose}-`);
    }
    expect((statement.Resource as unknown[]).length).toBe(4);
  });

  it("never grants a wildcard action or wildcard resource", () => {
    const policies = templateFor("dev").findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const properties = policy.Properties as { PolicyDocument?: unknown } | undefined;
      const statements = (
        properties?.PolicyDocument as { Statement: Array<Record<string, unknown>> }
      ).Statement;
      for (const s of statements) {
        expect(s.Action).not.toBe("*");
        expect(s.Resource).not.toBe("*");
      }
    }
  });

  it("names the role predictably per environment so the workflow can reference it", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({ RoleName: "maze-game-platform-gha-deploy-dev" }),
    );
    templateFor("prod").hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({ RoleName: "maze-game-platform-gha-deploy-prod" }),
    );
  });
});
