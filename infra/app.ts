#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ENVIRONMENT_NAMES, configFor } from "./config.js";
import { OidcProviderStack } from "./oidc-provider-stack.js";
import { PlatformStack } from "./platform-stack.js";

/**
 * CDK app entry point — the composition root for infrastructure.
 *
 * One app instantiates a shared, account-level {@link OidcProviderStack} (the GitHub
 * Actions OIDC identity provider) plus a separate {@link PlatformStack} per environment
 * (`dev`, `prod`). Because each platform stack has a distinct name,
 * `cdk deploy MazeGamePlatform-dev` and `cdk deploy MazeGamePlatform-prod` operate on them
 * independently — the per-environment isolation the design's "Baseline stack" and D6 call
 * for.
 *
 * The AWS account/region are taken from the standard CDK environment variables at synth
 * time, so the same app deploys into whichever account the assumed role belongs to (the
 * OIDC deploy pipeline supplies them). Leaving them unset keeps the app
 * account/region-agnostic, which is valid for `cdk synth` without credentials.
 */
export function buildApp(): App {
  const app = new App();

  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const region = process.env.CDK_DEFAULT_REGION;
  const env = {
    ...(account !== undefined ? { account } : {}),
    ...(region !== undefined ? { region } : {}),
  };

  // The GitHub OIDC provider is account-level and shared by every environment's deploy
  // role, so it is created once and injected into each platform stack.
  const oidc = new OidcProviderStack(app, "MazeGamePlatform-OidcProvider", {
    env,
    description:
      "Shared GitHub Actions OIDC identity provider for the Maze Game Platform",
  });

  for (const name of ENVIRONMENT_NAMES) {
    const environment = configFor(name);
    new PlatformStack(app, environment.stackName, {
      env,
      environment,
      oidcProvider: oidc.provider,
      description: `Maze Game Platform baseline stack (${environment.name})`,
    });
  }

  return app;
}

// Synthesize only when run as the CDK entry point (`cdk` executes this file via tsx), not
// when imported by a test, which calls buildApp() and asserts on the synthesized template.
if (process.env.VITEST === undefined) {
  buildApp().synth();
}
