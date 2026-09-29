/**
 * Pure mapping from a resolved shared session to the qualifying Scores that feed
 * the shared leaderboard (maze-game-platform R10.3).
 *
 * When a shared session resolves (`resolveSession`, Task 17.1), each Participant
 * has a {@link SessionParticipantResult}. R10.3 requires a *qualifying* result —
 * a `Finished` one — to be persisted "consistent with Requirement 4, so that
 * Shared_Session results feed the same persistent-score and Leaderboard system".
 * This module holds the pure half of that: it turns a `Finished` result into the
 * same authoritative `Won` {@link Score} solo play produces, so the Session
 * handler can persist it through the existing {@link ScoreRepository} path
 * rather than a parallel store. A `NotFinished` result yields no Score — a
 * timed-out Participant earns no win score (R10.4).
 *
 * The mapping is a pure function of the resolved results plus the session's
 * maze-parameter scope; it performs no I/O and keeps the "which results qualify
 * and how they become Scores" rule in the core, testable in isolation. The
 * persistence call itself lives behind the port in the application layer
 * (`server/handlers/sessionScores`), which composes this mapping with the
 * repository.
 *
 * Why the scope is a parameter. A `Score` is keyed on a leaderboard by its
 * {@link MazeParams} (size + generation seed + time limit), and that scope is
 * exactly the session's own maze parameters — the same params the server built
 * the shared maze from. The authoritative `SharedSessionState` retains the built
 * `Maze` and `timeLimit` but not the originating seed, so the scope is supplied
 * here by the caller that created the session rather than reconstructed from the
 * maze. This makes a shared-session Score land in the same leaderboard scope a
 * solo Run of those params would (R10.3).
 *
 * The finisher's `accountId` is the result's `participantId`: the server seats a
 * joiner under its JWT `sub`, so a Participant's session handle *is* its account
 * identifier (see `server/handlers/session`). Scores are keyed by account, so
 * the mapping carries it straight through.
 *
 * Pure: no I/O, no DOM, no `Date.now()`, no `Math.random()`.
 */
import type { MazeParams, Score } from "../validateSubmission";
import type { SessionParticipantResult } from "./sessionResolution";

/**
 * A qualifying shared-session result mapped to a persistable Score plus the
 * account it belongs to. This is exactly the pair the {@link ScoreRepository}
 * `putScore(accountId, score)` port consumes, so the application layer persists
 * it without any further shaping.
 */
export interface QualifyingScore {
  /** The finisher's account (its session `participantId` is its JWT `sub`). */
  readonly accountId: string;
  /**
   * The authoritative `Won` Score: the session's maze-parameter scope and the
   * server-recorded finishing time, identical in shape to a solo submission's
   * validated Score (R10.3).
   */
  readonly score: Score;
}

/**
 * Map the qualifying (`Finished`) results of a resolved shared session to the
 * Scores that feed the shared leaderboard (R10.3).
 *
 * Each `Finished` result becomes a `Won` {@link Score} whose `elapsedMs` is the
 * authoritative finishing time and whose `mazeParams` is the session's scope,
 * keyed by the finisher's `accountId` (its `participantId`). `NotFinished`
 * results are dropped — they earn no win Score (R10.4). Order is preserved from
 * the resolution, so finishers appear fastest-first as `resolveSession` ranked
 * them.
 *
 * @param results - the per-Participant results from {@link resolveSession}.
 * @param params - the session's maze parameters, defining the leaderboard scope.
 * @returns the account/Score pairs to persist, in resolution order.
 */
export function toQualifyingScores(
  results: ReadonlyArray<SessionParticipantResult>,
  params: MazeParams,
): ReadonlyArray<QualifyingScore> {
  const qualifying: QualifyingScore[] = [];
  for (const result of results) {
    if (result.outcome === "Finished") {
      qualifying.push({
        accountId: result.participantId,
        score: {
          outcome: "Won",
          mazeParams: params,
          elapsedMs: result.timeMs,
        },
      });
    }
  }
  return qualifying;
}
