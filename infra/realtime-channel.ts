import * as appsync from "aws-cdk-lib/aws-appsync";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type { IGrantable } from "aws-cdk-lib/aws-iam";
import type { Grant } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

/**
 * The AppSync Events `onPublish` event handler for the `sessions` namespace, in
 * AppSync's JavaScript runtime (APPSYNC_JS). It runs **after** AppSync has
 * authorized the publish, on every event published to `sessions/<sessionId>`,
 * and it owns both legs of the real-time transport (design "Real-time transport
 * (R9)"). Because the server's authoritative diff is published to the **same**
 * channel (via IAM), this one handler sees **two** kinds of publish and must
 * branch on the publisher's principal — the defect the 17.3 seam test surfaced
 * was a handler that treated every publish as a client intent, so it swallowed
 * the server's own diff and needlessly re-invoked the Lambda.
 *
 * The branch keys off `ctx.identity`, whose shape AppSync fixes per auth mode
 * (see the Event API context reference): a Cognito (`USER_POOL`) publish carries
 * `sub` + `claims`; an IAM (`AWS_IAM`) publish does not (it carries `accountId` /
 * `userArn` / `cognitoIdentityAuthType`, or no identity at all). Presence of a
 * Cognito `sub` therefore distinguishes an inbound client intent from the
 * server's own outbound diff.
 *
 * **Client publish (Cognito `USER_POOL` — an intended join/move).** Server
 * authority is preserved by construction (R9.2/R9.3):
 *  - `request` forwards the published event to the Session Lambda data source
 *    together with `ctx.identity` — the **validated** Cognito identity AppSync
 *    attached when it authorized the connection (`sub` + `claims`), never a
 *    client-supplied field. The Lambda derives the acting account from that
 *    identity and resolves the intent against authoritative DynamoDB state via
 *    the pure core, so a client can only ever act as its own Participant.
 *  - `response` returns an **empty** broadcast list, so the raw, unvalidated
 *    client intent is **never** fanned out to subscribers. The authoritative
 *    diff reaches subscribers only because the Session Lambda publishes it
 *    itself as the IAM principal (a separate, server-authenticated publish).
 *
 * **Server publish (`AWS_IAM` — the authoritative diff).** The handler must let
 * this through untouched: it calls `runtime.earlyReturn(ctx.events)`, which
 * broadcasts the events unchanged **and skips both the Lambda invocation and the
 * `response` function**. So the server's diff reaches subscribers, and the
 * server's own publish does not re-enter the Lambda (no needless re-invoke, no
 * feedback loop).
 *
 * The handler is intentionally tiny and rule-free (it holds no game logic — that
 * lives in `src/core`, invoked by the Lambda); it is only the transport glue
 * that routes an authorized client publish to the server without echoing the
 * intent, while passing the server's authoritative diff straight through to
 * subscribers.
 */
const ON_PUBLISH_HANDLER_CODE = `
export const onPublish = {
  request(ctx) {
    // Branch on the publisher's principal. A Cognito USER_POOL publish carries a
    // 'sub' (+ 'claims'); an AWS_IAM publish (the server's own authoritative
    // diff) does not. Only a client intent is routed to the Lambda.
    const identity = ctx.identity;
    const isCognitoClient = identity != null && identity.sub != null;

    if (!isCognitoClient) {
      // Server (IAM) publish: broadcast the authoritative diff unchanged and
      // skip the data source entirely — earlyReturn bypasses the Lambda invoke
      // and the response function, so the server's diff reaches subscribers and
      // never re-enters this handler as a fresh invocation.
      return runtime.earlyReturn(ctx.events);
    }

    // Client (Cognito) publish: invoke the Session Lambda with the client's
    // *intended* events plus the AppSync-validated caller identity. Identity is
    // authoritative; payload is untrusted intent the Lambda resolves against
    // server-held state.
    return {
      operation: "Invoke",
      payload: {
        identity: ctx.identity,
        channel: ctx.info.channel.path,
        events: ctx.events,
      },
    };
  },
  response() {
    // Only reached for a client (Cognito) publish — the server (IAM) path
    // earlyReturns and never runs response. Do not echo the client intent to
    // subscribers; the server fans out the authoritative diff itself via IAM,
    // so nothing is broadcast from here.
    return [];
  },
};
`;

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
 *  - **Clients publish only an *intended* move** on the `sessions` namespace, also with
 *    their Cognito JWT. That publish is not authoritative: it triggers the namespace's
 *    `onPublish` handler, which forwards the event — with the AppSync-**validated**
 *    identity — to the Session Lambda; the Lambda resolves it against authoritative state
 *    and the handler broadcasts nothing (see {@link attachSessionHandler}). A client thus
 *    cannot fabricate state or act as another Participant (R9.2/R9.3, R11.2).
 *  - **The server publishes authoritative diffs with IAM** (`AWS_IAM`) — the Session
 *    Lambda's execution role is granted publish (task 16.4 wires the Lambda;
 *    {@link grantPublish} exposes the grant), so authoritative updates that reach
 *    subscribers originate only from the server principal.
 *
 * **One namespace for all sessions.** A single `sessions` channel namespace carries every
 * shared session; an individual session uses the channel `/sessions/<sessionId>`. Adding a
 * second real-time concern later is a new namespace rather than a new API (Open/Closed).
 *
 * This construct defines only the transport and the `onPublish` glue that routes an
 * authorized client publish to the server. The `SessionChannel` port and its
 * `AppSyncEventsChannel` adapter are task 15.2, and the pure game rules the Session Lambda
 * runs live in `src/core` — kept out of this IaC so the pure core and the adapters stay
 * separate from the resource definition (hexagonal boundary; the inline handler here holds
 * transport glue only, no game rules).
 */
