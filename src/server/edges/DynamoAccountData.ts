/**
 * `DynamoAccountData` — the {@link AccountData} adapter over DynamoDB (task 11.2,
 * R11.5).
 *
 * The only account-erasure module that touches the AWS SDK. It implements the
 * platform's **stated data policy** (see {@link AccountData}): on a Player's
 * request to delete **their own** account, it irreversibly removes every
 * app-owned item under that account's partition (`ACCT#<accountId>`) — the
 * profile (personal data / display name), every Score (private history), and
 * every personal best — in two steps:
 *
 *  1. **Enumerate** the partition with a bounded, paginated `Query` on
 *     `PK = ACCT#<accountId>` (every entity for one account shares this
 *     partition — design "Single table"), collecting each item's `(PK, SK)` key.
 *  2. **Delete** those items in `BatchWriteItem` chunks of at most
 *     {@link BATCH_DELETE_LIMIT}.
 *
 * Because a Score item carries its leaderboard-index attributes on the *same*
 * item (see {@link DynamoScoreRepository}), deleting the base item also removes
 * its GSI projection — so a deleted Player's private identity is not retained on
 * the public leaderboard. The removal is irreversible: there is no tombstone or
 * soft-delete to restore from.
 *
 * Idempotent: an account with nothing left to erase enumerates to zero keys, so
 * no delete is issued and the result is `{ itemsDeleted: 0 }` — a repeated
 * request is safe.
 *
 * Requirement: R11.5.
 */
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import type { DynamoDocumentClient } from "./dynamoClient";
import { PARTITION_KEY, SORT_KEY, accountPartitionKey } from "./dynamoSchema";
import type { AccountData, DeleteAccountResult } from "../ports/AccountData";

/**
 * The maximum number of delete requests DynamoDB accepts in one
 * `BatchWriteItem`. The enumerated keys are erased in chunks of this size.
 */
const BATCH_DELETE_LIMIT = 25;

/** Construction dependencies (Dependency Injection). */
export interface DynamoAccountDataConfig {
  /** The DynamoDB DocumentClient seam; a fake in tests, the real client in prod. */
  readonly client: DynamoDocumentClient;
  /** The single table's name (from the CDK stack output, injected at the root). */
  readonly tableName: string;
}

/** The composite primary key of one item, used to target it for deletion. */
interface ItemKey {
  readonly [PARTITION_KEY]: string;
  readonly [SORT_KEY]: string;
}

export class DynamoAccountData implements AccountData {
  private readonly client: DynamoDocumentClient;
  private readonly tableName: string;

  public constructor(config: DynamoAccountDataConfig) {
    this.client = config.client;
    this.tableName = config.tableName;
  }

  public async deleteAccount(accountId: string): Promise<DeleteAccountResult> {
    const keys = await this.enumerateAccountKeys(accountId);
    await this.deleteKeys(keys);
    return { itemsDeleted: keys.length };
  }

  /**
   * Enumerate every item under the account's partition, following the query's
   * pagination cursor so a large history is fully collected. Reads only the two
   * key attributes — that is all a delete needs — keeping each page small.
   */
  private async enumerateAccountKeys(accountId: string): Promise<ItemKey[]> {
    const keys: ItemKey[] = [];
    let startKey: Record<string, unknown> | undefined;

    do {
      const response = (await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "#pk = :pk",
          ProjectionExpression: "#pk, #sk",
          ExpressionAttributeNames: { "#pk": PARTITION_KEY, "#sk": SORT_KEY },
          ExpressionAttributeValues: { ":pk": accountPartitionKey(accountId) },
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      )) as {
        Items?: ReadonlyArray<Record<string, unknown>>;
        LastEvaluatedKey?: Record<string, unknown>;
      };

      for (const item of response.Items ?? []) {
        keys.push({
          [PARTITION_KEY]: String(item[PARTITION_KEY]),
          [SORT_KEY]: String(item[SORT_KEY]),
        });
      }
      startKey = response.LastEvaluatedKey;
    } while (startKey !== undefined);

    return keys;
  }

  /**
   * Delete the enumerated keys in `BatchWriteItem` chunks of at most
   * {@link BATCH_DELETE_LIMIT}. Deleting the base item removes its leaderboard
   * GSI projection with it, since the projection lives on the same item.
   */
  private async deleteKeys(keys: readonly ItemKey[]): Promise<void> {
    for (let i = 0; i < keys.length; i += BATCH_DELETE_LIMIT) {
      const chunk = keys.slice(i, i + BATCH_DELETE_LIMIT);
      await this.client.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
          },
        }),
      );
    }
  }
}
