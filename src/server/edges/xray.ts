/**
 * The X-Ray instrumentation seam for the Phase 2 backend (task 9.1, R11.4).
 *
 * Active tracing is enabled on the HTTP API and every service Lambda by the CDK
 * `ServiceApi` construct (the IaC half of this task, already deployed). That
 * gives each request a trace whose top-level segment is the function invocation.
 * This module adds the *application* half: it makes the AWS SDK v3 calls the
 * functions issue (DynamoDB via the DocumentClient, and the Cognito IdP client
 * where a Lambda uses one) show up as **subsegments** of that segment, and it
 * annotates the trace by `accountId` so traces are filterable per account.
 *
 * ## Why this lives at the edge
 *
 * X-Ray is a browser-and-cloud *detail*, exactly the kind the hexagonal design
 * keeps out of the core. So the wrapping happens only where the concrete AWS SDK
 * clients are constructed — inside `src/server/edges` and the standalone Lambda
 * composition roots — and no `aws-xray-sdk-core` type ever appears in a port, a
 * pure handler signature, or anything under `src/core`. The capture function is
 * generic and returns the client's own type, so the seam types the adapters
 * depend on (`DynamoDocumentClient`) are unchanged.
 *
 * ## Why it is guarded
 *
 * `captureAWSv3Client` and the segment APIs assume a live X-Ray context (the
 * Lambda runtime, an X-Ray daemon, an open segment). Under unit tests, local
 * runs, or the browser there is none, and calling them would either throw or try
 * to reach a daemon that is not there. The Lambda runtime sets the
 * `_X_AMZN_TRACE_ID` environment variable when active tracing is on, so we treat
 * its presence as the single, cheap signal that instrumentation is safe. When it
 * is absent every function here degrades to a no-op (annotation) or returns the
 * un-instrumented client (capture), so `vitest run` stays deterministic and
 * needs no AWS.
 *
 * ## PII discipline (R11.4)
 *
 * The only value ever written to a trace here is the acting `accountId` (the
 * Cognito `sub`), under the fixed annotation key {@link ACCOUNT_ID_ANNOTATION}.
 * No token, credential, email, or other PII is annotated or added as metadata —
 * the annotation surface exposed by this module takes an account id and nothing
 * else, so a caller cannot route a secret through it.
 */
import { captureAWSv3Client, getSegment } from "aws-xray-sdk-core";

/** The trace annotation key carrying the acting account id. Never a PII field. */
export const ACCOUNT_ID_ANNOTATION = "accountId";

/**
 * The environment variable the AWS Lambda runtime sets to the active trace
 * header when active tracing is enabled. Its presence is our signal that an
 * X-Ray context exists and instrumentation is safe to apply.
 */
const TRACE_ID_ENV = "_X_AMZN_TRACE_ID";

/**
 * Read a process environment variable via `globalThis`, without pulling
 * `@types/node` into this DOM/jsdom-typed project (mirrors `context.ts` and the
 * seam tests). The Lambda runs under Node, so `process` exists at runtime.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[name];
}

/**
 * Whether the code is running under active X-Ray tracing (a Lambda whose tracing
 * is `ACTIVE`). Detected by the runtime-set {@link TRACE_ID_ENV}; absent (or
 * empty) everywhere else — unit tests, local, the browser — where wrapping and
 * segment access must be skipped.
 */
export function isXrayActive(): boolean {
  const traceId = readEnv(TRACE_ID_ENV);
  return traceId !== undefined && traceId.length > 0;
}

/**
 * The minimal slice of an X-Ray segment this module writes to: the ability to
 * add a key/value annotation. Kept as a narrow local type so nothing outside the
 * seam depends on the concrete `Segment`/`Subsegment` classes.
 */
interface AnnotatableSegment {
  addAnnotation(key: string, value: string): void;
}

/** Seams injected in tests so the guarded behavior is deterministic without AWS. */
interface CaptureOverrides {
  /**
   * The wrapper applied to an SDK v3 client; defaults to the real
   * `captureAWSv3Client`. Typed over `object` (not the generic client type) so a
   * test can inject a plain fake that returns any wrapper object; the public
   * {@link captureAwsClient} preserves the client's own type on the way out.
   */
  readonly capture?: (client: object) => object;
}

interface AnnotateOverrides {
  /** The current-segment provider; defaults to the real `getSegment`. */
  readonly getSegment?: () => AnnotatableSegment | undefined;
}

/**
 * Instrument an AWS SDK v3 client so its calls become X-Ray subsegments of the
 * current function segment — but only when running under active tracing.
 *
 * When tracing is inactive the client is returned **unchanged**, so tests and
 * local runs never require an X-Ray daemon and stay deterministic. Wrapping is
 * also defensive: if the capture call throws (e.g. no usable context), the
 * original client is returned so instrumentation can never break the real call
 * path.
 *
 * The return type is the client's own type, so wrapping a base `DynamoDBClient`
 * or a Cognito IdP client is transparent to the code that consumes it.
 *
 * @param client - the base AWS SDK v3 client to instrument.
 * @returns the instrumented client under active tracing, otherwise `client`.
 */
export function captureAwsClient<T extends object>(
  client: T,
  overrides: CaptureOverrides = {},
): T {
  if (!isXrayActive()) {
    return client;
  }
  const capture = overrides.capture ?? defaultCapture;
  try {
    // The wrapper returns the same client instance (X-Ray attaches a middleware
    // in place), so restoring the client's own type is sound.
    return capture(client) as T;
  } catch {
    // An unexpected capture failure must never break the DynamoDB/Cognito call
    // path; fall back to the un-instrumented client (the call still works, it is
    // just not traced).
    return client;
  }
}

/**
 * The real wrapper. `captureAWSv3Client` types its parameter as a concrete SDK
 * v3 client shape (`middlewareStack`/`config`); this seam accepts any object
 * client, so we bridge that gap with a single narrow cast here — the one place
 * an AWS-SDK-specific type is asserted — and hand back the (same) instrumented
 * instance as a plain `object`.
 */
function defaultCapture(client: object): object {
  return captureAWSv3Client(client as Parameters<typeof captureAWSv3Client>[0]);
}

/**
 * Annotate the current trace with the acting `accountId` (R11.4), so traces are
 * filterable by account. No-ops when tracing is inactive, when no segment is
 * open, or when the account id is empty; any failure to reach the segment is
 * swallowed so annotation can never break a request.
 *
 * Only the account id is ever written, under {@link ACCOUNT_ID_ANNOTATION} — no
 * token, credential, email, or other PII passes through here.
 *
 * @param accountId - the Cognito `sub` of the acting account.
 */
export function annotateAccountId(
  accountId: string,
  overrides: AnnotateOverrides = {},
): void {
  if (!isXrayActive() || accountId.length === 0) {
    return;
  }
  const resolveSegment = overrides.getSegment ?? defaultGetSegment;
  try {
    const segment = resolveSegment();
    segment?.addAnnotation(ACCOUNT_ID_ANNOTATION, accountId);
  } catch {
    // No open segment / no context — annotation is best-effort and must never
    // throw into the request path.
  }
}

/** The real current-segment provider, narrowed to the annotation surface. */
function defaultGetSegment(): AnnotatableSegment | undefined {
  const segment: AnnotatableSegment | undefined = getSegment();
  if (segment !== undefined && typeof segment.addAnnotation === "function") {
    return segment;
  }
  return undefined;
}
