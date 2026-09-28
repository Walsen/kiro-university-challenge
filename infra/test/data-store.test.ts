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

/** The shape of a synthesized DynamoDB table's properties these tests inspect. */
interface TableProperties {
  BillingMode?: string;
  KeySchema?: Array<{ AttributeName: string; KeyType: string }>;
  AttributeDefinitions?: Array<{ AttributeName: string; AttributeType: string }>;
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
    templateFor("dev").resourceCountIs("AWS::DynamoDB::Table", 1);
  });

  it("bills on-demand so capacity is never provisioned or a scaling knob", () => {
    expect(tableProps(templateFor("dev")).BillingMode).toBe("PAY_PER_REQUEST");
  });

  it("keys items by a partition key PK and a sort key SK (single-table scheme)", () => {
    const props = tableProps(templateFor("dev"));
    const keys = new Map(
      (props.KeySchema ?? []).map((k) => [k.KeyType, k.AttributeName]),
    );
    expect(keys.get("HASH"), "partition key").toBe("PK");
    expect(keys.get("RANGE"), "sort key").toBe("SK");
  });

  it("declares PK and SK as string attributes", () => {
    const props = tableProps(templateFor("dev"));
    const defs = new Map(
      (props.AttributeDefinitions ?? []).map((d) => [d.AttributeName, d.AttributeType]),
    );
    expect(defs.get("PK")).toBe("S");
    expect(defs.get("SK")).toBe("S");
  });
});

describe("data store — leaderboard GSI (R6.1)", () => {
  it("defines a GSI1 keyed on GSI1PK / GSI1SK so ascending sort = fastest-first", () => {
    const props = tableProps(templateFor("dev"));
    const gsi = (props.GlobalSecondaryIndexes ?? []).find((g) => g.IndexName === "GSI1");
    expect(gsi, "GSI1 leaderboard index").toBeDefined();
    const keys = new Map(gsi!.KeySchema.map((k) => [k.KeyType, k.AttributeName]));
    expect(keys.get("HASH"), "GSI partition key").toBe("GSI1PK");
    expect(keys.get("RANGE"), "GSI sort key").toBe("GSI1SK");
  });

  it("declares the GSI key attributes as strings", () => {
    const props = tableProps(templateFor("dev"));
    const defs = new Map(
      (props.AttributeDefinitions ?? []).map((d) => [d.AttributeName, d.AttributeType]),
    );
    expect(defs.get("GSI1PK")).toBe("S");
    expect(defs.get("GSI1SK")).toBe("S");
  });

  it("projects all attributes onto the GSI so a leaderboard read needs no table fetch", () => {
    const props = tableProps(templateFor("dev"));
    const gsi = (props.GlobalSecondaryIndexes ?? []).find((g) => g.IndexName === "GSI1");
    expect(gsi?.Projection?.ProjectionType).toBe("ALL");
  });
});

describe("data store — per-environment removal policy", () => {
  it("dev tears the table down with the stack (DESTROY)", () => {
    templateFor("dev").hasResource(
      "AWS::DynamoDB::Table",
      Match.objectLike({ DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" }),
    );
  });

  it("prod retains the table so a stack replacement never deletes real scores (RETAIN)", () => {
    templateFor("prod").hasResource(
      "AWS::DynamoDB::Table",
      Match.objectLike({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" }),
    );
  });
});

describe("data store — table name output", () => {
  it("outputs the table name for each environment so services can find it", () => {
    for (const name of ["dev", "prod"] as const) {
      const template = templateFor(name);
      const outputs = template.findOutputs("*") as Record<
        string,
        { Value: unknown; Description?: string }
      >;
      const descriptions = Object.values(outputs)
        .map((o) => o.Description ?? "")
        .join("\n");
      expect(descriptions, `table name output for ${name}`).toContain("table name");
    }
  });
});
