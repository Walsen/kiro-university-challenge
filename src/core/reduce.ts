/**
 * `reduce` — the single pure state transition for the maze game.
 *
 * `reduce(state, action)` is the one place the `GameState` machine advances
 * (design "State transition diagram"). It is pure and immutable: it derives a
 * new state from its inputs and never mutates them, and it reaches for no I/O,
 * DOM, clock, or randomness. All timing and movement rules are delegated to the
 * existing pure core functions:
 *
 * - `Move` delegates to `resolveMove`, then applies the R6.3 timer-start
 *   bookkeeping: the first accepted move (one that actually advances the avatar
 *   while the timer is still paused) flips `timerStarted` to `true`.
 * - `Tick` honors the R6.3 pause first: while `timerStarted` is `false` the
 *   timer is paused, so a tick only accrues `pausedElapsedMs` toward the 1s
 *   auto-start maximum without decrementing `remainingMs` and without ever
 *   moving the avatar; once the cumulative paused elapsed reaches 1000ms the
 *   timer starts and any elapsed beyond that threshold counts down. Once
 *   started, `Tick` delegates to `tickTimer`, then adds the Playing -> Lost
 *   on-expiry transition: reaching zero away from the exit is a loss (R3.3,
 *   Property 8).
 * - `StartSession` builds a fresh `PlayingState` via `GameSessionFactory`,
 *   discarding any prior session state (R6.5, Property 3).
 * - `MoveAnimationComplete` clears the `moveInProgress` guard (R2.5).
 *
 * Ended sessions (`Won`/`Lost`) freeze: `Move` and `Tick` return them unchanged
 * (R3.4, R3.5, R4.4, Properties 9/12). The `Idle` state has no running timer or
 * accepted moves, so those actions leave it unchanged too.
 */
import { DefaultGameSessionFactory } from "./GameSessionFactory";
import { resolveMove } from "./resolveMove";
import { tickTimer } from "./tickTimer";
import type {
  Direction,
  GameAction,
  GameConfig,
  GameState,
  LostState,
  PlayingState,
} from "./types";

/** The timer floor: reaching this while off the exit ends the session (R3.3). */
const EXPIRED_REMAINING_MS = 0;

/**
 * R6.3: a fresh session's timer stays paused for at most this long. Once this
 * much elapsed time has accrued with no move, the timer starts on its own and
 * begins counting down — without moving the avatar.
 */
const TIMER_AUTOSTART_MS = 1000;

/** The single session factory used to build fresh `PlayingState`s. */
const sessionFactory = new DefaultGameSessionFactory();

/** Whether two states are the same object — i.e. the transition was a no-op. */
function isUnchanged(before: GameState, after: GameState): boolean {
  return before === after;
}

function isOnExit(state: PlayingState): boolean {
  return (
    state.avatar.row === state.maze.exit.row &&
    state.avatar.column === state.maze.exit.column
  );
}

/**
 * Build a fresh session, reusing the current maze and applying the config's
 * time limit (R6.5). The maze comes from the state being replaced, since the
 * config carries only dimensions and a time limit, not a built maze.
 */
function startSession(state: GameState, config: GameConfig): GameState {
  return sessionFactory.createSession(state.maze, config.timeLimit);
}

/**
 * Apply a move, then start the timer on the first accepted one (R6.3). Only a
 * still-`Playing` result that advanced the avatar counts as accepted; a blocked
 * move (unchanged state) or a win (which has no timer to start) does not.
 */
function applyMove(state: GameState, direction: Direction): GameState {
  const moved = resolveMove(state, direction);

  if (moved.status !== "Playing" || isUnchanged(state, moved)) {
    return moved;
  }

  if (moved.timerStarted) {
    return moved;
  }

  const started: PlayingState = { ...moved, timerStarted: true };
  return started;
}

/**
 * Apply a timer tick to a still-paused session (R6.3). While the timer is
 * paused the avatar never moves and `remainingMs` does not count down; the tick
 * only accrues `pausedElapsedMs`. Once the cumulative paused elapsed reaches the
 * 1s maximum, the timer starts (`timerStarted: true`) and any elapsed beyond the
 * threshold is applied as countdown via the started-timer path.
 */
function applyPausedTick(state: PlayingState, elapsedMs: number): GameState {
  const pausedElapsedMs = state.pausedElapsedMs + elapsedMs;

  if (pausedElapsedMs < TIMER_AUTOSTART_MS) {
    const stillPaused: PlayingState = { ...state, pausedElapsedMs };
    return stillPaused;
  }

  const started: PlayingState = { ...state, timerStarted: true, pausedElapsedMs };
  const overshootMs = pausedElapsedMs - TIMER_AUTOSTART_MS;
  return applyRunningTick(started, overshootMs);
}

/**
 * Apply a timer tick to a running session, then add the Playing -> Lost
 * transition when the timer reaches zero away from the exit (R3.3). Reaching
 * zero on the exit is not a loss; ending there is a `Move`/win concern, not a
 * `Tick` concern.
 */
function applyRunningTick(state: PlayingState, elapsedMs: number): GameState {
  const ticked = tickTimer(state, elapsedMs);

  if (ticked.status !== "Playing") {
    return ticked;
  }

  if (ticked.remainingMs > EXPIRED_REMAINING_MS || isOnExit(ticked)) {
    return ticked;
  }

  const lost: LostState = {
    status: "Lost",
    maze: ticked.maze,
    avatar: ticked.avatar,
    timeLimit: ticked.timeLimit,
    reason: "TimeExpired",
  };
  return lost;
}

/**
 * Apply a timer tick. Non-`Playing` states have no running timer, so they are
 * returned unchanged. A still-paused `Playing` session accrues toward the R6.3
 * auto-start; a started one counts down.
 */
function applyTick(state: GameState, elapsedMs: number): GameState {
  if (state.status !== "Playing") {
    return state;
  }

  if (!state.timerStarted) {
    return applyPausedTick(state, elapsedMs);
  }

  return applyRunningTick(state, elapsedMs);
}

/** Clear the in-progress move guard once an animation finishes (R2.5). */
function completeMoveAnimation(state: GameState): GameState {
  if (state.status !== "Playing") {
    return state;
  }

  const idleBetweenMoves: PlayingState = { ...state, moveInProgress: false };
  return idleBetweenMoves;
}

export function reduce(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "StartSession":
      return startSession(state, action.config);
    case "Move":
      return applyMove(state, action.direction);
    case "Tick":
      return applyTick(state, action.elapsedMs);
    case "MoveAnimationComplete":
      return completeMoveAnimation(state);
  }
}
