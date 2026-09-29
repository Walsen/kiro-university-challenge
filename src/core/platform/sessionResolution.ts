/**
 * Pure shared-session finish/timeout resolution (maze-game-platform R10).
 *
 * When a shared session reaches its end — a Participant crosses the exit or the
 * session's time limit expires — the server resolves the final standing
 * **purely from its `Authoritative_State`** (design "Resolution and recording",
 * R10). This module holds that pure rule so the Session Lambda composes it
 * rather than reimplementing it, and so it can be exercised deterministically in
 * tests. No I/O, no DOM, no `Date.now()`, no `Math.random()`; time enters only
 * as data — the authoritative finishing time captured by the server.
 *
 * A Participant FINISHES when their authoritative position (never a
 * client-claimed one, R10.1) has reached the shared maze exit AND the server has
 * a recorded authoritative finishing time for them. Finishers are ranked
 * fastest-first by that time, with a deterministic tie-break on `participantId`
 * for equal times — the same stable ordering the leaderboard uses for its
 * `accountId` tie-break, so a tie resolves identically wherever it appears
 * (R10.2, and `leaderboard.ts`).
 *
 * TIME EXPIRY = NOT finished: a Participant who has not reached the exit when
 * the session ends is resolved as not-finished with no time or rank and no win
 * Score to persist (R10.4). A Participant sitting on the exit cell without a
 * recorded authoritative finishing time is likewise treated as not-finished —
 * finish is an authoritative fact, so it is never inferred from position alone.
 *
 * Resolving transitions the session to `Ended` and marks each finisher's
 * authoritative slice `Finished`, producing a new state rather than mutating the
 * input (data-model steering "transitions produce new values"). Outcomes are
 * modelled as a discriminated union so a finished result without a time/rank, or
 * a not-finished result carrying one, is unrepresentable.
 */
import type { Position } from "../types";
import type { ParticipantState, SharedSessionState } from "./sharedSession";

/**
 * The resolved outcome for one Participant, as a discriminated union so illegal
 * states cannot be built: a `Finished` result always carries an authoritative
 * `timeMs` and `rank`, and a `NotFinished` result never does (data-model
 * steering "make illegal states unrepresentable"). This is the shape Task 17.2
 * reads to persist qualifying (`Finished`) results through the R4
 * `ScoreRepository` path (R10.3); a `NotFinished` result yields no win Score
 * (R10.4).
 */
export type SessionParticipantResult =
  | {
      readonly participantId: string;
      readonly displayName: string;
      readonly outcome: "Finished";
      /** Authoritative completion time in milliseconds (R10.1). */
      readonly timeMs: number;
      /** 1-based finishing rank within the session, fastest-first (R10.1). */
      readonly rank: number;
    }
  | {
      readonly participantId: string;
      readonly displayName: string;
      readonly outcome: "NotFinished";
      /** The only way not to finish is to run out of time before the exit (R10.4). */
      readonly reason: "TimeExpired";
    };

/**
 * The result of resolving a shared session: the authoritative state advanced to
 * `Ended` (with finishers marked `Finished`) and the per-Participant results in
 * a stable order — finishers first fastest-first, then non-finishers, each group
 * tie-broken by `participantId`.
 */
export interface SessionResolution {
  readonly endedState: SharedSessionState;
  readonly results: ReadonlyArray<SessionParticipantResult>;
}

function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.column === b.column;
}

/**
 * A Participant who has reached the exit and has a recorded authoritative
 * finishing time, carried with that time so ranking need not re-look it up.
 */
interface Finisher {
  readonly participant: ParticipantState;
  readonly timeMs: number;
}

/**
 * Order finishers fastest-first, breaking ties on `participantId` ascending so
 * equal times resolve deterministically and consistently with the leaderboard's
 * `accountId` tie-break (R10.2).
 */
function byTimeThenId(a: Finisher, b: Finisher): number {
  if (a.timeMs !== b.timeMs) {
    return a.timeMs - b.timeMs;
  }
  return a.participant.participantId < b.participant.participantId ? -1 : 1;
}

/**
 * Resolve a shared session's final standing purely from its authoritative state
 * (R10.1, R10.2, R10.4).
 *
 * A Participant is a finisher when their authoritative `position` equals the
 * shared maze exit and `finishTimesMs` holds an authoritative finishing time for
 * them; finishers are ranked fastest-first with a `participantId` tie-break.
 * Every other Participant is resolved as `NotFinished` (`TimeExpired`). The
 * returned `endedState` is a new state transitioned to `Ended` with finishers
 * marked `Finished`; the input is left unchanged.
 *
 * @param state - the server-held authoritative shared-session state.
 * @param finishTimesMs - authoritative finishing times, keyed by
 *   `participantId`, captured by the server when a move reached the exit. A
 *   Participant absent from this map has no trusted finish and is not-finished.
 */
export function resolveSession(
  state: SharedSessionState,
  finishTimesMs: ReadonlyMap<string, number>,
): SessionResolution {
  const finishers: Finisher[] = [];
  const nonFinishers: ParticipantState[] = [];

  for (const participant of state.participants.values()) {
    const timeMs = finishTimesMs.get(participant.participantId);
    const reachedExit = samePosition(participant.position, state.maze.exit);
    if (reachedExit && timeMs !== undefined) {
      finishers.push({ participant, timeMs });
    } else {
      nonFinishers.push(participant);
    }
  }

  finishers.sort(byTimeThenId);
  nonFinishers.sort((a, b) => (a.participantId < b.participantId ? -1 : 1));

  const results: SessionParticipantResult[] = [];
  const nextParticipants = new Map(state.participants);

  finishers.forEach((finisher, index) => {
    const { participant, timeMs } = finisher;
    results.push({
      participantId: participant.participantId,
      displayName: participant.displayName,
      outcome: "Finished",
      timeMs,
      rank: index + 1,
    });
    nextParticipants.set(participant.participantId, {
      ...participant,
      status: "Finished",
    });
  });

  for (const participant of nonFinishers) {
    results.push({
      participantId: participant.participantId,
      displayName: participant.displayName,
      outcome: "NotFinished",
      reason: "TimeExpired",
    });
  }

  return {
    endedState: { ...state, participants: nextParticipants, status: "Ended" },
    results,
  };
}
