import { CfnOutput, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { GITHUB_OIDC_PROVIDER_URL } from "./config.js";

/**
 * A stack that references the single, account-level GitHub OIDC identity provider.
 *
 * An IAM OIDC provider for a given issuer URL is a per-AWS-account singleton, so the
 * GitHub Actions provider is expected to already exist in the target account. Rather than
 * creating it (which fails with `EntityAlreadyExistsException` on an account that already
 * has it), this stack imports the existing provider by ARN and shares it with every
 * environment's deploy role. Separating it from the per-environment stacks keeps the
 * environments free to be created, destroyed, or redeployed independently without
 * churning the shared provider.
 */
export class OidcProviderStack extends Stack {
  public readonly provider: iam.IOpenIdConnectProvider;

  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The provider URL without the `https://` scheme is the OIDC provider's host, which is
    // the last segment of its ARN.
    const host = GITHUB_OIDC_PROVIDER_URL.replace(/^https:\/\//, "");
    const providerArn = `arn:${this.partition}:iam::${this.account}:oidc-provider/${host}`;

    this.provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubActionsOidcProvider",
      providerArn,
    );

    new CfnOutput(this, "GitHubOidcProviderArn", {
      value: this.provider.openIdConnectProviderArn,
      description: "ARN of the shared GitHub Actions OIDC identity provider.",
      exportName: "MazeGamePlatform-GitHubOidcProviderArn",
    });
  }
}
