/**
 * Small display formatters shared by the score/leaderboard screens.
 *
 * Kept pure and dependency-free so they are trivially testable and used
 * consistently everywhere a completion time is shown.
 */

const MS_PER_SECOND = 1000;

/** Format a completion time in milliseconds as seconds with two decimals. */
export function formatSeconds(elapsedMs: number): string {
  return `${(elapsedMs / MS_PER_SECOND).toFixed(2)}s`;
}
