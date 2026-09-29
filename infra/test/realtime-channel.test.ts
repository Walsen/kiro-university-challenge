import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { STACK_NAME } from "../config.js";
import { OidcProviderStack } from "../oidc-provider-stack.js";
import { PlatformStack } from "../platform-stack.js";
import { REALTIME_API_NAME, SESSIONS_NAMESPACE_NAME } from "../realtime-channel.js";

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

/** The shape of a synthesized AppSync Event API's properties these tests inspect. */
interface EventApiProperties {
  Name?: string;
  EventConfig?: {
    AuthProviders?: Array<{ AuthType?: string }>;
    ConnectionAuthModes?: Array<{ AuthType?: string }>;
    DefaultPublishAuthModes?: Array<{ AuthType?: string }>;
    DefaultSubscribeAuthModes?: Array<{ AuthType?: string }>;
  };
}

function eventApiProps(template: Template): EventApiProperties {
  const apis = template.findResources("AWS::AppSync::Api") as Record<
    string,
    { Properties: EventApiProperties }
  >;
  const props = Object.values(apis)[0]?.Properties;
  expect(props, "an AppSync Event API is defined").toBeDefined();
  return props!;
}

function authTypesOf(modes?: Array<{ AuthType?: string }>): Set<string> {
  return new Set((modes ?? []).map((m) => m.AuthType ?? ""));
}

describe("realtime channel — AppSync Events API (R9.1)", () => {
  it("provisions exactly one serverless AppSync Event API", () => {
    platformTemplate().resourceCountIs("AWS::AppSync::Api", 1);
  });

  it("names the Event API for the shared platform (no environment suffix)", () => {
    expect(eventApiProps(platformTemplate()).Name).toBe(REALTIME_API_NAME);
    expect(REALTIME_API_NAME).not.toMatch(/-(dev|prod|staging)$/);
  });

  it("lets Cognito-authenticated clients connect (no committed API key)", () => {
    const config = eventApiProps(platformTemplate()).EventConfig;
    expect(authTypesOf(config?.ConnectionAuthModes)).toContain(
      "AMAZON_COGNITO_USER_POOLS",
    );
    // API-key auth would be a shared static secret; the platform authenticates
    // users with the shared Cognito pool instead (R11).
    const providers = authTypesOf(config?.AuthProviders);
    expect(providers).not.toContain("API_KEY");
  });

  it("publishes server-authoritatively via IAM and lets clients subscribe with Cognito", () => {
    const config = eventApiProps(platformTemplate()).EventConfig;
    // The Session Lambda (server) publishes authoritative updates using its IAM role.
    expect(authTypesOf(config?.DefaultPublishAuthModes)).toContain("AWS_IAM");
    // Clients subscribe with their Cognito JWT.
    expect(authTypesOf(config?.DefaultSubscribeAuthModes)).toContain(
      "AMAZON_COGNITO_USER_POOLS",
    );
  });
});

describe("realtime channel — shared-session channel namespace (R9.1)", () => {
  it("defines exactly one channel namespace for shared sessions", () => {
    platformTemplate().resourceCountIs("AWS::AppSync::ChannelNamespace", 1);
  });

  it("names the namespace 'sessions' so channels are addressed under /sessions/*", () => {
    platformTemplate().hasResourceProperties(
      "AWS::AppSync::ChannelNamespace",
      Match.objectLike({ Name: SESSIONS_NAMESPACE_NAME }),
    );
    expect(SESSIONS_NAMESPACE_NAME).toBe("sessions");
  });
});

describe("realtime channel — outputs", () => {
  it("outputs the realtime HTTP and WebSocket endpoints so the client SDK can connect", () => {
    const template = platformTemplate();
    const outputs = template.findOutputs("*") as Record<
      string,
      { Value: unknown; Export?: { Name?: string } }
    >;
    expect(Object.keys(outputs)).toContain("RealtimeHttpDns");
    expect(Object.keys(outputs)).toContain("RealtimeDns");
    expect(outputs.RealtimeHttpDns?.Export?.Name).toBe(
      "MazeGamePlatform-RealtimeHttpDns",
    );
    expect(outputs.RealtimeDns?.Export?.Name).toBe("MazeGamePlatform-RealtimeDns");
  });
});
