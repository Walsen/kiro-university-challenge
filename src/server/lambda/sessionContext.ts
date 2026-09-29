/**
 * The Lambda composition root for the Session service (task 16.4, Phase 2b).
 *
 * The pure Session handler (`makeSessionHandler`) depends only on the
 * {@link SessionRepository} and {@link SessionUpdatePublisher} ports. This module
 * is the single place those ports are bound to their real adapters — the
 * DynamoDB-backed {@link DynamoSessionRepository} over a marshalling
 * DocumentClient, and the {@link AppSyncEventsPublisher} over a real SigV4 HTTP
 * publish client against the AppSync Events endpoint — the composition root the
 * hexagonal design calls for (Dependency Injection). The entry file imports the
 * handler from here and stays a thin shim, so the handler is never coupled to
 * the AWS SDK.
 *
 * Configuration is read once from the environment at module load (cold start),
 * so a misconfiguration fails fast and the adapters are constructed once per
 * container:
 *  - `MAZE_TABLE_NAME` — the single table (shared with the score services).
 *  - `REALTIME_HTTP_DNS` — the AppSync Events HTTP endpoint hostname the server
 *    publishes authoritative updates to.
 *  - `AWS_REGION` — the region the SigV4 signature is scoped to (set by the
 *    Lambda runtime).
 *
 * ## Why the SigV4 publish client lives here
 *
 * Publishing to AppSync Events over HTTP requires SigV4-signing the request with
 * the function's execution-role credentials (the server publishes as the IAM
 * principal, R9.2). Signing and the HTTP call are pure edge concerns, so they
 * are constructed here and injected behind the narrow
 * {@link AppSyncPublisherClient} seam — the adapter and its unit tests never see
 * them. This file is bundled standalone by esbuild (CDK `NodejsFunction`), so it
 * may import the AWS SDK / signing libraries directly; it is not part of the pure
 * core or the handler hexagon.
 */
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";

import { createDynamoDocumentClient } from "../edges/dynamoClient";
import { DynamoSessionRepository } from "../edges/DynamoSessionRepository";
import { AppSyncEventsPublisher } from "../edges/AppSyncEventsPublisher";
import type { AppSyncPublisherClient } from "../edges/appSyncPublisherClient";
import { makeSessionHandler } from "../handlers/session";

/** The env var carrying the single-table name (shared with the score services). */
const TABLE_NAME_ENV = "MAZE_TABLE_NAME";

/** The env var carrying the AppSync Events HTTP endpoint hostname (set by CDK). */
const REALTIME_HTTP_DNS_ENV = "REALTIME_HTTP_DNS";

/** The env var the Lambda runtime sets to the function's region. */
const REGION_ENV = "AWS_REGION";

/** The AppSync Events service name SigV4 signs the publish request for. */
const APPSYNC_SERVICE = "appsync";

/** The Event API path an HTTP publish is POSTed to. */
const PUBLISH_PATH = "/event";

/** Read a process env var via `globalThis` without pulling in `@types/node`. */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env?.[name];
}

/** Read a required env var, failing fast if the function was misconfigured. */
function requireEnv(name: string): string {
  const value = readEnv(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set; the SessionApi construct must inject it`);
  }
  return value;
}

/**
 * The globals the Lambda runtime provides (Node 22 `fetch`), reached through a
 * narrow local type rather than widening the project's ambient globals (mirrors
 * the `readEnv` seam). `fetch` performs the actual HTTPS publish.
 */
interface RuntimeGlobals {
  fetch: (
    input: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/**
 * Build a real {@link AppSyncPublisherClient} that SigV4-signs and POSTs an event
 * to the AppSync Events HTTP endpoint as the function's IAM principal. AppSync
 * Events accepts a publish as `{ channel, events: [ "<json>" ] }` on `/event`,
 * where each event is a JSON string; the update is stringified accordingly.
 */
function buildPublisherClient(httpDns: string, region: string): AppSyncPublisherClient {
  const signer = new SignatureV4({
    service: APPSYNC_SERVICE,
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  const endpoint = `https://${httpDns}${PUBLISH_PATH}`;
  const { fetch } = globalThis as unknown as RuntimeGlobals;

  return {
    async publish(channel, event): Promise<void> {
      const body = JSON.stringify({
        channel,
        events: [JSON.stringify(event)],
      });
      const request: HttpRequest = {
        method: "POST",
        protocol: "https:",
        hostname: httpDns,
        path: PUBLISH_PATH,
        headers: {
          "content-type": "application/json",
          host: httpDns,
        },
        body,
      };
      const signed = await signer.sign(request);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: signed.headers,
        body,
      });
      if (!response.ok) {
        // Surface a publish failure so the caller (and X-Ray) sees a real fault
        // rather than a silently dropped update.
        const detail = await response.text();
        throw new Error(`AppSync publish failed (${response.status}): ${detail}`);
      }
    },
  };
}

/** Build the container-lifetime composition context for the Session handler. */
function buildContext(): {
  readonly handle: (
    command: unknown,
  ) => ReturnType<ReturnType<typeof makeSessionHandler>>;
} {
  const tableName = requireEnv(TABLE_NAME_ENV);
  const httpDns = requireEnv(REALTIME_HTTP_DNS_ENV);
  const region = requireEnv(REGION_ENV);

  const client = createDynamoDocumentClient();
  const repository = new DynamoSessionRepository({ client, tableName });
  const publisher = new AppSyncEventsPublisher(buildPublisherClient(httpDns, region));

  return { handle: makeSessionHandler({ repository, publisher }) };
}

/** The shared, container-lifetime composition context for the Session handler. */
export const sessionContext = buildContext();
