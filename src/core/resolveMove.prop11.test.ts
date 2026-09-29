import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolveMove } from "./resolveMove";
import { makeMaze, at } from "./testFixtures/mazes";
import {
  CellKind,
  type Direction,
  type Maze,
  type PlayingState,
  type Position,
  type TimeLimit,
} from "./types";

/**
 * Property-based test for Correctness Property 11.
 *
 * Property 11 (design.md): *For any* `PlayingState` whose `remainingMs` is less
 * than or equal to zero and any `Direction` whose target is the exit cell,
 * `resolveMove` does not transition the state to `Won`.
 *
 * In other words, arriving on the exit is only a win while time remains
 * (R4.5 / R3.5): the winning branch in `resolveMove` guards on
 * `remainingMs > 0`, so a move onto the exit with no time left must not
 * produce a `WonState`. Ending an out-of-time session is a `Tick` concern,
 * not a `Move` concern, so the move here simply advances onto the exit and
 * stays `Playing`.
 *
 * Determinism (testing steering): this property needs no randomness or maze
 * generation. It uses a small hand-built maze in which the avatar sits on a
 * path cell orthogonally adjacent to the exit, and generates the two varying
 * dimensions from fast-check: which side the exit is on (fixing the move
 * direction that reaches it) and the non-positive `remainingMs` (zero plus the
 * negative range, including a float). The property runs a minimum of 100
 * iterations.
 *
 * _Validates: Requirements 4.5_
 */

const PROPERTY_MIN_RUNS = 100;

/** A branded 60s limit; its exact value is irrelevant to this win-guard invariant. */
const TIME_LIMIT_SECONDS = 60;

const P = CellKind.Path;

/**
 * An exit-adjacency layout: a 1×2 corridor of two path cells where one is the
 * avatar's cell and the other is the exit, together with the `Direction` that
 * steps from the avatar onto the exit. Building one per direction lets the
 * property exercise every move orientation reaching the exit.
 */
interface AdjacentToExitCase {
  readonly maze: Maze;
  readonly avatar: Position;
  readonly direction: Direction;
}

/**
 * Four hand-built cases, one per direction, each placing the avatar on a path
 * cell whose neighbor in `direction` is the exit. The grids are minimal 1×2 or
 * 2×1 corridors so the only path cells are the avatar's cell and the exit.
 */
const ADJACENT_TO_EXIT_CASES: readonly AdjacentToExitCase[] = [
  // Avatar left of exit; moving Right reaches it.  [ S E ]
  {
    maze: makeMaze([[P, P]], at(0, 0), at(0, 1)),
    avatar: at(0, 0),
    direction: "Right",
  },
  // Avatar right of exit; moving Left reaches it.   [ E S ]
  {
    maze: makeMaze([[P, P]], at(0, 1), at(0, 0)),
    avatar: at(0, 1),
    direction: "Left",
  },
  // Avatar below exit; moving Up reaches it.        [ E / S ]
  {
    maze: makeMaze([[P], [P]], at(1, 0), at(0, 0)),
    avatar: at(1, 0),
    direction: "Up",
  },
  // Avatar above exit; moving Down reaches it.      [ S / E ]
  {
    maze: makeMaze([[P], [P]], at(0, 0), at(1, 0)),
    avatar: at(0, 0),
    direction: "Down",
  },
];

/** Build a Playing state on the adjacency case's avatar cell with given remaining time. */
function playingWith(caseData: AdjacentToExitCase, remainingMs: number): PlayingState {
  return {
    status: "Playing",
    maze: caseData.maze,
    avatar: caseData.avatar,
    timeLimit: TIME_LIMIT_SECONDS as TimeLimit,
    remainingMs,
    timerStarted: true,
    pausedElapsedMs: 0,
    moveInProgress: false,
  };
}

/** One of the four exit-adjacency cases. */
const adjacentCaseArb = fc.constantFrom(...ADJACENT_TO_EXIT_CASES);

/**
 * Non-positive remaining time: zero and the negative range. A float
 * (`-0.5` shifted) is included so the guard is exercised against non-integers
 * too, matching the testing-steering guidance to generate floats and
 * out-of-range values.
 */
const nonPositiveRemainingMsArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -600_000, max: 0 }),
  fc.double({ min: -600_000, max: 0, noNaN: true }),
);

describe("resolveMove — Property 11: reaching the exit without time remaining does not win", () => {
  // Feature: maze-game, Property 11: Reaching the exit without time remaining does not win
  it("does not produce a Won state when moving onto the exit with remainingMs <= 0", () => {
    fc.assert(
      fc.property(
        adjacentCaseArb,
        nonPositiveRemainingMsArb,
        (caseData, remainingMs) => {
          const state = playingWith(caseData, remainingMs);

          const next = resolveMove(state, caseData.direction);

          // The core precondition: the avatar really is adjacent to the exit
          // and this direction targets it, so a positive-time move here would
          // win. With no time left it must not.
          expect(next.status).not.toBe("Won");
        },
      ),
      { numRuns: PROPERTY_MIN_RUNS },
    );
  });
});
