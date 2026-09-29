/**
 * Unit tests for the account-deletion handler `DELETE /account/me` (task 11.2,
 * R11.5) against an in-memory {@link AccountData} fake.
 *
 * No AWS: the handler is a pure orchestration seam (read the caller's account
 * from the JWT, erase scoped data via the port, shape JSON), so it is exercised
 * with a fake and plain event objects.
 *
 * Acceptance criteria under test:
 *  - R11.5 — a successful request erases the caller's own account data and
 *    reports how many items were removed; deletion is idempotent (a caller with
 *    nothing left still succeeds).
 *  - R11.2 — per-account isolation: the erased account is the JWT `sub` and
 *    nothing else, so a caller can never delete another account. A
 *    client-supplied `accountId` is inert. A request with no account identity is
 *    rejected (401) with nothing deleted.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { makeDeleteAccountHandler } from "./deleteAccount";
import type { HttpApiEvent } from "./http";
import type { AccountData, DeleteAccountResult } from "../ports/AccountData";

// ---------------------------------------------------------------------------
// A recording in-memory AccountData fake that enforces per-account scoping
// ---------------------------------------------------------------------------

/**
 * The fake stores an item count per account so a delete for one account can
 * never remove another's — this lets the isolation tests prove the handler
 * passes the JWT `sub` through unchanged rather than the fake merely pretending
 * to isolate.
 */
class FakeAccountData implements AccountData {
  /** account id -> remaining item count. */
  private readonly countByAccount = new Map<string, number>();
  /** Records the accountId each delete call was scoped to, in order. */
  public readonly deleteCalls: string[] = [];

  public seed(accountId: string, itemCount: number): void {
    this.countByAccount.set(accountId, itemCount);
  }

  public deleteAccount(accountId: string): Promise<DeleteAccountResult> {
    this.deleteCalls.push(accountId);
    const itemsDeleted = this.countByAccount.get(accountId) ?? 0;
    this.countByAccount.set(accountId, 0);
    return Promise.resolve({ itemsDeleted });
  }
}

// ---------------------------------------------------------------------------
// Fixtures + event builders
// ---------------------------------------------------------------------------

const ACCOUNT_A = "cognito-sub-aaa";
const ACCOUNT_B = "cognito-sub-bbb";

function authedEvent(
  sub: string | null,
  query?: Record<string, string | undefined>,
): HttpApiEvent {
  return {
    queryStringParameters: query ?? null,
    requestContext: sub === null ? {} : { authorizer: { jwt: { claims: { sub } } } },
  };
}

// ---------------------------------------------------------------------------
// DELETE /account/me
// ---------------------------------------------------------------------------

describe("DELETE /account/me handler (R11.5)", () => {
  let accountData: FakeAccountData;

  beforeEach(() => {
    accountData = new FakeAccountData();
  });

  it("erases the caller's own account, scoped to the JWT sub (R11.5, R11.2)", async () => {
    accountData.seed(ACCOUNT_A, 4);
    const handler = makeDeleteAccountHandler({ accountData });

    const result = await handler(authedEvent(ACCOUNT_A));
    const payload = JSON.parse(result.body) as {
      deleted: boolean;
      itemsDeleted: number;
    };

    expect(result.statusCode).toBe(200);
    expect(payload).toEqual({ deleted: true, itemsDeleted: 4 });
    // The erasure was scoped to the caller's own sub, never a client field.
    expect(accountData.deleteCalls).toEqual([ACCOUNT_A]);
  });

  it("ignores a client-supplied accountId, deleting only the JWT sub's account (R11.2)", async () => {
    accountData.seed(ACCOUNT_A, 2);
    accountData.seed(ACCOUNT_B, 5);
    const handler = makeDeleteAccountHandler({ accountData });

    // Caller A tries to delete B by supplying an accountId param. The handler
    // derives the account only from the JWT sub, so the injected id is inert.
    await handler(authedEvent(ACCOUNT_A, { accountId: ACCOUNT_B, sub: ACCOUNT_B }));

    expect(accountData.deleteCalls).toEqual([ACCOUNT_A]);
  });

  it("is idempotent: a caller with nothing left still succeeds with itemsDeleted 0 (R11.5)", async () => {
    const handler = makeDeleteAccountHandler({ accountData });

    const result = await handler(authedEvent(ACCOUNT_A));
    const payload = JSON.parse(result.body) as { deleted: boolean; itemsDeleted: number };

    expect(result.statusCode).toBe(200);
    expect(payload).toEqual({ deleted: true, itemsDeleted: 0 });
  });

  it("rejects a request with no authenticated account (401) and deletes nothing (R11.2)", async () => {
    const handler = makeDeleteAccountHandler({ accountData });

    const result = await handler(authedEvent(null));

    expect(result.statusCode).toBe(401);
    expect(accountData.deleteCalls).toHaveLength(0);
  });

  it("sheds a downstream capacity failure as a retryable 429 (R7.3)", async () => {
    const throttling: AccountData = {
      deleteAccount(): Promise<DeleteAccountResult> {
        return Promise.reject(
          Object.assign(new Error("throttled"), { name: "ThrottlingException" }),
        );
      },
    };
    const handler = makeDeleteAccountHandler({ accountData: throttling });

    const result = await handler(authedEvent(ACCOUNT_A));

    expect(result.statusCode).toBe(429);
    expect(result.headers["retry-after"]).toBeDefined();
  });

  it("propagates an unexpected fault rather than reporting success", async () => {
    const broken: AccountData = {
      deleteAccount(): Promise<DeleteAccountResult> {
        return Promise.reject(new Error("boom"));
      },
    };
    const handler = makeDeleteAccountHandler({ accountData: broken });

    await expect(handler(authedEvent(ACCOUNT_A))).rejects.toThrow("boom");
  });
});
