/**
 * Unit tests for the Lambda-entry tracing shim (task 9.1, R11.4).
 *
 * The shim wraps an authenticated pure handler so each request annotates the
 * trace with the acting `accountId` (the JWT `sub`) and nothing else, then
 * delegates unchanged. These tests inject a fake annotator via the module mock
 * and assert: the account id is read from the JWT context and annotated exactly
 * once; the wrapped handler still runs and its result passes through untouched;
 * and a request with no `sub` annotates nothing (an unauthenticated route is
 * harmless to wrap).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { withAccountIdAnnotation } from "./tracing";
import type { HttpApiEvent, HttpApiResult } from "../handlers/http";
import { annotateAccountId } from "../edges/xray";

vi.mock("../edges/xray", () => ({
  annotateAccountId: vi.fn(),
}));

const annotateMock = vi.mocked(annotateAccountId);

afterEach(() => {
  vi.clearAllMocks();
});

/** An event whose JWT authorizer context carries the given `sub`. */
function eventWithSub(sub: string): HttpApiEvent {
  return {
    requestContext: { authorizer: { jwt: { claims: { sub } } } },
  };
}

const OK: HttpApiResult = {
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: "{}",
};

describe("withAccountIdAnnotation", () => {
  it("annotates the accountId from the JWT sub, then delegates", async () => {
    const inner = vi.fn((): Promise<HttpApiResult> => Promise.resolve(OK));
    const traced = withAccountIdAnnotation(inner);
    const event = eventWithSub("acct-123");

    const result = await traced(event);

    expect(annotateMock).toHaveBeenCalledTimes(1);
    expect(annotateMock).toHaveBeenCalledWith("acct-123");
    expect(inner).toHaveBeenCalledWith(event);
    expect(result).toBe(OK);
  });

  it("passes the wrapped handler's result through unchanged", async () => {
    const created: HttpApiResult = { statusCode: 201, headers: {}, body: '{"persisted":true}' };
    const traced = withAccountIdAnnotation(() => Promise.resolve(created));

    await expect(traced(eventWithSub("acct-9"))).resolves.toBe(created);
  });

  it("annotates nothing when the request has no JWT sub", async () => {
    const inner = vi.fn((): Promise<HttpApiResult> => Promise.resolve(OK));
    const traced = withAccountIdAnnotation(inner);

    await traced({ requestContext: { authorizer: {} } });

    expect(annotateMock).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
