/**
 * `GameController` — the application-layer orchestration (design "GameController
 * (orchestration)"). It wires the edge ports to the `GameStore` and owns no game
 * rules: it only routes (design "Data flow for one move").
 *
 * Responsibilities (all via injected abstractions — Dependency Inversion, never
 * `window`/`Date`/`requestAnimationFrame`/Canvas):
 * - subscribe the `Renderer` to the store so a `StateChanged` event redraws the
 *   maze, avatar, and remaining time, and an ended state draws the result
 *   (R5.3, R5.5); a fresh session clears the prior result (R6.4);
 * - register with the `InputSource` so a `MoveCommand` dispatches a `Move`
 *   (R2.4, R5.4) and the new-session control dispatches `StartSession`
 *   (R5.5, R6.1);
 * - drive the timer from the injected `Clock`: each `step()` reads `clock.now()`,
 *   computes the elapsed delta, and dispatches a `Tick` while the session is
 *   active (R3.1), stopping once it ends (R3.4).
 *
 * The R6.3 pause (the timer stays paused until the first move or a maximum of
 * one second of elapsed time) is a game rule and lives entirely in the pure
 * core `reduce`: a `Tick` on a still-paused session accrues toward the 1s
 * auto-start and counts down past it, never moving the avatar. The controller
 * simply forwards ticks and owns no timer rule.
 *
 * The real frame scheduling (`requestAnimationFrame`) lives in the composition
 * root (`main.ts`), which calls `step()` each frame. Advancing the loop through
 * an explicit `step()` over an injected `Clock` keeps it deterministic in tests
 * (design "Determinism").
 */
import type {
  GameConfig,
  GameResult,
  GameState,
  PlayingState,
} from "../core";
import type { Clock, InputSource, MoveCommand, Renderer } from "../edges/ports";

import type { GameEvent } from "./GameStore";
import type { GameStore } from "./GameStore";

const MILLISECONDS_PER_SECOND = 1000;

export class GameController {
  /** The monotonic clock reading at the previous `step()` (or `start()`). */
  private lastTickMs = 0;

  constructor(
    private readonly store: GameStore,
    private readonly renderer: Renderer,
    private readonly input: InputSource,
    private readonly clock: Clock,
    private readonly config: GameConfig,
  ) {}

  /**
   * Wire the edges to the store and render the initial state. Does not schedule
   * real timers or animation frames — the loop is advanced by `step()`.
   */
  start(): void {
    this.store.subscribe((event) => {
      this.onStoreEvent(event);
    });
    this.input.onCommand((command) => {
      this.onCommand(command);
    });
    this.input.onNewSession(() => {
      this.onNewSession();
    });

    this.lastTickMs = this.clock.now();
    this.render(this.store.getState());
  }

  /**
   * Advance the loop once: dispatch a `Tick` for the time elapsed since the
   * previous step while a session is active (R3.1). The core `reduce` honors
   * the R6.3 pause and auto-start on that `Tick` without moving the avatar, so
   * the controller only forwards elapsed time. Does nothing once the session
   * has ended (R3.4).
   */
  step(): void {
    const state = this.store.getState();
    if (state.status !== "Playing") {
      return;
    }

    const now = this.clock.now();
    const delta = now - this.lastTickMs;
    this.lastTickMs = now;

    this.store.dispatch({ type: "Tick", elapsedMs: delta });
  }

  /** Route a player command into a `Move` (R2.4, R5.4). */
  private onCommand(command: MoveCommand): void {
    this.store.dispatch({ type: "Move", direction: command.direction });
  }

  /** Route the new-session control into a fresh session (R5.5, R6.1). */
  private onNewSession(): void {
    this.renderer.clearResult();
    this.lastTickMs = this.clock.now();
    this.store.dispatch({ type: "StartSession", config: this.config });
  }

  /** Project a store event onto the renderer (Observer). */
  private onStoreEvent(event: GameEvent): void {
    if (event.type === "StateChanged") {
      this.render(event.state);
    }
  }

  /**
   * Draw the maze, avatar, and remaining time from an immutable state, and the
   * result once the session ends (design "Data flow for one move", step 5).
   */
  private render(state: GameState): void {
    this.renderer.renderMaze(state.maze);
    this.renderer.renderAvatar(state.avatar, state.maze);

    if (state.status === "Playing") {
      this.renderer.renderRemainingTime(secondsRemaining(state));
      return;
    }

    if (state.status === "Won" || state.status === "Lost") {
      this.renderer.renderResult(toResult(state));
    }
  }
}

/** Displayed whole seconds remaining: `max(0, floor(remainingMs / 1000))` (R3.2). */
function secondsRemaining(state: PlayingState): number {
  return Math.max(0, Math.floor(state.remainingMs / MILLISECONDS_PER_SECOND));
}

/** The `GameResult` projected for an ended state (R5.1, R5.3). */
function toResult(state: GameState): GameResult {
  if (state.status === "Won") {
    return {
      outcome: "Won",
      elapsedSeconds: state.elapsedMs / MILLISECONDS_PER_SECOND,
    };
  }
  return { outcome: "Lost", reason: "TimeExpired" };
}
