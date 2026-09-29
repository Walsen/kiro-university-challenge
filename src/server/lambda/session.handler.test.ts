/**
 * Unit tests for the Session Lambda entry (task 16.4 / 15.x wiring, Phase 2b).
 *
 * The entry is the shim the `sessions` channel namespace's `onPublish` handler
 * invokes: it derives the acting identity from the AppSync-**validated** context
 * (never the client payload), derives the session scope from the authorized
 * channel path, translates each untrusted client intent into a command, and
 * delegates to the pure Session handler bound at the composition root. These
 * tests inject a fake composition context (and a fake trace annotator) via the
 * module mocks and assert the trust boundary and the intent translation.
 *
 * Server authority (R9.2/R11.2) is the property under test: a client cannot
 * choose its own `accountId`, `displayName`, or `sessionId`; those come from the
 * verified identity and the authorized channel, regardless of what the payload
 * claims.
 *
 * _Requirements: R9.2, R9.3, R11.2._
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { annotateAccountId } from "../edges/xray";
import { sessionContext } from "./sessionContext";
import { handler } from "./session.handler";

vi.mock("../edges/xray", () => ({
  annotateAccountId: vi.fn(),
}));

// The composition context builds real AWS adapters at module load; replace it
// with a fake whose `handle` records the command it was given.
vi.mock("./sessionContext", () => ({
  sessionContext: { handle: vi.fn().mockResolvedValue({ ok: true }) },
}));

const handleMock = vi.mocked(sessionContext.handle);
const annotateMock = vi.mocked(annotateAccountId);

afterEach(() => {
  vi.clearAllMocks();
  handleMock.mockResolvedValue({ ok: true });
});

/** The verified identity AppSync attaches: a Cognito `sub` and a name claim. */
const IDENTITY = { sub: "account-1", claims: { sub: "account-1", name: "Ada" } };

/** The most-recent command the pure handler was called with. */
function lastCommand(): Record<string, unknown> {
  const call = handleMock.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

describe("session Lambda entry — identity trust boundary (R9.2, R11.2)", () => {
  it("derives accountId and displayName from the validated identity, not the payload", async () => {
    await handler({
      identity: IDENTITY,
      channel: "sessions/room-9",
      events: [
        {
          // A hostile payload trying to act as someone else — all ignored.
          payload: {
            kind: "move",
            move: "Up",
            accountId: "victim",
            displayName: "Impersonator",
            sessionId: "other-room",
          },
        },
      ],
    });

    const command = lastCommand();
    expect(command["accountId"]).toBe("account-1");
    expect(command["displayName"]).toBe("Ada");
    // sessionId comes from the authorized channel path, not the payload.
    expect(command["sessionId"]).toBe("room-9");
  });

  it("annotates the trace with the acting accountId exactly once", async () => {
    await handler({ identity: IDENTITY, channel: "sessions/room-9", events: [{ payload: {} }] });
    expect(annotateMock).toHaveBeenCalledTimes(1);
    expect(annotateMock).toHaveBeenCalledWith("account-1");
  });

  it("falls back to a safe display name when the identity has no name claim", async () => {
    await handler({
      identity: { sub: "account-2", claims: { sub: "account-2" } },
      channel: "sessions/room-1",
      events: [{ payload: { kind: "move", move: "Down" } }],
    });
    expect(lastCommand()["displayName"]).toBe("Unknown Player");
  });

  it("propagates an unauthenticated rejection when there is no verified sub", async () => {
    handleMock.mockResolvedValueOnce({ ok: false, reason: "unauthenticated" });

    const response = await handler({
      // No identity at all; the pure handler rejects the account-less command.
      channel: "sessions/room-1",
      events: [{ payload: { kind: "move", move: "Up" } }],
    });

    expect(annotateMock).not.toHaveBeenCalled();
    expect(lastCommand()["accountId"]).toBe("");
    expect(response.results).toEqual([{ ok: false, reason: "unauthenticated" }]);
  });
});

describe("session Lambda entry — intent translation (R9.3)", () => {
  it("maps the client move vocabulary (kind/move) to the core command (action/direction)", async () => {
    await handler({
      identity: IDENTITY,
      channel: "sessions/room-9",
      events: [{ payload: { kind: "move", move: "Left", expectedSeq: 3 } }],
    });

    const command = lastCommand();
    expect(command["action"]).toBe("move");
    expect(command["direction"]).toBe("Left");
    // Fields the pure handler validates are carried through untouched.
    expect(command["expectedSeq"]).toBe(3);
  });

  it("accepts the core vocabulary directly (action/direction)", async () => {
    await handler({
      identity: IDENTITY,
      channel: "sessions/room-9",
      events: [{ payload: { action: "move", direction: "Right", expectedSeq: 0 } }],
    });

    const command = lastCommand();
    expect(command["action"]).toBe("move");
    expect(command["direction"]).toBe("Right");
  });

  it("carries a join intent's params through for the pure handler to validate", async () => {
    const params = { rows: 5, columns: 5, seed: 1, timeLimitSeconds: 60 };
    await handler({
      identity: IDENTITY,
      channel: "sessions/room-9",
      events: [{ payload: { kind: "join", params } }],
    });

    const command = lastCommand();
    expect(command["action"]).toBe("join");
    expect(command["params"]).toEqual(params);
  });

  it("resolves each event in a batch, one command per published event", async () => {
    await handler({
      identity: IDENTITY,
      channel: "sessions/room-9",
      events: [
        { payload: { kind: "move", move: "Up" } },
        { payload: { kind: "move", move: "Down" } },
      ],
    });

    expect(handleMock).toHaveBeenCalledTimes(2);
  });

  it("drops a non-object payload rather than turning it into a command", async () => {
    await handler({
      identity: IDENTITY,
      channel: "sessions/room-9",
      events: [{ payload: "not-an-object" }, { payload: { kind: "move", move: "Up" } }],
    });

    // Only the one well-formed intent produced a command.
    expect(handleMock).toHaveBeenCalledTimes(1);
  });
});

describe("session Lambda entry — legacy direct-invocation shape", () => {
  it("accepts a single {identity, payload} event as a batch of one", async () => {
    await handler({
      identity: IDENTITY,
      // No channel: the direct seam carried the sessionId in the payload.
      payload: { action: "move", direction: "Up", expectedSeq: 1, sessionId: "room-direct" },
    });

    const command = lastCommand();
    expect(handleMock).toHaveBeenCalledTimes(1);
    expect(command["sessionId"]).toBe("room-direct");
    expect(command["accountId"]).toBe("account-1");
  });
});
