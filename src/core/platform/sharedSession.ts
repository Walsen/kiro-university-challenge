/**
 * Server-authoritative shared-session core (maze-game-platform R8, R9).
 *
 * This module holds the pure logic the Session service composes: the move
 * reducer (`resolveSessionMove`, Task 16.2) plus the session lifecycle helpers
 * (`createSharedSession`, `joinSession`, `startSession`) and the update
 * projections (`toSnapshotUpdate`, `toProgressUpdate`, `toJoinUpdate`) the
 * Session Lambda (Task 16.4) reuses. The reducer is pure core logic:
 * it resolves a Participant's intended move against the server-held
 * `Authoritative_State` by reusing the unchanged Phase 1 shared core
 * (`resolveMove`) exactly as solo play does, so an illegal or out-of-order move
 * is rejected and leaves that Participant's authoritative position unchanged
 * (design "Server-authoritative shared session", R9.2/R9.3). The maze is
 * identical for every Participant (R8.1); randomness/time enter only through
 * injected abstractions, so the reducer stays deterministic.
 *
 * Failure is modelled as typed data, never thrown (data-model steering
 * "validate at the boundary").
 *
 * Pure: no I/O, no DOM, no `Date.now()`, no `Math.random()`.
 */
import { DefaultMazeFactory } from "../MazeFactory";
import { RecursiveBacktrackerGenerator } from "../RecursiveBacktrackerGenerator";
import { parseTimeLimit } from "../parseTimeLimit";
import { resolveMove } from "../resolveMove";
import type { MazeParams } from "../validateSubmission";
import type { Direction, Maze, PlayingState, Position, TimeLimit } from "../types";

// ---------------------------------------------------------------------------
// Public shapes (per design "Server-authoritative shared session")
// ---------------------------------------------------------------------------

/**
 * A single Participant's authoritative slice of a shared session. `position` is
 * the server's source of truth for where the Participant is; a client-claimed
 * position is never trusted (R9.2). `moveSeq` is the count of moves the server
 * has accepted for this Participant so far and is used to reject stale /
 * out-of-order moves (R9.3).
 */
export interface ParticipantState {
  readonly participantId: string;
  /**
   * The Player-chosen public display name shown to other Participants (R11.3).
   * Carried on the authoritative slice so the server can project it into the
   * public updates without ever exposing the private account identifier.
   */
  readonly displayName: string;
  readonly position: Position;
  readonly moveSeq: number;
  readonly status: "Racing" | "Finished";
}

/** Lifecycle of a shared session (design). */
export type SharedSessionStatus = "Lobby" | "Racing" | "Ended";

/**
 * The server-held `Authoritative_State` for a shared session: one maze shared
 * by all Participants (R8.1) and each Participant's authoritative position.
 */
export interface SharedSessionState {
  readonly sessionId: string;
  readonly maze: Maze;
  readonly timeLimit: TimeLimit;
  readonly participants: ReadonlyMap<string, ParticipantState>;
  readonly status: SharedSessionStatus;
}

/**
 * A Participant's intended move. `expectedSeq` is the move sequence number the
 * client believes it is advancing from; a value that does not match the
 * authoritative `moveSeq` is a stale / out-of-order move and is rejected
 * (R9.3).
 */
export interface SessionMoveCommand {
  readonly participantId: string;
  readonly direction: Direction;
  readonly expectedSeq: number;
}

/** Why a move was rejected against the authoritative state. */
export type SessionMoveRejectionReason =
  "unknown-participant" | "session-not-racing" | "out-of-order" | "illegal-move";

/**
 * Typed result of resolving a move against the authoritative state — never
 * thrown. On success, `state` carries the advanced authoritative state; on
 * rejection, the reason is reported and the caller's state is left unchanged.
 */
export type ResolveSessionMoveResult =
  | { readonly ok: true; readonly state: SharedSessionState }
  | { readonly ok: false; readonly reason: SessionMoveRejectionReason };

// ---------------------------------------------------------------------------
// Reducer (implemented in Task 16.2)
// ---------------------------------------------------------------------------

/**
 * The status a shared session must be in for moves to be accepted. Moves are
 * only resolved while the race is live; a Lobby or Ended session rejects them
 * (R8.2 lifecycle).
 */
const RACING: SharedSessionStatus = "Racing";

/**
 * Sentinel remaining time used when replaying a Participant's move through the
 * shared core. It only has to be strictly positive so that `resolveMove` treats
 * a step onto the exit as a legal move (it advances the avatar) rather than a
 * timed-out no-op (R4.5) — session-level win/timeout lifecycle is resolved
 * elsewhere, not by this movement replay.
 */
const REPLAY_REMAINING_MS = 1;

function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.column === b.column;
}

/**
 * Wrap a Participant's authoritative position as the minimal `PlayingState` the
 * shared core movement rule operates on, so a session move is resolved by the
 * exact same rule as solo play (R9.2) rather than a reimplementation.
 */
