/**
 * Core (pure) layer entry point.
 *
 * Domain types and pure rule functions live here. No I/O, no DOM, no direct
 * access to `Date.now()` or `Math.random()`. See `.kiro/steering/architecture.md`.
 *
 * This file is fleshed out by the maze-game core tasks (types, validateMaze,
 * resolveMove, tickTimer, parseTimeLimit, reduce, and maze generation).
 */
export * from "./types";
export * from "./MazeGenerator";
export * from "./RecursiveBacktrackerGenerator";
export * from "./parseTimeLimit";
export * from "./validateMaze";
export * from "./MazeFactory";
export * from "./resolveMove";
export * from "./tickTimer";
export * from "./GameSessionFactory";
export * from "./reduce";
export * from "./validateSubmission";
export * from "./platform/leaderboard";
export * from "./platform/sharedSession";
export * from "./platform/sessionResolution";
export * from "./platform/sessionScorePersistence";
