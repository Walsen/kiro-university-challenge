/**
 * The Lambda composition root for the Phase 2a service handlers (task 8).
 *
 * The pure handlers (`makeScoreHandler`, `makePersonalHistoryHandler`,
 * `makePersonalBestHandler`, `makeLeaderboardHandler`, `makeOwnRankHandler`)
 * depend only on the `ScoreRepository` / `LeaderboardQuery` ports. This module
 * is the single place where those ports are bound to their real DynamoDB
 * adapters over a real marshalling DocumentClient — the composition root the
 * hexagonal design calls for (Dependency Injection). Each Lambda entry file
 * imports the collaborators from here and stays a thin wiring shim, so a handler
 * is never coupled to the AWS SDK.
 *
 * The table name is read once from the environment (`MAZE_TABLE_NAME`), which
 * the CDK `ServiceApi` construct sets on every function from the DynamoDB
 * table's name. Reading it at module load (cold start) rather than per request
 * lets a missing configuration fail fast and keeps the adapters constructed once
 * per container.
 */
import { createDynamoDocumentClient } from "../edges/dynamoClient";
import { DynamoScoreRepository } from "../edges/DynamoScoreRepository";
import { DynamoLeaderboardQuery } from "../edges/DynamoLeaderboardQuery";
import { DynamoAccountData } from "../edges/DynamoAccountData";
import type { ScoreRepository, LeaderboardQuery } from "../ports/ScoreRepository";
import type { AccountData } from "../ports/AccountData";

/**
 * The environment variable carrying the single-table name. Set by the CDK
 * `ServiceApi` construct from the `DataStore` table so the adapters target this
 * environment's table without a hardcoded name.
 */
const TABLE_NAME_ENV = "MAZE_TABLE_NAME";

/**
 * Read a process environment variable without pulling `@types/node` into this
 * DOM/jsdom-typed project (mirrors the seam tests). The Lambda runs under Node,
 * so `process` exists at runtime; we reach it through `globalThis` behind a
 * narrow local type rather than widening the project's ambient globals.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[name];
}

/** Read the configured table name, failing fast if the function was misconfigured. */
function requireTableName(): string {
  const name = readEnv(TABLE_NAME_ENV);
  if (name === undefined || name.length === 0) {
    throw new Error(
      `${TABLE_NAME_ENV} is not set; the ServiceApi construct must inject the DynamoDB table name`,
    );
  }
  return name;
}

/**
 * The real DynamoDB collaborators, constructed once per container. The document
 * client picks up region and credentials from the ambient Lambda execution
 * environment (the function's IAM role); no explicit configuration is needed.
 */
function buildContext(): {
  readonly repository: ScoreRepository;
  readonly query: LeaderboardQuery;
  readonly accountData: AccountData;
} {
  const tableName = requireTableName();
  const client = createDynamoDocumentClient();
  return {
    repository: new DynamoScoreRepository({ client, tableName }),
    query: new DynamoLeaderboardQuery({ client, tableName }),
    accountData: new DynamoAccountData({ client, tableName }),
  };
}

/** The shared, container-lifetime composition context for the service handlers. */
export const serviceContext = buildContext();
