/**
 * The Session service application handler (Task 16.4): join a shared session,
 * resolve intended moves against authoritative state, and publish authoritative
 * updates.
 *
 * This is the orchestration seam of the real-time shared-session path (R8, R9).
 * It does only orchestration — parse the untrusted command, apply the pure
 * shared-session core against the authoritative state, persist the result, and
 * publish the resulting diff — and holds no rules of its own. The server-owned
 * maze creation (R8.1), capacity / ended enforcement (R8.3), and move resolution
 * against authoritative state (R9.2/R9.3) all live in the pure core
 * (`platform/sharedSession`); durability and fan-out live behind the
 * {@link SessionRepository} / {@link SessionUpdatePublisher} ports. So this
 * module depends only on the pure core and the ports, never on the AWS SDK
 * (hexagonal Dependency Rule).
 *
 * ## Server-authoritative by construction (R9.2)
 *
 * A client publishes only its *intended* move; the acting identity is the JWT
 * `sub` supplied by the caller's authenticated context, never a client-claimed
 * field (R11.2). The handler resolves the move against the server-held
 * authoritative position via `resolveSessionMove` — exactly the rule solo play
 * uses — so an illegal or out-of-order move is rejected, the authoritative
 * position is left unchanged, and nothing is persisted or published (R9.3). Only
 * a legal, in-order move advances state and publishes a `progress` diff (R9.1).
 *
 * ## Untrusted input
 *
 * The command arrives as `unknown` and is parsed defensively here (data-model
 * steering "validate at the boundary"). A malformed command, an absent acting
 * account, or a command against a missing session is reported as typed data —
 * never thrown — and touches neither edge.
 *
 * Determinism. The maze is rebuilt from params + seed through the shared core,
 * so it is a pure function of the command; the handler introduces no clock or
 * randomness of its own.
 */
import {
  createSharedSession,
  joinSession,
  resolveSessionMove,
  startSession,
  toProgressUpdate,
  toSnapshotUpdate,
  type Direction,
  type MazeParams,
  type SharedSessionState,
} from "../../core/index";
import type {
  SessionRepository,
  SessionUpdatePublisher,
} from "../ports/SessionRepository";

// ---------------------------------------------------------------------------
// Command / result shapes
// ---------------------------------------------------------------------------

/** A request to join (or create-and-join) a shared session. */
export interface JoinCommand {
  readonly action: "join";
  readonly sessionId: string;
  /** The acting account (JWT `sub`); also the Participant handle for the session. */
  readonly accountId: string;
  /** The Player-chosen public display name (R11.3). */
  readonly displayName: string;
  /** The maze scope + seed the server builds the shared maze from (R8.1). */
  readonly params: MazeParams;
}

/** A request to resolve one intended move against authoritative state. */
export interface MoveCommand {
  readonly action: "move";
  readonly sessionId: string;
  /** The acting account (JWT `sub`); the Participant whose position is resolved. */
  readonly accountId: string;
  readonly direction: Direction;
  /** The move sequence the client believes it is advancing from (R9.3). */
  readonly expectedSeq: number;
}

/** Why a session command was rejected (typed data, never thrown). */
export type SessionRejectionReason =
  | "unauthenticated"
  | "malformed"
  | "unknown-session"
  | "invalid-maze"
  | "session-ended"
  | "session-full"
  | "unknown-participant"
  | "session-not-racing"
  | "out-of-order"
  | "illegal-move";

/** The typed outcome of handling a session command. */
export type SessionCommandResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: SessionRejectionReason };

/** Collaborators the Session handler depends on, injected at the composition root. */
export interface SessionHandlerDeps {
  readonly repository: SessionRepository;
  readonly publisher: SessionUpdatePublisher;
}

const OK: SessionCommandResult = { ok: true };

