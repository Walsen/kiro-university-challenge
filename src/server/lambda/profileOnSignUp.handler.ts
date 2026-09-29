/**
 * Cognito **PostConfirmation** trigger: write the account's `PROFILE` item
 * (task 8, the profile-on-signup path the walking skeleton needs).
 *
 * The leaderboard read resolves a public display name for each standing from a
 * `PROFILE` item (`PK = ACCT#<sub>`, `SK = PROFILE`, `accountId`, `displayName`
 * — see `DynamoLeaderboardQuery.resolveDisplayNames` and `dynamoSchema`). Nothing
 * created that item before this trigger existed, so a real sign-in → submit →
 * leaderboard slice would show "Unknown Player". This trigger closes that gap:
 * the moment Cognito confirms an account, it persists the profile so the account
 * has a public name the leaderboard can show (R6.2).
 *
 * Trust and shape. Cognito invokes this after it has confirmed the account, and
 * the event's `request.userAttributes` are Cognito's own verified attributes —
 * `sub` is the authoritative account id (the same `sub` the JWT authorizer later
 * puts in the request context, R11.2) and `name` is the Player-chosen display
 * name stored at sign-up (`DISPLAY_NAME_ATTRIBUTE` in `cognitoClient.ts`). The
 * account id is taken only from these verified attributes, never from anything
 * client-supplied.
 *
 * Idempotent and non-destructive. The write is a plain `Put` of exactly the
 * profile item's keys; a re-confirmation (or a Cognito retry) simply rewrites the
 * same item with the same values. A Cognito trigger MUST return the event so the
 * sign-up flow proceeds, so any failure is logged (through the redacting
 * `logError`, so a caught error can never leak a token or credential — R11.4)
 * and swallowed — a missing profile degrades to the leaderboard's "Unknown
 * Player" fallback rather than blocking the Player from ever confirming their
 * account.
 *
 * Least privilege (R11): the function is granted only `dynamodb:PutItem` on the
 * single table, nothing more (see the `ServiceApi` construct).
 *
 * This entry is bundled standalone by esbuild (CDK `NodejsFunction`), so it may
 * import the AWS SDK directly; it is not part of the pure core or the handler
 * hexagon, but it reuses the shared key encoders so its item shape can never
 * drift from what the leaderboard adapter reads.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

import {
  PARTITION_KEY,
  PROFILE_SORT_KEY,
  SORT_KEY,
  accountPartitionKey,
} from "../edges/dynamoSchema";
import { annotateAccountId, captureAwsClient } from "../edges/xray";
import { logError } from "../logging/redact";

/** The environment variable carrying the single-table name (set by `ServiceApi`). */
const TABLE_NAME_ENV = "MAZE_TABLE_NAME";

/** The verified Cognito attribute holding the account id. */
const SUB_ATTRIBUTE = "sub";

/** The verified Cognito attribute holding the Player-chosen display name. */
const DISPLAY_NAME_ATTRIBUTE = "name";

/**
 * Shown for an account whose sign-up carried no display name, mirroring the
 * leaderboard adapter's own fallback so the two never disagree. Never the
 * private identifier (R11.3).
 */
const UNKNOWN_DISPLAY_NAME = "Unknown Player";

/**
 * The slice of the Cognito PostConfirmation event this trigger reads. Transcribed
 * as a narrow local type (rather than pulling in `@types/aws-lambda`) so nothing
 * provider-specific is needed to type it; the runtime event is a superset. A
 * trigger must return the event unchanged for the flow to continue.
 */
interface PostConfirmationEvent {
  readonly request?: {
    readonly userAttributes?: Readonly<Record<string, string | undefined>>;
  };
}

/** Read a process env var via `globalThis` without pulling in `@types/node`. */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[name];
}

/**
 * The marshalling client, constructed once per container. The base client is
 * wrapped by {@link captureAwsClient} so under active X-Ray tracing its
 * `PutItem` call surfaces as a subsegment (task 9.1); outside a traced Lambda the
 * wrap is a no-op, so this standalone trigger stays test- and daemon-neutral.
 */
const docClient = DynamoDBDocumentClient.from(captureAwsClient(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function handler(
  event: PostConfirmationEvent,
): Promise<PostConfirmationEvent> {
  const attributes = event.request?.userAttributes ?? {};
  const accountId = attributes[SUB_ATTRIBUTE];

  // Without a verified `sub` there is no account to key a profile to; return the
  // event so the sign-up still completes (the leaderboard falls back gracefully).
  if (accountId === undefined || accountId.length === 0) {
    return event;
  }

  // Filterable-by-account tracing (R11.4): annotate the trace with the account
  // id only — never the display name, an email, or any token. No-ops when tracing
  // is inactive.
  annotateAccountId(accountId);

  const displayName = attributes[DISPLAY_NAME_ATTRIBUTE] ?? UNKNOWN_DISPLAY_NAME;
  const tableName = readEnv(TABLE_NAME_ENV);

  if (tableName !== undefined && tableName.length > 0) {
    try {
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            [PARTITION_KEY]: accountPartitionKey(accountId),
            [SORT_KEY]: PROFILE_SORT_KEY,
            accountId,
            displayName,
          },
        }),
      );
    } catch (error) {
      // A trigger must not break the sign-up flow. Log and continue; a missing
      // profile degrades to the leaderboard's "Unknown Player" fallback. Route
      // through `logError` so the caught error's message/stack — which could
      // embed a token or credential — is redacted before it reaches the log
      // (R11.4), never `console.error` directly.
      logError("failed to write PROFILE item on PostConfirmation", error);
    }
  }

  return event;
}
