/**
 * Unit tests for `CognitoAuthProvider` (client edge adapter for the
 * `AuthProvider` port).
 *
 * The adapter is exercised against a fake {@link CognitoClient} seam — never
 * real AWS (the real dev-pool integration is task 4.3). The fake records calls
 * and returns canned tokens so the tests can assert the adapter's own
 * behaviour: forwarding sign-up/confirm/recovery through the seam, turning a
 * sign-in into a bounded-lifetime {@link AuthSession}, caching it for
 * `currentSession`, and clearing it on `signOut`.
 *
 * _Requirements: R1.1, R1.2, R2.1, R2.2, R2.3, R3.1, R3.2._
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../ports";
import { CognitoAuthProvider } from "./CognitoAuthProvider";
import type { CognitoClient, CognitoTokens } from "./cognitoClient";

/** A fully controllable fake seam: every method is a spy with overridable behaviour. */
interface FakeClient extends CognitoClient {
  signUp: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  signIn: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  startRecovery: ReturnType<typeof vi.fn>;
  completeRecovery: ReturnType<typeof vi.fn>;
}

/** Canned tokens for a successful sign-in; expiry is in epoch **seconds**. */
const TOKENS: CognitoTokens = {
  accessToken: "header.payload.signature",
  expiresAtSeconds: 1_700_000_000,
  displayName: "Player One",
};

function makeFakeClient(overrides: Partial<CognitoClient> = {}): FakeClient {
  const client: FakeClient = {
    signUp: vi.fn().mockResolvedValue({ confirmationRequired: true }),
    confirm: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(TOKENS),
    signOut: vi.fn().mockResolvedValue(undefined),
    startRecovery: vi.fn().mockResolvedValue(undefined),
    completeRecovery: vi.fn().mockResolvedValue(undefined),
  };
  Object.assign(client, overrides);
  return client;
}

