/**
 * `FetchHttpTransport` — the browser-`fetch` adapter for the {@link HttpTransport}
 * port (task 10.1).
 *
 * This is the *only* module in the client that references the DOM `fetch`
 * API. Per the hexagonal architecture it lives in the client edges layer and
 * implements the narrow {@link HttpTransport} port the {@link PlatformSdk}
 * depends on; keeping `fetch`/`Request`/`Response` confined here means the SDK's
 * own logic — and its unit tests — never touch the network, exactly as the
 * Cognito SDK is confined to `cognitoClient.ts`.
 *
 * It performs a single translation: turn a plain {@link HttpRequest} into a
 * `fetch` call and reduce the `Response` to a plain {@link HttpResponse}
 * (status + text). It deliberately does **not** interpret the status — every 4xx
 * and 5xx is returned to the SDK, which owns the status-to-typed-failure mapping
 * (R12.5). A genuine network failure surfaces as `fetch`'s own rejection, which
 * the SDK catches and turns into a `network` failure.
 */
import type { HttpRequest, HttpResponse, HttpTransport } from "../ports/HttpTransport";

/** The `fetch` signature this adapter needs, so it can be injected in a test. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export class FetchHttpTransport implements HttpTransport {
  /**
   * @param fetchImpl the `fetch` implementation to use; defaults to the global
   *   `fetch`. Injectable so a test can supply a stub without a real network.
   */
  public constructor(private readonly fetchImpl: FetchLike = globalThis.fetch) {}

  public async send(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.fetchImpl(request.url, {
      method: request.method,
      ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    return { status: response.status, body: await response.text() };
  }
}
