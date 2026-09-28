/**
 * Integration Point B — Store + core (Task 11.3, BLOCKING gate).
 *
 * Unit tests verify `GameStore` against a stubbed reducer and verify the pure
 * core in isolation. This test closes the seam between them: it drives the
 * *real* `GameStore` with the *real* `reduce` (imported internally by the
 * store, never stubbed here) and asserts the emitted `GameEvent`s
 * (`StateChanged`, `MoveBlocked`, `InvalidMaze`) correspond to the real
 * reducer's state transitions across a representative session.
 *
 *   GameStore.dispatch → reduce → resolveMove / tickTimer
 *                      → DefaultGameSessionFactory → a real generated maze
 *
 * The only test double is the injected `MazeSource` port. For the valid-session
 * cases it returns a real maze built by `DefaultMazeFactory` +
 * `RecursiveBacktrackerGenerator` + a seeded mulberry32 rng; for the
 * invalid-maze case it returns `{ ok: false, error }`. Every emitted
 * `StateChanged` is checked against both `store.getState()` and the state a
 * direct `reduce` call produces, so the assertions bind the events to the real
 * reducer's output rather than to hand-written expectations.
 *
 * Determinism: the maze comes from a seeded rng; no wall clock, no
 * `Math.random()`. The solvable route is derived by a local BFS over the real
 * maze's Path cells so the WIN run follows a route the maze actually contains.
 *
 * _Requirements: 1.6, 2.2, 2.3, 5.1, 5.2; design "Integration testing" Point B._
 */
import { describe, expect, it, vi } from "vitest";

import { GameStore, type GameEvent, type MazeSource } from "./GameStore";
import {
  CellKind,
  DefaultMazeFactory,
  RecursiveBacktrackerGenerator,
  parseTimeLimit,
  reduce,
  type Direction,
  type GameState,
  type IdleState,
  type Maze,
  type MazeResult,
  type MazeValidationError,
  type Position,
  type TimeLimit,
} from "../core";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * A tiny deterministic PRNG (mulberry32). Given the same seed it yields the
 * same sequence in `[0, 1)`, so maze generation is reproducible without
 * touching `Math.random`. Matches the seeded rng used across the core tests.
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

