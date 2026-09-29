/**
 * Lambda entry for the authenticated `GET /leaderboard/me` (task 7.3, wired in
 * task 8).
 *
 * Binds the pure {@link makeOwnRankHandler} to the real `LeaderboardQuery` and
 * exports it as the function's `handler`. Returns the caller's own rank for a
 * maze-parameter scope, scoped to the JWT `sub` (R6.3, R11.2).
 */
import { makeOwnRankHandler } from "../handlers/leaderboard";
import { serviceContext } from "./context";
import { withAccountIdAnnotation } from "./tracing";

export const handler = withAccountIdAnnotation(
  makeOwnRankHandler({ query: serviceContext.query }),
);
