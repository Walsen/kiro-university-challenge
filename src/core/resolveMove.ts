/**
 * Pure movement rule for the maze game (R2.1, R2.2, R2.3, R2.5, R4.1, R4.2, R4.5, R4.4).
 *
 * `resolveMove` computes the next `GameState` from a move in a given direction.
 * It is deterministic and immutable: it never mutates its inputs and produces
 * new state objects. Blocked moves (into a wall or out of bounds) return the
 * state unchanged — the store surfaces that as a `MoveBlocked` event (see
 * design.md "Error Handling"); `resolveMove` does not signal it.
 *
 * Win/loss timing lives here only for the win transition: moving onto the exit
 * while `remainingMs > 0` wins and captures elapsed time (R4.1, R4.2). Moving
 * onto the exit at or below zero remaining time is not a win (R4.5); ending the
 * session on time expiry is a `Tick` concern, not a `Move` concern.
 *
 * Pure: no I/O, no DOM, no access to time or randomness.
 */
import {
  CellKind,
  type Direction,
  type GameState,
  type PlayingState,
  type Position,
  type WonState,
} from "./types";

/** Row/column deltas for each direction. Named to avoid magic offsets. */
const DIRECTION_DELTAS: Readonly<Record<Direction, Position>> = {
  Up: { row: -1, column: 0 },
  Down: { row: 1, column: 0 },
  Left: { row: 0, column: -1 },
  Right: { row: 0, column: 1 },
};

const MILLISECONDS_PER_SECOND = 1000;

/** The cell one step from `from` in `direction`. */
function step(from: Position, direction: Direction): Position {
  const delta = DIRECTION_DELTAS[direction];
  return { row: from.row + delta.row, column: from.column + delta.column };
}

function isInBounds(state: PlayingState, position: Position): boolean {
  const { maze } = state;
  return (
    position.row >= 0 &&
    position.row < maze.rows &&
    position.column >= 0 &&
    position.column < maze.columns
  );
}

function isPath(state: PlayingState, position: Position): boolean {
  return state.maze.grid[position.row]?.[position.column] === CellKind.Path;
}

function isSamePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.column === b.column;
}

/** Milliseconds elapsed so far, from the branded limit and remaining time. */
function elapsedMsFrom(state: PlayingState): number {
  return state.timeLimit * MILLISECONDS_PER_SECOND - state.remainingMs;
}

function toWon(state: PlayingState, avatar: Position): WonState {
  return {
    status: "Won",
    maze: state.maze,
    avatar,
    timeLimit: state.timeLimit,
    elapsedMs: elapsedMsFrom(state),
  };
}

function advanced(state: PlayingState, avatar: Position): PlayingState {
  return { ...state, avatar };
}

export function resolveMove(state: GameState, direction: Direction): GameState {
  // A move is only accepted during an active, idle-between-moves Playing state
  // (R4.4 rejects Won/Lost/Idle; R2.5 drops moves while one is in progress).
  if (state.status !== "Playing" || state.moveInProgress) {
    return state;
  }

  const target = step(state.avatar, direction);

  // Blocked into a wall or off the grid: no change (R2.2, R2.3).
  if (!isInBounds(state, target) || !isPath(state, target)) {
    return state;
  }

  // Valid one-cell move (R2.1). Winning onto the exit requires remaining time
  // (R4.1, R4.2); onto the exit without time is not a win (R4.5).
  if (isSamePosition(target, state.maze.exit) && state.remainingMs > 0) {
    return toWon(state, target);
  }

  return advanced(state, target);
}
