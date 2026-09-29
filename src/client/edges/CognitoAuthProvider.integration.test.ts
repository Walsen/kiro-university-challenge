/**
 * Integration seam test: client ↔ Cognito (real dev user pool). Task 4.3.
 *
 * This is a **cloud-seam** integration test in the sense the testing steering
 * requires: it composes the *real* components on the client side of the seam —
 * the `CognitoAuthProvider` adapter over the real `AmazonCognitoClient`
 * (`amazon-cognito-identity-js`) — against the **real** dev Cognito user pool
 * provisioned by CDK (`infra/identity-user-pool.ts`, task 2.1). Nothing on the
 * Cognito side is faked; only what is genuinely external to the application is
 * replaced.
 *
 * The one genuinely-external thing is the Player's **email inbox**: email
 * verification (R1.5) delivers a confirmation code out of band, which an
 * automated test cannot read. So the test confirms the freshly signed-up
 * account administratively via `AdminConfirmSignUp` — a real server-side
 * operation, not a stub of Cognito — standing in for the human clicking the
 * emailed code. Every other step (SRP sign-in, token issuance, sign-out,
 * recovery initiation) runs through the real adapter against the real pool.
 *
 * The seam under test (design "Deploy-First Delivery and Integration Seams"):
 *   client ↔ Cognito — sign-up → confirm → sign-in → token → sign-out.
 *
 * Assertions:
 *   - R1.1 / R2.1: a signed-up, confirmed account signs in and receives a
 *     bearer token with a bounded lifetime.
 *   - R2.2: invalid credentials are rejected without revealing which factor
 *     (username vs. password) was wrong — the pool's
 *     `preventUserExistenceErrors` yields one generic message.
 *   - R3.4: initiating recovery for an unknown identifier does not disclose
 *     whether the identifier exists.
 *
 * Gating: the test needs AWS credentials and a deployed pool, which are not
 * present in the ordinary unit run or in CI's `vitest run`. It therefore
 * **self-skips** unless the pool is supplied via the environment, so it never
 * breaks a no-AWS run. Run it explicitly (e.g. to satisfy the G1 gate) with:
 *
 *   MAZE_COGNITO_USER_POOL_ID=us-east-1_xxxx \
 *   MAZE_COGNITO_CLIENT_ID=xxxxxxxx \
 *   AWS_REGION=us-east-1 \
 *   devbox run -- npx vitest run src/client/edges/CognitoAuthProvider.integration.test.ts
 *
 * The pool/client IDs are the CDK stack outputs `UserPoolId` /
 * `UserPoolClientId` of `MazeGamePlatform-dev`; never hardcode them.
 *
 * _Requirements: R1.1, R2.1, R2.2, R3.4; design "integration seams"._
 */
import {
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AmazonCognitoClient } from "./cognitoClient";
import { CognitoAuthProvider } from "./CognitoAuthProvider";

/**
 * Read a process environment variable without pulling `@types/node` into this
 * browser/jsdom-typed project. The test runs under Node (Vitest), so `process`
 * exists at runtime; we reach it through `globalThis` behind a narrow local type
 * rather than widening the project's ambient globals. Returns `undefined` when
 * the variable (or `process` itself) is absent.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[name];
}

/** Pool configuration, supplied out of band from the CDK dev-stack outputs. */
const USER_POOL_ID = readEnv("MAZE_COGNITO_USER_POOL_ID");
const CLIENT_ID = readEnv("MAZE_COGNITO_CLIENT_ID");
const AWS_REGION = readEnv("AWS_REGION") ?? "us-east-1";

/** Present only when both pool identifiers were provided for a real run. */
const poolConfigured = Boolean(USER_POOL_ID && CLIENT_ID);

/**
 * A credential that satisfies the pool's policy (≥ 12 chars, all four character
 * classes — see `identity-user-pool.ts`). Reused as the "correct" password.
 */
const VALID_CREDENTIAL = "S3cret-Passw0rd!x";

/** A distinct, policy-satisfying password that is simply *not* this user's. */
const WRONG_CREDENTIAL = "Wr0ng-Passw0rd!x";

/**
 * A unique email per run so repeated runs never collide on an existing account
 * and one run cannot see another's leftovers. Uses the reserved `example.com`
 * domain, which can receive no real mail — fitting, since we confirm via admin.
 */
function uniqueIdentifier(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `maze-seam-${unique}@example.com`;
}

