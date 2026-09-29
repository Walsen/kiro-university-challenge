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
});