/** A valid branded TimeLimit produced through the only validator that makes one. */
function timeLimit(seconds: number): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test setup: ${String(seconds)} is not a valid TimeLimit`);
  }
  return result.value;
}

/** Build a real, validated maze from a seeded rng via the real factory. */
function generatedMaze(rows: number, columns: number, seed: number): Maze {
  const factory = new DefaultMazeFactory(
    new RecursiveBacktrackerGenerator(),
    mulberry32(seed),
  );
  const result = factory.create(rows, columns);
  if (!result.ok) {
    throw new Error(`test setup: maze generation failed with ${result.error}`);
  }
  return result.maze;
}

/**
 * A `MazeSource` stub that always succeeds with the supplied maze. This is the
 * only test double: the reducer the store runs is the real one.
 */
function succeedingSource(maze: Maze): MazeSource {
  return { create: (): MazeResult => ({ ok: true, maze }) };
}

/** A `MazeSource` stub that always fails with the supplied validation error. */
function failingSource(error: MazeValidationError): MazeSource {
  return { create: (): MazeResult => ({ ok: false, error }) };
}

/** A fresh Idle state seeded with a real maze — the store's starting point. */
function idleOn(maze: Maze, seconds: number): IdleState {
  return { status: "Idle", maze, avatar: maze.start, timeLimit: timeLimit(seconds) };
}

/**
 * Build a store on a real maze plus an observer that records every event in
 * order, so the test can assert the emitted event stream matches the
 * transitions the store took.
 */
function storeWith(
  initial: GameState,
  source: MazeSource,
): { store: GameStore; events: GameEvent[]; observer: ReturnType<typeof vi.fn> } {
  const store = new GameStore(initial, source);
  const events: GameEvent[] = [];
  const observer = vi.fn((event: GameEvent) => {
    events.push(event);
  });
  store.subscribe(observer);
  return { store, events, observer };
}

// ---------------------------------------------------------------------------
// Local BFS over the real generated maze (test-only path finder)
// ---------------------------------------------------------------------------

const DIRECTION_DELTAS: ReadonlyArray<readonly [Direction, Position]> = [
  ["Up", { row: -1, column: 0 }],
  ["Down", { row: 1, column: 0 }],
  ["Left", { row: 0, column: -1 }],
  ["Right", { row: 0, column: 1 }],
];

function keyOf(p: Position): string {
  return `${p.row},${p.column}`;
}

function isPathCell(maze: Maze, p: Position): boolean {
  return maze.grid[p.row]?.[p.column] === CellKind.Path;
}

/**
 * BFS over 4-directionally adjacent Path cells, returning the `Direction`s that
 * walk the avatar from `maze.start` to `maze.exit`. Mirrors the connectivity
 * `validateMaze` enforces, so following it through the store's real reducer
 * must land on the exit. Throws if no route exists (a contract violation for a
 * validated maze).
 */
function bfsDirections(maze: Maze): Direction[] {
  const start = maze.start;
  const exit = maze.exit;
  const visited = new Set<string>([keyOf(start)]);
  const queue: Position[] = [start];
  const cameFrom = new Map<string, { prev: Position; direction: Direction }>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.row === exit.row && current.column === exit.column) {
      return reconstruct(cameFrom, start, exit);
    }
    for (const [direction, delta] of DIRECTION_DELTAS) {
      const next: Position = {
        row: current.row + delta.row,
        column: current.column + delta.column,
      };
      if (!isPathCell(maze, next) || visited.has(keyOf(next))) {
        continue;
      }
      visited.add(keyOf(next));
      cameFrom.set(keyOf(next), { prev: current, direction });
      queue.push(next);
    }
  }

  throw new Error("test setup: no start-to-exit path in a validated maze");
}

function reconstruct(
  cameFrom: Map<string, { prev: Position; direction: Direction }>,
  start: Position,
  exit: Position,
): Direction[] {
  const directions: Direction[] = [];
  let cursor = exit;
  while (!(cursor.row === start.row && cursor.column === start.column)) {
    const step = cameFrom.get(keyOf(cursor));
    if (step === undefined) {
      throw new Error("test setup: BFS reconstruction broke");
    }
    directions.unshift(step.direction);
    cursor = step.prev;
  }
  return directions;
}

/** The last StateChanged event's carried state, or throw if there is none. */
function lastStateChange(events: readonly GameEvent[]): GameState {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "StateChanged") {
      return event.state;
    }
  }
  throw new Error("expected at least one StateChanged event");
}

/** Find a blocked direction (into a wall or off-grid) from the avatar cell. */
function blockedDirectionFrom(maze: Maze, avatar: Position): Direction {
  for (const [direction, delta] of DIRECTION_DELTAS) {
    const target: Position = {
      row: avatar.row + delta.row,
      column: avatar.column + delta.column,
    };
    if (!isPathCell(maze, target)) {
      return direction;
    }
  }
  throw new Error("test setup: start cell has no blocked neighbor");
}

describe("Integration Point B — store + core", () => {
  it("emits StateChanged carrying the reducer's Playing state when a session starts (R5.1)", () => {
    const maze = generatedMaze(9, 9, 4242);
    const seconds = 60;
    const { store, events } = storeWith(idleOn(maze, seconds), succeedingSource(maze));

    store.dispatch({
      type: "StartSession",
      config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
    });

    // The store emits exactly one StateChanged, and the state it carries is the
    // store's new state — a fresh Playing session on the real maze.
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("StateChanged");
    if (event.type !== "StateChanged") {
      throw new Error("expected StateChanged");
    }
    expect(event.state).toBe(store.getState());
    expect(event.state.status).toBe("Playing");
    if (event.state.status !== "Playing") {
      throw new Error("expected a Playing state");
    }
    // R6.2/R6.3 via the real factory: avatar on start, timer reset and paused.
    expect(event.state.avatar).toEqual(maze.start);
    expect(event.state.remainingMs).toBe(seconds * MILLISECONDS_PER_SECOND);
    expect(event.state.timerStarted).toBe(false);
  });

  it("emits StateChanged whose state equals a direct reduce() for a valid move that advances (R5.1, R5.2)", () => {
    const maze = generatedMaze(11, 11, 20240607);
    const seconds = 120;
    const { store, events } = storeWith(idleOn(maze, seconds), succeedingSource(maze));

    store.dispatch({
      type: "StartSession",
      config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
    });
    const started = store.getState();
    expect(started.status).toBe("Playing");

    // First step of a real solvable route: guaranteed to advance the avatar.
    const path = bfsDirections(maze);
    const firstMove = path[0]!;

    // Compute the expected transition directly from the real reducer, then
    // dispatch the same action and assert the emitted event matches it.
    const expected = reduce(started, { type: "Move", direction: firstMove });
    expect(expected).not.toBe(started); // sanity: this move truly advances

    events.length = 0;
    store.dispatch({ type: "Move", direction: firstMove });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("StateChanged");
    if (event.type !== "StateChanged") {
      throw new Error("expected StateChanged");
    }
    // The emitted state IS the store's state and matches the pure reducer.
    expect(event.state).toBe(store.getState());
    expect(event.state).toEqual(expected);
    expect(event.state.avatar).not.toEqual(started.avatar);
  });

  it("emits MoveBlocked and leaves the avatar unchanged for a move into a wall/off-grid (R2.2, R2.3)", () => {
    const maze = generatedMaze(9, 9, 4242);
    const seconds = 60;
    const { store, events } = storeWith(idleOn(maze, seconds), succeedingSource(maze));

    store.dispatch({
      type: "StartSession",
      config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
    });
    const started = store.getState();
    if (started.status !== "Playing") {
      throw new Error("expected a Playing state");
    }
    const avatarBefore = started.avatar;

    // A direction the real reducer treats as a no-op (blocked): reduce returns
    // the same reference, which the store must surface as MoveBlocked.
    const blocked = blockedDirectionFrom(maze, avatarBefore);
    expect(reduce(started, { type: "Move", direction: blocked })).toBe(started);

    events.length = 0;
    store.dispatch({ type: "Move", direction: blocked });

    // Exactly one MoveBlocked event, no StateChanged, avatar unmoved.
    expect(events).toEqual([{ type: "MoveBlocked" }]);
    expect(store.getState()).toBe(started);
    const after = store.getState();
    if (after.status !== "Playing") {
      throw new Error("expected the state to remain Playing");
    }
    expect(after.avatar).toEqual(avatarBefore);
  });

  it("emits StateChanged with the reducer's decremented remainingMs on a Tick (R5.1)", () => {
    const maze = generatedMaze(9, 9, 4242);
    const seconds = 60;
    const { store, events } = storeWith(idleOn(maze, seconds), succeedingSource(maze));

    store.dispatch({
      type: "StartSession",
      config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
    });
    // Start the timer with a real accepted first move (R6.3): the timer is
    // paused until the first move, so a Tick only counts down once it has
    // started. Use the first step of a real solvable route so it is accepted.
    const firstMove = bfsDirections(maze)[0]!;
    store.dispatch({ type: "Move", direction: firstMove });
    const started = store.getState();
    if (started.status !== "Playing") {
      throw new Error("expected a Playing state");
    }
    expect(started.timerStarted).toBe(true);

    const tick = { type: "Tick" as const, elapsedMs: MILLISECONDS_PER_SECOND };
    const expected = reduce(started, tick);

    events.length = 0;
    store.dispatch(tick);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("StateChanged");
    if (event.type !== "StateChanged") {
      throw new Error("expected StateChanged");
    }
    expect(event.state).toBe(store.getState());
    expect(event.state).toEqual(expected);
    if (event.state.status !== "Playing") {
      throw new Error("expected a Playing state");
    }
    expect(event.state.remainingMs).toBe(started.remainingMs - MILLISECONDS_PER_SECOND);
  });

  it("drives Ticks to expiry off the exit and the final StateChanged carries a Lost state (R5.2, reduce Property 8)", () => {
    // Avatar stays on the start cell (clear of the exit), so hitting zero is
    // unambiguously a time-expiry loss handled by the real reducer.
    const maze = generatedMaze(9, 9, 4242);
    const seconds = 30;
    const { store, events } = storeWith(idleOn(maze, seconds), succeedingSource(maze));

    store.dispatch({
      type: "StartSession",
      config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
    });
    expect(maze.start).not.toEqual(maze.exit);

    events.length = 0;
    // One whole-second Tick per second of the limit, plus one extra second: per
    // R6.3 the first whole-second Tick only closes the 1s pause (the avatar
    // never moves) and starts the countdown, so expiry needs one more Tick.
    const ticks = seconds + 1;
    for (let i = 0; i < ticks; i += 1) {
      expect(store.getState().status).toBe("Playing");
      store.dispatch({ type: "Tick", elapsedMs: MILLISECONDS_PER_SECOND });
    }

    // Every emitted event across the run is a StateChanged (the first Tick
    // records the pause progress and each later Tick changes remainingMs); no
    // MoveBlocked/InvalidMaze slipped in.
    expect(events.every((e) => e.type === "StateChanged")).toBe(true);
    expect(events).toHaveLength(ticks);

    // The final StateChanged carries the Lost state the store now holds.
    const finalState = lastStateChange(events);
    expect(finalState).toBe(store.getState());
    expect(finalState.status).toBe("Lost");
    if (finalState.status !== "Lost") {
      throw new Error("expected a Lost state");
    }
    expect(finalState.reason).toBe("TimeExpired");
    expect(finalState.avatar).toEqual(maze.start);

    // A frozen session rejects further movement (R4.4): reduce returns the same
    // Lost reference, so the store surfaces the rejected Move as MoveBlocked and
    // emits no StateChanged. The stored state is unchanged.
    events.length = 0;
    store.dispatch({ type: "Move", direction: "Down" });
    expect(events).toEqual([{ type: "MoveBlocked" }]);
    expect(store.getState()).toBe(finalState);

    // A Tick on the frozen session is also a no-op, and (not being a Move) emits
    // nothing at all.
    events.length = 0;
    store.dispatch({ type: "Tick", elapsedMs: MILLISECONDS_PER_SECOND });
    expect(events).toHaveLength(0);
    expect(store.getState()).toBe(finalState);
  });

  it("reaches the exit with time remaining and the final StateChanged carries a Won state (R5.1, reduce win path)", () => {
    const maze = generatedMaze(11, 11, 20240607);
    const seconds = 120;
    const { store, events } = storeWith(idleOn(maze, seconds), succeedingSource(maze));

    store.dispatch({
      type: "StartSession",
      config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
    });

    const path = bfsDirections(maze);
    expect(path.length).toBeGreaterThan(0);

    events.length = 0;
    for (const direction of path) {
      store.dispatch({ type: "Move", direction });
    }

    // Each accepted move advanced the avatar, so every event is a StateChanged.
    expect(events.every((e) => e.type === "StateChanged")).toBe(true);
    expect(events).toHaveLength(path.length);

    const finalState = lastStateChange(events);
    expect(finalState).toBe(store.getState());
    expect(finalState.status).toBe("Won");
    if (finalState.status !== "Won") {
      throw new Error("expected a Won state");
    }
    expect(finalState.avatar).toEqual(maze.exit);
    expect(finalState.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("emits InvalidMaze and does not enter Playing when the maze source fails (R1.6)", () => {
    const maze = generatedMaze(9, 9, 4242);
    const seconds = 60;
    const error: MazeValidationError = "NoPathFromStartToExit";
    const { store, events } = storeWith(idleOn(maze, seconds), failingSource(error));

    store.dispatch({
      type: "StartSession",
      config: { rows: maze.rows, columns: maze.columns, timeLimit: timeLimit(seconds) },
    });

    // Exactly one InvalidMaze event carrying the port's error, and no
    // StateChanged: the store refused to start a session on an invalid maze.
    expect(events).toEqual([{ type: "InvalidMaze", error }]);
    expect(store.getState().status).not.toBe("Playing");
    expect(store.getState().status).toBe("Idle");
  });
});
