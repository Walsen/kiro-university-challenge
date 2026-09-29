import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_ROLE_NAME,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_REPO,
  STACK_NAME,
} from "../config.js";
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

/** Reads the deploy role's trust-policy first statement from a synthesized template. */
function deployTrustStatement(template: Template): {
  Action: string;
  Condition: {
    StringEquals: Record<string, string>;
    StringLike: Record<string, string[]>;
  };
} {
  const roles = template.findResources("AWS::IAM::Role");
  // Select the deploy role specifically (by its RoleName), not the Amplify service role.
  const deployRole = Object.values(roles).find(
    (r) => (r.Properties as { RoleName?: string }).RoleName === DEPLOY_ROLE_NAME,
  );
  const properties = deployRole?.Properties as
    | { AssumeRolePolicyDocument?: unknown }
    | undefined;
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

describe("deploy role — one role for the shared backend", () => {
  it("creates exactly one deploy role", () => {
    const template = platformTemplate();
    const deployRoles = Object.values(
      template.findResources("AWS::IAM::Role"),
    ).filter((r) => (r.Properties as { RoleName?: string }).RoleName === DEPLOY_ROLE_NAME);
    expect(deployRoles).toHaveLength(1);
  });

  it("names the single role predictably (unsuffixed) so the workflow can reference it", () => {
    platformTemplate().hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({ RoleName: "maze-game-platform-gha-deploy" }),
    );
  });
});

describe("deploy role — trust policy (who may assume it)", () => {
  it("uses web-identity federation with GitHub's OIDC audience — no long-lived keys", () => {
    const statement = deployTrustStatement(platformTemplate());

    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(
      statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"],
    ).toBe(GITHUB_OIDC_AUDIENCE);
  });

  it("trusts this repo's main + staging branches and pull requests — both env branches deploy the shared backend", () => {
    const statement = deployTrustStatement(platformTemplate());
    const subs =
      statement.Condition.StringLike["token.actions.githubusercontent.com:sub"]!;

    // Every allowed subject is fully qualified with the repository — never a bare wildcard.
    for (const sub of subs) {
      expect(sub.startsWith(`repo:${GITHUB_REPO}:`)).toBe(true);
    }
    expect(subs).toContain(`repo:${GITHUB_REPO}:ref:refs/heads/main`);
    expect(subs).toContain(`repo:${GITHUB_REPO}:ref:refs/heads/staging`);
    expect(subs).toContain(`repo:${GITHUB_REPO}:pull_request`);
  });
});

describe("deploy role — permissions (what it may do)", () => {
  it("grants only sts:AssumeRole on the CDK bootstrap roles — no wildcard admin", () => {
    const template = platformTemplate();
    const policies = template.findResources("AWS::IAM::Policy");
    // Scope to the DEPLOY ROLE's own policy. The stack also holds the service
    // Lambdas' execution-role policies (DynamoDB grants, log writes); this test
    // is about the deploy role's least privilege, so select its policy by the
    // `GitHubDeployRole` construct path in the logical id — not every policy in
    // the stack.
    const deployPolicies = Object.entries(policies).filter(([logicalId]) =>
      logicalId.includes("GitHubDeployRole"),
    );
    expect(deployPolicies, "exactly one deploy-role policy").toHaveLength(1);
    const statements = deployPolicies.flatMap(([, p]) => {
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

  it("never grants a wildcard action or wildcard resource on the deploy role", () => {
    // Scope to the deploy role's own policy. Other execution-role policies in the stack
    // legitimately carry an X-Ray statement with `Resource: "*"` (the X-Ray write actions
    // do not support resource-level scoping); this test is about the deploy identity.
    const policies = platformTemplate().findResources("AWS::IAM::Policy");
    const deployPolicies = Object.entries(policies).filter(([logicalId]) =>
      logicalId.includes("GitHubDeployRole"),
    );
    expect(deployPolicies, "exactly one deploy-role policy").toHaveLength(1);
    for (const [, policy] of deployPolicies) {
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
});
