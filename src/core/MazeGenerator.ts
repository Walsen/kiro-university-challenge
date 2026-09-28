/**
 * Maze generation strategy (Strategy pattern).
 *
 * Swappable maze-generation algorithms live behind this single interface,
 * satisfying Open/Closed: new algorithms are added as new implementations
 * (e.g. `RecursiveBacktrackerGenerator`) rather than by editing existing ones.
 *
 * Generation is deterministic given its inputs — randomness enters only
 * through the injected `rng: () => number`, never `Math.random()` directly.
 * This keeps generation pure and reproducible under test (seed the `rng`).
 */
import type { Maze } from "./types";

export interface MazeGenerator {
  /**
   * Produce a maze that is guaranteed valid per `validateMaze`: exactly one
   * start and one exit (distinct path cells) with a 4-directionally adjacent
   * path connecting them.
   *
   * @param rows    Number of rows in the generated grid.
   * @param columns Number of columns in the generated grid.
   * @param rng     Injected source of randomness in `[0, 1)`; seed for determinism.
   */
  generate(rows: number, columns: number, rng: () => number): Maze;
}
