/**
 * Contract tests for the `AuthProvider` / `AuthSession` client port.
 *
 * The port is a pure interface (Dependency Inversion): the rest of the client
 * depends on it, and only the `CognitoAuthProvider` adapter (task 4.2) touches
 * Cognito. These tests pin the shape of that contract so a conforming fake can
 * stand in for the real adapter in the client's tests, and assert the port
 * carries no identity-provider-specific leakage.
 *
 * Because the port is types-only, the checks are largely compile-time: a fake
 * that implements the interface must type-check, and its return values must
 * match `SignUpResult` / `AuthSession`. The runtime assertions exercise that
 * fake to keep the contract executable rather than purely structural.
 *
 * Requirements: R1 (create account), R2 (sign in/out), R3 (recover access).
 */
import { describe, expect, it } from "vitest";

import type { AuthProvider, AuthSession, SignUpResult } from "./AuthProvider";

/**
 * A minimal in-memory fake implementing the whole port. Its existence and
 * type-checking is the primary assertion: the interface is implementable
 * without reference to any Cognito type. It keeps enough state (registered
 * identifiers, the current session) to exercise the contract at runtime.
 */
class FakeAuthProvider implements AuthProvider {
  private session: AuthSession | null = null;
  private readonly registered = new Set<string>();

  signUp(
    identifier: string,
    credential: string,
    displayName: string,
  ): Promise<SignUpResult> {
    this.registered.add(`${identifier}:${credential}`);
    return Promise.resolve({ identifier, displayName, confirmationRequired: true });
  }

  confirm(identifier: string, code: string): Promise<void> {
    this.registered.add(`${identifier}:confirmed:${code}`);
    return Promise.resolve();
  }

  signIn(identifier: string, credential: string): Promise<AuthSession> {
    this.session = {
      accessToken: `fake.jwt.${identifier}.${credential.length}`,
      displayName: "Player One",
      expiresAt: 1_000,
    };
    return Promise.resolve(this.session);
  }

  signOut(): Promise<void> {
    this.session = null;
    return Promise.resolve();
  }

  currentSession(): AuthSession | null {
    return this.session;
  }

  startRecovery(identifier: string): Promise<void> {
    this.registered.delete(identifier);
    return Promise.resolve();
  }

  completeRecovery(
    identifier: string,
    code: string,
    newCredential: string,
  ): Promise<void> {
    this.registered.add(`${identifier}:recovered:${code}:${newCredential.length}`);
    return Promise.resolve();
  }
}

describe("AuthProvider port contract", () => {
  it("is implementable by a fake without any identity-provider types (R1, R2, R3)", () => {
    const provider: AuthProvider = new FakeAuthProvider();
    expect(provider).toBeInstanceOf(FakeAuthProvider);
  });

  it("signUp resolves to a SignUpResult describing the created account (R1)", async () => {
    const provider: AuthProvider = new FakeAuthProvider();

    const result = await provider.signUp("player@example.com", "S3cret!!", "Player One");

    expect(result).toEqual({
      identifier: "player@example.com",
      displayName: "Player One",
      confirmationRequired: true,
    });
  });

  it("signIn returns a bounded-lifetime session exposed via currentSession (R2.1, R2.4)", async () => {
    const provider: AuthProvider = new FakeAuthProvider();
    expect(provider.currentSession()).toBeNull();

    const session = await provider.signIn("player@example.com", "S3cret!!");

    expect(session.accessToken).toContain("player@example.com");
    expect(session.displayName).toBe("Player One");
    expect(session.expiresAt).toBe(1_000);
    expect(provider.currentSession()).toEqual(session);
  });

  it("signOut clears the current session so the token can no longer act (R2.3)", async () => {
    const provider: AuthProvider = new FakeAuthProvider();
    await provider.signIn("player@example.com", "S3cret!!");

    await provider.signOut();

    expect(provider.currentSession()).toBeNull();
  });

  it("exposes the recovery flow entry points (R3.1, R3.2)", async () => {
    const provider: AuthProvider = new FakeAuthProvider();

    await expect(provider.startRecovery("player@example.com")).resolves.toBeUndefined();
    await expect(
      provider.completeRecovery("player@example.com", "123456", "N3wS3cret!!"),
    ).resolves.toBeUndefined();
  });
});
