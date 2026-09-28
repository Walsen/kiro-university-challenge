/**
 * Integration Point C — Controller + store + faked edges (Task 13.3, BLOCKING gate).
 *
 * Unit tests verify the `GameController` against a store double, verify the
 * `GameStore` against a stubbed reducer, and verify the pure core in isolation.
 * This test closes the seam that ties them together: it composes the *real*
 * `GameController`, the *real* `GameStore`, and the *real* `reduce` (imported
 * internally by the store, never stubbed here), faking only the genuinely
 * external edges — timing (`FakeClock`), input (`InputSource`), and output
 * (`Renderer`). It is the "does the whole machine turn over" test, landing
 * before the composition-root smoke test (Integration Point D).
 *
 *   InputSource → GameController → GameStore.dispatch → reduce
 *              → resolveMove / tickTimer / DefaultGameSessionFactory
 *   GameStore (StateChanged) → GameController → Renderer
 *   Clock → GameController.step() → GameStore.dispatch(Tick) → reduce
 *
 * The only test doubles are the three edge ports. The maze the store runs on is
 * a real one built by `DefaultMazeFactory` + `RecursiveBacktrackerGenerator` +
 * a seeded mulberry32 rng, and the injected `MazeSource` returns that same real
 * maze so the real reducer builds a real fresh session on `StartSession`.
 *
 * Determinism: the maze comes from a seeded rng and time is advanced explicitly
 * through the `FakeClock`; no wall clock, no `Math.random()`, no real
 * timers/`requestAnimationFrame`. The `FakeClock`, fake `InputSource`, and mock
 * `Renderer` match the doubles the `GameController` unit test settled on — in
 * particular each renderer method is captured into a standalone `Mock` spy so
 * assertions reference the spy directly (avoiding `@typescript-eslint/
 * unbound-method` from reading a method off the `Renderer`).
 *
 * _Requirements: 2.4, 3.1, 3.4, 5.4, 6.1, 6.3; design "Integration testing" Point C._
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { GameStore, type MazeSource } from "./GameStore";
import { GameController } from "./GameController";
import {
  CellKind,
  DefaultMazeFactory,
  RecursiveBacktrackerGenerator,
  parseTimeLimit,
  type Direction,
  type GameConfig,
  type GameState,
  type IdleState,
  type Maze,
  type MazeResult,
  type PlayingState,
  type Position,
  type TimeLimit,
} from "../core";
import type { Clock, InputSource, MoveCommand, Renderer } from "../edges/ports";

const MILLISECONDS_PER_SECOND = 1000;
/** R6.3: the timer auto-starts after at most 1 second even without a move. */
const TIMER_AUTOSTART_MS = 1000;

/**
 * A tiny deterministic PRNG (mulberry32). Given the same seed it yields the
 * same sequence in `[0, 1)`, so maze generation is reproducible without
 * touching `Math.random`. Matches the seeded rng used across the core and
 * Integration Point B tests.
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
 * A `MazeSource` stub that always succeeds with the supplied real maze, so the
 * real `GameStore` enters a fresh `Playing` session on `StartSession`. This is
 * the only non-edge double; the reducer the store runs is the real one.
 */
function succeedingSource(maze: Maze): MazeSource {
  return { create: (): MazeResult => ({ ok: true, maze }) };
}

/** A `GameConfig` sized to the given maze with a valid time limit. */
function configFor(maze: Maze, seconds: number): GameConfig {
  return {
    rows: maze.rows,
    columns: maze.columns,
    timeLimit: timeLimit(seconds),
  };
}

/** A fresh Idle state seeded with a real maze — a store starting point. */
function idleOn(maze: Maze, seconds: number): IdleState {
  return { status: "Idle", maze, avatar: maze.start, timeLimit: timeLimit(seconds) };
}

/**
 * Build a fresh `PlayingState` on the given real maze with the timer full and
 * not yet started — the shape a started session has.
 */
function freshPlaying(maze: Maze, seconds: number): PlayingState {
  const limit = timeLimit(seconds);
  return {
    status: "Playing",
    maze,
    avatar: maze.start,
    timeLimit: limit,
    remainingMs: limit * MILLISECONDS_PER_SECOND,
    timerStarted: false,
    pausedElapsedMs: 0,
    moveInProgress: false,
  };
}

/**
 * A mock `Renderer`. Each method is captured into a standalone `Mock` spy so
 * assertions reference the spy directly (`spies.renderAvatar`) rather than a
 * method read off the `Renderer` (`renderer.renderAvatar`), which keeps them
 * type-safe and avoids `@typescript-eslint/unbound-method`.
 */
interface MockRenderer {
  renderer: Renderer;
  spies: Record<keyof Renderer, Mock>;
}

