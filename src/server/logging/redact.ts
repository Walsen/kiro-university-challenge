/**
 * Server logging redaction (task 11.3, R11.4).
 *
 * R11.4: when the platform logs activity it must **never** record credentials or
 * full token values. Server code runs in Lambda, where anything written to
 * `console.*` lands in CloudWatch Logs. A caught error, a request, or a set of
 * headers can carry an `Authorization: Bearer <jwt>` value, a `password` /
 * `credential` field, or a raw Cognito token — so any value bound for a log must
 * pass through here first.
 *
 * The redactor is **pure and deterministic**: {@link redact} never mutates its
 * input, reaches no clock or IO, and always maps a given value to the same
 * masked value. That keeps it fully unit-testable without a log sink and lets
 * the whole server route logging through {@link safeLog} rather than calling
 * `console.*` directly, so a future log statement cannot leak a secret by
 * omission.
 *
 * Redaction is defence in depth, applied two ways at once:
 *  - **by key** — a field whose name looks sensitive (`authorization`,
 *    `password`, `credential`, `*token*`, `secret`, `apiKey`, …) is masked
 *    wholesale, whatever its value; and
 *  - **by shape** — any string that *looks* like a JWT or a `Bearer <token>`
 *    value is masked even under an innocent key, catching secrets that arrive in
 *    a free-text message or an unexpected place.
 *
 * This module is server-only infrastructure; it is not part of the pure game
 * core and must never be imported by `src/core`.
 */

/** The placeholder written in place of any redacted value. */
export const REDACTED = "[REDACTED]";

/** The marker written where a reference cycle is detected, to stop recursion. */
const CIRCULAR = "[CIRCULAR]";

/**
 * Object keys whose *value* is always masked, matched case-insensitively as a
 * substring so `Authorization`, `x-authorization`, `accessToken`, `idToken`,
 * `refreshToken`, `newCredential`, `apiKey`, etc. are all covered. These are the
 * names under which a credential or token realistically travels in a request,
 * header bag, or auth call's arguments.
 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "authorization",
  "password",
  "credential",
  "token",
  "secret",
  "apikey",
  "api-key",
  "cookie",
  "session",
];

/**
 * A JWT: three non-empty base64url segments joined by dots (`header.payload.
 * signature`). Cognito access/id tokens and any bearer JWT match this, so a raw
 * token is masked even when it slips into an otherwise-innocent string. The
 * segment length floor avoids masking ordinary dotted identifiers.
 */
const JWT_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * A `Bearer <token>` (or other auth-scheme) credential embedded in a string —
 * e.g. an `Authorization` header value logged verbatim. The scheme is kept and
 * the credential after it is masked.
 */
const BEARER_PATTERN = /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Does this key name indicate a value that must be masked wholesale? */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Mask token-shaped substrings (JWTs and `Bearer …` credentials) within a string. */
function redactStringShapes(value: string): string {
  return value
    .replace(BEARER_PATTERN, (match) => {
      const scheme = match.split(/\s+/, 1)[0]!;
      return `${scheme} ${REDACTED}`;
    })
    .replace(JWT_PATTERN, REDACTED);
}

/**
 * Return a redacted copy of any log-bound value, safe to write to a log sink.
 *
 * - Strings have token-shaped substrings (JWTs, `Bearer …`) masked.
 * - `Error`s become a plain object with `name`, a redacted `message`, and a
 *   redacted `stack` (the stack embeds the message, which may carry a token).
 * - Objects and arrays are copied recursively; a value under a sensitive key is
 *   replaced with {@link REDACTED} wholesale, other values are redacted by shape.
 * - Primitives (`number`, `boolean`, `bigint`), `null`, and `undefined` pass
 *   through unchanged.
 * - Reference cycles are broken with a {@link CIRCULAR} marker.
 *
 * The input is never mutated.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactStringShapes(value);
  }

  if (value === null || typeof value !== "object") {
    // number, boolean, bigint, symbol, function, undefined — nothing to redact.
    return value;
  }

  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactStringShapes(value.message),
      ...(value.stack === undefined
        ? {}
        : { stack: redactStringShapes(value.stack) }),
    };
  }

  if (Array.isArray(value)) {
    return value.map((element) => redactValue(element, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(entry, seen);
  }
  return result;
}

/** A log sink: the shape of `console.error` / `console.info` etc. */
export type LogSink = (message: string, ...context: readonly unknown[]) => void;

/**
 * Write a log line through {@link redact}: the message and every context value
 * are redacted before they reach the sink. Server code logs via this helper (or
 * the module-level {@link logError}) rather than calling `console.*` directly, so
 * no log statement can leak a credential or token (R11.4).
 *
 * @param sink the underlying sink (e.g. `console.error`), injected for testability.
 * @param message the human-readable message; token-shaped substrings are masked.
 * @param context arbitrary structured context; each value is redacted.
 */
export function safeLog(
  sink: LogSink,
  message: string,
  ...context: readonly unknown[]
): void {
  const safeMessage = redactStringShapes(message);
  const safeContext = context.map((entry) => redact(entry));
  sink(safeMessage, ...safeContext);
}

/**
 * Read `console` off `globalThis` behind a narrow local type, so this module
 * needs neither `@types/node` nor the DOM lib to reference the runtime console
 * that Lambda provides.
 */
function runtimeConsole(): { error: LogSink } | undefined {
  return (globalThis as { console?: { error?: LogSink } }).console?.error === undefined
    ? undefined
    : { error: (globalThis as { console: { error: LogSink } }).console.error };
}

/**
 * The server's standard "log an error safely" entry point. Routes through
 * {@link safeLog} to `console.error`, so a caught error (whose message/stack may
 * embed a token) and any extra context are redacted before hitting CloudWatch.
 */
export function logError(message: string, ...context: readonly unknown[]): void {
  const target = runtimeConsole();
  if (target !== undefined) {
    safeLog(target.error, message, ...context);
  }
}
