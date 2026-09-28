/**
 * Game session factory (Factory pattern), Task 9.3.
 *
 * `GameSessionFactory` centralizes construction of a fresh Game_Session state.
 * Given an already-validated `Maze` (produced by `MazeFactory`, Task 5.4) and a
 * branded `TimeLimit` (produced by `parseTimeLimit`, Task 3), it returns a fresh
 * `PlayingState`: the avatar on the maze Start_Cell (R1.2, R6.2), the timer
 * reset to the Time_Limit and paused until the first move (R6.3), the applied
 * Time_Limit as the active limit (R7.4), and no state carried over from any
 * prior session (R6.5).
 *
 * The design's `GameSessionFactory` interface names this method `createSession`
 * and shows a `config`-only shape. A `PlayingState` needs the concrete `Maze`
 * to seat the avatar on `maze.start`, and maze construction is the separate
 * responsibility of `MazeFactory` (Single Responsibility), so this factory
 * takes the built `Maze` plus the branded `TimeLimit` rather than a
 * `GameConfig` (which carries only `rows`/`columns`/`timeLimit` and no maze).
 * The composition root wires `MazeFactory` -> `GameSessionFactory`.
 *
 * The factory is pure and deterministic: no I/O, no DOM, no `Date.now()` or
 * `Math.random()`. The same inputs always yield a structurally identical fresh
 * state, which is exactly what "retain no state from the discarded session"
 * (R6.5) requires.
 */
import type { Maze, PlayingState, TimeLimit } from "./types";

/** Milliseconds in one second — avoids a magic number when seeding the timer. */
const MILLISECONDS_PER_SECOND = 1000;

export interface GameSessionFactory {
  /**
   * Build a fresh `PlayingState` for a new Game_Session.
   *
   * @param maze - an already-validated maze; the avatar is seated on
   *   `maze.start` (R1.2, R6.2).
   * @param timeLimit - the active Time_Limit in seconds; the timer is reset to
   *   `timeLimit * 1000` ms and left paused (R6.3, R7.4).
   * @returns a fresh `PlayingState` derived solely from the inputs, retaining
   *   no state from any prior session (R6.5).
   */
  createSession(maze: Maze, timeLimit: TimeLimit): PlayingState;
}

/**
 * Default `GameSessionFactory`.
 *
 * Stateless: it holds no fields, so it can never leak a prior session's avatar
 * or timer value into a new one (R6.5). Constructing a new state produces a new
 * immutable value rather than mutating an existing one.
 */
export class DefaultGameSessionFactory implements GameSessionFactory {
  createSession(maze: Maze, timeLimit: TimeLimit): PlayingState {
    return {
      status: "Playing",
      maze,
      avatar: maze.start,
      timeLimit,
      remainingMs: timeLimit * MILLISECONDS_PER_SECOND,
      timerStarted: false,
      pausedElapsedMs: 0,
      moveInProgress: false,
    };
  }
}
