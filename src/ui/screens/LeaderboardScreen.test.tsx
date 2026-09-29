/**
 * Smoke tests for the leaderboard screen (task 10.2, R6.1/R6.3, R12.5).
 *
 * Verifies the screen reads the public standings and own-rank through the
 * injected fake {@link PlatformClient}, renders standings (display name + time),
 * and surfaces a typed failure as an explicit, non-frozen state (R12.5) — never
 * touching the network.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeaderboardScreen } from "./LeaderboardScreen";
import { createFakePlatform } from "../test/fakePlatform";
import { renderWithPlatform } from "../test/renderWithPlatform";
import type { MazeParams } from "../../client/ports/PlatformClient";

const SCOPE: MazeParams = { rows: 21, columns: 21, seed: 7, timeLimitSeconds: 60 };

describe("LeaderboardScreen", () => {
  it("renders public standings with display name and time", async () => {
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank={false} />,
      createFakePlatform({
        leaderboard: () =>
          Promise.resolve({
            ok: true,
            value: [{ rank: 1, displayName: "Ada", timeMs: 12_340 }],
          }),
      }),
    );

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("12.34s")).toBeInTheDocument();
  });

  it("shows an explicit failure state when the leaderboard read fails (R12.5)", async () => {
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank={false} />,
      createFakePlatform({
        leaderboard: () =>
          Promise.resolve({
            ok: false,
            failure: { kind: "network", message: "offline" },
          }),
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot reach the server",
    );
    // Transient failure → a retry is offered (not a frozen dead-end).
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows own rank when signed in and ranked (R6.3)", async () => {
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank />,
      createFakePlatform({
        ownRank: () => Promise.resolve({ ok: true, value: { ranked: true, rank: 3 } }),
      }),
    );

    expect(await screen.findByText("#3")).toBeInTheDocument();
  });
});
