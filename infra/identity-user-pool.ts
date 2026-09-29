import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

/**
 * Minimum password length the Platform accepts. Longer than Cognito's default of 8 so a
 * weak credential is rejected at sign-up (R1.3); paired with the character-class rules
 * below it forms the "stated Credential policy" the requirement refers to.
 */
const MIN_PASSWORD_LENGTH = 12;

/**
 * The pool name and the prefix used to build the Cognito hosted sign-in domain.
 * Environment-agnostic (no `-dev`/`-prod` suffix) because there is one shared user pool for
 * the single backend (D6); the hosted domain still appends the account-scoped node address
 * so it stays globally unique while within Cognito's domain-prefix character rules.
 */
const USER_POOL_NAME = "maze-game-platform";

/**
 * The Cognito SPA app client name. Environment-agnostic for the same single-backend reason.
 */
const SPA_CLIENT_NAME = "maze-game-platform-spa";

/**
 * The Cognito hosted sign-in domain prefix. The full domain is `<prefix>-<account>` so it
 * is globally unique across accounts while staying within the domain-prefix character rules.
 */
const HOSTED_DOMAIN_PREFIX = "maze-game-platform";

/**
 * The Cognito identity for the Maze Game Platform (task 2.1, R1–R3, R11): a user pool plus
 * a public SPA app client and a hosted sign-in domain.
 *
 * The requirements this construct configures in IaC:
 *
 *  - **Email-verified accounts (R1.1, R1.5).** Email is the sign-in identifier and is
 *    auto-verified, so Cognito withholds sign-in until the Player confirms the address and
 *    provides the confirmation code as the means to complete verification.
 *  - **Credential policy (R1.3).** A password policy (length + all four character classes)
 *    rejects weak credentials at sign-up and surfaces which rule failed. Cognito stores only
 *    a salted hash of the password, never the plaintext (R1.4) — an inherent guarantee of
 *    the service.
 *  - **Failed-attempt lockout (R2.5).** Advanced security enforcement engages Cognito's
 *    adaptive protections, which include locking an identifier after repeated failed
 *    sign-ins, limiting automated credential guessing.
 *  - **Self-service recovery (R3.1–R3.3).** Account recovery is via the verified email — a
 *    channel the owner controls — and the emitted code has a bounded validity window after
 *    which it is rejected.
 *
 * The app client is a **public** SPA client (no generated secret, since a browser cannot
 * keep one) using SRP auth so the password is never sent in the clear. The user pool ID and
 * client ID are surfaced by {@link PlatformStack} as stack outputs so the client build and
 * the API's JWT authorizer (task 2.2) can find the pool they validate tokens against.
 */
export class IdentityUserPool extends Construct {
  /** The Cognito user pool holding Player accounts. */
  public readonly userPool: cognito.UserPool;

  /** The public app client the SPA authenticates through. */
  public readonly userPoolClient: cognito.UserPoolClient;

  /** The hosted/managed sign-in domain for the pool. */
  public readonly userPoolDomain: cognito.UserPoolDomain;

  public constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: USER_POOL_NAME,
      // Email is the identifier Players sign in with, and it is self-service (R1.1).
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // Withhold sign-in until the emailed code is entered — the means to complete
      // verification (R1.5).
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      // Reject weak credentials with a stated policy (R1.3). Cognito always stores only a
      // non-reversible hash of the password (R1.4).
      passwordPolicy: {
        minLength: MIN_PASSWORD_LENGTH,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(1),
      },
      // Recovery flows through the verified email, a channel the Account owner controls
      // (R3.1); the code's validity window bounds its lifetime (R3.3).
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Engage Cognito's adaptive threat protection, which includes failed-attempt lockout
      // to limit automated credential guessing (R2.5). Threat protection requires the PLUS
      // feature plan; FULL_FUNCTION lets Cognito take preventative action rather than only
      // audit. (This is the non-deprecated replacement for `advancedSecurityMode`.)
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      // The single shared pool holds real accounts and is never disposable, so it always
      // retains on stack replacement — a replacement never silently deletes real Players
      // (D6, prod-grade posture always).
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient("SpaClient", {
      userPoolClientName: SPA_CLIENT_NAME,
      // A browser SPA is a public client: it cannot keep a secret, so none is generated.
      generateSecret: false,
      // SRP keeps the password off the wire; refresh flow supports the bounded-lifetime
      // token model (R2.1, R2.4). USER_PASSWORD (plaintext) is deliberately not enabled.
      authFlows: {
        userSrp: true,
      },
      // Bounded token lifetime (R2.4): access/id tokens are short-lived and refreshed.
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // A hosted/managed sign-in experience for the pool. The prefix is made unique per
    // account (via the node address) so it never collides on the global namespace.
    this.userPoolDomain = this.userPool.addDomain("HostedDomain", {
      cognitoDomain: {
        domainPrefix: `${HOSTED_DOMAIN_PREFIX}-${this.node.addr.slice(0, 8)}`,
      },
    });
  }
}
