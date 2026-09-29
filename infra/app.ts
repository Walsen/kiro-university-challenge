#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { STACK_NAME } from "./config.js";
import { OidcProviderStack } from "./oidc-provider-stack.js";
import { PlatformStack } from "./platform-stack.js";

/**
 * CDK app entry point — the composition root for infrastructure.
 *
 * One app instantiates a shared, account-level {@link OidcProviderStack} (the GitHub
 * Actions OIDC identity provider) plus the **single** {@link PlatformStack} named
 * `MazeGamePlatform`. There is no per-environment stack loop: the backend is one shared,
 * environment-agnostic stack (D6), and the environment is identified by the Amplify Git
 * branch inside it (D7), not by the stack name.
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

  // The GitHub OIDC provider is account-level and shared by the deploy role, so it is
  // created once and injected into the platform stack.
  const oidc = new OidcProviderStack(app, "MazeGamePlatform-OidcProvider", {
    env,
    description:
      "Shared GitHub Actions OIDC identity provider for the Maze Game Platform",
  });

  // The single shared backend. No environment suffix and no loop: one Cognito pool, one
  // table, one HTTP API + Lambdas, one deploy role — served to both Amplify branches.
  new PlatformStack(app, STACK_NAME, {
    env,
    oidcProvider: oidc.provider,
    description: "Maze Game Platform shared backend stack",
  });

  return app;
}

// Synthesize only when run as the CDK entry point (`cdk` executes this file via tsx), not
// when imported by a test, which calls buildApp() and asserts on the synthesized template.
if (process.env.VITEST === undefined) {
  buildApp().synth();
}