// The seam only exists when a real pool is supplied; otherwise skip cleanly so
// the ordinary no-AWS unit run and CI stay green.
describe.skipIf(!poolConfigured)("client ↔ Cognito seam (real dev pool)", () => {
  // Non-null assertions are safe here: `skipIf` guarantees both identifiers are
  // set whenever this block runs.
  const userPoolId = USER_POOL_ID as string;
  const clientId = CLIENT_ID as string;

  // Constructed in `beforeAll`, not at collection time: instantiating
  // `AmazonCognitoClient` requires a non-empty pool/client, so building it
  // eagerly in the describe body would throw during collection on a no-AWS run
  // even though `skipIf` means no test would run. Deferring keeps the skip clean.
  let provider: CognitoAuthProvider;
  let admin: CognitoIdentityProviderClient;

  // Track every identifier created so cleanup removes them even on assertion
  // failure, keeping the dev pool free of test residue.
  const createdIdentifiers: string[] = [];

  beforeAll(() => {
    // The real adapter over the real SDK client — the client side of the seam.
    provider = new CognitoAuthProvider(new AmazonCognitoClient({ userPoolId, clientId }));
    // A separate admin client stands in for the external email inbox (confirm)
    // and cleans up the disposable dev account afterwards.
    admin = new CognitoIdentityProviderClient({ region: AWS_REGION });
  });

  afterAll(async () => {
    await Promise.all(
      createdIdentifiers.map((identifier) =>
        admin
          .send(
            new AdminDeleteUserCommand({
              UserPoolId: userPoolId,
              Username: identifier,
            }),
          )
          // Cleanup is best-effort: a user that never got created (e.g. a failed
          // sign-up) has nothing to delete, and that must not fail the suite.
          .catch(() => undefined),
      ),
    );
  });

  it(
    "signs up, confirms, signs in for a bounded-lifetime token, then signs out (R1.1, R2.1)",
    async () => {
      const identifier = uniqueIdentifier();
      createdIdentifiers.push(identifier);

      // sign-up (R1.1): the real pool requires confirmation before sign-in (R1.5).
      const signUp = await provider.signUp(identifier, VALID_CREDENTIAL, "Seam Player");
      expect(signUp.identifier).toBe(identifier);
      expect(signUp.confirmationRequired).toBe(true);

      // confirm: stand in for the emailed code (the external inbox) with a real
      // admin confirmation, so the rest of the flow runs against a verified account.
      await admin.send(
        new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: identifier }),
      );

      // sign-in (R2.1): real SRP through the adapter yields a session with a
      // bearer token and a bounded expiry in the future.
      const before = Date.now();
      const session = await provider.signIn(identifier, VALID_CREDENTIAL);
      expect(session.accessToken.length).toBeGreaterThan(0);
      // A JWT is three dot-separated segments; a crude but real shape check.
      expect(session.accessToken.split(".")).toHaveLength(3);
      expect(session.expiresAt).toBeGreaterThan(before);
      expect(provider.currentSession()).toEqual(session);

      // sign-out (R2.3): the cached session is cleared.
      await provider.signOut();
      expect(provider.currentSession()).toBeNull();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "rejects invalid credentials without revealing which factor was wrong (R2.2)",
    async () => {
      const identifier = uniqueIdentifier();
      createdIdentifiers.push(identifier);

      await provider.signUp(identifier, VALID_CREDENTIAL, "Seam Player");
      await admin.send(
        new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: identifier }),
      );

      // Wrong password for an account that DOES exist.
      const wrongPassword = provider
        .signIn(identifier, WRONG_CREDENTIAL)
        .then(() => {
          throw new Error("sign-in unexpectedly succeeded with the wrong password");
        })
        .catch((error: unknown) => messageOf(error));

      // Any password for an account that does NOT exist.
      const unknownUser = provider
        .signIn(uniqueIdentifier(), VALID_CREDENTIAL)
        .then(() => {
          throw new Error("sign-in unexpectedly succeeded for an unknown identifier");
        })
        .catch((error: unknown) => messageOf(error));

      const [wrongPasswordMessage, unknownUserMessage] = await Promise.all([
        wrongPassword,
        unknownUser,
      ]);

      // Both fail, and both fail with the SAME generic message — so the failure
      // does not reveal whether it was the identifier or the password that was
      // wrong (preventUserExistenceErrors, R2.2).
      expect(wrongPasswordMessage).toBe(unknownUserMessage);
      // And the message names neither factor specifically.
      expect(wrongPasswordMessage.toLowerCase()).not.toContain("user does not exist");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "does not disclose whether an identifier exists when recovery is initiated (R3.4)",
    async () => {
      // Recovery for an identifier that was never registered must not reveal
      // that it is unknown: with preventUserExistenceErrors the pool responds as
      // though a code were sent, so the adapter resolves without error.
      const unknownIdentifier = uniqueIdentifier();

      await expect(provider.startRecovery(unknownIdentifier)).resolves.toBeUndefined();
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

/** A generous per-test budget: real Cognito round-trips (SRP) are not instant. */
const INTEGRATION_TIMEOUT_MS = 30_000;

/** The message of an unknown thrown value, for comparing failure disclosure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
