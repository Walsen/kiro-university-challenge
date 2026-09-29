/**
 * Smoke tests for the leaderboard screen (task 10.2, R6.1/R6.3, R12.5).
 *
 * Verifies the screen reads the public standings and own-rank through the
 * injected fake {@link PlatformClient}, renders standings (display name + time),
 * and surfaces a typed failure as an explicit, non-frozen state (R12.5) — never
 * touching the network.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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

describe("LeaderboardScreen — a11y and keyboard operability (task 11.4)", () => {
  it("renders standings with accessible table semantics (R12.3)", async () => {
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank={false} />,
      createFakePlatform({
        leaderboard: () =>
          Promise.resolve({
            ok: true,
            value: [
              { rank: 1, displayName: "Ada", timeMs: 12_340 },
              { rank: 2, displayName: "Grace", timeMs: 13_000 },
            ],
          }),
      }),
    );

    const table = await screen.findByRole("table");
    // Column headers are exposed to assistive tech.
    expect(within(table).getByRole("columnheader", { name: "Rank" })).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "Player" }),
    ).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Time" })).toBeInTheDocument();
    // Header row + one row per standing.
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("names the region by its heading so AT users can navigate to it (R12.3)", async () => {
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank={false} />,
      createFakePlatform(),
    );

    // The <section> is labelled by its <h2 id="leaderboard-heading">.
    expect(
      screen.getByRole("region", { name: "Leaderboard" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/No scores recorded for this scope yet/i),
    ).toBeInTheDocument();
  });

  it("shows a perceivable loading affordance before data arrives (R12.3)", async () => {
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank={false} />,
      createFakePlatform({
        leaderboard: () => new Promise<never>(() => {}),
      }),
    );

    // An accessible status affordance is shown while the read is in flight.
    expect(await screen.findByText(/Loading leaderboard…/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("re-queries via the keyboard-operable Refresh control (R12.4)", async () => {
    const reads = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: [] as ReadonlyArray<never> }),
    );
    const user = userEvent.setup();
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank={false} />,
      createFakePlatform({ leaderboard: reads }),
    );

    await screen.findByText(/No scores recorded/i);
    const initialCalls = reads.mock.calls.length;

    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    expect(refresh).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(reads.mock.calls.length).toBeGreaterThan(initialCalls),
    );
  });

  it("keeps a failed own-rank read explicit and retryable (R12.5)", async () => {
    renderWithPlatform(
      <LeaderboardScreen params={SCOPE} showOwnRank />,
      createFakePlatform({
        ownRank: () =>
          Promise.resolve({
            ok: false,
            failure: { kind: "rate-limited", message: "slow down" },
          }),
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many requests");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
