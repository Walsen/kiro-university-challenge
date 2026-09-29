import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { BRANCH_ENVIRONMENTS, STACK_NAME } from "../config.js";
import { PlatformStack } from "../platform-stack.js";

function platformStacks(): PlatformStack[] {
  return buildApp()
    .node.findAll()
    .filter((node): node is PlatformStack => node instanceof PlatformStack);
}

describe("CDK app scaffolding", () => {
  it("instantiates exactly one shared backend stack named MazeGamePlatform", () => {
    const names = platformStacks().map((stack) => stack.stackName);

    expect(names).toEqual([STACK_NAME]);
    expect(STACK_NAME).toBe("MazeGamePlatform");
  });

  it("synthesizes the single backend stack to a valid CloudFormation template", () => {
    const stacks = platformStacks();
    expect(stacks).toHaveLength(1);
    // Synthesizing without throwing is the assertion that the stack is valid CDK.
    const template = Template.fromStack(stacks[0]!);
    expect(template.toJSON()).toBeTypeOf("object");
  });
});

describe("branch → environment mapping", () => {
  it("maps main to prod and staging to staging (branch = environment, one app)", () => {
    expect(BRANCH_ENVIRONMENTS).toEqual([
      { branchName: "main", environment: "prod" },
      { branchName: "staging", environment: "staging" },
    ]);
  });
});
