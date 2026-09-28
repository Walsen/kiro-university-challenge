/**
 * `CognitoAuthProvider` — client edge adapter implementing the {@link AuthProvider}
 * port against Amazon Cognito.
 *
 * This is the one adapter the design names for identity (see the Phase 2 design,
 * "Identity (R1–R3, R11)"). Per the hexagonal architecture it lives in the
 * client edges layer and depends *inward* on the `AuthProvider` port and on the
 * narrow {@link CognitoClient} seam; the rest of the client depends only on the
 * port, so no Cognito type ever leaks past this file (Dependency Inversion).
 *
 * The provider is otherwise a thin translation layer:
 *  - it forwards sign-up / confirm / recovery straight through to the seam, and
 *  - it turns a successful SRP sign-in into a provider-agnostic
 *    {@link AuthSession} with a **bounded lifetime**, caching it so
 *    {@link AuthProvider.currentSession} can answer synchronously and
 *    {@link AuthProvider.signOut} can clear it (R2.1, R2.3, R2.4).
 *
 * Side effects (network, token storage) live in the injected seam; this class
 * holds only the current session in memory, which keeps it unit-testable
 * against a fake seam without touching AWS (task 4.3 covers the real pool).
 *
 * _Requirements: R1.1, R1.2, R2.1, R2.2, R2.3, R3.1, R3.2._
 */
import type { AuthProvider, AuthSession, SignUpResult } from "../ports";
import type { CognitoClient, CognitoTokens } from "./cognitoClient";

/** Milliseconds per second, for converting Cognito's epoch-seconds expiry. */
const MILLIS_PER_SECOND = 1000;

export class CognitoAuthProvider implements AuthProvider {
  /** The current public session, or `null` when none is established. */
  private session: AuthSession | null = null;

  /**
   * The identifier of the currently signed-in Player, retained privately so
   * `signOut` can target the right user (Cognito's `signOut` is per-user). It
   * is the Player's private identifier and is never exposed to callers (R11.3).
   */
  private identifierForSignOut: string | null = null;

  /**
   * @param client the Cognito seam performing the actual identity operations;
   *   {@link AmazonCognitoClient} in production, a fake in tests.
   */
  public constructor(private readonly client: CognitoClient) {}

  public async signUp(
    identifier: string,
    credential: string,
    displayName: string,
  ): Promise<SignUpResult> {
    const { confirmationRequired } = await this.client.signUp(
      identifier,
      credential,
      displayName,
    );
    return { identifier, displayName, confirmationRequired };
  }

  public confirm(identifier: string, code: string): Promise<void> {
    return this.client.confirm(identifier, code);
  }

  public async signIn(identifier: string, credential: string): Promise<AuthSession> {
    const tokens = await this.client.signIn(identifier, credential);
    const session = toSession(tokens, identifier);
    this.session = session;
    this.identifierForSignOut = identifier;
    return session;
  }

  public async signOut(): Promise<void> {
    const identifier = this.identifierForSignOut;
    if (identifier !== null) {
      await this.client.signOut(identifier);
    }
    this.session = null;
    this.identifierForSignOut = null;
  }

  public currentSession(): AuthSession | null {
    return this.session;
  }

  public startRecovery(identifier: string): Promise<void> {
    return this.client.startRecovery(identifier);
  }

  public completeRecovery(
    identifier: string,
    code: string,
    newCredential: string,
  ): Promise<void> {
    return this.client.completeRecovery(identifier, code, newCredential);
  }
}

/** Build the provider-agnostic session from verified tokens (R2.1, R2.4). */
function toSession(tokens: CognitoTokens, identifier: string): AuthSession {
  return {
    accessToken: tokens.accessToken,
    // Fall back to the identifier only if the pool carried no display name;
    // the public display name is never the private identifier by design.
    displayName: tokens.displayName ?? identifier,
    expiresAt: tokens.expiresAtSeconds * MILLIS_PER_SECOND,
  };
}
