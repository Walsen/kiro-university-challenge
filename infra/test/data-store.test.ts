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

/** The shape of a synthesized DynamoDB table's properties these tests inspect. */
interface TableProperties {
  BillingMode?: string;
  KeySchema?: Array<{ AttributeName: string; KeyType: string }>;
  AttributeDefinitions?: Array<{ AttributeName: string; AttributeType: string }>;
  PointInTimeRecoverySpecification?: { PointInTimeRecoveryEnabled?: boolean };
  GlobalSecondaryIndexes?: Array<{
    IndexName: string;
    KeySchema: Array<{ AttributeName: string; KeyType: string }>;
    Projection?: { ProjectionType?: string };
  }>;
}

function tableProps(template: Template): TableProperties {
  const tables = template.findResources("AWS::DynamoDB::Table") as Record<
    string,
    { Properties: TableProperties }
  >;
  const props = Object.values(tables)[0]?.Properties;
  expect(props, "a DynamoDB table is defined").toBeDefined();
  return props!;
}

describe("data store — single table (R4.2, R5.1)", () => {
  it("creates exactly one DynamoDB table for the platform", () => {
    platformTemplate().resourceCountIs("AWS::DynamoDB::Table", 1);
  });

  it("names the single table maze-game-platform (no environment suffix)", () => {
    platformTemplate().hasResourceProperties(
      "AWS::DynamoDB::Table",
      Match.objectLike({ TableName: "maze-game-platform" }),
    );
  });

  it("bills on-demand so capacity is never provisioned or a scaling knob", () => {
    expect(tableProps(platformTemplate()).BillingMode).toBe("PAY_PER_REQUEST");
  });

  it("keys items by a partition key PK and a sort key SK (single-table scheme)", () => {
    const props = tableProps(platformTemplate());
    const keys = new Map(
      (props.KeySchema ?? []).map((k) => [k.KeyType, k.AttributeName]),
    );
    expect(keys.get("HASH"), "partition key").toBe("PK");
    expect(keys.get("RANGE"), "sort key").toBe("SK");
  });

  it("declares PK and SK as string attributes", () => {
    const props = tableProps(platformTemplate());
    const defs = new Map(
      (props.AttributeDefinitions ?? []).map((d) => [d.AttributeName, d.AttributeType]),
    );
    expect(defs.get("PK")).toBe("S");
    expect(defs.get("SK")).toBe("S");
  });
});

describe("data store — leaderboard GSI (R6.1)", () => {
  it("defines a GSI1 keyed on GSI1PK / GSI1SK so ascending sort = fastest-first", () => {
    const props = tableProps(platformTemplate());
    const gsi = (props.GlobalSecondaryIndexes ?? []).find((g) => g.IndexName === "GSI1");
    expect(gsi, "GSI1 leaderboard index").toBeDefined();
    const keys = new Map(gsi!.KeySchema.map((k) => [k.KeyType, k.AttributeName]));
    expect(keys.get("HASH"), "GSI partition key").toBe("GSI1PK");
    expect(keys.get("RANGE"), "GSI sort key").toBe("GSI1SK");
  });

  it("declares the GSI key attributes as strings", () => {
    const props = tableProps(platformTemplate());
    const defs = new Map(
      (props.AttributeDefinitions ?? []).map((d) => [d.AttributeName, d.AttributeType]),
    );
    expect(defs.get("GSI1PK")).toBe("S");
    expect(defs.get("GSI1SK")).toBe("S");
  });

  it("projects all attributes onto the GSI so a leaderboard read needs no table fetch", () => {
    const props = tableProps(platformTemplate());
    const gsi = (props.GlobalSecondaryIndexes ?? []).find((g) => g.IndexName === "GSI1");
    expect(gsi?.Projection?.ProjectionType).toBe("ALL");
  });
});

describe("data store — prod-grade posture always (single shared backend, D6)", () => {
  it("retains the table so a stack replacement never deletes real scores (RETAIN)", () => {
    platformTemplate().hasResource(
      "AWS::DynamoDB::Table",
      Match.objectLike({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" }),
    );
  });

  it("enables point-in-time recovery on the shared table", () => {
    expect(
      tableProps(platformTemplate()).PointInTimeRecoverySpecification
        ?.PointInTimeRecoveryEnabled,
    ).toBe(true);
  });
});

describe("data store — table name output", () => {
  it("outputs the table name so services can find the shared table", () => {
    const template = platformTemplate();
    const outputs = template.findOutputs("*") as Record<
      string,
      { Value: unknown; Description?: string; Export?: { Name?: string } }
    >;
    const entry = Object.entries(outputs).find(([key]) => key === "TableName");
    expect(entry, "table name output").toBeDefined();
    expect(entry?.[1].Description ?? "").toContain("table name");
    expect(entry?.[1].Export?.Name).toBe("MazeGamePlatform-TableName");
  });
});
