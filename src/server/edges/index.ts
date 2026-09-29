/**
 * Server edges layer entry point.
 *
 * Concrete adapters implementing the server ports (`src/server/ports`) against
 * the outside world (DynamoDB). Only modules here reference the AWS SDK; the
 * Lambdas depend on the ports, and the composition root (task 7) constructs
 * these adapters with a real DocumentClient and injects them. Mirrors
 * `src/client/edges/`. See `.kiro/steering/architecture.md`.
 */
export { DynamoScoreRepository } from "./DynamoScoreRepository";
export type { DynamoScoreRepositoryConfig } from "./DynamoScoreRepository";
export { DynamoLeaderboardQuery } from "./DynamoLeaderboardQuery";
export type { DynamoLeaderboardQueryConfig } from "./DynamoLeaderboardQuery";
export { DynamoAccountData } from "./DynamoAccountData";
export type { DynamoAccountDataConfig } from "./DynamoAccountData";
export {
  createDynamoDocumentClient,
  type DynamoCommand,
  type DynamoDocumentClient,
} from "./dynamoClient";
