import * as appsync from "aws-cdk-lib/aws-appsync";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type { IGrantable } from "aws-cdk-lib/aws-iam";
import type { Grant } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * The Event API name. Environment-agnostic (no `-dev`/`-prod`/`-staging` suffix) because
 * there is one shared backend for both Amplify branches (D6), exactly like the table and
 * user pool.
 */
export const REALTIME_API_NAME = "maze-game-platform-realtime";

/**
 * The channel namespace shared sessions publish/subscribe under. A session's channel is
 * addressed as `/${SESSIONS_NAMESPACE_NAME}/<sessionId>`; fixing the name here means the
 * `SessionChannel` adapter (task 15.2) and this IaC name the same namespace without
 * duplicating a literal, the same pattern `DataStore` uses for its index name.
 */
export const SESSIONS_NAMESPACE_NAME = "sessions";

/** Props for {@link RealtimeChannel}. */
export interface RealtimeChannelProps {
  /**
   * The shared Cognito user pool whose JWTs authenticate clients that connect to and
   * subscribe on the realtime API. The same pool the HTTP API's JWT authorizer validates
   * against, so a signed-in player uses one identity across both edges (R11).
   */
  readonly userPool: cognito.IUserPool;
}

/**
 * The real-time transport for shared sessions (task 15.1, R9.1): an **AWS AppSync Events**
 * API — serverless WebSocket pub/sub — plus the channel namespace shared sessions flow
 * through, following the design's "Real-time transport (R9)".
 *
 * **Serverless WebSockets, no servers to run.** AppSync Events provides the managed
 * WebSocket fan-out; there is no connection table, no idle capacity, and it scales with
 * subscribers on its own — the same serverless posture the rest of the backend takes.
 *
 * **Server-authoritative by construction (R9.2, R9.3).** The design makes the server the
 * single source of truth: clients send intended moves and the Session Lambda (task 16)
 * resolves each against authoritative state and publishes the resulting diff. The auth
 * modes encode that split so it is enforced at the transport, not just by convention:
 *
 *  - **Clients connect and subscribe with their Cognito JWT** (`USER_POOL`) — the same pool
 *    the HTTP API uses, so one signed-in identity spans both edges (R11). There is
 *    deliberately **no API-key provider**: an API key is a shared static secret, whereas
 *    every client here already carries a per-user token.
 *  - **The server publishes with IAM** (`AWS_IAM`) — the Session Lambda's execution role is
 *    granted publish (task 16.4 wires the Lambda; {@link grantPublish} exposes the grant),
 *    so authoritative updates originate only from the server principal. Clients are not
 *    granted publish, so they cannot fabricate updates.
 *
 * **One namespace for all sessions.** A single `sessions` channel namespace carries every
 * shared session; an individual session uses the channel `/sessions/<sessionId>`. Adding a
 * second real-time concern later is a new namespace rather than a new API (Open/Closed).
 *
 * This construct defines only the transport. The `SessionChannel` port and its
 * `AppSyncEventsChannel` adapter are task 15.2, and the publishing Session Lambda is task
 * 16 — kept out of this IaC so the pure core and the adapters stay separate from the
 * resource definition (hexagonal boundary).
 */
export class RealtimeChannel extends Construct {
  /** The AppSync Events API providing the serverless WebSocket pub/sub transport. */
  public readonly api: appsync.EventApi;

  /** The channel namespace all shared sessions publish and subscribe under. */
  public readonly sessionsNamespace: appsync.ChannelNamespace;

  public constructor(scope: Construct, id: string, props: RealtimeChannelProps) {
    super(scope, id);

    // Cognito for clients (connect/subscribe), IAM for the server (publish). Both providers
    // are declared so either principal can be an allowed auth mode below.
    const cognitoProvider: appsync.AppSyncAuthProvider = {
      authorizationType: appsync.AppSyncAuthorizationType.USER_POOL,
      cognitoConfig: { userPool: props.userPool },
    };
    const iamProvider: appsync.AppSyncAuthProvider = {
      authorizationType: appsync.AppSyncAuthorizationType.IAM,
    };

    this.api = new appsync.EventApi(this, "EventApi", {
      apiName: REALTIME_API_NAME,
      authorizationConfig: {
        authProviders: [cognitoProvider, iamProvider],
        // Clients connect and subscribe with their Cognito JWT; the server may also use
        // IAM (e.g. to publish a snapshot on the same connection it manages).
        connectionAuthModeTypes: [
          appsync.AppSyncAuthorizationType.USER_POOL,
          appsync.AppSyncAuthorizationType.IAM,
        ],
        // Only the server publishes authoritative updates, via its IAM role (R9.2). Clients
        // are intentionally excluded from publish so they cannot fabricate state.
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        // Clients subscribe with their Cognito JWT; the server may also subscribe via IAM.
        defaultSubscribeAuthModeTypes: [
          appsync.AppSyncAuthorizationType.USER_POOL,
          appsync.AppSyncAuthorizationType.IAM,
        ],
      },
    });

    // The single namespace shared sessions flow through. It inherits the API's default
    // publish/subscribe auth modes (IAM publish, Cognito subscribe), so no per-namespace
    // override is needed.
    this.sessionsNamespace = this.api.addChannelNamespace(SESSIONS_NAMESPACE_NAME, {
      channelNamespaceName: SESSIONS_NAMESPACE_NAME,
    });
  }

  /** The realtime API's HTTP endpoint hostname (used to publish events over HTTP). */
  public get httpDns(): string {
    return this.api.httpDns;
  }

  /** The realtime API's WebSocket endpoint hostname (used by subscribing clients). */
  public get realtimeDns(): string {
    return this.api.realtimeDns;
  }

  /**
   * Grant a principal (the Session Lambda's role, task 16.4) permission to publish
   * authoritative updates to this API. Least privilege (R11.1): publish only — the server
   * fans out state, it does not need to connect or subscribe as a client.
   */
  public grantPublish(grantee: IGrantable): Grant {
    return this.api.grantPublish(grantee);
  }
}