export class RealtimeChannel extends Construct {
  /** The AppSync Events API providing the serverless WebSocket pub/sub transport. */
  public readonly api: appsync.EventApi;

  /**
   * The channel namespace all shared sessions publish and subscribe under.
   * Created by {@link attachSessionHandler} once the Session Lambda exists, so
   * the namespace can carry the `onPublish` handler that routes an intended move
   * to the server. Undefined until then.
   */
  public sessionsNamespace?: appsync.ChannelNamespace;

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
        // By default only the server publishes, via its IAM role (R9.2) — any future
        // namespace stays server-only unless it opts in. The `sessions` namespace overrides
        // this to also allow Cognito clients to publish their *intended* move (see
        // {@link attachSessionHandler}); authority is still enforced there because the
        // client publish is only an intent the server resolves.
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        // Clients subscribe with their Cognito JWT; the server may also subscribe via IAM.
        defaultSubscribeAuthModeTypes: [
          appsync.AppSyncAuthorizationType.USER_POOL,
          appsync.AppSyncAuthorizationType.IAM,
        ],
      },
    });

    // The `sessions` namespace is created in `attachSessionHandler` (called by the
    // `SessionApi` construct at the composition root) rather than here, because it must
    // carry an `onPublish` handler backed by the Session Lambda data source — and the
    // Lambda does not exist yet when this transport is provisioned.
  }

  /**
   * Wire the inbound (client→server) leg of the real-time transport to the
   * server-authoritative Session Lambda, creating the `sessions` channel
   * namespace with the `onPublish` handler that routes an intended `join`/`move`
   * to that Lambda (design "Real-time transport (R9)", closing the gap the 17.3
   * seam test surfaced). Called once, by {@link SessionApi} at the composition
   * root, so this transport stays decoupled from the Lambda's own construct
   * (the Lambda depends on the transport, not the reverse).
   *
   * How the leg is wired without weakening server authority:
   *  - A **Lambda data source** is added for the Session `handler`. Adding it
   *    grants AppSync `lambda:InvokeFunction` on that one function only.
   *  - The `sessions` namespace is created with an `onPublish` **CODE** handler
   *    ({@link ON_PUBLISH_HANDLER_CODE}) that **branches on the publisher's
   *    principal**. For a Cognito client intent, `request` invokes that data
   *    source with the client's events **and the AppSync-validated
   *    `ctx.identity`** and `response` returns `[]`, so the raw client intent is
   *    never broadcast; the Session Lambda derives the acting account from the
   *    validated identity (never a client field), resolves the intent against
   *    authoritative state, and publishes the authoritative diff itself via IAM
   *    (R9.2/R9.3). For that server IAM publish — which lands on this same
   *    channel — the handler `earlyReturn`s `ctx.events`, broadcasting the diff
   *    unchanged and skipping the Lambda so the server's publish neither is
   *    swallowed nor re-invokes the Lambda.
   *  - The namespace's publish auth modes are `USER_POOL` **and** `AWS_IAM`
   *    (least privilege, R11.1): Cognito clients may publish only their intended
   *    move on this one namespace so the handler fires — they are **not** granted
   *    IAM — while the server retains IAM publish for the authoritative diff.
   *    Subscribe stays Cognito (+IAM), inherited from the API default.
   *
   * @param handler the Session Lambda (created by {@link SessionApi}).
   * @returns the created `sessions` {@link appsync.ChannelNamespace}.
   */
  public attachSessionHandler(handler: IFunction): appsync.ChannelNamespace {
    if (this.sessionsNamespace !== undefined) {
      throw new Error("attachSessionHandler must be called exactly once");
    }

    // Data source over the Session Lambda. Adding it grants AppSync
    // `lambda:InvokeFunction` on this one function only (least privilege, R11.1).
    const dataSource = this.api.addLambdaDataSource("SessionDataSource", handler);

    // The single namespace shared sessions flow through, now carrying the
    // `onPublish` handler that routes an authorized client publish to the server.
    this.sessionsNamespace = this.api.addChannelNamespace(SESSIONS_NAMESPACE_NAME, {
      channelNamespaceName: SESSIONS_NAMESPACE_NAME,
      code: appsync.Code.fromInline(ON_PUBLISH_HANDLER_CODE),
      // CODE behavior (not `direct`): the handler controls the broadcast, so it can
      // branch on the publisher — suppress the client intent (`response` returns `[]`)
      // while invoking the Lambda, and pass the server's IAM diff straight through
      // (`earlyReturn(ctx.events)`, no invoke). A DIRECT integration would broadcast
      // whatever the Lambda returns and could not make that distinction.
      publishHandlerConfig: { dataSource },
      // Clients (USER_POOL) may publish their intended move so the handler fires; the
      // server keeps IAM publish for the authoritative diff. Scoped to this namespace
      // only (R11.1) — the API default remains IAM-only publish.
      authorizationConfig: {
        publishAuthModeTypes: [
          appsync.AppSyncAuthorizationType.USER_POOL,
          appsync.AppSyncAuthorizationType.IAM,
        ],
        subscribeAuthModeTypes: [
          appsync.AppSyncAuthorizationType.USER_POOL,
          appsync.AppSyncAuthorizationType.IAM,
        ],
      },
    });

    return this.sessionsNamespace;
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
