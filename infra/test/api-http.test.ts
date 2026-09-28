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

describe("api — HTTP API edge (R2, R11)", () => {
  it("creates exactly one HTTP API fronting the platform (R11.1)", () => {
    const template = templateFor("dev");
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    // HTTP API (protocol HTTP), which is served exclusively over TLS.
    template.hasResourceProperties(
      "AWS::ApiGatewayV2::Api",
      Match.objectLike({ ProtocolType: "HTTP" }),
    );
  });

  it("auto-deploys a stage so the API is actually reachable", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::ApiGatewayV2::Stage",
      Match.objectLike({ AutoDeploy: true }),
    );
  });
});

describe("api — JWT authorizer over Cognito (R2.1, R2.4, R4.3, R5.3, R11.2)", () => {
  it("configures a JWT authorizer as the protection on protected routes", () => {
    templateFor("dev").hasResourceProperties(
      "AWS::ApiGatewayV2::Authorizer",
      Match.objectLike({ AuthorizerType: "JWT" }),
    );
  });

  it("pins the authorizer to this environment's Cognito user pool issuer", () => {
    const template = templateFor("dev");
    // The issuer references the Cognito user pool provider URL (Fn::Join of the pool's
    // provider URL). Presence of the pool id reference proves the authorizer trusts THIS
    // pool's tokens rather than an arbitrary issuer.
    const authorizers = template.findResources("AWS::ApiGatewayV2::Authorizer") as Record<
      string,
      { Properties: { JwtConfiguration?: { Issuer?: unknown } } }
    >;
    const jwt = Object.values(authorizers)[0]?.Properties.JwtConfiguration;
    expect(jwt, "JWT configuration").toBeDefined();
    expect(
      JSON.stringify(jwt?.Issuer ?? null),
      "issuer references the user pool",
    ).toContain("UserPool");
  });

  it("pins the token audience to the SPA app client so foreign-client tokens are rejected", () => {
    const template = templateFor("dev");
    const authorizers = template.findResources("AWS::ApiGatewayV2::Authorizer") as Record<
      string,
      { Properties: { JwtConfiguration?: { Audience?: unknown } } }
    >;
    const jwt = Object.values(authorizers)[0]?.Properties.JwtConfiguration;
    // The audience list references the app client id, tying accepted tokens to this client.
    expect(
      JSON.stringify(jwt?.Audience ?? null),
      "audience references the app client",
    ).toContain("Client");
  });
});

describe("api — protected health route (R4.3, R5.3)", () => {
  it("backs the health route with a minimal Lambda that returns 200", () => {
    const template = templateFor("dev");
    // Exactly one route is defined for the health probe.
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 1);
    template.hasResourceProperties(
      "AWS::ApiGatewayV2::Route",
      Match.objectLike({ RouteKey: "GET /health" }),
    );
  });

  it("requires the JWT authorizer on the health route (401 without a valid token)", () => {
    const template = templateFor("dev");
    const routes = template.findResources("AWS::ApiGatewayV2::Route") as Record<
      string,
      { Properties: { AuthorizationType?: string; AuthorizerId?: unknown } }
    >;
    const route = Object.values(routes)[0]?.Properties;
    // The route is guarded by JWT authorization and references an authorizer, so an
    // unauthenticated request is rejected at the edge before the handler runs.
    expect(route?.AuthorizationType).toBe("JWT");
    expect(route?.AuthorizerId, "route references an authorizer").toBeDefined();
  });

  it("integrates the route with a Lambda proxy backed by the inline health handler", () => {
    const template = templateFor("dev");
    // The route's integration is a Lambda proxy — exactly one, for the health handler.
    template.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
    template.hasResourceProperties(
      "AWS::ApiGatewayV2::Integration",
      Match.objectLike({ IntegrationType: "AWS_PROXY" }),
    );
    // The handler itself is the minimal inline Lambda that returns a 200 status code,
    // so a validated caller gets 200.
    template.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Handler: "index.handler",
        Code: Match.objectLike({
          ZipFile: Match.stringLikeRegexp("statusCode: 200"),
        }),
      }),
    );
  });
});

describe("api — base URL output", () => {
  it("outputs the API base URL for each environment", () => {
    for (const name of ["dev", "prod"] as const) {
      const template = templateFor(name);
      const outputs = template.findOutputs("*") as Record<
        string,
        { Value: unknown; Description?: string }
      >;
      const descriptions = Object.values(outputs)
        .map((o) => o.Description ?? "")
        .join("\n");
      expect(descriptions, `API URL output for ${name}`).toContain("HTTP API");
    }
  });
});
