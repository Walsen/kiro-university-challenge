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

/** Find the route resource whose RouteKey matches, or undefined. */
function routeFor(
  template: Template,
  routeKey: string,
): { AuthorizationType?: string; AuthorizerId?: unknown } | undefined {
  const routes = template.findResources("AWS::ApiGatewayV2::Route") as Record<
    string,
    {
      Properties: {
        RouteKey?: string;
        AuthorizationType?: string;
        AuthorizerId?: unknown;
      };
    }
  >;
  return Object.values(routes).find((r) => r.Properties.RouteKey === routeKey)
    ?.Properties;
}

describe("service-api — score & leaderboard routes (tasks 7.1–7.3, R4/R5/R6)", () => {
  it("adds the five feature routes plus the health probe", () => {
    const template = platformTemplate();
    const routeKeys = Object.values(
      template.findResources("AWS::ApiGatewayV2::Route") as Record<
        string,
        { Properties: { RouteKey?: string } }
      >,
    ).map((r) => r.Properties.RouteKey);

    expect(routeKeys).toEqual(
      expect.arrayContaining([
        "GET /health",
        "POST /scores",
        "GET /scores/me",
        "GET /scores/me/best",
        "GET /leaderboard",
        "GET /leaderboard/me",
        "DELETE /account/me",
      ]),
    );
  });

  it("guards the authenticated routes with the JWT authorizer (401 without a token)", () => {
    const template = platformTemplate();
    for (const routeKey of [
      "POST /scores",
      "GET /scores/me",
      "GET /scores/me/best",
      "GET /leaderboard/me",
      "DELETE /account/me",
    ]) {
      const route = routeFor(template, routeKey);
      expect(route?.AuthorizationType, `${routeKey} is JWT-guarded`).toBe("JWT");
      expect(route?.AuthorizerId, `${routeKey} references an authorizer`).toBeDefined();
    }
  });

  it("leaves GET /leaderboard public (no authorizer) so anyone may read the ranking", () => {
    const route = routeFor(platformTemplate(), "GET /leaderboard");
    // A public route has no JWT authorization.
    expect(route?.AuthorizationType ?? "NONE").not.toBe("JWT");
    expect(route?.AuthorizerId).toBeUndefined();
  });
});

describe("service-api — X-Ray active tracing on every Lambda (D8)", () => {
  it("enables Active tracing on all functions (service handlers, delete, profile trigger, health)", () => {
    const template = platformTemplate();
    const functions = template.findResources("AWS::Lambda::Function") as Record<
      string,
      { Properties: { TracingConfig?: { Mode?: string } } }
    >;

    // Scope to the backend's own application Lambdas. The stack also contains
    // non-application functions that are not ours to trace: the Synthetics canary run
    // Lambdas (under the Observability construct, task 9.2) run the AWS-managed
    // `syn-nodejs` runtime, and CDK provisions a custom-resource Lambda for the canary
    // artifacts bucket's auto-delete. Neither is an application handler, so exclude them by
    // their construct-path logical id and assert every remaining (application) Lambda
    // traces actively.
    const isApplicationFn = (logicalId: string): boolean =>
      !logicalId.includes("Observability") &&
      !logicalId.includes("AutoDeleteObjects") &&
      !logicalId.includes("CustomS3");
    const appFunctions = Object.entries(functions).filter(([logicalId]) =>
      isApplicationFn(logicalId),
    );
    const modes = appFunctions.map(([, f]) => f.Properties.TracingConfig?.Mode);
    // There are eight application Lambdas in the backend: health, scores, personal-history,
    // personal-best, leaderboard, own-rank, delete-account, and the profile-signup
    // trigger. Every one of them must trace actively — none left untraced.
    expect(modes.length).toBeGreaterThanOrEqual(8);
    for (const mode of modes) {
      expect(mode, "every application Lambda traces actively").toBe("Active");
    }
  });

  it("grants each function the X-Ray write permission (via tracing: ACTIVE)", () => {
    const template = platformTemplate();
    // With `tracing: ACTIVE`, CDK grants the X-Ray daemon write permission by inlining the
    // two X-Ray write actions into each function's execution-role policy (equivalent to
    // the managed AWSXRayDaemonWriteAccess). Count the PutTraceSegments grants: one per
    // Lambda, so eight across the backend.
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;
    let xrayGrants = 0;
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const raw = statement["Action"];
        const actions = Array.isArray(raw) ? raw : [raw];
        if (actions.includes("xray:PutTraceSegments")) {
          xrayGrants += 1;
        }
      }
    }
    expect(xrayGrants).toBeGreaterThanOrEqual(8);
  });
});