function asPlayingState(
  maze: Maze,
  timeLimit: TimeLimit,
  position: Position,
): PlayingState {
  return {
    status: "Playing",
    maze,
    avatar: position,
    timeLimit,
    remainingMs: REPLAY_REMAINING_MS,
    timerStarted: true,
    pausedElapsedMs: 0,
    moveInProgress: false,
  };
}

/** Replace one Participant's slice, leaving every other Participant untouched. */
function withParticipant(
  state: SharedSessionState,
  next: ParticipantState,
): SharedSessionState {
  const participants = new Map(state.participants);
  participants.set(next.participantId, next);
  return { ...state, participants };
}

/**
 * Resolve a Participant's move against the shared session's authoritative
 * state, reusing the shared core movement rule (`resolveMove`).
 *
 * The move is validated at the boundary and resolved purely against the
 * server-held authoritative position — never a client-claimed one (R9.2). A
 * legal step advances only the acting Participant's position and bumps their
 * move sequence, leaving every other Participant's slice identical (R9.2). An
 * illegal (wall / out-of-bounds), stale / out-of-order, unknown-participant, or
 * not-racing move is reported as typed data with the authoritative state left
 * unchanged (R9.3). No exception is thrown for these expected rejections.
 */
export function resolveSessionMove(
  state: SharedSessionState,
  command: SessionMoveCommand,
): ResolveSessionMoveResult {
  if (state.status !== RACING) {
    return { ok: false, reason: "session-not-racing" };
  }

  const participant = state.participants.get(command.participantId);
  if (participant === undefined) {
    return { ok: false, reason: "unknown-participant" };
  }

  // Stale / out-of-order: the client advanced from a sequence the server has
  // already moved past (R9.3). Leave the authoritative position unchanged.
  if (command.expectedSeq !== participant.moveSeq) {
    return { ok: false, reason: "out-of-order" };
  }

  // Replay the move through the unchanged shared core against the authoritative
  // position. A blocked move returns an unchanged avatar (R2.2, R2.3).
  const replayed = resolveMove(
    asPlayingState(state.maze, state.timeLimit, participant.position),
    command.direction,
  );

  if (samePosition(replayed.avatar, participant.position)) {
    return { ok: false, reason: "illegal-move" };
  }

  const advanced: ParticipantState = {
    ...participant,
    position: replayed.avatar,
    moveSeq: participant.moveSeq + 1,
  };

  return { ok: true, state: withParticipant(state, advanced) };
}

// ---------------------------------------------------------------------------
// Session lifecycle (create / join / start) — Task 16.4 pure core
// ---------------------------------------------------------------------------

/**
 * The stated maximum number of Participants a shared session admits (R8.3). A
 * join beyond this is refused with `session-full`; naming it here keeps the one
 * capacity rule in the pure core so the Session Lambda enforces it by reusing
 * this reducer rather than hardcoding a limit at the edge.
 */
export const SESSION_CAPACITY = 8;

/**
 * The public identity of a Participant joining a session: the opaque, stable
 * per-session handle and the Player-chosen display name (R11.3). The private
 * account identifier never enters the authoritative state — the Session Lambda
 * derives `participantId` from the JWT and passes only these public fields.
 */
export interface ParticipantIdentity {
  readonly participantId: string;
  readonly displayName: string;
}

/** Why a shared session could not be created from the requested parameters. */
export type CreateSessionRejectionReason = "invalid-maze";

/** Typed result of creating a shared session — never thrown. */
export type CreateSharedSessionResult =
  | { readonly ok: true; readonly state: SharedSessionState }
  | { readonly ok: false; readonly reason: CreateSessionRejectionReason };

/** Why a Player could not join a shared session (R8.3). */
export type JoinRejectionReason = "session-ended" | "session-full";

/** Typed result of joining a shared session — never thrown (R8.3). */
export type JoinSessionResult =
  | { readonly ok: true; readonly state: SharedSessionState }
  | { readonly ok: false; readonly reason: JoinRejectionReason };

/**
 * A tiny deterministic PRNG (mulberry32), matching the one score validation
 * uses so client and server rebuild an identical maze from the same seed
 * (design "Determinism"). Kept private here rather than shared to avoid widening
 * the core's surface; it is a pure function of the seed, no `Math.random`.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a shared session whose maze is owned and built by the server from the
 * maze parameters and a seed, using the unchanged shared maze core (R8.1). The
 * same params + seed always rebuild the identical maze, so every Participant
 * races the same maze without the client ever supplying it. The session begins
 * in `Lobby` with no Participants; failure to construct a valid maze (e.g. a
 * degenerate size) is reported as typed data, never thrown.
 *
 * @param sessionId - the identifier the session is addressed by.
 * @param params - the maze size + generation seed identifying the scope.
 * @param seed - the generation seed (kept explicit so callers may seed
 *   independently of the leaderboard-scope `params.seed` if ever needed; pass
 *   `params.seed` for the common case).
 */
