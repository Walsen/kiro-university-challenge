/**
 * Tests for the server logging redaction utility (task 11.3, R11.4).
 *
 * R11.4: when the platform logs activity it must NEVER record credentials or
 * full token values. These tests specify a pure `redact` function that masks
 * anything log-bound that could carry a bearer token, a password/credential
 * field, or a raw JWT — before it reaches a log sink — and a `safeLog` helper
 * that routes a message + arbitrary context through `redact`.
 *
 * The utility is pure and deterministic: `redact` never mutates its input and
 * takes no clock/IO, so it is fully unit-testable here without a log sink.
 */
import { describe, expect, it, vi } from "vitest";

import { redact, safeLog, REDACTED, type LogSink } from "./redact";

/** A JWT-shaped string: three base64url segments separated by dots. */
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LTEyMyJ9.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("redact — token-shaped strings (R11.4)", () => {
  it("masks a bare JWT string entirely", () => {
    expect(redact(SAMPLE_JWT)).toBe(REDACTED);
  });

  it("masks a JWT embedded inside a larger string, leaving surrounding text", () => {
    const message = `request failed with token ${SAMPLE_JWT} attached`;
    const result = redact(message) as string;
    expect(result).not.toContain(SAMPLE_JWT);
    expect(result).toContain(REDACTED);
    expect(result).toContain("request failed with token");
  });

  it("masks the credential after a Bearer scheme in an Authorization value", () => {
    const result = redact(`Bearer ${SAMPLE_JWT}`) as string;
    expect(result).not.toContain(SAMPLE_JWT);
    expect(result).toContain(REDACTED);
  });

  it("leaves an ordinary string with no secret material untouched", () => {
    expect(redact("failed to write PROFILE item on PostConfirmation")).toBe(
      "failed to write PROFILE item on PostConfirmation",
    );
  });
});

describe("redact — sensitive object fields (R11.4)", () => {
  it("masks an Authorization header regardless of key casing", () => {
    const result = redact({
      headers: { Authorization: `Bearer ${SAMPLE_JWT}`, authorization: SAMPLE_JWT },
    }) as { headers: Record<string, unknown> };
    expect(result.headers["Authorization"]).toBe(REDACTED);
    expect(result.headers["authorization"]).toBe(REDACTED);
  });

  it("masks password / credential / token / secret fields by name", () => {
    const result = redact({
      password: "hunter2",
      credential: "hunter2",
      newCredential: "hunter2",
      accessToken: SAMPLE_JWT,
      refreshToken: "rt-abc",
      idToken: SAMPLE_JWT,
      secret: "shhh",
    }) as Record<string, unknown>;
    for (const key of [
      "password",
      "credential",
      "newCredential",
      "accessToken",
      "refreshToken",
      "idToken",
      "secret",
    ]) {
      expect(result[key], `${key} is masked`).toBe(REDACTED);
    }
  });

  it("keeps non-sensitive fields intact", () => {
    const result = redact({
      accountId: "acct-123",
      displayName: "Ada",
      elapsedMs: 4200,
    }) as Record<string, unknown>;
    expect(result).toEqual({
      accountId: "acct-123",
      displayName: "Ada",
      elapsedMs: 4200,
    });
  });

  it("redacts recursively through nested objects and arrays", () => {
    const result = redact({
      request: {
        headers: [{ name: "authorization", value: `Bearer ${SAMPLE_JWT}` }],
        body: { password: "hunter2", note: "hi" },
      },
    }) as {
      request: {
        headers: Array<{ name: string; value: unknown }>;
        body: { password: unknown; note: string };
      };
    };
    // The `value` sits under a non-sensitive key but carries a Bearer JWT, so
    // shape-based redaction masks the credential while keeping the scheme.
    const headerValue = result.request.headers[0]!.value as string;
    expect(headerValue).not.toContain(SAMPLE_JWT);
    expect(headerValue).toContain(REDACTED);
    expect(result.request.body.password).toBe(REDACTED);
    expect(result.request.body.note).toBe("hi");
  });

  it("does not mutate the input object", () => {
    const input = { password: "hunter2" };
    redact(input);
    expect(input.password).toBe("hunter2");
  });

  it("redacts an Error's message and leaves its name", () => {
    const error = new Error(`token ${SAMPLE_JWT} rejected`);
    const result = redact(error) as { name: string; message: string };
    expect(result.name).toBe("Error");
    expect(result.message).not.toContain(SAMPLE_JWT);
    expect(result.message).toContain(REDACTED);
  });

  it("handles primitives and nullish values without throwing", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it("breaks cycles rather than recursing forever", () => {
    const cyclic: Record<string, unknown> = { note: "hi" };
    cyclic["self"] = cyclic;
    const result = redact(cyclic) as Record<string, unknown>;
    expect(result["note"]).toBe("hi");
    // The cycle is replaced with a marker, not followed.
    expect(result["self"]).not.toBe(cyclic);
  });
});

describe("safeLog — routes logging through redaction (R11.4)", () => {
  it("passes redacted context to the injected sink", () => {
    const sink = vi.fn<LogSink>();
    safeLog(sink, "failed to write PROFILE item", {
      headers: { authorization: `Bearer ${SAMPLE_JWT}` },
      accountId: "acct-123",
    });
    expect(sink).toHaveBeenCalledTimes(1);
    const [message, context] = sink.mock.calls[0]!;
    expect(message).toBe("failed to write PROFILE item");
    const ctx = context as { headers: Record<string, unknown>; accountId: string };
    expect(ctx.headers["authorization"]).toBe(REDACTED);
    expect(ctx.accountId).toBe("acct-123");
  });

  it("redacts a secret that appears in the message itself", () => {
    const sink = vi.fn<LogSink>();
    safeLog(sink, `unexpected token ${SAMPLE_JWT}`);
    const [message] = sink.mock.calls[0]!;
    expect(message).not.toContain(SAMPLE_JWT);
    expect(message).toContain(REDACTED);
  });
});