function mockRenderer(): MockRenderer {
  const renderMaze: Mock = vi.fn();
  const renderAvatar: Mock = vi.fn();
  const renderRemainingTime: Mock = vi.fn();
  const renderResult: Mock = vi.fn();
  const renderInvalidMaze: Mock = vi.fn();
  const clearResult: Mock = vi.fn();
  return {
    renderer: {
      renderMaze,
      renderAvatar,
      renderRemainingTime,
      renderResult,
      renderInvalidMaze,
      clearResult,
    },
    spies: {
      renderMaze,
      renderAvatar,
      renderRemainingTime,
      renderResult,
      renderInvalidMaze,
      clearResult,
    },
  };
}

/**
 * A fake `InputSource` capturing the registered handlers so the test can invoke
 * them, simulating a player key press (a `MoveCommand`) and activating the
 * new-session control.
 */
interface FakeInput extends InputSource {
  emitCommand(command: MoveCommand): void;
  emitNewSession(): void;
}

function fakeInput(): FakeInput {
  let commandHandler: ((command: MoveCommand) => void) | undefined;
  let newSessionHandler: (() => void) | undefined;
  return {
    onCommand(handler: (command: MoveCommand) => void): void {
      commandHandler = handler;
    },
    onNewSession(handler: () => void): void {
      newSessionHandler = handler;
    },
    dispose(): void {
      commandHandler = undefined;
      newSessionHandler = undefined;
    },
    emitCommand(command: MoveCommand): void {
      if (!commandHandler) {
        throw new Error("test: no MoveCommand handler registered");
      }
      commandHandler(command);
    },
    emitNewSession(): void {
      if (!newSessionHandler) {
        throw new Error("test: no new-session handler registered");
      }
      newSessionHandler();
    },
  };
}

/**
 * A `FakeClock` returning a controllable monotonic time in milliseconds. Tests
 * advance it explicitly so the tick loop is deterministic (design
 * "Determinism"); no wall-clock time is read.
 */
interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