describe("CognitoAuthProvider", () => {
  let client: FakeClient;
  let provider: CognitoAuthProvider;

  beforeEach(() => {
    client = makeFakeClient();
    provider = new CognitoAuthProvider(client);
  });

  describe("signUp (R1.1, R1.2)", () => {
    it("forwards identifier, credential, and display name to the seam", async () => {
      await provider.signUp("player@example.com", "S3cret-Passw0rd!", "Player One");

      expect(client.signUp).toHaveBeenCalledTimes(1);
      expect(client.signUp).toHaveBeenCalledWith(
        "player@example.com",
        "S3cret-Passw0rd!",
        "Player One",
      );
    });

    it("reports confirmation is required when the pool withholds sign-in (R1.5)", async () => {
      const result = await provider.signUp(
        "player@example.com",
        "S3cret-Passw0rd!",
        "Player One",
      );

      expect(result).toEqual({
        identifier: "player@example.com",
        displayName: "Player One",
        confirmationRequired: true,
      });
    });

    it("reports no confirmation when the seam auto-confirms the account", async () => {
      client.signUp.mockResolvedValue({ confirmationRequired: false });

      const result = await provider.signUp("p@example.com", "S3cret-Passw0rd!", "P");

      expect(result.confirmationRequired).toBe(false);
    });

    it("propagates a sign-up rejection (e.g. identifier already registered, R1.2)", async () => {
      client.signUp.mockRejectedValue(
        new Error("An account with the given email already exists."),
      );

      await expect(
        provider.signUp("taken@example.com", "S3cret-Passw0rd!", "P"),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe("confirm (R1.5)", () => {
    it("forwards the identifier and verification code to the seam", async () => {
      await provider.confirm("player@example.com", "123456");

      expect(client.confirm).toHaveBeenCalledTimes(1);
      expect(client.confirm).toHaveBeenCalledWith("player@example.com", "123456");
    });
  });

  describe("signIn (R2.1, R2.4)", () => {
    it("returns a session carrying the access token and display name", async () => {
      const session = await provider.signIn("player@example.com", "S3cret-Passw0rd!");

      expect(session.accessToken).toBe(TOKENS.accessToken);
      expect(session.displayName).toBe("Player One");
    });

    it("converts the bounded expiry from epoch seconds to epoch milliseconds (R2.4)", async () => {
      const session = await provider.signIn("player@example.com", "S3cret-Passw0rd!");

      expect(session.expiresAt).toBe(TOKENS.expiresAtSeconds * 1000);
    });

    it("authenticates via the seam with the supplied credentials (R2.1)", async () => {
      await provider.signIn("player@example.com", "S3cret-Passw0rd!");

      expect(client.signIn).toHaveBeenCalledTimes(1);
      expect(client.signIn).toHaveBeenCalledWith(
        "player@example.com",
        "S3cret-Passw0rd!",
      );
    });

    it("falls back to the identifier when the pool carries no display name", async () => {
      client.signIn.mockResolvedValue({ ...TOKENS, displayName: null });

      const session = await provider.signIn("player@example.com", "S3cret-Passw0rd!");

      expect(session.displayName).toBe("player@example.com");
    });

    it("propagates an invalid-credential failure without revealing the factor (R2.2)", async () => {
      // preventUserExistenceErrors makes Cognito return a single generic message;
      // the adapter passes it through unchanged.
      client.signIn.mockRejectedValue(new Error("Incorrect username or password."));

      await expect(
        provider.signIn("player@example.com", "wrong-Passw0rd!"),
      ).rejects.toThrow("Incorrect username or password.");
    });

    it("does not establish a session when sign-in fails", async () => {
      client.signIn.mockRejectedValue(new Error("Incorrect username or password."));

      await expect(provider.signIn("player@example.com", "nope")).rejects.toThrow();

      expect(provider.currentSession()).toBeNull();
    });
  });

  describe("currentSession (R2.1)", () => {
    it("is null before any sign-in", () => {
      expect(provider.currentSession()).toBeNull();
    });

    it("reflects the session established by signIn", async () => {
      const signedIn = await provider.signIn("player@example.com", "S3cret-Passw0rd!");
      const current = provider.currentSession();

      expect(current).toEqual(signedIn);
    });

    it("exposes only the public session shape, not the private sign-out identifier (R11.3)", async () => {
      await provider.signIn("player@example.com", "S3cret-Passw0rd!");

      const current = provider.currentSession() as AuthSession & Record<string, unknown>;

      expect(Object.keys(current).sort()).toEqual(
        ["accessToken", "displayName", "expiresAt"].sort(),
      );
      expect(current["identifierForSignOut"]).toBeUndefined();
    });
  });

  describe("signOut (R2.3)", () => {
    it("clears the current session", async () => {
      await provider.signIn("player@example.com", "S3cret-Passw0rd!");

      await provider.signOut();

      expect(provider.currentSession()).toBeNull();
    });

    it("signs the authenticated identifier out through the seam", async () => {
      await provider.signIn("player@example.com", "S3cret-Passw0rd!");

      await provider.signOut();

      expect(client.signOut).toHaveBeenCalledTimes(1);
      expect(client.signOut).toHaveBeenCalledWith("player@example.com");
    });

    it("is a safe no-op when there is no current session", async () => {
      await expect(provider.signOut()).resolves.toBeUndefined();

      expect(client.signOut).not.toHaveBeenCalled();
      expect(provider.currentSession()).toBeNull();
    });
  });

  describe("startRecovery (R3.1)", () => {
    it("forwards the identifier to the seam", async () => {
      await provider.startRecovery("player@example.com");

      expect(client.startRecovery).toHaveBeenCalledTimes(1);
      expect(client.startRecovery).toHaveBeenCalledWith("player@example.com");
    });

    it("propagates seam failures", async () => {
      client.startRecovery.mockRejectedValue(new Error("LimitExceededException"));

      await expect(provider.startRecovery("player@example.com")).rejects.toThrow(
        /LimitExceeded/,
      );
    });
  });

  describe("completeRecovery (R3.2)", () => {
    it("forwards identifier, code, and new credential to the seam", async () => {
      await provider.completeRecovery("player@example.com", "654321", "N3w-Passw0rd!");

      expect(client.completeRecovery).toHaveBeenCalledTimes(1);
      expect(client.completeRecovery).toHaveBeenCalledWith(
        "player@example.com",
        "654321",
        "N3w-Passw0rd!",
      );
    });

    it("propagates an expired/used code rejection (R3.3)", async () => {
      client.completeRecovery.mockRejectedValue(
        new Error("Invalid code provided, please request a code again."),
      );

      await expect(
        provider.completeRecovery("player@example.com", "000000", "N3w-Passw0rd!"),
      ).rejects.toThrow(/Invalid code/);
    });
  });
});
