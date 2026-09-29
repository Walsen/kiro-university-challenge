/**
 * `DynamoSessionRepository` — the {@link SessionRepository} adapter over DynamoDB
 * (task 16.4, Phase 2b).
 *
 * The Session Lambda is stateless across invocations, but a shared session's
 * `Authoritative_State` must survive between a join, each move, and a reconnect
 * (R9.2, R9.4, R9.5). This adapter persists that state as a single item in the
 * session's partition (`PK = SESSION#<sessionId>`, `SK = STATE`), so a cold
 * Lambda `load`s exactly the state the previous invocation `save`d and resumes
 * without ever having seen the session before.
 *
 * ## Why the state is stored as a JSON document
 *
 * `SharedSessionState` carries a `Maze` (nested arrays) and a `ReadonlyMap` of
 * Participants — shapes DynamoDB's attribute model does not represent directly
 * (a `Map` object is not a DynamoDB map, and marshalling the nested grid per
 * attribute buys nothing here). The whole state is queried and rewritten as one
 * unit on every touch, never partially updated, so it is serialized to a single
 * JSON `state` attribute and parsed back on load. That keeps the item
 * self-contained and the (de)serialization lossless and centralized in one
 * place. The branded `TimeLimit` survives a JSON round-trip because it is a
 * number at runtime.
 *
 * Only this module (in the edges layer) touches the AWS SDK; the handler depends
 * on the {@link SessionRepository} port. A fake DocumentClient substitutes the
 * seam in unit tests, and the real round-trip is the task 17.3 integration seam.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import type {
  ParticipantState,
  SharedSessionState,
} from "../../core/platform/sharedSession";
import type { DynamoDocumentClient } from "./dynamoClient";
import {
  PARTITION_KEY,
  SESSION_STATE_SORT_KEY,
  SORT_KEY,
  sessionPartitionKey,
} from "./dynamoSchema";
import type { SessionRepository } from "../ports/SessionRepository";

/** The item attribute holding the serialized authoritative state document. */
const STATE_ATTRIBUTE = "state";

/** Construction dependencies (Dependency Injection). */
export interface DynamoSessionRepositoryConfig {
  /** The DynamoDB DocumentClient seam; a fake in tests, the real client in prod. */
  readonly client: DynamoDocumentClient;
  /** The single table's name (from the CDK stack output, injected at the root). */
  readonly tableName: string;
}

/**
 * The wire shape of the serialized state: the participants map flattened to an
 * array so it survives JSON, everything else carried verbatim. Private to this
 * adapter — the port exposes only the domain `SharedSessionState`.
 */
interface SerializedState {
  readonly sessionId: string;
  readonly maze: SharedSessionState["maze"];
  readonly timeLimit: number;
  readonly status: SharedSessionState["status"];
  readonly participants: ReadonlyArray<ParticipantState>;
}

export class DynamoSessionRepository implements SessionRepository {
  private readonly client: DynamoDocumentClient;
  private readonly tableName: string;

  public constructor(config: DynamoSessionRepositoryConfig) {
    this.client = config.client;
    this.tableName = config.tableName;
  }

  public async load(sessionId: string): Promise<SharedSessionState | null> {
    const response = (await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          [PARTITION_KEY]: sessionPartitionKey(sessionId),
          [SORT_KEY]: SESSION_STATE_SORT_KEY,
        },
      }),
    )) as { Item?: Record<string, unknown> };

    const raw = response.Item?.[STATE_ATTRIBUTE];
    if (typeof raw !== "string") {
      return null;
    }
    return deserializeState(raw);
  }

  public async save(state: SharedSessionState): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          [PARTITION_KEY]: sessionPartitionKey(state.sessionId),
          [SORT_KEY]: SESSION_STATE_SORT_KEY,
          [STATE_ATTRIBUTE]: serializeState(state),
        },
      }),
    );
  }
}

/** Flatten the authoritative state to a JSON string (participants map -> array). */
function serializeState(state: SharedSessionState): string {
  const wire: SerializedState = {
    sessionId: state.sessionId,
    maze: state.maze,
    timeLimit: state.timeLimit,
    status: state.status,
    participants: [...state.participants.values()],
  };
  return JSON.stringify(wire);
}

/**
 * Parse a serialized state document back into the domain `SharedSessionState`,
 * rebuilding the participants `Map`. Returns `null` for anything unparseable so
 * a corrupt record reads as "no session" rather than throwing into the handler.
 * The `timeLimit` is carried back as the branded `TimeLimit` — it was produced
 * by `parseTimeLimit` before being stored and is a plain number at runtime, so
 * the round-trip preserves it.
 */
function deserializeState(raw: string): SharedSessionState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const wire = parsed as SerializedState;
  const participants = new Map<string, ParticipantState>();
  for (const participant of wire.participants) {
    participants.set(participant.participantId, participant);
  }
  return {
    sessionId: wire.sessionId,
    maze: wire.maze,
    timeLimit: wire.timeLimit as SharedSessionState["timeLimit"],
    status: wire.status,
    participants,
  };
}
