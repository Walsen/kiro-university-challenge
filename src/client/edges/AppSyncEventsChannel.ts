/**
 * `AppSyncEventsChannel` — client edge adapter implementing the
 * {@link SessionChannel} port against AWS AppSync Events.
 *
 * This is the one adapter the design names for the real-time transport (see the
 * Phase 2 design, "Real-time transport (R9)"). Per the hexagonal architecture it
 * lives in the client edges layer and depends *inward* on the `SessionChannel`
 * port and on the narrow {@link AppSyncEventsClient} seam; the rest of the
 * client depends only on the port, so no AppSync/WebSocket type ever leaks past
 * this file (Dependency Inversion).
 *
 * Its responsibilities are a thin translation layer:
 *  - `join` connects the seam with the Player's JWT and subscribes to the
 *    session's channel, fanning validated updates out to registered handlers;
 *  - `publishMove` sends only the Player's *intended* move as a plain payload,
 *    leaving authoritative resolution to the server (R9.2, R9.3);
 *  - `onUpdate` registers/unregisters observer handlers (Observer pattern),
 *    independent of the transport.
 *
 * Incoming channel messages arrive as untyped JSON and are parsed into a domain
 * {@link SessionUpdate} at the boundary (data-model steering "validate at the
 * boundary"); malformed messages are dropped rather than delivered, so a handler
 * never sees an ill-formed update. Side effects (connect, subscribe, publish)
 * live in the injected seam; this class holds only the handler set and current
 * subscription in memory, which keeps it unit-testable against a fake seam
 * without touching AWS (the real round-trip is task 17.3).
 *
 * Requirements: R8.1, R9.1.
 */
import type { Direction, Maze, TimeLimit } from "../../core/types";
import type {
  ParticipantUpdate,
  Position,
  SessionChannel,
  SessionUpdate,
  Unsubscribe,
} from "../ports/SessionChannel";
import {
  type AppSyncEventsClient,
  type ChannelMessage,
  type ChannelSubscription,
  sessionChannelPath,
} from "./appSyncEventsClient";

/** The payload field naming the intended move on a client `publishMove`. */
const MOVE_PAYLOAD_KIND = "move" as const;

export class AppSyncEventsChannel implements SessionChannel {
  /** Registered update handlers (Observer). A Set so unsubscribe is exact. */
  private readonly handlers = new Set<(update: SessionUpdate) => void>();

  /** The live channel subscription for the joined session, or `null`. */
  private subscription: ChannelSubscription | null = null;

  /**
   * @param client the AppSync Events seam performing the actual connect /
   *   subscribe / publish; a real WebSocket client in production, a fake in
   *   tests.
   */
  public constructor(private readonly client: AppSyncEventsClient) {}

  public async join(sessionId: string, token: string): Promise<void> {
    // Tear down any prior session subscription before joining a new one, so a
    // re-join does not leak a live subscription.
    this.subscription?.close();
    await this.client.connect(token);
    const channel = sessionChannelPath(sessionId);
    this.subscription = await this.client.subscribe(channel, (message) =>
      this.dispatch(message),
    );
  }

  public async publishMove(sessionId: string, move: Direction): Promise<void> {
    await this.client.publish(sessionChannelPath(sessionId), {
      kind: MOVE_PAYLOAD_KIND,
      move,
    });
  }

  public onUpdate(handler: (update: SessionUpdate) => void): Unsubscribe {
    this.handlers.add(handler);
    let active = true;
    return () => {
      // Idempotent: a second call is a safe no-op (port contract).
      if (active) {
        active = false;
        this.handlers.delete(handler);
      }
    };
  }

  /**
   * Validate an incoming message into a {@link SessionUpdate} and fan it out to
   * every registered handler. A malformed payload is dropped, never delivered.
   */
  private dispatch(message: ChannelMessage): void {
    const update = parseUpdate(message.data);
    if (update === null) {
      return;
    }
    // Iterate a copy so a handler that unsubscribes during dispatch is safe.
    for (const handler of [...this.handlers]) {
      handler(update);
    }
  }
}

// ---------------------------------------------------------------------------
// Boundary validation: untyped JSON -> SessionUpdate (typed data, no throw)
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a plain object without asserting field types. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePosition(value: unknown): Position | null {
  if (!isRecord(value)) {
    return null;
  }
  const { row, column } = value;
  if (typeof row !== "number" || typeof column !== "number") {
    return null;
  }
  return { row, column };
}

function parseParticipant(value: unknown): ParticipantUpdate | null {
  if (!isRecord(value)) {
    return null;
  }
  const { participantId, displayName, position, finishedRank } = value;
  if (typeof participantId !== "string" || typeof displayName !== "string") {
    return null;
  }
  const parsedPosition = parsePosition(position);
  if (parsedPosition === null) {
    return null;
  }
  if (finishedRank !== null && typeof finishedRank !== "number") {
    return null;
  }
  return { participantId, displayName, position: parsedPosition, finishedRank };
}

/** Parse an array of participants, failing (null) if any element is malformed. */
function parseParticipants(value: unknown): ReadonlyArray<ParticipantUpdate> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const participants: ParticipantUpdate[] = [];
  for (const element of value) {
    const participant = parseParticipant(element);
    if (participant === null) {
      return null;
    }
    participants.push(participant);
  }
  return participants;
}

/**
 * Parse an untyped channel payload into a {@link SessionUpdate}, returning
 * `null` for anything malformed. The `maze`/`timeLimit` on a snapshot are
 * carried through as already-validated core values produced by the server (the
 * authoritative source), so they are accepted as-is once structurally present;
 * only the client-facing discriminant and participant shapes are re-checked
 * here.
 */
function parseUpdate(data: unknown): SessionUpdate | null {
  if (!isRecord(data)) {
    return null;
  }
  const { kind } = data;
  switch (kind) {
    case "snapshot": {
      const { maze, timeLimit, status, participants } = data;
      if (
        maze === undefined ||
        timeLimit === undefined ||
        (status !== "Lobby" && status !== "Racing" && status !== "Ended")
      ) {
        return null;
      }
      const parsed = parseParticipants(participants);
      if (parsed === null) {
        return null;
      }
      return {
        kind: "snapshot",
        // The server is the authoritative source of the maze/time limit; they
        // arrive as already-validated core values and are carried through once
        // structurally present, rather than re-validated on the client.
        maze: maze as Maze,
        timeLimit: timeLimit as TimeLimit,
        status,
        participants: parsed,
      };
    }
    case "progress":
    case "join": {
      const participant = parseParticipant(data["participant"]);
      if (participant === null) {
        return null;
      }
      return { kind, participant };
    }
    case "disconnect": {
      const participantId = data["participantId"];
      if (typeof participantId !== "string") {
        return null;
      }
      return { kind: "disconnect", participantId };
    }
    case "result": {
      const parsed = parseParticipants(data["participants"]);
      if (parsed === null) {
        return null;
      }
      return { kind: "result", participants: parsed };
    }
    default:
      return null;
  }
}
