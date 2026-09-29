import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseTimeLimit } from "../parseTimeLimit";
import { RecursiveBacktrackerGenerator } from "../RecursiveBacktrackerGenerator";
import {
  CellKind,
  type Direction,
  type Maze,
  type Position,
  type TimeLimit,
} from "../types";
import {
  resolveSessionMove,
  type ParticipantState,
  type SessionMoveCommand,
  type SharedSessionState,
} from "./sharedSession";

/**
 * Property-based test for maze-game-platform Correctness Property: authoritative
 * legality (Task 16.3).
 *
 * Property (design "Server-authoritative shared session", R9.3): *for any* valid
 * shared-session state and *any* sequence of move commands — legal, illegal
 * (into a wall / off the grid), stale / out-of-order, or from an unknown
 * participant — every participant's resulting authoritative position is always a
 * Path cell inside the maze bounds. A rejected move never advances a position,
 * so no participant can ever occupy a wall or an out-of-bounds cell.
 *
 * The property folds the generated command sequence through the pure reducer
 * `resolveSessionMove`, threading the authoritative state, and after every step
 * asserts the invariant across all participants.
 *
 * Determinism (testing steering): the maze comes from the real generator seeded
 * by a local mulberry32 PRNG; participants start on the maze's Start cell (a
 * valid Path cell); directions, participant targets, and expected sequence
 * numbers all come from fast-check arbitraries — never `Math.random` or
 * wall-clock time. Custom arbitraries constrain generation to valid domain
 * values while deliberately mixing in illegal, out-of-order, and
 * unknown-participant commands so every rejection path is exercised. The
 * property runs a minimum of 100 iterations.
 *
 * _Validates: Requirements 9.3_
 */

/** fast-check iterations; testing steering requires a minimum of 100. */
const NUM_RUNS = 200;

/** Smallest dimension for which the generator yields distinct start/exit. */
const MIN_DIMENSION = 3;
/** Upper dimension bound; keeps the property fast at >= 100 iterations. */
const MAX_DIMENSION = 11;

/** The four directions a participant can attempt to move. */
const DIRECTIONS: readonly Direction[] = ["Up", "Down", "Left", "Right"];

/** Known participant identifiers seated in every generated session. */
const KNOWN_PARTICIPANTS: readonly string[] = ["alice", "bob", "carol"];

/**
 * Identifiers a command may target: the seated participants plus an unknown one
 * ("mallory") so the unknown-participant rejection path is exercised.
 */
const COMMAND_TARGETS: readonly string[] = [...KNOWN_PARTICIPANTS, "mallory"];

/**
 * A tiny deterministic PRNG (mulberry32): the same seed yields the same
 * sequence in `[0, 1)`, making maze generation reproducible without
 * `Math.random`. Defined locally per the testing steering.
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

/** A branded, in-range time limit; its exact value is irrelevant here. */
function fixtureTimeLimit(): TimeLimit {
  return parseTimeLimit(60).value;
}

/** True when `position` lies inside the maze grid. */
function isInBounds(maze: Maze, position: Position): boolean {
  return (
    position.row >= 0 &&
    position.row < maze.rows &&
    position.column >= 0 &&
    position.column < maze.columns
  );
}

/** True when the cell at `position` is a Path cell (assumes in-bounds). */
function isPathCell(maze: Maze, position: Position): boolean {
  return maze.grid[position.row]?.[position.column] === CellKind.Path;
}

/**
 * The invariant under test: a position is authoritatively legal iff it is
 * inside the maze bounds AND on a Path cell (never a Wall, never off-grid).
 */
function isLegalPosition(maze: Maze, position: Position): boolean {
  return isInBounds(maze, position) && isPathCell(maze, position);
}

/**
 * Build a Racing shared session from a generator-produced maze with the known
 * participants all seated on the maze's Start cell (a valid Path cell).
 */
function racingSession(maze: Maze): SharedSessionState {
  const participants = new Map<string, ParticipantState>();
  for (const participantId of KNOWN_PARTICIPANTS) {
    participants.set(participantId, {
      participantId,
      displayName: participantId,
      position: maze.start,
      moveSeq: 0,
      status: "Racing",
    });
  }
  return {
    sessionId: "session-prop",
    maze,
    timeLimit: fixtureTimeLimit(),
    participants,
    status: "Racing",
  };
}

/** Full 32-bit seed space for the injected PRNG. */
const seedArb = fc.integer({ min: 0, max: 0xffffffff });
const dimensionArb = fc.integer({ min: MIN_DIMENSION, max: MAX_DIMENSION });

/** A valid maze from the real generator, guaranteed solvable and well-formed. */
const mazeArb: fc.Arbitrary<Maze> = fc
  .record({ rows: dimensionArb, columns: dimensionArb, seed: seedArb })
  .map(({ rows, columns, seed }) => {
    const generator = new RecursiveBacktrackerGenerator();
    return generator.generate(rows, columns, mulberry32(seed));
  });

/**
 * A single move command. It mixes known and unknown participants, all four
 * directions, and a small `expectedSeq` drawn from a range that includes both
 * the correct value (0, 1, 2, ...) and stale/ahead values, so legal,
 * illegal (wall / out-of-bounds), out-of-order, and unknown-participant
 * commands are all generated.
 */
const commandArb: fc.Arbitrary<SessionMoveCommand> = fc.record({
  participantId: fc.constantFrom(...COMMAND_TARGETS),
  direction: fc.constantFrom(...DIRECTIONS),
  expectedSeq: fc.integer({ min: 0, max: 8 }),
});

const commandsArb = fc.array(commandArb, { minLength: 1, maxLength: 40 });

const caseArb: fc.Arbitrary<{
  readonly maze: Maze;
  readonly commands: readonly SessionMoveCommand[];
}> = fc.record({ maze: mazeArb, commands: commandsArb });

describe("resolveSessionMove — Property: authoritative legality (R9.3)", () => {
  // Feature: maze-game-platform, Property: authoritative legality
  it("never lets any participant's authoritative position enter a wall or out-of-bounds cell", () => {
    fc.assert(
      fc.property(caseArb, ({ maze, commands }) => {
        let state = racingSession(maze);

        // Precondition: every seated participant starts on a legal cell.
        for (const p of state.participants.values()) {
          expect(isLegalPosition(maze, p.position)).toBe(true);
        }

        for (const command of commands) {
          const result = resolveSessionMove(state, command);
          if (result.ok) {
            state = result.state;
          }

          // Invariant: after every step (accepted or rejected), every
          // participant's authoritative position is in-bounds and on a Path
          // cell.
          for (const p of state.participants.values()) {
            expect(isLegalPosition(maze, p.position)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
