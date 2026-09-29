/**
 * Unit tests for the X-Ray instrumentation seam (task 9.1, R11.4).
 *
 * These tests never touch AWS or an X-Ray daemon. They inject fakes for the
 * capture function and the current-segment provider so the seam's *behavior* is
 * pinned deterministically:
 *
 *  - the AWS SDK v3 client is wrapped (so DynamoDB/Cognito calls become
 *    subsegments) ONLY when the function runs under active tracing — detected by
 *    the `_X_AMZN_TRACE_ID` env var the Lambda runtime sets — and is returned
 *    unchanged otherwise (unit tests, local, browser), so no daemon is needed;
 *  - the trace annotation records `accountId` and ONLY `accountId`, never a
 *    token, credential, email, or other PII (R11.4), and no-ops safely when
 *    tracing is inactive or no segment is open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  annotateAccountId,
  captureAwsClient,
  isXrayActive,
  ACCOUNT_ID_ANNOTATION,
} from "./xray";

/** The env var the Lambda runtime sets when active tracing is enabled. */
const TRACE_ENV = "_X_AMZN_TRACE_ID";

/** Read/write `process.env` via the same `globalThis` cast the seam uses. */
function processEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  if (proc?.env === undefined) {
    throw new Error("process.env is unexpectedly absent in the test runtime");
  }
  return proc.env;
}

function setTracingActive(): void {
  processEnv()[TRACE_ENV] = "Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1";
}

function clearTracing(): void {
  delete processEnv()[TRACE_ENV];
}

afterEach(() => {
  clearTracing();
  vi.restoreAllMocks();
});

describe("isXrayActive — tracing detection", () => {
  it("is false when the runtime sets no trace id (unit tests, local, browser)", () => {
    clearTracing();
    expect(isXrayActive()).toBe(false);
  });

  it("is true when the Lambda runtime has set the trace id", () => {
    setTracingActive();
    expect(isXrayActive()).toBe(true);
  });

  it("is false when the trace id is present but empty", () => {
    processEnv()[TRACE_ENV] = "";
    expect(isXrayActive()).toBe(false);
  });
});

describe("captureAwsClient — guarded SDK v3 wrapping", () => {
  it("returns the client unchanged when tracing is inactive", () => {
    clearTracing();
    const client = { marker: "dynamo" };
    const capture = vi.fn((c: object) => ({ wrapped: c }));

    const result = captureAwsClient(client, { capture });

    expect(result).toBe(client);
    expect(capture).not.toHaveBeenCalled();
  });

  it("wraps the client via the capture fn when tracing is active", () => {
    setTracingActive();
    const client = { marker: "dynamo" };
    const wrapped = { wrapped: client };
    const capture = vi.fn(() => wrapped);

    const result = captureAwsClient(client, { capture });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(client);
    expect(result).toBe(wrapped);
  });

  it("falls back to the un-instrumented client if capture throws (never breaks the call path)", () => {
    setTracingActive();
    const client = { marker: "dynamo" };
    const capture = vi.fn(() => {
      throw new Error("no daemon");
    });

    const result = captureAwsClient(client, { capture });

    expect(result).toBe(client);
  });
});

describe("annotateAccountId — accountId-only, PII-free annotation (R11.4)", () => {
  it("no-ops when tracing is inactive (no segment lookup attempted)", () => {
    clearTracing();
    const getSegment = vi.fn();

    annotateAccountId("acct-123", { getSegment });

    expect(getSegment).not.toHaveBeenCalled();
  });

  it("annotates only the accountId on the current segment when tracing is active", () => {
    setTracingActive();
    const addAnnotation = vi.fn();
    const getSegment = vi.fn(() => ({ addAnnotation }));

    annotateAccountId("acct-123", { getSegment });

    expect(addAnnotation).toHaveBeenCalledTimes(1);
    expect(addAnnotation).toHaveBeenCalledWith(ACCOUNT_ID_ANNOTATION, "acct-123");
    // The annotation key is exactly "accountId" — never a PII-bearing name.
    expect(ACCOUNT_ID_ANNOTATION).toBe("accountId");
  });

  it("no-ops safely when no segment is open (getSegment returns undefined)", () => {
    setTracingActive();
    const getSegment = vi.fn(() => undefined);

    expect(() => annotateAccountId("acct-123", { getSegment })).not.toThrow();
  });

  it("no-ops safely when segment lookup throws", () => {
    setTracingActive();
    const getSegment = vi.fn(() => {
      throw new Error("no context");
    });

    expect(() => annotateAccountId("acct-123", { getSegment })).not.toThrow();
  });

  it("never records the value under a token/email/credential key", () => {
    setTracingActive();
    const calls: Array<readonly [string, string]> = [];
    const addAnnotation = vi.fn((key: string, value: string) => {
      calls.push([key, value]);
    });
    const getSegment = vi.fn(() => ({ addAnnotation }));

    annotateAccountId("acct-123", { getSegment });

    // Only one annotation, under the exact accountId key; nothing token/PII-shaped.
    expect(calls).toEqual([["accountId", "acct-123"]]);
    for (const [key] of calls) {
      expect(key.toLowerCase()).not.toMatch(/token|email|credential|secret|password/);
    }
  });

  it("does not annotate an empty account id", () => {
    setTracingActive();
    const addAnnotation = vi.fn();
    const getSegment = vi.fn(() => ({ addAnnotation }));

    annotateAccountId("", { getSegment });

    expect(addAnnotation).not.toHaveBeenCalled();
  });
});
