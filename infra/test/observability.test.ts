import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  STACK_NAME,
  SYNTHETIC_CANARY_CREDENTIAL_PARAM,
  SYNTHETIC_CANARY_USERNAME,
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

/** All canary resources, keyed by logical id. */
function canaries(
  template: Template,
): Record<string, { Properties: Record<string, unknown> }> {
  return template.findResources("AWS::Synthetics::Canary") as Record<
    string,
    { Properties: Record<string, unknown> }
  >;
}

/** Find the one canary whose Name matches. */
function canaryNamed(
  template: Template,
  name: string,
): Record<string, unknown> | undefined {
  return Object.values(canaries(template)).find((c) => c.Properties["Name"] === name)
    ?.Properties;
}

describe("observability — the two Synthetics canaries (task 9.2, D8)", () => {
  it("provisions exactly two canaries: a read-only and a full-flow", () => {
    const found = canaries(platformTemplate());
    expect(Object.keys(found)).toHaveLength(2);
    const names = Object.values(found).map((c) => c.Properties["Name"]);
    expect(names).toEqual(
      expect.arrayContaining(["maze-platform-readonly", "maze-platform-fullflow"]),
    );
  });

  it("schedules the read-only canary every 5 minutes", () => {
    const canary = canaryNamed(platformTemplate(), "maze-platform-readonly");
    const schedule = canary?.["Schedule"] as { Expression?: string } | undefined;
    expect(schedule?.Expression).toBe("rate(5 minutes)");
  });

  it("schedules the full-flow canary every 30 minutes", () => {
    const canary = canaryNamed(platformTemplate(), "maze-platform-fullflow");
    const schedule = canary?.["Schedule"] as { Expression?: string } | undefined;
    expect(schedule?.Expression).toBe("rate(30 minutes)");
  });

  it("points the read-only canary at the PUBLIC leaderboard route (unauthenticated probe)", () => {
    const canary = canaryNamed(platformTemplate(), "maze-platform-readonly");
    const vars = (
      canary?.["RunConfig"] as
        { EnvironmentVariables?: Record<string, unknown> } | undefined
    )?.EnvironmentVariables;
    expect(vars?.["MAZE_LEADERBOARD_PATH"]).toBe("/leaderboard");
    // The leaderboard scope query carries the maze params the public route requires.
    const query = vars?.["MAZE_LEADERBOARD_QUERY"];
    expect(typeof query).toBe("string");
    expect(query as string).toContain("rows=");
    // No credential material is injected into the read-only canary.
    expect(vars?.["MAZE_SYNTHETIC_CREDENTIAL_PARAM"]).toBeUndefined();
  });

  it("pins a specific Synthetics runtime (not 'latest') for both canaries", () => {
    for (const canary of Object.values(canaries(platformTemplate()))) {
      const runtimeVersion = canary.Properties["RuntimeVersion"];
      expect(typeof runtimeVersion).toBe("string");
      expect(runtimeVersion as string).toMatch(/^syn-nodejs-puppeteer-/);
    }
  });

  it("enables X-Ray active tracing on BOTH canaries so their requests trace the seam (task 9.3)", () => {
    const found = canaries(platformTemplate());
    expect(Object.keys(found)).toHaveLength(2);
    for (const canary of Object.values(found)) {
      const runConfig = canary.Properties["RunConfig"] as
        | { ActiveTracing?: boolean }
        | undefined;
      expect(runConfig?.ActiveTracing).toBe(true);
    }
  });
});

