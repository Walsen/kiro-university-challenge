import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ENVIRONMENT_NAMES, configFor, isEnvironmentName } from "../config.js";
import { PlatformStack } from "../platform-stack.js";

function platformStacks(): PlatformStack[] {
  return buildApp()
    .node.findAll()
    .filter((node): node is PlatformStack => node instanceof PlatformStack);
}

describe("CDK app scaffolding", () => {
  it("instantiates one stack per environment with distinct, environment-suffixed names", () => {
    const names = platformStacks()
      .map((stack) => stack.stackName)
      .sort();

    expect(names).toEqual(["MazeGamePlatform-dev", "MazeGamePlatform-prod"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("synthesizes each per-environment stack to a valid CloudFormation template", () => {
    for (const name of ENVIRONMENT_NAMES) {
      const stack = platformStacks().find((s) => s.environmentConfig.name === name);

      expect(stack, `stack for environment "${name}"`).toBeDefined();
      // Synthesizing without throwing is the assertion that the stack is valid CDK.
      const template = Template.fromStack(stack as PlatformStack);
      expect(template.toJSON()).toBeTypeOf("object");
    }
  });

  it("defines exactly the two expected environments once each", () => {
    const environments = platformStacks()
      .map((s) => s.environmentConfig.name)
      .sort();

    expect(environments).toEqual(["dev", "prod"]);
  });
});

describe("environment configuration", () => {
  it("derives a distinct, prefixed stack name for each environment", () => {
    expect(configFor("dev").stackName).toBe("MazeGamePlatform-dev");
    expect(configFor("prod").stackName).toBe("MazeGamePlatform-prod");
  });

  it("recognizes known environment names and rejects unknown ones", () => {
    expect(isEnvironmentName("dev")).toBe(true);
    expect(isEnvironmentName("prod")).toBe(true);
    expect(isEnvironmentName("staging")).toBe(false);
    expect(isEnvironmentName("")).toBe(false);
  });
});
