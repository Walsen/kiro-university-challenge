import { describe, expect, it } from "vitest";

import {
  createSharedSession,
  joinSession,
  startSession,
  type SharedSessionState,
} from "../../core/platform/sharedSession";
import { DynamoSessionRepository } from "./DynamoSessionRepository";
import type { DynamoCommand, DynamoDocumentClient } from "./dynamoClient";
import {
  PARTITION_KEY,
  SESSION_STATE_SORT_KEY,
  SORT_KEY,
  sessionPartitionKey,
} from "./dynamoSchema";

/**
 * Unit tests for {@link DynamoSessionRepository} against a fake DocumentClient
 * seam (task 16.4). They assert the adapter maps a `load`/`save` to the right
 * DynamoDB commands and round-trips the authoritative state — including the
 * server-owned maze (R8.1) and the participants map (R9.2) — losslessly, so a
 * stateless Lambda resumes exactly the state it saved (R9.4, R9.5). No network
 * is touched; the real round-trip is the task 17.3 integration seam.
 */

const PARAMS = { rows: 5, columns: 5, seed: 99, timeLimitSeconds: 60 } as const;
const TABLE = "maze-table";

/** A minimal fake DocumentClient recording sent commands and returning a stub Item. */
class FakeDocClient implements DynamoDocumentClient {
  public readonly sent: DynamoCommand[] = [];
  public item: Record<string, unknown> | undefined;

  public send(command: DynamoCommand): Promise<unknown> {
    this.sent.push(command);
    const name = command.constructor.name;
    if (name === "GetCommand") {
      return Promise.resolve({ Item: this.item });
    }
    // PutCommand: record what would be written so a subsequent Get can return it.
    const input = command.input as { Item?: Record<string, unknown> };
    if (input.Item !== undefined) {
      this.item = input.Item;
    }
    return Promise.resolve({});
  }
}

function racingFixture(): SharedSessionState {
  const created = createSharedSession("session-1", PARAMS, PARAMS.seed);
  if (!created.ok) throw new Error("fixture");
  const joined = joinSession(startSession(created.state), {
    participantId: "acct-alice",
    displayName: "Alice",
  });
  if (!joined.ok) throw new Error("fixture join");
  return joined.state;
}

describe("DynamoSessionRepository — load", () => {
  it("returns null when no session item exists", async () => {
    const client = new FakeDocClient();
    const repo = new DynamoSessionRepository({ client, tableName: TABLE });

    const state = await repo.load("missing");

    expect(state).toBeNull();
    const get = client.sent[0];
    expect(get?.constructor.name).toBe("GetCommand");
    expect(get?.input).toMatchObject({
      TableName: TABLE,
      Key: {
        [PARTITION_KEY]: sessionPartitionKey("missing"),
        [SORT_KEY]: SESSION_STATE_SORT_KEY,
      },
    });
  });
});

describe("DynamoSessionRepository — save then load round-trip", () => {
  it("persists and restores the authoritative state losslessly", async () => {
    const client = new FakeDocClient();
    const repo = new DynamoSessionRepository({ client, tableName: TABLE });
    const state = racingFixture();

    await repo.save(state);
    const loaded = await repo.load(state.sessionId);

    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    expect(loaded.sessionId).toBe(state.sessionId);
    expect(loaded.status).toBe("Racing");
    expect(loaded.maze).toEqual(state.maze);
    expect(loaded.timeLimit).toBe(state.timeLimit);
    // The participants map round-trips (Map -> stored -> Map).
    expect(loaded.participants.get("acct-alice")).toEqual(
      state.participants.get("acct-alice"),
    );
    expect(loaded.participants.size).toBe(1);
  });

  it("writes the session state item under the session partition", async () => {
    const client = new FakeDocClient();
    const repo = new DynamoSessionRepository({ client, tableName: TABLE });
    const state = racingFixture();

    await repo.save(state);

    const put = client.sent.find((c) => c.constructor.name === "PutCommand");
    expect(put?.input).toMatchObject({
      TableName: TABLE,
      Item: {
        [PARTITION_KEY]: sessionPartitionKey("session-1"),
        [SORT_KEY]: SESSION_STATE_SORT_KEY,
      },
    });
  });
});