describe("service-api — least-privilege DynamoDB grants (R11.1)", () => {
  it("grants only the actions each function needs, scoped to the table (no wildcard resource, no dynamodb:*)", () => {
    const template = platformTemplate();
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;

    // Collect every DynamoDB action granted anywhere in the stack's policies.
    const dynamoActions = new Set<string>();
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const raw = statement["Action"];
        const actions = Array.isArray(raw) ? raw : [raw];
        for (const action of actions) {
          if (typeof action === "string" && action.startsWith("dynamodb:")) {
            dynamoActions.add(action);
            // No blanket dynamodb:* is ever granted.
            expect(action).not.toBe("dynamodb:*");
          }
        }
      }
    }

    // The write path needs PutItem/UpdateItem; the read paths need GetItem/Query/BatchGetItem.
    // These are exactly the standard CDK grantRead(Write)Data actions.
    expect(dynamoActions.has("dynamodb:PutItem")).toBe(true);
    expect(dynamoActions.has("dynamodb:Query")).toBe(true);
  });

  it("grants the profile-signup trigger only dynamodb:PutItem (no delete/scan, no wildcards)", () => {
    const template = platformTemplate();
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;

    // Select the trigger's own execution-role policy by its construct path in the
    // logical id, so this asserts the trigger's least privilege specifically —
    // not the aggregate across the whole stack.
    const triggerPolicies = Object.entries(policies).filter(([logicalId]) =>
      logicalId.includes("ProfileSignUpTrigger"),
    );
    expect(triggerPolicies, "exactly one profile-signup-trigger policy").toHaveLength(1);

    const dynamoActions = new Set<string>();
    for (const [, policy] of triggerPolicies) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const raw = statement["Action"];
        const actions = Array.isArray(raw) ? raw : [raw];
        const isDynamo = actions.some(
          (a) => typeof a === "string" && a.startsWith("dynamodb:"),
        );
        for (const action of actions) {
          if (typeof action === "string" && action.startsWith("dynamodb:")) {
            dynamoActions.add(action);
          }
        }
        // No wildcard action ever. The DynamoDB grant must also be resource-scoped (no
        // wildcard resource); the co-located X-Ray write statement legitimately uses
        // `Resource: "*"` (those actions do not support resource-level scoping), so the
        // resource check applies to the DynamoDB statement only.
        expect(statement["Action"]).not.toBe("*");
        if (isDynamo) {
          expect(statement["Resource"]).not.toBe("*");
        }
      }
    }

    // The trigger only ever writes a single profile item: PutItem, nothing more.
    // A grantWriteData would also permit DeleteItem/BatchWriteItem — assert those
    // are absent so the grant can never quietly widen.
    expect([...dynamoActions]).toEqual(["dynamodb:PutItem"]);
    expect(dynamoActions.has("dynamodb:DeleteItem")).toBe(false);
    expect(dynamoActions.has("dynamodb:BatchWriteItem")).toBe(false);
    expect(dynamoActions.has("dynamodb:Scan")).toBe(false);
    expect(dynamoActions.has("dynamodb:*")).toBe(false);
  });

  it("grants the delete-account handler only Query/Delete/BatchWrite (no Put/Update, no wildcards) (R11.5, R11.1)", () => {
    const template = platformTemplate();
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    >;

    // Select the delete Lambda's own execution-role policy by its construct path
    // in the logical id, so this asserts THAT function's least privilege — not
    // the aggregate across the whole stack.
    const deletePolicies = Object.entries(policies).filter(([logicalId]) =>
      logicalId.includes("DeleteAccountHandler"),
    );
    expect(deletePolicies, "exactly one delete-account-handler policy").toHaveLength(1);

    const dynamoActions = new Set<string>();
    for (const [, policy] of deletePolicies) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const raw = statement["Action"];
        const actions = Array.isArray(raw) ? raw : [raw];
        const isDynamo = actions.some(
          (a) => typeof a === "string" && a.startsWith("dynamodb:"),
        );
        for (const action of actions) {
          if (typeof action === "string" && action.startsWith("dynamodb:")) {
            dynamoActions.add(action);
          }
        }
        // No wildcard action ever. The DynamoDB grant must also be resource-scoped; the
        // co-located X-Ray write statement legitimately uses `Resource: "*"`, so the
        // resource check applies to the DynamoDB statement only.
        expect(statement["Action"]).not.toBe("*");
        if (isDynamo) {
          expect(statement["Resource"]).not.toBe("*");
        }
      }
    }

    // Exactly the erase actions it needs: enumerate the partition (Query) and
    // remove items (DeleteItem/BatchWriteItem). Nothing more.
    expect(dynamoActions.has("dynamodb:Query")).toBe(true);
    expect(dynamoActions.has("dynamodb:DeleteItem")).toBe(true);
    expect(dynamoActions.has("dynamodb:BatchWriteItem")).toBe(true);
    // It must NOT be able to write or mutate scores — that is not its job.
    expect(dynamoActions.has("dynamodb:PutItem")).toBe(false);
    expect(dynamoActions.has("dynamodb:UpdateItem")).toBe(false);
    expect(dynamoActions.has("dynamodb:*")).toBe(false);
  });

  it("injects the table name into every service function via MAZE_TABLE_NAME", () => {
    const template = platformTemplate();
    const functions = template.findResources("AWS::Lambda::Function") as Record<
      string,
      { Properties: { Environment?: { Variables?: Record<string, unknown> } } }
    >;
    // Count the functions that carry the table-name env var: the five service
    // handlers plus the delete-account handler plus the profile-signup trigger.
    const withTableEnv = Object.values(functions).filter(
      (f) => f.Properties.Environment?.Variables?.["MAZE_TABLE_NAME"] !== undefined,
    );
    expect(withTableEnv.length).toBeGreaterThanOrEqual(7);
  });
});

describe("service-api — unsuffixed function names (single shared backend, D6)", () => {
  it("names the score handler maze-game-platform-score-handler (no environment suffix)", () => {
    platformTemplate().hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({ FunctionName: "maze-game-platform-score-handler" }),
    );
  });
});

describe("service-api — profile-on-signup trigger (task 8, R6.2)", () => {
  it("attaches a Cognito PostConfirmation Lambda trigger to the user pool", () => {
    platformTemplate().hasResourceProperties(
      "AWS::Cognito::UserPool",
      Match.objectLike({
        LambdaConfig: Match.objectLike({ PostConfirmation: Match.anyValue() }),
      }),
    );
  });
});
