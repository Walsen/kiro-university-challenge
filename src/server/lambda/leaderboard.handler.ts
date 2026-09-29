/**
 * Lambda entry for the PUBLIC `GET /leaderboard` (task 7.3, wired in task 8).
 *
 * Binds the pure {@link makeLeaderboardHandler} to the real `LeaderboardQuery`
 * and exports it as the function's `handler`. This route is unauthenticated;
 * the handler projects away the private account identifier so only display
 * name + time + rank leave the boundary (R6.2, R11.3).
 */
import { makeLeaderboardHandler } from "../handlers/leaderboard";
import { serviceContext } from "./context";

export const handler = makeLeaderboardHandler({ query: serviceContext.query });
