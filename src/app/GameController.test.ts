/**
 * Example-based unit tests for the orchestration controller `GameController`
 * (design "GameController (orchestration)").
 *
 * Red step (Task 13.1): these specify the controller's behavior before the
 * implementation in `GameController.ts` exists (Task 13.2), so they are expected
 * to fail on the missing `./GameController` import until then.
 *
 * The `GameController` owns no game rules — it only routes (design "Data flow
 * for one move" and the component diagram). It:
 * - subscribes the injected `Renderer` to the `GameStore` so a `StateChanged`
 *   event redraws the maze, avatar, remaining time, and result, and a
 *   `MoveBlocked`/`InvalidMaze` event is projected too (R2.4, R5.1–R5.3, R5.5,
 *   R6.4);
 * - registers with the `InputSource`, so a `MoveCommand` dispatches a `Move`
 *   (R2.4) and activating the new-session control dispatches `StartSession`
 *   (R5.5, R6.1);
 * - drives the timer from the injected `Clock`: each loop step reads
 *   `clock.now()`, computes the elapsed delta, and dispatches a `Tick` (R3.1),
 *   stopping once the session ends (R3.4); and
 * - honors the R6.3 pause: the timer stays paused until the first move or a
 *   maximum of 1 second elapses, after which ticks begin counting down even
 *   with no move.
 *
 * Design decisions this test pins down for Task 13.2 (so the implementation
 * matches), all consistent with the design's `GameController` responsibilities,
 * the `GameStore` interface, and the edge ports:
 *
 * - Construction: `new GameController(store, renderer, input, clock, config)`.
 *   The controller depends only on the abstractions `GameStore`, `Renderer`,
 *   `InputSource`, `Clock`, and a `GameConfig` (Dependency Inversion) — never on
 *   `window`, `Date`, `requestAnimationFrame`, or a Canvas.
 * - `start(): void` performs the wiring: it subscribes the renderer to the
 *   store, registers the input handlers, dispatches the initial `StartSession`,
 *   and records the clock baseline for elapsed-delta computation. It does NOT
 *   schedule real timers/animation frames — the loop is advanced explicitly.
 * - `step(): void` advances the loop exactly once: it reads `clock.now()`,
 *   computes the elapsed delta since the last step, dispatches a `Tick` with
 *   that delta while a session is active, and does nothing once the session has
 *   ended. Injecting time via the `Clock` and advancing via `step()` keeps the
 *   loop deterministic in tests (design "Determinism"); the real frame
 *   scheduling lives in the composition root, not here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { parseTimeLimit } from "../core";
import { solvableMaze } from "../core/testFixtures/mazes";
import type {
  GameConfig,
  GameState,
  Maze,
  MazeResult,
  PlayingState,
  TimeLimit,
} from "../core";
import type { Clock, InputSource, MoveCommand, Renderer } from "../edges/ports";

import { GameStore } from "./GameStore";
import { GameController } from "./GameController";

const MILLISECONDS_PER_SECOND = 1000;
/** R6.3: the timer auto-starts after at most 1 second even without a move. */
const TIMER_AUTOSTART_MS = 1000;

/** A valid branded TimeLimit produced through the only validator that makes one. */
function timeLimit(seconds: number): TimeLimit {
  const result = parseTimeLimit(seconds);
  if (!result.ok) {
    throw new Error(`test setup: ${String(seconds)} is not a valid TimeLimit`);
  }
  return result.value;
}

/**
 * Build a fresh `PlayingState` on the given maze with the timer full and not
 * yet started — the shape a started session has.
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

/** A `GameConfig` sized to the given maze with a valid time limit. */
function configFor(maze: Maze, seconds: number): GameConfig {
  return {
    rows: maze.rows,
    columns: maze.columns,
    timeLimit: timeLimit(seconds),
  };
}

/**
 * A stub `MazeFactory` port that always succeeds with the given maze, so the
 * real `GameStore` enters `Playing` on `StartSession`. The controller test uses
 * the REAL store and reducer (more faithful than a store double); only the edge
 * ports are faked.
 */
function factoryReturning(maze: Maze): { create: () => MazeResult } {
  return { create: (): MazeResult => ({ ok: true, maze }) };
}

/**
 * A mock `Renderer`. Each method is captured into a standalone `Mock` spy so
 * assertions reference the spy directly (`spies.renderAvatar`) rather than a
 * method read off the `Renderer` (`renderer.renderAvatar`). Referencing the
 * standalone spies keeps the assertions type-safe and avoids treating the
 * spies as unbound methods.
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
 * A fake `InputSource` that captures the registered handlers so the test can
 * invoke them, simulating a player key press (a `MoveCommand`) and activating
 * the new-session control.
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

/** The current state narrowed to `PlayingState` (throws if it is not). */
function playing(state: GameState): PlayingState {
  if (state.status !== "Playing") {
    throw new Error(`expected Playing, got ${state.status}`);
  }
  return state;
}