function fakeClock(startMs = 0): FakeClock {
  let current = startMs;
  return {
    now(): number {
      return current;
    },
    advance(ms: number): void {
      current += ms;
    },
    set(ms: number): void {
      current = ms;
    },
  };
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
 * walk the avatar from `maze.start` to `maze.exit`. Following it through the
 * controller's real store/reducer must land on the exit.
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

/** The current state narrowed to `PlayingState` (throws if it is not). */
function playing(state: GameState): PlayingState {
  if (state.status !== "Playing") {
    throw new Error(`expected Playing, got ${state.status}`);
  }
  return state;
}

describe("Integration Point C — controller + store + faked edges", () => {
  // A small real maze; seed 4242 matches the Point B fixtures.
  const MAZE_SIZE = 9;
  const MAZE_SEED = 4242;
  const SECONDS = 30;

  let maze: Maze;
  let store: GameStore;
  let renderer: Renderer;
  let spies: Record<keyof Renderer, Mock>;
  let input: FakeInput;
  let clock: FakeClock;
  let controller: GameController;

  beforeEach(() => {
    maze = generatedMaze(MAZE_SIZE, MAZE_SIZE, MAZE_SEED);
    // Start already Playing so a routed Move produces a StateChanged the
    // controller must project (the store enters Playing via StartSession too,
    // exercised in the new-session scenario below).
    store = new GameStore(freshPlaying(maze, SECONDS), succeedingSource(maze));
    const mock = mockRenderer();
    renderer = mock.renderer;
    spies = mock.spies;
    input = fakeInput();
    clock = fakeClock(0);
    controller = new GameController(store, renderer, input, clock, configFor(maze, SECONDS));
  });

  it("flows an input MoveCommand through the real store to a renderer redraw (R2.4, R5.4)", () => {
    // The whole input→store→render path with real components: an emitted
    // command routes into a real Move, the real reducer advances the avatar
    // along a genuine route, and the StateChanged redraws the avatar.
    controller.start();
    const before = playing(store.getState()).avatar;
    const firstMove = bfsDirections(maze)[0]!;
    spies.renderAvatar.mockClear();
    spies.renderMaze.mockClear();

    input.emitCommand({ kind: "move", direction: firstMove });

    // The real store advanced (the first step of a real solvable route always
    // moves the avatar).
    const after = playing(store.getState()).avatar;
    expect(after).not.toEqual(before);
    // The command flowed all the way through to a renderer redraw (R2.4/R5.4).
    expect(
      spies.renderAvatar.mock.calls.length + spies.renderMaze.mock.calls.length,
    ).toBeGreaterThan(0);
    expect(spies.renderAvatar).toHaveBeenCalled();
  });

  it("decrements remaining time by the Clock's elapsed delta once the timer has started (R3.1)", () => {
    // A first move starts the timer (R6.3); advancing the FakeClock and
    // stepping the loop must decrement remaining by exactly that delta, proving
    // the Clock → controller → Tick → reducer wiring carries elapsed time.
    controller.start();
    input.emitCommand({ kind: "move", direction: bfsDirections(maze)[0]! });
    const before = playing(store.getState()).remainingMs;

    clock.advance(1500);
    controller.step();

    expect(playing(store.getState()).remainingMs).toBe(before - 1500);
    // Remaining time is projected to the screen (R3.2, part of the redraw).
    expect(spies.renderRemainingTime).toHaveBeenCalled();
  });

  it("drives the tick loop to a loss and then stops dispatching once ended (R3.1, R3.4)", () => {
    // The tick loop, with no move, turns the whole machine over to a loss: the
    // first ~1s of stepping closes the R6.3 pause and starts the countdown,
    // then continued elapsed time drives remaining to zero off the exit.
    controller.start();
    const startCell = playing(store.getState()).avatar;
    expect(startCell).not.toEqual(maze.exit);

    // Close the 1s auto-start pause without moving the avatar (R6.3).
    clock.advance(TIMER_AUTOSTART_MS);
    controller.step();
    expect(playing(store.getState()).timerStarted).toBe(true);
    expect(playing(store.getState()).avatar).toEqual(startCell);

    // Run the clock past the full limit to force expiry into Lost.
    clock.advance(SECONDS * MILLISECONDS_PER_SECOND);
    controller.step();

    expect(store.getState().status).toBe("Lost");
    const ended = store.getState();
    if (ended.status !== "Lost") {
      throw new Error("expected a Lost state");
    }
    expect(ended.reason).toBe("TimeExpired");
    // The avatar never moved during the pure tick loop (R6.3).
    expect(ended.avatar).toEqual(startCell);
    // The result was projected to the screen (R5.3).
    expect(spies.renderResult).toHaveBeenCalledWith({
      outcome: "Lost",
      reason: "TimeExpired",
    });

    // R3.4: once ended, further clock advances + steps do NOT dispatch a Tick,
    // so the frozen state is left untouched (same reference).
    const renderCallsBefore =
      spies.renderMaze.mock.calls.length +
      spies.renderAvatar.mock.calls.length +
      spies.renderRemainingTime.mock.calls.length;

    clock.advance(5 * MILLISECONDS_PER_SECOND);
    controller.step();
    clock.advance(5 * MILLISECONDS_PER_SECOND);
    controller.step();

    expect(store.getState()).toBe(ended);
    // No further StateChanged means no further redraw of the live board.
    const renderCallsAfter =
      spies.renderMaze.mock.calls.length +
      spies.renderAvatar.mock.calls.length +
      spies.renderRemainingTime.mock.calls.length;
    expect(renderCallsAfter).toBe(renderCallsBefore);
  });

  it("starts a fresh session when the new-session control is activated (R6.1)", () => {
    // Drive the machine to an ended (Lost) session first, then activate the
    // new-session control: the real store must validate the maze through the
    // injected source and enter a brand-new Playing session, and the controller
    // must clear the prior result from the display (R6.1, R6.4-adjacent).
    controller.start();
    clock.advance(TIMER_AUTOSTART_MS);
    controller.step();
    clock.advance(SECONDS * MILLISECONDS_PER_SECOND);
    controller.step();
    expect(store.getState().status).toBe("Lost");

    spies.clearResult.mockClear();
    input.emitNewSession();

    // A fresh Playing session built by the real reducer + session factory on a
    // real validated maze: avatar back at start, timer full and paused (R6.2/R6.3).
    const fresh = playing(store.getState());
    expect(fresh.avatar).toEqual(maze.start);
    expect(fresh.remainingMs).toBe(SECONDS * MILLISECONDS_PER_SECOND);
    expect(fresh.timerStarted).toBe(false);
    expect(fresh.pausedElapsedMs).toBe(0);
    // The prior result was cleared from the display when the new session began.
    expect(spies.clearResult).toHaveBeenCalled();

    // And the fresh session is live again: an input command advances the avatar,
    // confirming the whole machine turned back over.
    input.emitCommand({ kind: "move", direction: bfsDirections(maze)[0]! });
    expect(playing(store.getState()).avatar).not.toEqual(maze.start);
  });

  it("starts a session from Idle when the new-session control is activated (R6.1)", () => {
    // Even from a cold Idle store the new-session control must turn the machine
    // over: the controller renders the initial Idle state on start, then the
    // control dispatches StartSession through the real store into Playing.
    store = new GameStore(idleOn(maze, SECONDS), succeedingSource(maze));
    controller = new GameController(store, renderer, input, clock, configFor(maze, SECONDS));
    controller.start();
    expect(store.getState().status).toBe("Idle");

    input.emitNewSession();

    const fresh = playing(store.getState());
    expect(fresh.avatar).toEqual(maze.start);
    expect(fresh.remainingMs).toBe(SECONDS * MILLISECONDS_PER_SECOND);
    expect(fresh.timerStarted).toBe(false);
    expect(spies.clearResult).toHaveBeenCalled();
  });
});
