import { Duration } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { RemovalPolicy } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * The protected route the API exposes as a liveness/auth probe. A request with no or an
 * invalid bearer token is rejected at the authorizer (401) before any Lambda runs; a
 * request carrying a valid Cognito token reaches the handler and gets 200 (R4.3, R5.3).
 */
const HEALTH_ROUTE_PATH = "/health";

/**
 * How long the health handler is allowed to run. It does trivial work, so a short timeout
 * is ample and keeps a stuck invocation from lingering.
 */
const HEALTH_HANDLER_TIMEOUT = Duration.seconds(5);

/**
 * How long the health handler's logs are retained. Long enough to investigate a deploy or
 * auth-wiring problem, short enough that a low-value probe log never accumulates cost.
 */
const HEALTH_LOG_RETENTION = logs.RetentionDays.ONE_WEEK;

/** The API name for the single shared backend (D6, no environment suffix). */
const API_NAME = "maze-game-platform";

/** The health handler's function name for the single shared backend (D6). */
const HEALTH_FUNCTION_NAME = "maze-game-platform-health";

/**
 * The minimal handler behind the protected health route. It runs only once the JWT
 * authorizer has already validated the caller's token, so reaching it at all is the
 * success signal; it just returns 200. Kept inline (no bundling step) so `cdk synth` and
 * the assertion tests need no asset build — the real feature Lambdas (tasks 7.x) bring
 * their own bundled code.
 */
const HEALTH_HANDLER_CODE = `
exports.handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "ok" }),
});
`;

export interface ApiHttpProps {
  /** The Cognito user pool whose issued tokens the JWT authorizer trusts. */
  readonly userPool: cognito.IUserPool;
  /**
   * The Cognito app client the tokens are issued for. The authorizer pins the token
   * audience to this client, so a token minted for a different client is rejected.
   */
  readonly userPoolClient: cognito.IUserPoolClient;
}

/**
 * The API edge for the Maze Game Platform (task 2.2, R2, R4.3, R5.3, R11): an API Gateway
 * **HTTP API** fronting Lambda, with a **JWT authorizer** that validates Cognito-issued
 * tokens before any handler runs.
 *
 * What this construct establishes:
 *
 *  - **HTTPS-only transport (R11.1).** API Gateway HTTP APIs serve only over TLS, so
 *    tokens and personal data are never carried over an unencrypted channel.
 *  - **Edge authentication (R2.1, R2.4, R4.3, R5.3).** The {@link HttpUserPoolAuthorizer}
 *    validates the token's signature, issuer (this user pool), and audience (this app
 *    client) on every protected route. An absent, malformed, or expired token is rejected
 *    with 401 at the edge — the handler is never invoked. A token past its bounded
 *    lifetime (R2.4) fails validation the same way.
 *  - **Per-account identity for authorization (R11.2).** A validated token's claims (the
 *    Cognito `sub`) are passed to the handler in the request context, giving every
 *    downstream Lambda the acting account identity it needs to restrict actions to that
 *    account's own data — without trusting any client-supplied identifier.
 *
 * A single **protected** `GET /health` route exercises the whole edge: it is backed by a
 * minimal Lambda that returns 200, so a 401 there proves the authorizer rejects
 * unauthenticated callers and a 200 proves a valid token reaches the handler. The feature
 * routes (`POST /scores`, `GET /leaderboard`, …) are added by later tasks as new
 * integrations behind this same API and authorizer (Open/Closed).
 */
export class ApiHttp extends Construct {
  /** The HTTP API that fronts the platform's Lambdas. */
  public readonly httpApi: apigwv2.HttpApi;

  /** The JWT authorizer validating Cognito tokens on protected routes. */
  public readonly authorizer: HttpUserPoolAuthorizer;

  /** The minimal Lambda backing the protected health route. */
  public readonly healthHandler: lambda.Function;

  public constructor(scope: Construct, id: string, props: ApiHttpProps) {
    super(scope, id);

    // The authorizer trusts tokens issued by this environment's user pool and pins the
    // audience to the SPA app client, so a token from another pool or client is rejected.
    this.authorizer = new HttpUserPoolAuthorizer("JwtAuthorizer", props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    // A browser SPA needs cross-origin access to the API. Restricting methods/headers here
    // is defence in depth; the authorizer remains the security boundary.
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: API_NAME,
      description:
        "Maze Game Platform shared HTTP API. Cognito JWT authorizer on protected routes.",
      corsPreflight: {
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        allowOrigins: ["*"],
      },
    });

    // Own the handler's log group explicitly (with bounded retention) rather than letting
    // Lambda create an unbounded one on first invocation. Passing it via `logGroup` also
    // avoids the deprecated `logRetention` prop, which provisions an extra custom-resource
    // Lambda just to set retention.
    const healthLogGroup = new logs.LogGroup(this, "HealthHandlerLogs", {
      retention: HEALTH_LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.healthHandler = new lambda.Function(this, "HealthHandler", {
      functionName: HEALTH_FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(HEALTH_HANDLER_CODE),
      timeout: HEALTH_HANDLER_TIMEOUT,
      logGroup: healthLogGroup,
      // X-Ray active tracing (D8): the runtime emits a segment per invocation and CDK
      // wires the managed AWSXRayDaemonWriteAccess policy onto the execution role for us.
      // The SDK v3 client instrumentation that turns DynamoDB/Cognito calls into
      // subsegments is application code in the Lambda composition roots
      // (`src/server/lambda`), not this IaC task.
      tracing: lambda.Tracing.ACTIVE,
      description:
        "Protected health probe for the shared API. Returns 200 only when the JWT authorizer has admitted the caller.",
    });

    // The route is protected: the authorizer runs first, so no/invalid token yields 401
    // and the handler only runs for a validated caller (which then returns 200).
    this.httpApi.addRoutes({
      path: HEALTH_ROUTE_PATH,
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("HealthIntegration", this.healthHandler),
      authorizer: this.authorizer,
    });

    this.enableStageObservability();
  }

  /**
   * Turn on request-level observability for the auto-deployed default stage (D8).
   *
   * API Gateway **HTTP APIs** do not expose per-stage X-Ray *active tracing* the way REST
   * APIs do (that is a REST-only stage property); the distributed trace is produced by the
   * X-Ray-traced Lambdas the API integrates, which carry the incoming trace header through.
   * What the HTTP API stage *does* support, and what makes a seam diagnosable at the edge,
   * is **access logging** — so we enable it here with a structured JSON format that records
   * the request id, route, status, and latency. It carries no credentials, tokens, or PII
   * (R11.4). This is reached via the L1 stage escape hatch because the L2 default stage does
   * not surface access-log settings.
   */
  private enableStageObservability(): void {
    const accessLogGroup = new logs.LogGroup(this, "ApiAccessLogs", {
      retention: HEALTH_LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      // Structured, PII-free access log: request id, route, status, and latency only.
      format: JSON.stringify({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status",
        responseLatency: "$context.responseLatency",
      }),
    };
  }

  /** The base HTTPS URL at which the API is served. */
  public get url(): string {
    // `apiEndpoint` is the execute-api HTTPS endpoint; the default stage is served at its root.
    return this.httpApi.apiEndpoint;
  }
}
