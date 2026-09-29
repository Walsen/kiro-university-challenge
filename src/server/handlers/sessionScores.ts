/**
 * Persist qualifying shared-session results through the R4 score path (Task
 * 17.2, R10.3).
 *
 * When a shared session resolves, each finisher's result must be recorded as a
 * Score so live-race results feed the *same* persistent-score and leaderboard
 * system solo play uses (R10.3) — not a parallel store or a second leaderboard.
 * This module is that orchestration seam: it composes the pure
 * {@link toQualifyingScores} mapping (which qualifies and shapes the Scores)
 * with the existing {@link ScoreRepository} port (which persists them), and adds
 * nothing else. It holds no rules of its own and touches no AWS SDK — the same
 * `ScoreRepository` DynamoDB adapter that backs `POST /scores` is injected here,
 * so solo and shared-session Scores land in one leaderboard behind one port
 * (hexagonal Dependency Rule).
 *
 * ## Idempotency — no double-counting on retry (R7.4 reused)
 *
 * Session resolution can be retried (a re-invoked Session Lambda re-resolves the
 * same authoritative state to the same finishers and times). Each qualifying
 * Score is a deterministic function of the session scope, the finisher's
 * account, and the authoritative finishing time — precisely the tuple the
 * `ScoreRepository` derives its idempotency key from (see
 * `DynamoScoreRepository`, R7.4). So a re-resolved Score targets the identical
 * item and the conditional put makes the duplicate a no-op. No separate
 * dedupe key is introduced here: reusing the R4 path *is* what prevents a
 * session result being counted twice on the leaderboard.
 *
 * A non-finisher (`NotFinished` / time-expired) is never mapped to a Score, so
 * it is never persisted (R10.4).
 */
import { toQualifyingScores } from "../../core/platform/sessionScorePersistence";
import type { SessionResolution } from "../../core/platform/sessionResolution";
import type { MazeParams } from "../../core/validateSubmission";
import type { ScoreRepository } from "../ports/ScoreRepository";

/**
 * The outcome of persisting a resolved session's qualifying results. Reports how
 * many Scores were newly recorded versus resolved as idempotent duplicates, so
 * the caller (and observability) can distinguish a first resolution from a
 * retry without either being an error.
 */
export interface SessionScorePersistenceSummary {
  /** Qualifying (Finished) results considered — the count mapped to Scores. */
  readonly qualifying: number;
  /** Scores newly recorded on the leaderboard by this call. */
  readonly persisted: number;
  /** Qualifying Scores already present (idempotent no-ops), e.g. on a retry (R7.4). */
  readonly duplicates: number;
}

/**
 * Persist every qualifying result of a resolved shared session as a Score,
 * feeding the shared leaderboard through the R4 {@link ScoreRepository} path
 * (R10.3).
 *
 * Finishers are mapped to authoritative `Won` Scores by {@link toQualifyingScores}
 * and each is written with `putScore`; non-finishers are skipped (R10.4). The
 * put is idempotent on the deterministic (scope, account, time) key, so
 * re-resolving the same session records no duplicate leaderboard entries
 * (R7.4). Puts run sequentially so the summary counts are deterministic and a
 * fault is not masked by concurrent settling.
 *
 * @param resolution - the resolved session from `resolveSession`, carrying the
 *   per-Participant results.
 * @param params - the session's maze parameters (the leaderboard scope).
 * @param repository - the shared score-persistence port (the same adapter solo
 *   scores use).
 * @returns a summary of how many qualifying Scores were newly persisted versus
 *   deduplicated.
 */
export async function persistSessionScores(
  resolution: SessionResolution,
  params: MazeParams,
  repository: ScoreRepository,
): Promise<SessionScorePersistenceSummary> {
  const qualifying = toQualifyingScores(resolution.results, params);

  let persisted = 0;
  let duplicates = 0;
  for (const { accountId, score } of qualifying) {
    const result = await repository.putScore(accountId, score);
    if (result.persisted) {
      persisted += 1;
    } else {
      duplicates += 1;
    }
  }

  return { qualifying: qualifying.length, persisted, duplicates };
}
