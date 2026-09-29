/**
 * `GameplayScreen` — the Run screen that hosts the Canvas maze island and wires
 * a local win to a platform score submission (task 10.3, R4.1, R5.2, R6.3,
 * R12.2, R12.5).
 *
 * The maze itself is the Phase 1 core rendered by {@link CanvasIsland} on its
 * own `requestAnimationFrame` loop, so gameplay stays fluid and the React chrome
 * never drives per-frame rendering (R12.2). The island is seeded from this Run's
 * scope (`params`), so the maze the Player solves is the exact maze the server
 * rebuilds when it validates the submission — closing the seed/moves gap.
 *
 * ## Win → submit → reflect
 *
 * When the island reports a won run (its `onRun`, fired once with the captured
 * `seed`/`moves`/advisory `clientElapsedMs`), this screen builds a
 * {@link ScoreSubmission} and posts it through the {@link PlatformClient} port
 * (R4.1). On success it reflects the server's authoritative result — whether it
 * persisted (vs. an idempotent duplicate), whether it is a personal best (R5.2),
 * and the server-recomputed time (R4.6) — and then reads the updated own-rank
 * for the scope and shows it (R6.3). Any typed SDK failure is surfaced as an
 * explicit, non-frozen state via {@link FailureNotice} (R12.5).
 *
 * The move sequence is submitted as-is; the server replays it as the anti-cheat
 * authority, so this screen never inspects or trusts the local timing.
 */
import { useCallback, useRef, useState } from "react";

import type {
  MazeParams,
  OwnRankResult,
  ScoreSubmissionResult,
} from "../../client/ports/PlatformClient";
import type { CapturedRun, WiredGame } from "../../main";
import { usePlatform } from "../platform/PlatformProvider";
import { usePlatformQuery } from "../platform/usePlatformQuery";
import { CanvasIsland } from "../canvas/CanvasIsland";
import { FailureNotice } from "../components/FailureNotice";
import { Spinner } from "../components/Spinner";
import { formatSeconds } from "../format";

/** The explicit lifecycle of submitting a won run (R12.5 — never frozen). */
type SubmitState =
  | { readonly status: "playing" }
  | { readonly status: "submitting" }
  | { readonly status: "submitted"; readonly result: ScoreSubmissionResult }
  | {
      readonly status: "failed";
      readonly failure: Parameters<typeof FailureNotice>[0]["failure"];
    };

export interface GameplayScreenProps {
  /** The scope this Run is played in (size + seed + time limit). */
  readonly params: MazeParams;
  /** Return to run setup to choose a different scope. */
  readonly onBack: () => void;
  /**
   * Optional hook handed the wired game (for callers that want to observe the
   * store directly). The submission wiring here does not need it.
   */
  readonly onWiredGame?: (game: WiredGame) => void;
}

export function GameplayScreen({
  params,
  onBack,
  onWiredGame,
}: GameplayScreenProps): JSX.Element {
  const platform = usePlatform();
  const [submit, setSubmit] = useState<SubmitState>({ status: "playing" });

  // Updated own-rank for this scope, read after a successful submit (R6.3).
  const ownRank = usePlatformQuery<OwnRankResult>(() => platform.ownRank(params));
  const { run: runOwnRank } = ownRank;

  // Keep the last captured run so a retry can re-submit the same run.
  const lastRunRef = useRef<CapturedRun | null>(null);

  const submitRun = useCallback(
    (run: CapturedRun) => {
      lastRunRef.current = run;
      setSubmit({ status: "submitting" });
      void platform
        .submitScore({
          mazeParams: params,
          moves: run.moves,
          clientElapsedMs: run.clientElapsedMs,
          idempotencyKey: idempotencyKeyFor(params, run),
        })
        .then((result) => {
          if (result.ok) {
            setSubmit({ status: "submitted", result: result.value });
            // Reflect the Player's new standing for this scope (R6.3).
            runOwnRank();
          } else {
            setSubmit({ status: "failed", failure: result.failure });
          }
        });
    },
    [platform, params, runOwnRank],
  );

  const retry = useCallback(() => {
    const run = lastRunRef.current;
    if (run !== null) {
      submitRun(run);
    }
  }, [submitRun]);

  return (
    <section className="screen gameplay" aria-labelledby="gameplay-heading">
      <h2 id="gameplay-heading">Run in progress</h2>
      <p className="gameplay__scope">
        {params.rows}×{params.columns} · {params.timeLimitSeconds}s · seed{" "}
        {params.seed}
      </p>

      <CanvasIsland
        mazeParams={params}
        onRun={submitRun}
        {...(onWiredGame ? { onWiredGame } : {})}
      />

      <SubmissionStatus
        submit={submit}
        ownRank={ownRank.state}
        onRetry={retry}
      />

      <button type="button" className="btn" onClick={onBack}>
        Back to setup
      </button>
    </section>
  );
}

/** Render the submit lifecycle and, once submitted, the updated own-rank. */
function SubmissionStatus({
  submit,
  ownRank,
  onRetry,
}: {
  readonly submit: SubmitState;
  readonly ownRank: ReturnType<typeof usePlatformQuery<OwnRankResult>>["state"];
  readonly onRetry: () => void;
}): JSX.Element | null {
  if (submit.status === "playing") {
    return null;
  }

  return (
    <section className="gameplay__submission" aria-labelledby="submission-heading">
      <h3 id="submission-heading">Your run</h3>

      {submit.status === "submitting" ? (
        <Spinner label="Submitting your run" />
      ) : null}

      {submit.status === "failed" ? (
        <FailureNotice failure={submit.failure} onRetry={onRetry} />
      ) : null}

      {submit.status === "submitted" ? (
        <SubmittedResult result={submit.result} ownRank={ownRank} />
      ) : null}
    </section>
  );
}

/** The server-authoritative result of a persisted (or duplicate) submission. */
function SubmittedResult({
  result,
  ownRank,
}: {
  readonly result: ScoreSubmissionResult;
  readonly ownRank: ReturnType<typeof usePlatformQuery<OwnRankResult>>["state"];
}): JSX.Element {
  return (
    <div className="gameplay__result">
      <p className="gameplay__time">
        Completed in {formatSeconds(result.elapsedMs)}
      </p>
      {result.isPersonalBest ? (
        <p className="gameplay__pb" role="status">
          New personal best!
        </p>
      ) : result.persisted ? (
        <p className="gameplay__saved">Run saved.</p>
      ) : (
        <p className="gameplay__saved">Run already recorded.</p>
      )}

      <div className="gameplay__rank" aria-live="polite">
        {ownRank.status === "loading" ? <Spinner label="Updating your rank" /> : null}
        {ownRank.status === "success" ? (
          ownRank.value.ranked ? (
            <p>Your rank in this scope: #{ownRank.value.rank}</p>
          ) : (
            <p>You are not ranked in this scope yet.</p>
          )
        ) : null}
        {ownRank.status === "failure" ? (
          <FailureNotice failure={ownRank.failure} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A stable idempotency key for a run so a retried/duplicated submit dedupes
 * server-side (R7.4). Derived from the scope and the captured move sequence so
 * re-submitting the *same* won run yields the same key, while a different run
 * (or scope) gets a different one.
 */
function idempotencyKeyFor(params: MazeParams, run: CapturedRun): string {
  return [
    params.rows,
    params.columns,
    params.seed,
    params.timeLimitSeconds,
    run.moves.length,
    run.moves.join(""),
  ].join(":");
}
