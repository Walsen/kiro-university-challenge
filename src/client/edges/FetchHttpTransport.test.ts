/**
 * Mock-based unit tests for `FetchHttpTransport` — the `fetch` adapter for the
 * {@link HttpTransport} port (task 10.1).
 *
 * Edge adapters are covered by mock-based unit tests (testing steering): a stub
 * `fetch` records what the adapter passed and returns a scripted response, so
 * the translation (plain request → `fetch` init, `Response` → plain response) is
 * verified without a real network.
 */
import { describe, expect, it, vi } from "vitest";

import { FetchHttpTransport, type FetchLike } from "./FetchHttpTransport";

describe("FetchHttpTransport", () => {
  it("translates a request into a fetch call and reduces the response to status + text", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      status: 201,
      text: () => Promise.resolve('{"persisted":true}'),
    });
    const transport = new FetchHttpTransport(fetchImpl);

    const response = await transport.send({
      method: "POST",
      url: "https://api.example.com/scores",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: '{"a":1}',
    });

    expect(response).toEqual({ status: 201, body: '{"persisted":true}' });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/scores", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("omits headers and body for a bare GET", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve("{}"),
    });
    const transport = new FetchHttpTransport(fetchImpl);

    await transport.send({ method: "GET", url: "https://api.example.com/leaderboard" });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/leaderboard", {
      method: "GET",
    });
  });

  it("propagates a fetch rejection unchanged (the SDK maps it to a network failure)", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error("Failed to fetch"));
    const transport = new FetchHttpTransport(fetchImpl);

    await expect(
      transport.send({ method: "GET", url: "https://api.example.com/leaderboard" }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("default transport invokes the GLOBAL fetch with this===globalThis (no 'Illegal invocation')", async () => {
    // Regression test for the deployed bug: capturing `globalThis.fetch` as a
    // bare reference and calling it as a method detaches `this` from the global,
    // which the browser rejects with `TypeError: Illegal invocation`. The strict
    // stub below throws exactly that unless it is invoked with `this === globalThis`,
    // so it fails if the default transport ever regresses to a detached call.
    const original = globalThis.fetch;
    const spy = vi.fn(function (
      this: unknown,
    ): Promise<{ status: number; text(): Promise<string> }> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") });
    });
    (globalThis as { fetch: unknown }).fetch = spy;
    try {
      const transport = new FetchHttpTransport();
      const response = await transport.send({
        method: "GET",
        url: "https://api.example.com/leaderboard",
      });
      expect(response).toEqual({ status: 200, body: "{}" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });
});
