/**
 * The narrow DynamoDB seam the persistence adapters depend on (tasks 6.3/6.4).
 *
 * The two adapters build AWS SDK v3 command objects (`PutCommand`,
 * `UpdateCommand`, `GetCommand`, `QueryCommand` from `@aws-sdk/lib-dynamodb`)
 * and hand them to a client with a single `send` method. `DynamoDBDocumentClient`
 * from the SDK satisfies this shape in production; a hand fake satisfies it in
 * tests, so the adapters are unit-testable without a network (mirroring the
 * `CognitoClient` seam on the client side). Isolating the seam in its own module
 * also keeps the "how we talk to DynamoDB" concern in one place and lets the
 * composition root (task 7) construct the real client once and inject it.
 *
 * Nothing outside `src/server/edges` imports this module, so no AWS SDK type
 * leaks past the edges layer (hexagonal Dependency Rule).
 */
import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { captureAwsClient } from "./xray";

/**
 * A command sent to DynamoDB. The adapters only ever construct SDK command
 * objects, but the seam treats a command opaquely — it carries an `input`
 * payload and is identified by its constructor name — so a test fake can match
 * on the command type without depending on the concrete SDK classes.
 */
export interface DynamoCommand {
  readonly input: unknown;
}

/**
 * The minimal `send` surface of a DynamoDB DocumentClient. Deliberately as small
 * as the adapters need (Interface Segregation): send a command, await a result.
 * The result is `unknown` at the seam; each adapter narrows the response it
 * expects for the command it sent.
 */
export interface DynamoDocumentClient {
  send(command: DynamoCommand): Promise<unknown>;
}

/**
 * Construct the real marshalling DocumentClient over a base DynamoDB client.
 *
 * `removeUndefinedValues` keeps optional attributes from being written as
 * explicit nulls, so an absent field is simply absent in the item. Used by the
 * composition root (task 7); tests inject a fake and never call this.
 *
 * The base client is passed through {@link captureAwsClient} before the document
 * client is built over it, so under active X-Ray tracing every DynamoDB call the
 * adapters issue surfaces as a subsegment of the function's trace (task 9.1). The
 * wrapping is guarded: outside a traced Lambda it returns the base client
 * unchanged, so this factory needs no X-Ray daemon and stays test-neutral. The
 * returned {@link DynamoDocumentClient} type is unchanged either way, so the
 * adapters and their tests are unaffected.
 */
export function createDynamoDocumentClient(
  config: DynamoDBClientConfig = {},
): DynamoDocumentClient {
  const base = captureAwsClient(new DynamoDBClient(config));
  const doc = DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return doc;
}