function rejected(reason: SessionRejectionReason): SessionCommandResult {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Boundary parsing (untrusted command -> typed command)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const VALID_DIRECTIONS: ReadonlySet<string> = new Set<Direction>([
  "Up",
  "Down",
  "Left",
  "Right",
]);

function parseMazeParams(value: unknown): MazeParams | null {
  if (!isRecord(value)) {
    return null;
  }
  const { rows, columns, seed, timeLimitSeconds } = value;
  if (
    typeof rows !== "number" ||
    typeof columns !== "number" ||
    typeof seed !== "number" ||
    typeof timeLimitSeconds !== "number"
  ) {
    return null;
  }
  return { rows, columns, seed, timeLimitSeconds };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Build the Session service handler over its injected ports.
 *
 * @param deps - the authoritative-state store and the update publisher.
 * @returns an async function from an untrusted command to a typed
 *   {@link SessionCommandResult}. It persists and publishes on a state change and
 *   does neither on a rejection.
 */
export function makeSessionHandler({
  repository,
  publisher,
}: SessionHandlerDeps): (command: unknown) => Promise<SessionCommandResult> {
  return async function handleSessionCommand(command): Promise<SessionCommandResult> {
    if (!isRecord(command)) {
      return rejected("malformed");
    }

    // Identity first: without an acting account there is nothing to act as, and
    // an unauthenticated Player may not join (R8.4). Read only from the supplied
    // authenticated context, never a client-claimed field (R11.2).
    if (!isNonEmptyString(command["accountId"])) {
      // An entirely account-less command is unauthenticated; but a malformed
      // command with no recognisable action is malformed. Disambiguate on action.
      return command["action"] === "join" || command["action"] === "move"
        ? rejected("unauthenticated")
        : rejected("malformed");
    }

    switch (command["action"]) {
      case "join":
        return handleJoin(command, { repository, publisher });
      case "move":
        return handleMove(command, { repository, publisher });
      default:
        return rejected("malformed");
    }
  };
}

/**
 * Join (creating the server-owned session on first join). Persists the new
 * authoritative state and publishes a snapshot so the joiner — including a
 * reconnecting Participant — receives the current authoritative state (R9.4,
 * R9.5).
 */
async function handleJoin(
  command: Record<string, unknown>,
  { repository, publisher }: SessionHandlerDeps,
): Promise<SessionCommandResult> {
  const sessionId = command["sessionId"];
  const displayName = command["displayName"];
  const params = parseMazeParams(command["params"]);
  const accountId = command["accountId"] as string;
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(displayName) || params === null) {
    return rejected("malformed");
  }

  // Load the authoritative state, or create it with the server-owned maze on the
  // first join (R8.1). Creation is a pure function of params + seed.
  let state = await repository.load(sessionId);
  if (state === null) {
    const created = createSharedSession(sessionId, params, params.seed);
    if (!created.ok) {
      return rejected("invalid-maze");
    }
    // A newly created session begins the race so joined Participants may move
    // immediately (R8.2). Lifecycle refinement (an explicit Lobby wait) is a
    // later concern; a single-invocation join must leave the session Racing.
    state = startSession(created.state);
  }

  const joined = joinSession(state, {
    participantId: accountId,
    displayName,
  });
  if (!joined.ok) {
    // Capacity / ended: nothing persisted or published, reason relayed (R8.3).
    return rejected(joined.reason);
  }

  await repository.save(joined.state);
  // The joiner (or reconnecting Participant) receives the full authoritative
  // state so it can render the shared maze and every current position (R9.4,
  // R9.5).
  await publisher.publish(sessionId, toSnapshotUpdate(joined.state));
  return OK;
}

/**
 * Resolve one intended move against authoritative state. On a legal, in-order
 * move the advance is persisted and a minimal `progress` diff is published
 * (R9.1); on any rejection the authoritative state is left unchanged and nothing
 * is persisted or published (R9.3).
 */
async function handleMove(
  command: Record<string, unknown>,
  { repository, publisher }: SessionHandlerDeps,
): Promise<SessionCommandResult> {
  const sessionId = command["sessionId"];
  const direction = command["direction"];
  const expectedSeq = command["expectedSeq"];
  const accountId = command["accountId"] as string;
  if (
    !isNonEmptyString(sessionId) ||
    typeof direction !== "string" ||
    !VALID_DIRECTIONS.has(direction) ||
    typeof expectedSeq !== "number" ||
    !Number.isInteger(expectedSeq)
  ) {
    return rejected("malformed");
  }

  const state = await repository.load(sessionId);
  if (state === null) {
    return rejected("unknown-session");
  }

  const resolved = resolveSessionMove(state, {
    participantId: accountId,
    direction: direction as Direction,
    expectedSeq,
  });
  if (!resolved.ok) {
    // Server-authoritative rejection: leave state untouched, publish nothing
    // (R9.3). The client learns the real position only from authoritative
    // updates, never by assuming its move applied.
    return rejected(resolved.reason);
  }

  await repository.save(resolved.state);
  await publisher.publish(sessionId, progressFor(resolved.state, accountId));
  return OK;
}

/** Project the acting Participant's advanced slice into a `progress` diff. */
function progressFor(
  state: SharedSessionState,
  participantId: string,
): ReturnType<typeof toProgressUpdate> {
  const participant = state.participants.get(participantId);
  // The move resolved to a change for this Participant, so their slice exists;
  // guard defensively and fall back to a snapshot rather than throwing.
  if (participant === undefined) {
    return toSnapshotUpdate(state);
  }
  return toProgressUpdate(participant);
}
