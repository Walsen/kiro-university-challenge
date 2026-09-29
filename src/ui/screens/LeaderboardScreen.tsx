/**
 * `LeaderboardScreen` — the public top-N leaderboard and the Player's own rank
 * for the current scope (task 10.2, R6.1/R6.3, R12.3/R12.5).
 *
 * The public standings read carries no token; own-rank is an authenticated read
 * and is only shown when signed in (the shell passes `showOwnRank`). Both go
 * through the {@link PlatformClient} port and render as explicit states via
 * {@link usePlatformQuery} — loading, typed failure (retryable), or data — so
 * leaderboard position feedback is always clear and never frozen.
 *
 * Standings carry the public **display name** only, never the private account
 * identifier (R6.2/R11.3) — the SDK/API guarantee this shape; the screen just
 * renders it.
 */
import { useEffect } from "react";

import type {
  LeaderboardStanding,
  MazeParams,
  OwnRankResult,
} from "../../client/ports/PlatformClient";
import { usePlatform } from "../platform/PlatformProvider";
import { usePlatformQuery } from "../platform/usePlatformQuery";
import { FailureNotice } from "../components/FailureNotice";
import { Spinner } from "../components/Spinner";
import { formatSeconds } from "../format";

export interface LeaderboardScreenProps {
  readonly params: MazeParams;
  /** Whether to show the authenticated own-rank block (signed in). */
  readonly showOwnRank: boolean;
}

export function LeaderboardScreen({
  params,
  showOwnRank,
}: LeaderboardScreenProps): JSX.Element {
  const platform = usePlatform();

  const board = usePlatformQuery<ReadonlyArray<LeaderboardStanding>>(() =>
    platform.leaderboard(params),
  );
  const ownRank = usePlatformQuery<OwnRankResult>(() => platform.ownRank(params));

  const { run: runBoard } = board;
  const { run: runOwnRank } = ownRank;
  useEffect(() => {
    runBoard();
    if (showOwnRank) {
      runOwnRank();
    }
  }, [runBoard, runOwnRank, showOwnRank, params]);

  return (
    <section className="screen leaderboard" aria-labelledby="leaderboard-heading">
      <div className="screen__header">
        <h2 id="leaderboard-heading">Leaderboard</h2>
        <button
          type="button"
          className="btn"
          onClick={() => {
            runBoard();
            if (showOwnRank) {
              runOwnRank();
            }
          }}
        >
          Refresh
        </button>
      </div>

      {showOwnRank ? (
        <section aria-labelledby="own-rank-heading" className="leaderboard__own">
          <h3 id="own-rank-heading">Your rank</h3>
          {ownRank.state.status === "loading" ? (
            <Spinner label="Loading your rank" />
          ) : null}
          {ownRank.state.status === "failure" ? (
            <FailureNotice failure={ownRank.state.failure} onRetry={runOwnRank} />
          ) : null}
          {ownRank.state.status === "success" ? (
            ownRank.state.value.ranked ? (
              <p className="leaderboard__own-value">#{ownRank.state.value.rank}</p>
            ) : (
              <p className="empty">
                You are not ranked in this scope yet — win a run to appear.
              </p>
            )
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="standings-heading" className="leaderboard__standings">
        <h3 id="standings-heading">Top players</h3>
        {board.state.status === "loading" ? (
          <Spinner label="Loading leaderboard" />
        ) : null}
        {board.state.status === "failure" ? (
          <FailureNotice failure={board.state.failure} onRetry={runBoard} />
        ) : null}
        {board.state.status === "success" ? (
          <StandingsTable standings={board.state.value} />
        ) : null}
      </section>
    </section>
  );
}

function StandingsTable({
  standings,
}: {
  readonly standings: ReadonlyArray<LeaderboardStanding>;
}): JSX.Element {
  if (standings.length === 0) {
    return <p className="empty">No scores recorded for this scope yet.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Player</th>
          <th scope="col">Time</th>
        </tr>
      </thead>
      <tbody>
        {standings.map((standing) => (
          <tr key={`${standing.rank}-${standing.displayName}`}>
            <td>#{standing.rank}</td>
            <td>{standing.displayName}</td>
            <td>{formatSeconds(standing.timeMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
