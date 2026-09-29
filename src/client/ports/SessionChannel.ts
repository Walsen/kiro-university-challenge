/**
 * Client-side real-time transport port (ports-and-adapters), Phase 2b.
 *
 * `SessionChannel` is the abstraction the client depends on to take part in a
 * server-authoritative shared session: join a session, publish an intended move
 * for the server to resolve, and observe the authoritative updates the server
 * fans out. Per the Phase 2 design ("Real-time transport (R9)") and the
 * Dependency Inversion principle, the rest of the client talks only to this
 * interface; only the `AppSyncEventsChannel` adapter (this task) references AWS
 * AppSync Events. No transport type (AppSync, WebSocket) appears in this
 * contract, so pivoting to a different real-time transport is a matter of
 * swapping the adapter behind this port.
 *
 * The surface is transcribed from the design's `SessionChannel` interface. The
 * server is the single source of truth: {@link SessionChannel.publishMove} sends
 * only the Player's *intended* {@link Direction}, and authoritative resolution
 * (legal/illegal, ordering) happens server-side exactly as solo play resolves a
 * move through the shared core (R9.2, R9.3). The client never computes its own
 * authoritative position; it renders what arrives via {@link SessionChannel.onUpdate}.
 *
 * Requirements: R8.1 (same maze for all participants — the update stream is how
 * the client learns it), R9.1 (real-time publish/subscribe transport).
 */
import type { Direction, Maze, Position, TimeLimit } from "../../core/types";

// Re-export the domain shapes a caller needs to consume updates, so UI/session
// code can import them from the one port module it already depends on rather
// than reaching into `core` directly. These are the *same* core types gameplay
// uses — reused, never redefined.
export type { Direction, Maze, Position, TimeLimit } from "../../core/types";

/**
 * A handle returned by {@link SessionChannel.onUpdate}. Calling it removes the
 * registered handler so it receives no further updates; calling it more than
 * once is a safe no-op. Modelled as a plain function (no transport type) so the
 * port stays provider-agnostic.
 */
export type Unsubscribe = () => void;

/**
 * One participant's authoritative standing in a shared session, as published by
 * the server. Carries the public display name only — never the private account
 * identifier (R11.3) — and the server-owned position/finish, never a
 * client-computed one (R9.2).
 */
export interface ParticipantUpdate {
  /** Opaque, non-identifying participant handle stable for the session. */
  readonly participantId: string;
  /** Player-chosen public display name to show in the UI (R11.3). */
  readonly displayName: string;
  /** The participant's authoritative position in the shared maze (R9.2, R9.3). */
  readonly position: Position;
  /**
   * The participant's authoritative finish rank once they reach the exit, or
   * `null` while still racing / if time expired without finishing (R10.1).
   */
  readonly finishedRank: number | null;
}

/**
 * An authoritative update the server publishes to a session's channel, as a
 * discriminated union so the client must handle each kind and illegal
 * combinations are unrepresentable (data-model steering "make illegal states
 * unrepresentable"). These mirror the design's "participant progress, joins,
 * disconnects, results".
 */
export type SessionUpdate =
  /**
   * A snapshot of the whole authoritative state: the shared maze (R8.1), the
   * time limit, and every current participant. Sent on join and on
   * resubscribe after a reconnect so the client can restore state (R9.4, R9.5).
   */
  | {
      readonly kind: "snapshot";
      readonly maze: Maze;
      readonly timeLimit: TimeLimit;
      readonly status: "Lobby" | "Racing" | "Ended";
      readonly participants: ReadonlyArray<ParticipantUpdate>;
    }
  /** A participant's authoritative position advanced (a resolved, legal move). */
  | { readonly kind: "progress"; readonly participant: ParticipantUpdate }
  /** A participant joined the session. */
  | { readonly kind: "join"; readonly participant: ParticipantUpdate }
  /** A participant disconnected; their authoritative state is retained server-side (R9.4). */
  | { readonly kind: "disconnect"; readonly participantId: string }
  /** The session ended (all finished or time expired); final standings included (R10). */
  | {
      readonly kind: "result";
      readonly participants: ReadonlyArray<ParticipantUpdate>;
    };

/**
 * The real-time capability the client depends on. Implemented by
 * `AppSyncEventsChannel` in the client edges layer; substituted by fakes in
 * tests.
 */
export interface SessionChannel {
  /**
   * Join the shared session identified by `sessionId`, authenticating with the
   * Player's bearer `token` (the same Cognito JWT the HTTP API uses, R11). On
   * success the server publishes a `snapshot` update carrying the shared maze
   * and current participants. Rejects if the session cannot be joined (e.g. it
   * has ended or is at capacity, R8.3/R8.4 — surfaced by the server).
   */
  join(sessionId: string, token: string): Promise<void>;

  /**
   * Publish the Player's *intended* move to the session. The move is resolved
   * **server-side** against authoritative state (R9.2, R9.3); the client learns
   * the outcome only through a subsequent {@link SessionChannel.onUpdate}
   * `progress`/`snapshot` update, never by assuming the move applied.
   */
  publishMove(sessionId: string, move: Direction): Promise<void>;

  /**
   * Register `handler` to receive every authoritative {@link SessionUpdate} for
   * the joined session. Returns an {@link Unsubscribe} that detaches the
   * handler. Multiple handlers may be registered independently.
   */
  onUpdate(handler: (update: SessionUpdate) => void): Unsubscribe;
}