export function createSharedSession(
  sessionId: string,
  params: MazeParams,
  seed: number,
): CreateSharedSessionResult {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(seed),
  );
  const built = factory.create(params.rows, params.columns);
  if (!built.ok) {
    return { ok: false, reason: "invalid-maze" };
  }
  // The time limit is validated upstream by the same gate score submission uses;
  // honor its typed result and fall back to the branded default if not-ok.
  const timeLimit: TimeLimit = parseTimeLimit(params.timeLimitSeconds).value;
  return {
    ok: true,
    state: {
      sessionId,
      maze: built.maze,
      timeLimit,
      participants: new Map(),
      status: "Lobby",
    },
  };
}

/**
 * Seat an authenticated Player as a Participant, enforcing the session
 * lifecycle and capacity at the boundary (R8.3). A join into an `Ended` session
 * is refused with `session-ended`; a join that would exceed {@link
 * SESSION_CAPACITY} is refused with `session-full`; either way the reason is
 * typed data the Lambda relays to the Player ("indicate why", R8.3). A Player
 * already present re-joins idempotently (a reconnect), keeping their
 * authoritative slice. A new Participant is seated on the shared start cell
 * (R8.1, R8.2) with a fresh move sequence.
 */
export function joinSession(
  state: SharedSessionState,
  identity: ParticipantIdentity,
): JoinSessionResult {
  if (state.status === "Ended") {
    return { ok: false, reason: "session-ended" };
  }

  // A re-join by an existing Participant is idempotent — it must not consume a
  // capacity slot or reset their authoritative position (supports reconnect,
  // R9.5). Return the state unchanged.
  if (state.participants.has(identity.participantId)) {
    return { ok: true, state };
  }

  if (state.participants.size >= SESSION_CAPACITY) {
    return { ok: false, reason: "session-full" };
  }

  const seated: ParticipantState = {
    participantId: identity.participantId,
    displayName: identity.displayName,
    position: state.maze.start,
    moveSeq: 0,
    status: "Racing",
  };
  return { ok: true, state: withParticipant(state, seated) };
}

/**
 * Transition a session to `Racing` so moves are accepted (R8.2). Idempotent: a
 * session already `Racing` is returned unchanged, and an `Ended` session is not
 * revived (only `Lobby` starts). Every Participant is already seated on the
 * shared start under the shared time limit by {@link joinSession}, so starting
 * is purely a status transition.
 */
export function startSession(state: SharedSessionState): SharedSessionState {
  if (state.status !== "Lobby") {
    return state;
  }
  return { ...state, status: RACING };
}

// ---------------------------------------------------------------------------
// Update projections — authoritative diffs the server publishes (R9.1, R9.4)
// ---------------------------------------------------------------------------

/**
 * One Participant's public standing, as published to the session channel.
 * Deliberately public-safe: it carries the display name, never the private
 * account identifier (R11.3), and the server-owned position/finish, never a
 * client-computed one (R9.2). Mirrors the client-side `ParticipantUpdate` so the
 * publishing adapter serializes this shape directly.
 */
export interface ParticipantProjection {
  readonly participantId: string;
  readonly displayName: string;
  readonly position: Position;
  /** Finish rank once the Participant reaches the exit, else `null` (R10.1). */
  readonly finishedRank: number | null;
}

/**
 * An authoritative update the server publishes to a session's channel, as a
 * discriminated union (data-model steering "make illegal states
 * unrepresentable"). These mirror the client's `SessionUpdate`; the publishing
 * adapter carries them across the wire and the client validates them back at its
 * boundary. Kept in the pure core so both the reducer's callers and the adapter
 * agree on one shape.
 */
export type SessionUpdate =
  | {
      readonly kind: "snapshot";
      readonly maze: Maze;
      readonly timeLimit: TimeLimit;
      readonly status: SharedSessionStatus;
      readonly participants: ReadonlyArray<ParticipantProjection>;
    }
  | { readonly kind: "progress"; readonly participant: ParticipantProjection }
  | { readonly kind: "join"; readonly participant: ParticipantProjection }
  | { readonly kind: "disconnect"; readonly participantId: string };

/** Project a Participant's authoritative slice into its public projection. */
export function toParticipantProjection(
  participant: ParticipantState,
): ParticipantProjection {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    position: participant.position,
    // Session finish/rank recording is Task 17; a still-racing Participant has
    // no rank yet. Modelled explicitly so the field is never absent.
    finishedRank: null,
  };
}

/**
 * Project the whole authoritative state into a `snapshot` update: the shared
 * maze (R8.1), the time limit, and every current Participant. Sent on join and
 * on resubscribe after a reconnect so the client can restore state (R9.4, R9.5).
 */
export function toSnapshotUpdate(state: SharedSessionState): SessionUpdate {
  return {
    kind: "snapshot",
    maze: state.maze,
    timeLimit: state.timeLimit,
    status: state.status,
    participants: [...state.participants.values()].map(toParticipantProjection),
  };
}

/** Project a single Participant's advance into a minimal `progress` diff (R9.1). */
export function toProgressUpdate(participant: ParticipantState): SessionUpdate {
  return { kind: "progress", participant: toParticipantProjection(participant) };
}

/** Project a Participant's arrival into a `join` diff. */
export function toJoinUpdate(participant: ParticipantState): SessionUpdate {
  return { kind: "join", participant: toParticipantProjection(participant) };
}
