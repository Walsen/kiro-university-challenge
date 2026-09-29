/**
 * Lambda entry for `GET /scores/me` (task 7.2, wired in task 8).
 *
 * Binds the pure {@link makePersonalHistoryHandler} to the real
 * `ScoreRepository` and exports it as the function's `handler`. Per-account
 * isolation (R5.3, R11.2) is enforced by the handler from the JWT `sub`.
 */
import { makePersonalHistoryHandler } from "../handlers/personalHistory";
import { serviceContext } from "./context";
import { withAccountIdAnnotation } from "./tracing";

export const handler = withAccountIdAnnotation(
  makePersonalHistoryHandler({
    repository: serviceContext.repository,
  }),
);
