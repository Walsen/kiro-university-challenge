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

describe("identity — Cognito user pool (R1, R3)", () => {
  it("creates exactly one user pool for accounts", () => {
    templateFor("dev").resourceCountIs("AWS::Cognito::UserPool", 1);
  });

  it("verifies the email identifier so sign-in is withheld until verified (R1.5)", () => {
    // Email is the sign-in identifier and Cognito auto-verifies it, satisfying the
    // requirement that an unverified identifier cannot yet sign in.
    templateFor("dev").hasResourceProperties(
      "AWS::Cognito::UserPool",
      Match.objectLike({
        AutoVerifiedAttributes: Match.arrayWith(["email"]),
        UsernameAttributes: Match.arrayWith(["email"]),
      }),
    );
  });

  it("enforces a password policy that rejects weak credentials (R1.3)", () => {
    const template = templateFor("dev");
    const pools = template.findResources("AWS::Cognito::UserPool") as Record<
      string,
      {
        Properties: {
          Policies?: {
            PasswordPolicy?: {
              MinimumLength?: number;
              RequireLowercase?: boolean;
              RequireUppercase?: boolean;
              RequireNumbers?: boolean;
              RequireSymbols?: boolean;
            };
          };
        };
      }
    >;
    const policy = Object.values(pools)[0]!.Properties.Policies?.PasswordPolicy;
    expect(policy, "password policy").toBeDefined();
    expect(policy?.MinimumLength ?? 0).toBeGreaterThanOrEqual(12);
    expect(policy?.RequireLowercase).toBe(true);
    expect(policy?.RequireUppercase).toBe(true);
    expect(policy?.RequireNumbers).toBe(true);
    expect(policy?.RequireSymbols).toBe(true);
  });

  it("recovers account access through the email channel the owner controls (R3.1)", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::Cognito::UserPool",
      Match.objectLike({
        AccountRecoverySetting: Match.objectLike({
          RecoveryMechanisms: Match.arrayWith([
            Match.objectLike({ Name: "verified_email" }),
          ]),
        }),
      }),
    );
  });

  it("limits repeated failed sign-in attempts via advanced security (R2.5)", () => {
    // Cognito's built-in adaptive/compromised-credential protections (which include failed-
    // attempt lockout) are engaged by enabling advanced security enforcement.
    templateFor("dev").hasResourceProperties(
      "AWS::Cognito::UserPool",
      Match.objectLike({
        UserPoolAddOns: Match.objectLike({
          AdvancedSecurityMode: "ENFORCED",
        }),
      }),
    );
  });

  it("prod retains the user pool so a stack replacement never deletes accounts", () => {
    templateFor("prod").hasResource(
      "AWS::Cognito::UserPool",
      Match.objectLike({ DeletionPolicy: "Retain" }),
    );
  });
});

describe("identity — user pool app client (R2)", () => {
  it("creates exactly one app client for the SPA", () => {
    templateFor("dev").resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  });

  it("is a public SPA client with no generated secret", () => {
    // A browser SPA cannot keep a secret, so the client is created without one.
    templateFor("dev").hasResourceProperties(
      "AWS::Cognito::UserPoolClient",
      Match.objectLike({
        GenerateSecret: false,
      }),
    );
  });

  it("enables SRP auth so credentials are never sent in the clear (R1.4/R2)", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::Cognito::UserPoolClient",
      Match.objectLike({
        ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_SRP_AUTH"]),
      }),
    );
  });
});

describe("identity — hosted sign-in domain (R2)", () => {
  it("provisions a hosted/managed sign-in domain for the pool", () => {
    templateFor("dev").resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
  });
});

describe("identity — outputs", () => {
  it("outputs the user pool ID and app client ID for each environment", () => {
    for (const name of ["dev", "prod"] as const) {
      const template = templateFor(name);
      const outputs = template.findOutputs("*") as Record<
        string,
        { Value: unknown; Description?: string }
      >;
      const descriptions = Object.values(outputs)
        .map((o) => o.Description ?? "")
        .join("\n");
      expect(descriptions, `user pool ID output for ${name}`).toContain("user pool ID");
      expect(descriptions, `app client ID output for ${name}`).toContain("client ID");
    }
  });
});
