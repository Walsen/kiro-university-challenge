/**
 * The HTTP transport port the client Platform SDK depends on (task 10.1).
 *
 * The SDK talks to the Phase 2 API over HTTP, but the *rules* of the SDK —
 * attaching the bearer token, mapping status codes to typed failures — are not
 * `fetch`'s concern and must be unit-testable without a real network. So the
 * SDK depends inward on this small, provider-agnostic seam (Dependency
 * Inversion, Interface Segregation) and the composition root injects a concrete
 * adapter over the browser `fetch` (`FetchHttpTransport`). Tests inject a fake
 * transport and never touch the network (testing steering "Determinism").
 *
 * The seam is expressed purely in plain data — a method, an absolute URL,
 * optional headers, an optional string body — and returns the status and raw
 * text body. No `Request`/`Response`/`Headers` DOM type appears in the SDK's
 * own logic; those live only in the `fetch` adapter, mirroring how Cognito types
 * are confined to `cognitoClient.ts`.
 */

/** The HTTP methods the Phase 2a API surface uses (`POST /scores`, the `GET`s). */
export type HttpMethod = "GET" | "POST";

/** A transport request: everything the SDK must say to reach one endpoint. */
export interface HttpRequest {
  readonly method: HttpMethod;
  /** Absolute URL (the SDK composes it from its injected base URL). */
  readonly url: string;
  /** Request headers (e.g. `authorization`, `content-type`); may be omitted. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialized request body (JSON string) for a `POST`; omitted for a `GET`. */
  readonly body?: string;
}

/** A transport response reduced to the plain fields the SDK reacts to. */
export interface HttpResponse {
  /** The HTTP status code (200, 201, 400, 401, 429, 5xx, ...). */
  readonly status: number;
  /** The raw response body text; the SDK parses it as JSON when a body is expected. */
  readonly body: string;
}

/**
 * The transport capability the SDK depends on: send one request, resolve one
 * response. A genuine network/connection failure (DNS, offline, TLS, timeout)
 * is signalled by a **rejected** Promise; the SDK catches it and turns it into a
 * typed `network` failure so no caller ever faces an ambiguous throw (R12.5).
 */
export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}
