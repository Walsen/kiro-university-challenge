import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * The single table's name. Environment-agnostic (no `-dev`/`-prod` suffix) because there is
 * one shared table for the single backend (D6).
 */
export const TABLE_NAME = "maze-game-platform";

/**
 * The leaderboard index name. Fixed rather than derived so both the table definition here
 * and the query adapter (task 6.4) name the same index without duplicating a literal.
 */
export const LEADERBOARD_INDEX_NAME = "GSI1";

/** The single-table partition-key attribute. */
export const PARTITION_KEY = "PK";

/** The single-table sort-key attribute. */
export const SORT_KEY = "SK";

/** The leaderboard GSI partition-key attribute. */
export const GSI1_PARTITION_KEY = "GSI1PK";

/** The leaderboard GSI sort-key attribute. */
export const GSI1_SORT_KEY = "GSI1SK";

/**
 * The persistence layer for the Maze Game Platform (task 6.1, R4.2, R5.1, R6.1): a single
 * DynamoDB table plus a leaderboard global secondary index, following the design's
 * "Data model (DynamoDB single-table)".
 *
 * **Single table (R4.2, R5.1).** All entities share one table under a generic
 * partition/sort key scheme (`PK` / `SK`), so a Player's profile, every Score, and their
 * personal bests live under one partition (`ACCT#<accountId>`) and are read with a single
 * bounded `Query`. Concretely the item shapes the later adapters (tasks 6.3/6.4) write are:
 *
 *  - **Player profile** — `PK = ACCT#<accountId>`, `SK = PROFILE` (displayName, createdAt).
 *  - **Score** — `PK = ACCT#<accountId>`, `SK = SCORE#<params>#<ts>` (time, params).
 *  - **Personal best** — `PK = ACCT#<accountId>`, `SK = BEST#<params>`, updated by a
 *    conditional write (R4.5).
 *  - **Leaderboard entry** — projected onto the GSI, `GSI1PK = LB#<params>`,
 *    `GSI1SK = <zeroPaddedTimeMs>#<accountId>`.
 *
 * **On-demand billing.** `PAY_PER_REQUEST` means capacity scales with traffic and there is
 * no provisioned-throughput knob to tune or over-provision — the serverless posture the
 * design's baseline stack calls for, and which keeps a quiet dev environment free.
 *
 * **Leaderboard GSI (R6.1).** `GSI1` is keyed so a `Query` on `GSI1PK = LB#<params>` in
 * ascending sort order returns fastest-first: the sort key encodes a **zero-padded** time
 * so lexicographic order matches numeric order, with `accountId` appended as a deterministic
 * tie-break. The top segment is then a bounded ascending `Query` (R6.4), and own-rank
 * (R6.3) is a count of better times. All attributes are projected onto the index so a
 * leaderboard read is served entirely from the GSI without a follow-up fetch against the
 * base table, keeping the read within the latency budget.
 *
 * Because the key names are generic, adding a new access pattern later is a new
 * `SK`/`GSI1SK` encoding rather than a schema change (Open/Closed). This construct only
 * defines the table; the `ScoreRepository`/`LeaderboardQuery` adapters and their
 * least-privilege grants are tasks 6.3/6.4.
 */
export class DataStore extends Construct {
  /** The single DynamoDB table holding profiles, scores, personal bests, and the GSI. */
  public readonly table: dynamodb.Table;

  public constructor(scope: Construct, id: string) {
    super(scope, id);

    // The single shared table is the real source of truth (not disposable per-environment
    // scratch), so it always uses a prod-grade posture (D6): retain on stack replacement
    // and point-in-time recovery, so a replacement never silently deletes real scores.
    this.table = new dynamodb.Table(this, "Table", {
      tableName: TABLE_NAME,
      partitionKey: { name: PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      sortKey: { name: SORT_KEY, type: dynamodb.AttributeType.STRING },
      // On-demand: no provisioned capacity to manage, scales with request volume.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Point-in-time recovery protects the shared source of truth against accidental
      // data loss (always on — the single backend is never disposable).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The leaderboard index (R6.1): ascending Query on GSI1SK is fastest-first because the
    // time component is zero-padded. Project ALL so a leaderboard read is served from the
    // index alone (R6.4 latency budget) with no base-table lookup.
    this.table.addGlobalSecondaryIndex({
      indexName: LEADERBOARD_INDEX_NAME,
      partitionKey: { name: GSI1_PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      sortKey: { name: GSI1_SORT_KEY, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }

  /** The name of the single table, for services and outputs to reference. */
  public get tableName(): string {
    return this.table.tableName;
  }
}
