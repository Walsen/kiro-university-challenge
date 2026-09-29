/**
 * Server logging layer entry point.
 *
 * The one job of this layer is to keep credentials and token values out of the
 * logs (R11.4). Server code logs through {@link logError} / {@link safeLog}
 * rather than `console.*` directly, so every log-bound value passes through the
 * pure {@link redact} redactor first. Server-only infrastructure — never
 * imported by `src/core`.
 */
export { redact, safeLog, logError, REDACTED, type LogSink } from "./redact";
