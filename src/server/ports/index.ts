/**
 * Server ports layer entry point.
 *
 * The small, provider-agnostic interfaces the Phase 2 server (the Lambdas)
 * depends on for persistence and ranked reads. Concrete adapters (e.g.
 * `DynamoScoreRepository`, `DynamoLeaderboardQuery`) live in the server edges
 * layer and implement these ports; dependencies point inward only. Mirrors
 * `src/client/ports/`. See `.kiro/steering/architecture.md`.
 */
export type {
  ScoreRepository,
  LeaderboardQuery,
  PutScoreResult,
  Page,
  PageToken,
  LeaderboardStanding,
} from "./ScoreRepository";
export type { AccountData, DeleteAccountResult } from "./AccountData";
export type { SessionRepository, SessionUpdatePublisher } from "./SessionRepository";
