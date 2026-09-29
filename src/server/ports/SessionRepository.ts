/**
 * Server-side shared-session ports (ports-and-adapters), Phase 2b.
 *
 * The Session service (Lambda) is the single source of truth for a shared
 * session's `Authoritative_State` (R9.2). But a Lambda is stateless across
 * invocations, so the authoritative state must live in durable storage between
 * a join, each move, and the publish that follows — and the authoritative
 * updates must reach every Participant over the real-time transport. Those are
 * two side-effecting concerns, so they sit behind two small ports here
 * (Interface Segregation, Dependency Inversion): the pure session logic and the
 * application handler depend only on these interfaces, and only the DynamoDB /
 * AppSync adapters in `src/server/edges` reference the AWS SDK. No storage or
 * AppSync type appears in these contracts, so swapping either substrate is a
 * matter of changing the adapter, not the handler.
 *
 * The domain types are reused unchanged from the pure core
 * (`platform/sharedSession`): `SharedSessionState` is the authoritative state
 * the reducer advances, and `SessionUpdate` is the diff the reducer projects and
 * the publisher fans out. This port adds only the provider-agnostic
 * `MazeParams` scope the session was created for, which storage needs to
 * reconstruct or key the record.
 *
 * Requirements: R8.1 (server-owned maze persisted authoritatively), R9.1
 * (publish updates over the real-time transport), R9.2/R9.4/R9.5 (authoritative
 * state retained on the server across moves and reconnects).
 */
import type {
  SessionUpdate,
  SharedSessionState,
} from "../../core/platform/sharedSession";

/**
 * Durable storage for a shared session's authoritative state. Implemented by
 * `DynamoSessionRepository` in the server edges layer; substituted by an
 * in-memory fake in the handler's unit tests.
 *
 * Every operation is keyed by `sessionId` so one session's state is loaded,
 * created, and saved as a unit. The state carries the server-owned maze (R8.1)
 * and every Participant's authoritative position (R9.2), which is exactly what
 * must survive between the stateless Lambda invocations that handle a join, each
 * move, and a reconnect (R9.4, R9.5).
 */
export interface SessionRepository {
  /**
   * Load the authoritative state for `sessionId`, or `null` when no session
   * with that id has been created yet. The caller creates one (via the pure
   * `createSharedSession`) and persists it with {@link save} when this is
   * `null`.
   */
  load(sessionId: string): Promise<SharedSessionState | null>;

  /**
   * Durably record the authoritative state, creating the record on first save
   * and overwriting it on subsequent saves. The last-written state is the
   * single source of truth the next invocation loads. Storing the whole state
   * (rather than a diff) keeps the record self-contained so a cold Lambda can
   * resume a session it never saw before.
   */
  save(state: SharedSessionState): Promise<void>;
}

/**
 * The real-time fan-out capability the Session service depends on to deliver
 * authoritative updates to a session's Participants (R9.1). Implemented by the
 * AppSync-publishing adapter in the server edges layer — the only server code
 * that touches AppSync Events — and substituted by a recording fake in tests.
 *
 * Kept separate from {@link SessionRepository} (Interface Segregation): persisting
 * authoritative state and broadcasting a diff are distinct concerns behind
 * distinct substrates (DynamoDB vs AppSync Events). The publisher carries the
 * pure-core {@link SessionUpdate} verbatim; the client validates it back into a
 * domain update at its own boundary.
 */
export interface SessionUpdatePublisher {
  /**
   * Publish one authoritative update to the channel for `sessionId` (addressed
   * as `sessions/<sessionId>` on the shared namespace). Only the server, acting
   * as the IAM principal, publishes — clients merely subscribe — so an update
   * on the channel is authoritative by construction (R9.2).
   */
  publish(sessionId: string, update: SessionUpdate): Promise<void>;
}