describe("GameController", () => {
  let maze: Maze;
  let store: GameStore;
  let renderer: Renderer;
  let spies: Record<keyof Renderer, Mock>;
  let input: FakeInput;
  let clock: FakeClock;
  let controller: GameController;

  beforeEach(() => {
    maze = solvableMaze();
    store = new GameStore(freshPlaying(maze, 60), factoryReturning(maze));
    const mock = mockRenderer();
    renderer = mock.renderer;
    spies = mock.spies;
    input = fakeInput();
    clock = fakeClock(0);
    controller = new GameController(store, renderer, input, clock, configFor(maze, 60));
  });

  describe("routes input commands to the store", () => {
    it("dispatches a Move when the InputSource emits a MoveCommand, advancing the avatar (R2.4)", () => {
      // R2.4/R5.4: a player command flows through the controller into a store
      // Move. Right from (0,0) targets path cell (0,1), so the avatar advances.
      controller.start();

      input.emitCommand({ kind: "move", direction: "Right" });

      expect(playing(store.getState()).avatar).toEqual({ row: 0, column: 1 });
      // The renderer re-draws the avatar at its new cell (R2.4).
      expect(spies.renderAvatar).toHaveBeenCalled();
    });
  });

  describe("renders on state changes", () => {
    it("invokes the Renderer when the store emits StateChanged (R5.3/R5.5/R6.4)", () => {
      controller.start();
      spies.renderMaze.mockClear();
      spies.renderAvatar.mockClear();

      input.emitCommand({ kind: "move", direction: "Right" });

      // A StateChanged event drives a redraw of the maze/avatar from the new
      // immutable state (design "Data flow for one move", step 5).
      expect(
        spies.renderMaze.mock.calls.length +
          spies.renderAvatar.mock.calls.length,
      ).toBeGreaterThan(0);
    });

    it("renders the result via renderResult once the session is won", () => {
      // Seed a store one Right-move away from the exit with time remaining, so
      // the routed Move produces a Won state the controller must project (R5.1).
      const nearExit: PlayingState = {
        ...freshPlaying(maze, 60),
        avatar: { row: 2, column: 1 },
        timerStarted: true,
      };
      store = new GameStore(nearExit, factoryReturning(maze));
      controller = new GameController(
        store,
        renderer,
        input,
        clock,
        configFor(maze, 60),
      );
      controller.start();

      // Right from (2,1) reaches the exit (2,2) while time remains -> Won.
      input.emitCommand({ kind: "move", direction: "Right" });

      expect(store.getState().status).toBe("Won");
      // `expect.any` is an asymmetric matcher typed as `any`; cast it to the
      // field's type so the expected-result object literal stays type-safe.
      expect(spies.renderResult).toHaveBeenCalledWith({
        outcome: "Won",
        elapsedSeconds: expect.any(Number) as number,
      });
    });
  });

  describe("drives the timer from the Clock", () => {
    it("dispatches a Tick using the Clock's elapsed delta once the timer has started (R3.1)", () => {
      // First move starts the timer (R6.3), then advancing the clock and
      // stepping the loop must decrease the remaining time by the elapsed delta.
      controller.start();
      input.emitCommand({ kind: "move", direction: "Right" });
      const before = playing(store.getState()).remainingMs;

      clock.advance(1500);
      controller.step();

      const after = playing(store.getState()).remainingMs;
      expect(after).toBe(before - 1500);
      // Remaining time is projected to the screen at least once per second (R3.2).
      expect(spies.renderRemainingTime).toHaveBeenCalled();
    });

    it("auto-starts the timer after 1 second even without a move (R6.3)", () => {
      // R6.3: the timer stays paused until the first move OR a maximum of 1
      // second elapses. With no move, once the 1s max is exceeded the timer
      // begins counting down on its own — and the avatar never moves.
      controller.start();
      const started = playing(store.getState());
      const full = started.remainingMs;
      const avatarBefore = started.avatar;
      expect(started.timerStarted).toBe(false);

      // Advance just past the 1s auto-start max so the surplus counts down.
      clock.advance(TIMER_AUTOSTART_MS + 500);
      controller.step();

      const state = playing(store.getState());
      // The core auto-started the timer on a plain Tick, no move required.
      expect(state.timerStarted).toBe(true);
      // The surplus beyond the 1s threshold counts down.
      expect(state.remainingMs).toBeLessThan(full);
      expect(state.remainingMs).toBe(full - 500);
      // The avatar is unchanged — auto-start never moves the avatar (R6.3).
      expect(state.avatar).toEqual(avatarBefore);
    });

    it("stops dispatching Tick once the session has ended (R3.4)", () => {
      // Drive the timer to expiry (a loss), then confirm further loop steps do
      // not change the frozen state — the timer has stopped counting (R3.4).
      controller.start();
      // Auto-start then run the clock past the full 60s limit to force a loss.
      clock.advance(TIMER_AUTOSTART_MS);
      controller.step();
      clock.advance(60 * MILLISECONDS_PER_SECOND);
      controller.step();

      expect(store.getState().status).toBe("Lost");
      const ended = store.getState();

      clock.advance(5 * MILLISECONDS_PER_SECOND);
      controller.step();

      // The state is frozen after the session ends: no more ticks applied.
      expect(store.getState()).toBe(ended);
    });
  });

  describe("routes the new-session control", () => {
    it("dispatches StartSession when the InputSource activates the new-session control (R6.1)", () => {
      // Win first so there is an ended session to replace, then activating the
      // control must start a fresh Playing session (R5.5, R6.1) and clear the
      // prior result from the display (R6.4).
      const nearExit: PlayingState = {
        ...freshPlaying(maze, 60),
        avatar: { row: 2, column: 1 },
        timerStarted: true,
      };
      store = new GameStore(nearExit, factoryReturning(maze));
      controller = new GameController(
        store,
        renderer,
        input,
        clock,
        configFor(maze, 60),
      );
      controller.start();
      input.emitCommand({ kind: "move", direction: "Right" });
      expect(store.getState().status).toBe("Won");

      input.emitNewSession();

      // A fresh session: back to Playing, avatar reset to the start cell (R6.2),
      // and the timer full and paused (R6.3).
      const fresh = playing(store.getState());
      expect(fresh.avatar).toEqual(maze.start);
      expect(fresh.remainingMs).toBe(60 * MILLISECONDS_PER_SECOND);
      expect(fresh.timerStarted).toBe(false);
      // The prior result is removed from display when the new session begins (R6.4).
      expect(spies.clearResult).toHaveBeenCalled();
    });
  });
});
