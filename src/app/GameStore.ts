/**
 * `GameStore` — the application-layer State + Observer (design "GameStore").
 *
 * The store is the single source of truth for `GameState`. It applies the pure
 * `reduce` transition on `dispatch`, exposes the current state via `getState`,
 * and notifies observers registered through `subscribe` with `GameEvent`s. It
 * never renders and never touches the DOM, Canvas, `Date`, or `Math.random()`:
 * side effects live at the edges (architecture "Dependency Rule").
 *
 * Following Dependency Inversion, the store depends only on core abstractions —
 * the pure `reduce` and an injected `MazeFactory` port used to validate a
 * candidate maze when a session starts, so the store can emit `InvalidMaze`
 * and refuse to enter `Playing` for an invalid maze (R1.6, design "Error
 * Handling").
 */
import {
  reduce,
  type GameAction,
  type GameState,
  type IdleState,
  type MazeResult,
  type MazeValidationError,
} from "../core";

/**
 * Events the store emits to observers (design `GameEvent` union). The renderer
 * consumes these; the store itself never renders.
 */
export type GameEvent =
  | { readonly type: "StateChanged"; readonly state: GameState }
  | { readonly type: "MoveBlocked" }
  | { readonly type: "InvalidMaze"; readonly error: MazeValidationError };

/**
 * The injected maze-validation port. Only the `create` capability is required,
 * so the store depends on this narrow abstraction rather than the concrete
 * `MazeFactory` (Interface Segregation + Dependency Inversion).
 */
export interface MazeSource {
  create(rows: number, columns: number): MazeResult;
}

type Observer = (event: GameEvent) => void;

export class GameStore {
  private state: GameState;
  private readonly observers = new Set<Observer>();

  constructor(
    initialState: GameState,
    private readonly mazeFactory: MazeSource,
  ) {
    this.state = initialState;
  }

  getState(): GameState {
    return this.state;
  }

  subscribe(observer: Observer): () => void {
    this.observers.add(observer);
    return (): void => {
      this.observers.delete(observer);
    };
  }

  dispatch(action: GameAction): void {
    if (action.type === "StartSession") {
      this.startSession(action);
      return;
    }
    this.applyTransition(action);
  }

  /**
   * Validate a candidate maze through the injected port before starting. On
   * failure, emit `InvalidMaze` and settle into a non-`Playing` (`Idle`) state
   * so the store never runs a session on an invalid maze (R1.6). On success,
   * seed the validated maze into the state so the pure `StartSession`
   * transition builds the fresh session from it, then emit the changed state.
   */
  private startSession(action: Extract<GameAction, { type: "StartSession" }>): void {
    const { rows, columns } = action.config;
    const result = this.mazeFactory.create(rows, columns);
    if (!result.ok) {
      const idle: IdleState = {
        status: "Idle",
        maze: this.state.maze,
        avatar: this.state.maze.start,
        timeLimit: action.config.timeLimit,
      };
      this.state = idle;
      this.emit({ type: "InvalidMaze", error: result.error });
      return;
    }

    const seeded: GameState = { ...this.state, maze: result.maze };
    this.state = reduce(seeded, action);
    this.emit({ type: "StateChanged", state: this.state });
  }

  /**
   * Apply a `Move`/`Tick`/`MoveAnimationComplete` via the pure reducer. `reduce`
   * returns the same state reference for a no-op (e.g. a blocked move), so a
   * `Move` that leaves the state unchanged signals `MoveBlocked` (R2.2, R2.3);
   * any actual change emits `StateChanged` (R5.1, R5.2).
   */
  private applyTransition(action: GameAction): void {
    const next = reduce(this.state, action);
    if (next === this.state) {
      if (action.type === "Move") {
        this.emit({ type: "MoveBlocked" });
      }
      return;
    }
    this.state = next;
    this.emit({ type: "StateChanged", state: next });
  }

  private emit(event: GameEvent): void {
    for (const observer of this.observers) {
      observer(event);
    }
  }
}
