/**
 * `usePlatformQuery` — run a `PlatformResult`-returning SDK read and expose it
 * as an explicit React state (idle → loading → success | failure).
 *
 * Every data-reading screen (score history, personal best, leaderboard,
 * own-rank) needs the same shape: kick off a read, show a loading affordance,
 * then render either the value or a typed failure — and never leave the screen
 * ambiguous or frozen (R12.5). This hook centralizes that so each screen only
 * describes *what* to fetch and *how* to render each state.
 *
 * It is intentionally not auto-running: the caller triggers `run()` (e.g. from
 * an effect on mount, or a "Refresh" button), which keeps it deterministic in
 * tests and lets a screen re-query after a parameter change. A stale in-flight
 * result is discarded when a newer `run()` supersedes it, so out-of-order
 * responses never clobber fresher state.
 */
import { useCallback, useRef, useState } from "react";

import type {
  PlatformFailure,
  PlatformResult,
} from "../../client/ports/PlatformClient";

/** The explicit, exhaustive state of a platform read (R12.5 — no frozen state). */
export type QueryState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly value: T }
  | { readonly status: "failure"; readonly failure: PlatformFailure };

export interface PlatformQuery<T> {
  readonly state: QueryState<T>;
  /** Execute the query; supersedes any in-flight call. */
  readonly run: () => void;
}

export function usePlatformQuery<T>(
  query: () => Promise<PlatformResult<T>>,
): PlatformQuery<T> {
  const [state, setState] = useState<QueryState<T>>({ status: "idle" });
  // Monotonic token so only the most recent `run` may commit a result.
  const latest = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  const run = useCallback(() => {
    const token = ++latest.current;
    setState({ status: "loading" });
    void queryRef.current().then(
      (result) => {
        if (token !== latest.current) {
          return;
        }
        setState(toState(result));
      },
      // The SDK contract never rejects for an expected failure, but guard the
      // impossible so a thrown error still becomes an explicit state, not a
      // frozen screen (R12.5).
      (error: unknown) => {
        if (token !== latest.current) {
          return;
        }
        setState({
          status: "failure",
          failure: { kind: "backend", message: messageOf(error) },
        });
      },
    );
  }, []);

  return { state, run };
}

function toState<T>(result: PlatformResult<T>): QueryState<T> {
  return result.ok
    ? { status: "success", value: result.value }
    : { status: "failure", failure: result.failure };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
