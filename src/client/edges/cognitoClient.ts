/**
 * Internal Cognito seam for {@link CognitoAuthProvider}.
 *
 * This module is the *only* place in the client that references
 * `amazon-cognito-identity-js`. It exposes a narrow, provider-agnostic
 * `CognitoClient` interface expressed purely in plain data (no Cognito types in
 * its signatures) plus a default implementation that adapts the callback-based
 * SDK to Promises.
 *
 * The seam exists so `CognitoAuthProvider` — and its unit tests — depend on a
 * small interface rather than the SDK's SRP internals: tests inject a fake
 * `CognitoClient` and never touch AWS (the real dev-pool integration is task
 * 4.3). Keeping the SDK confined here upholds the architecture's rule that no
 * identity-provider type leaks past the adapter (see
 * `.kiro/steering/architecture.md`).
 *
 * The public SPA app client is configured in `infra/identity-user-pool.ts` as a
 * secret-less client using SRP auth, which is exactly the flow
 * `amazon-cognito-identity-js` implements in the browser.
 *
 * _Requirements: R1.1, R1.2, R2.1, R2.2, R2.3, R3.1, R3.2._
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
  type ICognitoUserPoolData,
} from "amazon-cognito-identity-js";

/**
 * A verified authentication result reduced to the plain fields the adapter
 * needs. Deliberately free of any Cognito type so the seam does not leak the
 * provider outward.
 */
export interface CognitoTokens {
  /** The Cognito access token JWT, presented as a bearer token (R2.1). */
  readonly accessToken: string;
  /**
   * Access-token expiry as **epoch seconds** (Cognito's native unit). The
   * adapter converts to the epoch-milliseconds `AuthSession.expiresAt` (R2.4).
   */
  readonly expiresAtSeconds: number;
  /**
   * Player-chosen public display name resolved from the ID token, or `null`
   * when the pool did not carry one. Never the private identifier (R11.3).
   */
  readonly displayName: string | null;
}

/**
 * The identity operations {@link CognitoAuthProvider} depends on, each modelled
 * as a Promise over plain data. Implemented for real by
 * {@link AmazonCognitoClient} and faked in the adapter's unit tests.
 */
export interface CognitoClient {
  /** Register an account; resolves with whether confirmation is required (R1.1, R1.2). */
  signUp(
    identifier: string,
    credential: string,
    displayName: string,
  ): Promise<{ readonly confirmationRequired: boolean }>;

  /** Complete identifier verification with the emailed code (R1.5). */
  confirm(identifier: string, code: string): Promise<void>;

  /** Authenticate via SRP, resolving verified tokens (R2.1, R2.2). */
  signIn(identifier: string, credential: string): Promise<CognitoTokens>;

  /** Sign the identifier out locally, invalidating cached tokens (R2.3). */
  signOut(identifier: string): Promise<void>;

  /** Begin forgot-password recovery through the verified email (R3.1). */
  startRecovery(identifier: string): Promise<void>;

  /** Set a new credential using the recovery code (R3.2, R3.3). */
  completeRecovery(
    identifier: string,
    code: string,
    newCredential: string,
  ): Promise<void>;
}

/** The custom attribute name the display name is stored under at sign-up. */
const DISPLAY_NAME_ATTRIBUTE = "name";

/**
 * Configuration the {@link AmazonCognitoClient} needs to reach a specific user
 * pool app client. These values are produced by the CDK identity stack
 * (`infra/identity-user-pool.ts`) as stack outputs and supplied to the client
 * build at the composition root.
 */
export interface CognitoClientConfig {
  /** The Cognito user pool ID (e.g. `us-east-1_abc123`). */
  readonly userPoolId: string;
  /** The public SPA app client ID (no secret). */
  readonly clientId: string;
}

/**
 * The real {@link CognitoClient}, backed by `amazon-cognito-identity-js`. It
 * translates the SDK's callback API into Promises and reduces its session
 * objects to {@link CognitoTokens}. Constructed only at the composition root;
 * unit tests use a fake instead.
 */
export class AmazonCognitoClient implements CognitoClient {
  private readonly pool: CognitoUserPool;

  public constructor(config: CognitoClientConfig) {
    const poolData: ICognitoUserPoolData = {
      UserPoolId: config.userPoolId,
      ClientId: config.clientId,
    };
    this.pool = new CognitoUserPool(poolData);
  }

  public signUp(
    identifier: string,
    credential: string,
    displayName: string,
  ): Promise<{ readonly confirmationRequired: boolean }> {
    const attributes = [
      new CognitoUserAttribute({ Name: DISPLAY_NAME_ATTRIBUTE, Value: displayName }),
    ];
    return new Promise((resolve, reject) => {
      this.pool.signUp(identifier, credential, attributes, [], (err, result) => {
        if (err) {
          reject(toError(err));
          return;
        }
        resolve({ confirmationRequired: result?.userConfirmed !== true });
      });
    });
  }

  public confirm(identifier: string, code: string): Promise<void> {
    const user = this.user(identifier);
    return new Promise((resolve, reject) => {
      user.confirmRegistration(code, true, (err) => {
        if (err) {
          reject(toError(err));
          return;
        }
        resolve();
      });
    });
  }

  public signIn(identifier: string, credential: string): Promise<CognitoTokens> {
    const user = this.user(identifier);
    const details = new AuthenticationDetails({
      Username: identifier,
      Password: credential,
    });
    return new Promise((resolve, reject) => {
      user.authenticateUser(details, {
        onSuccess: (session) => resolve(toTokens(session)),
        onFailure: (err) => reject(toError(err)),
      });
    });
  }

  public signOut(identifier: string): Promise<void> {
    return new Promise((resolve) => {
      this.user(identifier).signOut(() => resolve());
    });
  }

  public startRecovery(identifier: string): Promise<void> {
    const user = this.user(identifier);
    return new Promise((resolve, reject) => {
      user.forgotPassword({
        onSuccess: () => resolve(),
        onFailure: (err) => reject(toError(err)),
      });
    });
  }

  public completeRecovery(
    identifier: string,
    code: string,
    newCredential: string,
  ): Promise<void> {
    const user = this.user(identifier);
    return new Promise((resolve, reject) => {
      user.confirmPassword(code, newCredential, {
        onSuccess: () => resolve(),
        onFailure: (err) => reject(toError(err)),
      });
    });
  }

  private user(identifier: string): CognitoUser {
    return new CognitoUser({ Username: identifier, Pool: this.pool });
  }
}

/** Reduce a Cognito session to the plain {@link CognitoTokens} the seam exposes. */
function toTokens(session: CognitoUserSession): CognitoTokens {
  const accessToken = session.getAccessToken();
  // `decodePayload()` is typed `{ [id: string]: any }`; treat claims as `unknown`
  // and narrow, so nothing untyped escapes this function.
  const idPayload: Record<string, unknown> = session.getIdToken().decodePayload();
  const displayNameClaim = idPayload[DISPLAY_NAME_ATTRIBUTE];
  return {
    accessToken: accessToken.getJwtToken(),
    expiresAtSeconds: accessToken.getExpiration(),
    displayName: typeof displayNameClaim === "string" ? displayNameClaim : null,
  };
}

/**
 * Normalise the SDK's `unknown`/`Error`-ish failures into a real `Error`
 * without inspecting or reshaping the provider's message — preserving R2.2 and
 * R3.4 (the pool is configured with `preventUserExistenceErrors`, so the
 * message the caller sees is Cognito's non-disclosing one, passed through
 * untouched).
 */
function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    const { message } = err;
    if (typeof message === "string") {
      return new Error(message);
    }
  }
  return new Error(String(err));
}
