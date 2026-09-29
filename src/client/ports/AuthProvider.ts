/**
 * Client-side identity port (ports-and-adapters).
 *
 * `AuthProvider` is the abstraction the client depends on for account creation,
 * sign-in/out, and account recovery. Per the Phase 2 design and the Dependency
 * Inversion principle, the rest of the client talks only to this interface;
 * only the `CognitoAuthProvider` adapter (task 4.2) references Amazon Cognito.
 * No identity-provider (Cognito) type appears in this contract, so pivoting to a
 * different provider is a matter of swapping the adapter behind this port.
 *
 * The interface is transcribed from the design's "Identity (R1–R3, R11)"
 * section; `SignUpResult` is defined here as a small, provider-agnostic result
 * so callers can react to identifier-verification requirements (R1.5) without
 * knowing how any provider models sign-up.
 *
 * Requirements: R1 (create account), R2 (sign in/out), R3 (recover access).
 */

/**
 * Outcome of a successful sign-up request.
 *
 * Sign-up is expected failures aside a provider-agnostic fact: an account for
 * `identifier` now exists with the chosen public `displayName`. When the
 * Platform requires identifier verification before sign-in (R1.5),
 * `confirmationRequired` is `true` and the caller must route the Player to
 * {@link AuthProvider.confirm} before {@link AuthProvider.signIn} will succeed.
 */
export interface SignUpResult {
  /** The identifier (e.g. email) the account was created for. */
  readonly identifier: string;
  /** The Player-chosen public display name (never the private identifier). */
  readonly displayName: string;
  /**
   * Whether the Player must complete identifier verification (e.g. email
   * confirmation) before an authenticated Session can be established (R1.5).
   */
  readonly confirmationRequired: boolean;
}

/**
 * An authenticated Session: a bearer token with a bounded lifetime plus the
 * public display name to show in the UI. Deliberately minimal — it exposes only
 * what the client needs and never the Player's private identifier (R11.3).
 */
export interface AuthSession {
  /** JWT presented as a bearer token; has a bounded lifetime (R2.1, R2.4). */
  readonly accessToken: string;
  /** Player-chosen public display name (R6.2, R11.3). */
  readonly displayName: string;
  /** Epoch milliseconds after which `accessToken` is no longer valid (R2.4). */
  readonly expiresAt: number;
}

/**
 * The identity capability the client depends on. Implemented by
 * `CognitoAuthProvider` in the client edges layer; substituted by fakes in
 * tests.
 */
export interface AuthProvider {
  /**
   * Create an Account for `identifier` with the given `credential` and public
   * `displayName` (R1.1). Rejects if the identifier is already registered
   * (R1.2) or the credential fails the stated policy (R1.3).
   */
  signUp(
    identifier: string,
    credential: string,
    displayName: string,
  ): Promise<SignUpResult>;

  /**
   * Complete identifier verification for `identifier` using the `code`
   * delivered through the owner-controlled channel (R1.5).
   */
  confirm(identifier: string, code: string): Promise<void>;

  /**
   * Establish an authenticated Session for a verified Account, returning a
   * bounded-lifetime token (R2.1). Rejects invalid credentials without
   * revealing which factor was wrong (R2.2).
   */
  signIn(identifier: string, credential: string): Promise<AuthSession>;

  /**
   * End the current authenticated Session so its token can no longer act as the
   * Account (R2.3).
   */
  signOut(): Promise<void>;

  /**
   * The current authenticated Session, or `null` when none is established.
   */
  currentSession(): AuthSession | null;

  /**
   * Initiate account recovery for `identifier`, sending a recovery mechanism
   * through the owner-controlled channel (R3.1). Does not reveal whether the
   * identifier exists (R3.4).
   */
  startRecovery(identifier: string): Promise<void>;

  /**
   * Complete recovery within the mechanism's validity window by setting a new
   * credential (R3.2); rejects an expired or already-used mechanism (R3.3).
   */
  completeRecovery(
    identifier: string,
    code: string,
    newCredential: string,
  ): Promise<void>;
}
