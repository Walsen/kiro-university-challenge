/**
 * Lambda entry for `GET /scores/me/best` (task 7.2, wired in task 8).
 *
 * Binds the pure {@link makePersonalBestHandler} to the real `ScoreRepository`
 * and exports it as the function's `handler`. Returns the caller's own best for
 * a maze-parameter scope (R5.2), scoped to the JWT `sub` (R5.3, R11.2).
 */
import { makePersonalBestHandler } from "../handlers/personalHistory";
import { serviceContext } from "./context";
import { withAccountIdAnnotation } from "./tracing";

export const handler = withAccountIdAnnotation(
  makePersonalBestHandler({
    repository: serviceContext.repository,
  }),
);