describe("observability — full-flow canary sources credentials from SSM (R11.4)", () => {
  it("passes the SSM parameter NAME, never a literal password", () => {
    const canary = canaryNamed(platformTemplate(), "maze-platform-fullflow");
    const vars = (
      canary?.["RunConfig"] as
        { EnvironmentVariables?: Record<string, unknown> } | undefined
    )?.EnvironmentVariables;
    // The canary receives the parameter name and the (non-secret) username, and the seed —
    // but no password value.
    expect(vars?.["MAZE_SYNTHETIC_CREDENTIAL_PARAM"]).toBe(
      SYNTHETIC_CANARY_CREDENTIAL_PARAM,
    );
    expect(vars?.["MAZE_SYNTHETIC_USERNAME"]).toBe(SYNTHETIC_CANARY_USERNAME);
    // Nothing in the canary's injected env resembles a committed secret/password value.
    const serialized = JSON.stringify(vars);
    expect(serialized.toLowerCase()).not.toMatch(/password"\s*:\s*"[^"]+"/);
  });

  it("grants the full-flow canary role read on ONLY the one credential parameter (no ssm:* , no wildcard resource)", () => {
    const template = platformTemplate();
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;

    // Collect every SSM action granted anywhere in the stack + assert none is a wildcard.
    let sawGetParameter = false;
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const raw = statement["Action"];
        const actions = Array.isArray(raw) ? raw : [raw];
        for (const action of actions) {
          if (typeof action === "string" && action.startsWith("ssm:")) {
            expect(action).not.toBe("ssm:*");
            if (action === "ssm:GetParameter" || action === "ssm:GetParameters") {
              sawGetParameter = true;
              // The resource must be scoped (not a bare "*").
              expect(statement["Resource"]).not.toBe("*");
            }
          }
        }
      }
    }
    expect(
      sawGetParameter,
      "the full-flow canary can read the credential parameter",
    ).toBe(true);
  });

  it("grants each canary role the baseline Synthetics execution permissions (regression: custom role ⇒ no auto grants)", () => {
    // When a custom role is passed to the L2 Canary, CDK does NOT attach its default
    // execution policy — we must attach it ourselves. Without these, the engine Lambda
    // runs but every run fails before the Synthetics library reports (no log group forms,
    // no metrics, no artifacts). Assert the scoped grants are present in the template.
    const template = platformTemplate();
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;

    const allActions = new Set<string>();
    let sawScopedMetricData = false;
    let sawCwsynLogGroup = false;
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const raw = statement["Action"];
        const actions = Array.isArray(raw) ? raw : [raw];
        for (const action of actions) {
          if (typeof action === "string") {
            allActions.add(action);
          }
        }
        // PutMetricData must be scoped to the CloudWatchSynthetics namespace.
        if (actions.includes("cloudwatch:PutMetricData")) {
          const conditions = statement["Condition"] as
            | { StringEquals?: Record<string, unknown> }
            | undefined;
          if (
            conditions?.StringEquals?.["cloudwatch:namespace"] === "CloudWatchSynthetics"
          ) {
            sawScopedMetricData = true;
          }
        }
        // Log grants must be scoped to the cwsyn-* engine log groups.
        if (actions.includes("logs:CreateLogGroup")) {
          const serialized = JSON.stringify(statement["Resource"]);
          if (serialized.includes("/aws/lambda/cwsyn-*")) {
            sawCwsynLogGroup = true;
          }
        }
      }
    }

    // The baseline the canary needs to write artifacts, emit metrics, and log.
    for (const required of [
      "s3:GetBucketLocation",
      "s3:PutObject",
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      // X-Ray write actions that activeTracing requires (task 9.3).
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]) {
      expect(allActions.has(required), `canary roles grant ${required}`).toBe(true);
    }
    expect(sawScopedMetricData, "PutMetricData scoped to CloudWatchSynthetics").toBe(true);
    expect(sawCwsynLogGroup, "log grants scoped to cwsyn-* log groups").toBe(true);
  });

  it("gives each canary its own execution role and neither holds a wildcard-admin grant", () => {
    const template = platformTemplate();
    // Two canaries → their two dedicated roles exist (plus other stack roles).
    const roles = template.findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(2);

    // No policy anywhere grants Action:"*" on Resource:"*" (wildcard admin).
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const isAdmin = statement["Action"] === "*" && statement["Resource"] === "*";
        expect(isAdmin, "no wildcard-admin statement").toBe(false);
      }
    }
  });
});

describe("observability — CloudWatch alarms on availability + latency/freshness budgets", () => {
  /** All alarm resources, keyed by logical id. */
  function alarms(
    template: Template,
  ): Array<{ AlarmName?: string; Threshold?: number; MetricName?: string }> {
    const found = template.findResources("AWS::CloudWatch::Alarm") as Record<
      string,
      { Properties: { AlarmName?: string; Threshold?: number; MetricName?: string } }
    >;
    return Object.values(found).map((a) => a.Properties);
  }

  it("creates availability alarms on both canaries' SuccessPercent", () => {
    const found = alarms(platformTemplate());
    const availability = found.filter((a) => a.MetricName === "SuccessPercent");
    expect(availability.length).toBeGreaterThanOrEqual(2);
    const names = found.map((a) => a.AlarmName);
    expect(names).toEqual(
      expect.arrayContaining([
        "maze-platform-readonly-availability",
        "maze-platform-fullflow-availability",
      ]),
    );
  });

  it("alarms the leaderboard p95 latency against the 300 ms budget (R6.4)", () => {
    const latency = alarms(platformTemplate()).find(
      (a) => a.AlarmName === "maze-platform-leaderboard-p95-latency",
    );
    expect(latency, "leaderboard p95 latency alarm exists").toBeDefined();
    expect(latency?.MetricName).toBe("Duration");
    expect(latency?.Threshold).toBe(300);
  });

  it("alarms leaderboard freshness against the < 2 s budget (R6.5)", () => {
    const freshness = alarms(platformTemplate()).find(
      (a) => a.AlarmName === "maze-platform-leaderboard-freshness",
    );
    expect(freshness, "leaderboard freshness alarm exists").toBeDefined();
    // Duration metric is milliseconds; 2 s budget → 2000 ms threshold.
    expect(freshness?.Threshold).toBe(2000);
  });
});

describe("observability — canary artifacts bucket has a lifecycle expiry (D8 cost)", () => {
  it("sets an expiration lifecycle rule on the artifacts bucket", () => {
    const template = platformTemplate();
    template.hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({ Status: "Enabled", ExpirationInDays: 14 }),
          ]),
        }),
      }),
    );
  });

  it("blocks public access on the artifacts bucket (R11)", () => {
    platformTemplate().hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: true,
          RestrictPublicBuckets: true,
        }),
      }),
    );
  });
});
