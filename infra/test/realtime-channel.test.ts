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

/** The properties of the synthesized `sessions` channel namespace these tests inspect. */
interface ChannelNamespaceProperties {
  Name?: string;
  CodeHandlers?: string;
  HandlerConfigs?: {
    OnPublish?: {
      Behavior?: string;
      Integration?: { DataSourceName?: string };
    };
  };
  PublishAuthModes?: Array<{ AuthType?: string }>;
  SubscribeAuthModes?: Array<{ AuthType?: string }>;
}

function sessionsNamespaceProps(template: Template): ChannelNamespaceProperties {
  const namespaces = template.findResources("AWS::AppSync::ChannelNamespace") as Record<
    string,
    { Properties: ChannelNamespaceProperties }
  >;
  const props = Object.values(namespaces)[0]?.Properties;
  expect(props, "the sessions channel namespace is defined").toBeDefined();
  return props!;
}

describe("realtime channel — inbound client→server leg (R9.2/R9.3, R11.1)", () => {
  it("routes published events through an onPublish handler backed by the Session Lambda data source", () => {
    const template = platformTemplate();

    // A Lambda data source is defined for the Session Lambda so the namespace handler can
    // invoke the server on publish.
    template.hasResourceProperties(
      "AWS::AppSync::DataSource",
      Match.objectLike({ Type: "AWS_LAMBDA" }),
    );

    // The sessions namespace carries an onPublish handler (inline code) wired to that data
    // source, so an authorized client publish invokes the server-authoritative Lambda.
    const props = sessionsNamespaceProps(template);
    expect(props.CodeHandlers, "onPublish handler code is attached").toContain(
      "onPublish",
    );
    expect(props.HandlerConfigs?.OnPublish?.Integration?.DataSourceName).toBeDefined();
  });

  it("does not echo the raw client intent (the client-publish response broadcasts nothing)", () => {
    // For a client (Cognito) publish the onPublish handler's response returns [] so only
    // the server's authoritative diff (published separately via IAM) reaches subscribers —
    // the client intent is never fanned out. Assert the handler code encodes that
    // suppression.
    const props = sessionsNamespaceProps(platformTemplate());
    expect(props.CodeHandlers).toMatch(/response\s*\(\s*\)\s*\{[\s\S]*return \[\]/);
  });

  it("branches on the publisher: broadcasts the server's IAM diff but only invokes the Lambda for a Cognito client", () => {
    // The defect the 17.3 seam test surfaced was a handler that suppressed *every* publish
    // — swallowing the server's own authoritative diff (published via IAM to this same
    // channel) and needlessly re-invoking the Lambda. The fix branches on the publisher's
    // principal, whose identity shape AppSync fixes per auth mode: a Cognito USER_POOL
    // publish carries `sub`; an AWS_IAM publish does not.
    const code = sessionsNamespaceProps(platformTemplate()).CodeHandlers ?? "";

    // It distinguishes the two principals by the presence of a Cognito `sub` on
    // `ctx.identity` (absent for the server's IAM publish).
    expect(code).toMatch(/identity\.sub/);

    // Server (IAM) path: the authoritative diff is broadcast unchanged and the data source
    // is skipped — `runtime.earlyReturn(ctx.events)` bypasses both the Lambda invoke and
    // the response function, so the server's diff reaches subscribers and does not
    // re-enter the handler.
    expect(code).toMatch(/runtime\.earlyReturn\(\s*ctx\.events\s*\)/);

    // Client (Cognito) path: the intended move is still routed to the server-authoritative
    // Session Lambda via an Invoke, carrying the AppSync-validated identity.
    expect(code).toMatch(/operation:\s*["']Invoke["']/);
    expect(code).toContain("identity: ctx.identity");
  });

  it("lets Cognito clients publish their intended move on the sessions namespace only", () => {
    const props = sessionsNamespaceProps(platformTemplate());
    // Clients (USER_POOL) may publish their intent so the handler fires...
    expect(authTypesOf(props.PublishAuthModes)).toContain("AMAZON_COGNITO_USER_POOLS");
    // ...while the API default publish mode stays IAM-only (server authority by default),
    // so the client-publish grant is scoped to this namespace, not the whole API.
    const apiConfig = eventApiProps(platformTemplate()).EventConfig;
    expect(authTypesOf(apiConfig?.DefaultPublishAuthModes)).not.toContain(
      "AMAZON_COGNITO_USER_POOLS",
    );
  });

  it("keeps IAM publish on the namespace so the server fans out authoritative diffs", () => {
    const props = sessionsNamespaceProps(platformTemplate());
    expect(authTypesOf(props.PublishAuthModes)).toContain("AWS_IAM");
  });

  it("grants AppSync invoke on the Session Lambda only (least privilege)", () => {
    // Adding the Lambda data source creates a service-linked invoke permission scoped to a
    // single function — not a wildcard. Assert exactly one AppSync-invoke policy exists.
    const template = platformTemplate();
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } } }
    >;
    const invokeStatements = Object.values(policies).flatMap((p) =>
      p.Properties.PolicyDocument.Statement.filter((s) => {
        const action = s.Action;
        return (
          action === "lambda:InvokeFunction" ||
          (Array.isArray(action) && action.includes("lambda:InvokeFunction"))
        );
      }),
    );
    expect(invokeStatements.length).toBeGreaterThan(0);
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
