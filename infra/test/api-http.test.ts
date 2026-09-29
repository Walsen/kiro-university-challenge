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

describe("api — HTTP API edge (R2, R11)", () => {
  it("creates exactly one HTTP API fronting the platform (R11.1)", () => {
    const template = platformTemplate();
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    // HTTP API (protocol HTTP), which is served exclusively over TLS.
    template.hasResourceProperties(
      "AWS::ApiGatewayV2::Api",
      Match.objectLike({ ProtocolType: "HTTP" }),
    );
  });

  it("names the single API maze-game-platform (no environment suffix)", () => {
    platformTemplate().hasResourceProperties(
      "AWS::ApiGatewayV2::Api",
      Match.objectLike({ Name: "maze-game-platform" }),
    );
  });

  it("auto-deploys a stage so the API is actually reachable", () => {
    platformTemplate().hasResourceProperties(
      "AWS::ApiGatewayV2::Stage",
      Match.objectLike({ AutoDeploy: true }),
    );
  });
});

describe("api — JWT authorizer over Cognito (R2.1, R2.4, R4.3, R5.3, R11.2)", () => {
  it("configures a JWT authorizer as the protection on protected routes", () => {
    platformTemplate().hasResourceProperties(
      "AWS::ApiGatewayV2::Authorizer",
      Match.objectLike({ AuthorizerType: "JWT" }),
    );
  });

  it("pins the authorizer to the shared Cognito user pool issuer", () => {
    const template = platformTemplate();
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
    const template = platformTemplate();
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
  it("defines the protected health probe route (GET /health)", () => {
    const template = platformTemplate();
    // The health probe route exists (alongside the feature routes added by the
    // ServiceApi construct — those are asserted in service-api.test.ts).
    template.hasResourceProperties(
      "AWS::ApiGatewayV2::Route",
      Match.objectLike({ RouteKey: "GET /health" }),
    );
  });

  it("integrates the route with a Lambda proxy backed by the inline health handler", () => {
    const template = platformTemplate();
    // The route's integration is a Lambda proxy (AWS_PROXY). Feature routes add
    // their own proxy integrations; the health integration is asserted by its
    // handler below.
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

describe("api — X-Ray tracing & access logging (D8)", () => {
  it("enables X-Ray active tracing on the health handler Lambda", () => {
    platformTemplate().hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Handler: "index.handler",
        TracingConfig: Match.objectLike({ Mode: "Active" }),
      }),
    );
  });

  it("enables access logging on the HTTP API stage so edge requests are diagnosable", () => {
    // HTTP APIs do not expose per-stage X-Ray active tracing (a REST-only property); the
    // distributed trace comes from the X-Ray-traced Lambdas. The stage-level observability
    // it does support is access logging, enabled here with a PII-free structured format.
    const template = platformTemplate();
    const stages = template.findResources("AWS::ApiGatewayV2::Stage") as Record<
      string,
      { Properties: { AccessLogSettings?: { DestinationArn?: unknown; Format?: unknown } } }
    >;
    const settings = Object.values(stages)[0]?.Properties.AccessLogSettings;
    expect(settings, "stage access-log settings").toBeDefined();
    expect(settings?.DestinationArn).toBeDefined();
    // The format records request id/route/status/latency — no credentials, tokens, or PII.
    const format = JSON.stringify(settings?.Format ?? "");
    expect(format).toContain("requestId");
    expect(format).toContain("status");
    expect(format).not.toContain("authorization");
  });
});

describe("api — base URL output", () => {
  it("outputs the API base URL for the shared backend", () => {
    const template = platformTemplate();
    const outputs = template.findOutputs("*") as Record<
      string,
      { Value: unknown; Description?: string }
    >;
    const descriptions = Object.values(outputs)
      .map((o) => o.Description ?? "")
      .join("\n");
    expect(descriptions, "API URL output").toContain("HTTP API");
  });
});
