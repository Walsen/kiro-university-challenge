/**
 * Maze construction factory (Factory pattern), Task 5.4.
 *
 * `MazeFactory` centralizes maze construction and enforces the validity
 * contract in one place. It asks the injected `MazeGenerator` for a maze, runs
 * `validateMaze`, and returns a typed `MazeResult`: `ok: true` with the maze,
 * or `ok: false` with the `MazeValidationError`. It never throws for expected
 * invalid input — failure is modelled as data so the type system forces callers
 * to handle both outcomes (fail fast at the boundary, R1.6).
 *
 * Construction is pure and deterministic: the concrete factory receives its
 * `MazeGenerator` and an `rng: () => number` via constructor injection
 * (Dependency Inversion), so it never reaches `Math.random()` directly and the
 * same seeded rng yields the same maze.
 */
import type { Maze, MazeResult } from "./types";
import type { MazeGenerator } from "./MazeGenerator";
import { validateMaze } from "./validateMaze";

export interface MazeFactory {
  /**
   * Generate and validate a maze of the requested size.
   *
   * @returns `{ ok: true, maze }` when the generated maze is valid, otherwise
   *   `{ ok: false, error }` with the matching `MazeValidationError`.
   */
  create(rows: number, columns: number): MazeResult;
}

/**
 * Default `MazeFactory` that composes a `MazeGenerator` with `validateMaze`.
 *
 * The generator and randomness source are injected so generation stays pure and
 * reproducible, and so alternative generation strategies can be substituted
 * without editing this class (Open/Closed).
 */
export class DefaultMazeFactory implements MazeFactory {
  constructor(
    private readonly generator: MazeGenerator,
    private readonly rng: () => number,
  ) {}

  create(rows: number, columns: number): MazeResult {
    const maze: Maze = this.generator.generate(rows, columns, this.rng);
    const validation = validateMaze(maze);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
    return { ok: true, maze };
  }
}
