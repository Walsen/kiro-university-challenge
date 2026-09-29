/**
 * `ScoreHistoryScreen` — the Player's own score history and personal best for
 * the current scope (task 10.2, R5.1/R5.2, R12.3/R12.5).
 *
 * Both reads go through the {@link PlatformClient} port and render as explicit
 * states via {@link usePlatformQuery}: a loading affordance, a typed
 * {@link FailureNotice} on failure (retryable where it helps), and the data on
 * success. "No scores yet" and "no personal best yet" are rendered as ordinary
 * empty states, not failures.
 *
 * The screen fetches on mount and whenever the scope changes, and offers a
 * manual refresh — so a Player who just finished a run (submitted in task 10.3)
 * can pull the updated history.
 */
import { useEffect } from "react";

import type {
  MazeParams,
  Score,
  ScoreHistoryPage,
} from "../../client/ports/PlatformClient";
import { usePlatform } from "../platform/PlatformProvider";
import { usePlatformQuery } from "../platform/usePlatformQuery";
import { FailureNotice } from "../components/FailureNotice";
import { Spinner } from "../components/Spinner";
import { formatSeconds } from "../format";

export interface ScoreHistoryScreenProps {
  readonly params: MazeParams;
}

export function ScoreHistoryScreen({ params }: ScoreHistoryScreenProps): JSX.Element {
  const platform = usePlatform();

  const history = usePlatformQuery<ScoreHistoryPage>(() =>
    platform.personalHistory(),
  );
  const best = usePlatformQuery<Score | null>(() => platform.personalBest(params));

  const { run: runHistory } = history;
  const { run: runBest } = best;
  // Re-query when the scope changes (and on mount). `run` identities are stable.
  useEffect(() => {
    runHistory();
    runBest();
  }, [runHistory, runBest, params]);

  return (
    <section className="screen history" aria-labelledby="history-heading">
      <div className="screen__header">
        <h2 id="history-heading">Your scores</h2>
        <button
          type="button"
          className="btn"
          onClick={() => {
            runHistory();
            runBest();
          }}
        >
          Refresh
        </button>
      </div>

      <section aria-labelledby="best-heading" className="history__best">
        <h3 id="best-heading">Personal best for this scope</h3>
        {best.state.status === "loading" ? <Spinner label="Loading best" /> : null}
        {best.state.status === "failure" ? (
          <FailureNotice failure={best.state.failure} onRetry={runBest} />
        ) : null}
        {best.state.status === "success" ? (
          best.state.value === null ? (
            <p className="empty">No personal best yet — win a run in this scope.</p>
          ) : (
            <p className="history__best-value">
              {formatSeconds(best.state.value.elapsedMs)}
            </p>
          )
        ) : null}
      </section>

      <section aria-labelledby="history-list-heading" className="history__list">
        <h3 id="history-list-heading">History</h3>
        {history.state.status === "loading" ? (
          <Spinner label="Loading history" />
        ) : null}
        {history.state.status === "failure" ? (
          <FailureNotice failure={history.state.failure} onRetry={runHistory} />
        ) : null}
        {history.state.status === "success" ? (
          <HistoryList items={history.state.value.items} />
        ) : null}
      </section>
    </section>
  );
}

function HistoryList({ items }: { readonly items: ReadonlyArray<Score> }): JSX.Element {
  if (items.length === 0) {
    return <p className="empty">No scores yet. Play a run to get started.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Scope</th>
          <th scope="col">Time</th>
        </tr>
      </thead>
      <tbody>
        {items.map((score, index) => (
          <tr key={`${score.mazeParams.seed}-${score.elapsedMs}-${index}`}>
            <td>
              {score.mazeParams.rows}×{score.mazeParams.columns} · seed{" "}
              {score.mazeParams.seed}
            </td>
            <td>{formatSeconds(score.elapsedMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
