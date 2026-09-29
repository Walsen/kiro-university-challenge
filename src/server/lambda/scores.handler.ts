/**
 * Lambda entry for `POST /scores` (task 7.1, wired for the walking skeleton in
 * task 8).
 *
 * A thin shim: bind the pure {@link makeScoreHandler} to the real
 * `ScoreRepository` from the composition root and export it as the function's
 * `handler`. The narrow {@link HttpApiHandler} shape is structurally the API
 * Gateway HTTP API (payload v2.0) proxy handler the runtime invokes — the real
 * event is a superset of {@link HttpApiEvent} — so no adapter is needed here.
 *
 * The handler is wrapped by {@link withAccountIdAnnotation} so each request
 * annotates its X-Ray trace with the acting `accountId` (task 9.1); the wrap
 * keeps the pure handler free of any tracing concern.
 */
import { makeScoreHandler } from "../handlers/scores";
import { serviceContext } from "./context";
import { withAccountIdAnnotation } from "./tracing";

export const handler = withAccountIdAnnotation(
  makeScoreHandler({ repository: serviceContext.repository }),
);
