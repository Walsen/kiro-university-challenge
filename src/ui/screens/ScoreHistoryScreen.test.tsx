/**
 * Component + accessibility tests for the personal score screen (task 11.4,
 * R12.3, R12.4, R12.5).
 *
 * These render the real {@link ScoreHistoryScreen} against an injected fake
 * {@link PlatformClient}, so nothing touches the API or the network. They cover
 * every state the two reads (history + personal best) can be in:
 *   - loading — a perceivable, labeled status affordance while a read is in
 *     flight (R12.3), not a blank screen;
 *   - populated — the history table and the personal-best value render with
 *     accessible table semantics;
 *   - empty — "no scores"/"no best" render as ordinary empty states, distinct
 *     from a failure;
 *   - failure — a rejected read surfaces an explicit, announced error with a
 *     retry that re-invokes the read (R12.5 — explicit, not frozen).
 * Plus keyboard operability of the manual "Refresh" control (R12.4).
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ScoreHistoryScreen } from "./ScoreHistoryScreen";
import { createFakePlatform } from "../test/fakePlatform";
import { renderWithPlatform } from "../test/renderWithPlatform";
import type {
  MazeParams,
  PlatformResult,
  Score,
  ScoreHistoryPage,
} from "../../client/ports/PlatformClient";

const SCOPE: MazeParams = { rows: 21, columns: 21, seed: 7, timeLimitSeconds: 60 };

function score(elapsedMs: number): Score {
  return { outcome: "Won", mazeParams: SCOPE, elapsedMs };
}

describe("ScoreHistoryScreen — states, keyboard, and a11y (task 11.4)", () => {
  it("shows a perceivable loading affordance while reads are in flight (R12.3)", async () => {
    // Reads that never settle so the loading state is observable.
    renderWithPlatform(
      <ScoreHistoryScreen params={SCOPE} />,
      createFakePlatform({
        personalHistory: () => new Promise<never>(() => {}),
        personalBest: () => new Promise<never>(() => {}),
      }),
    );

    // Both sub-sections show an accessible status affordance (role="status").
    const statuses = await screen.findAllByRole("status");
    expect(statuses.length).toBeGreaterThan(0);
    expect(screen.getByText(/Loading history…/)).toBeInTheDocument();
    expect(screen.getByText(/Loading best…/)).toBeInTheDocument();
  });

  it("renders a populated history table and personal best (R5.1/R5.2)", async () => {
    const page: ScoreHistoryPage = { items: [score(12_340), score(15_000)] };
    renderWithPlatform(
      <ScoreHistoryScreen params={SCOPE} />,
      createFakePlatform({
        personalHistory: () => Promise.resolve({ ok: true, value: page }),
        personalBest: () => Promise.resolve({ ok: true, value: score(12_340) }),
      }),
    );

    // Accessible table semantics: a real table with column headers.
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Time" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2 rows
    // The personal-best value is shown.
    expect(screen.getAllByText("12.34s").length).toBeGreaterThan(0);
  });

  it("renders explicit empty states when there are no scores (not a failure)", async () => {
    renderWithPlatform(
      <ScoreHistoryScreen params={SCOPE} />,
      createFakePlatform({
        personalHistory: () => Promise.resolve({ ok: true, value: { items: [] } }),
        personalBest: () => Promise.resolve({ ok: true, value: null }),
      }),
    );

    expect(await screen.findByText(/No scores yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No personal best yet/i)).toBeInTheDocument();
    // An empty state is not an error: nothing is announced as an alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces a failed history read as an explicit, retryable alert (R12.5)", async () => {
    const historyReads = vi.fn<() => Promise<PlatformResult<ScoreHistoryPage>>>();
    // First call fails; a retry (second call) succeeds — proving the retry is
    // wired and the state is not a frozen dead-end.
    historyReads
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: "backend", message: "boom" },
      })
      .mockResolvedValueOnce({ ok: true, value: { items: [score(9_990)] } });

    const user = userEvent.setup();
    renderWithPlatform(
      <ScoreHistoryScreen params={SCOPE} />,
      createFakePlatform({
        personalHistory: historyReads,
        personalBest: () => Promise.resolve({ ok: true, value: null }),
      }),
    );

    // Explicit failure: an announced alert with the backend headline.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong on our end");

    // The retry is a keyboard-operable button; clicking it re-runs the read.
    const retry = within(alert).getByRole("button", { name: "Retry" });
    await user.click(retry);

    await waitFor(() => expect(historyReads).toHaveBeenCalledTimes(2));
    // After a successful retry the alert is gone and data renders (not frozen).
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("9.99s")).toBeInTheDocument();
  });

  it("exposes a keyboard-operable Refresh control that re-queries (R12.4)", async () => {
    const historyReads = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: { items: [] } }),
    );
    const user = userEvent.setup();
    renderWithPlatform(
      <ScoreHistoryScreen params={SCOPE} />,
      createFakePlatform({
        personalHistory: historyReads,
        personalBest: () => Promise.resolve({ ok: true, value: null }),
      }),
    );

    await screen.findByText(/No scores yet/i);
    const initialCalls = historyReads.mock.calls.length;

    // Tab focus reaches the Refresh button and Enter activates it.
    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    expect(refresh).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(historyReads.mock.calls.length).toBeGreaterThan(initialCalls),
    );
  });
});
