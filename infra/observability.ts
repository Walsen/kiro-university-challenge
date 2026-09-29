import { ArnFormat, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as synthetics from "aws-cdk-lib/aws-synthetics";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Construct } from "constructs";

/**
 * The directory holding the canary handler scripts, resolved relative to this construct so
 * `cdk synth`/`deploy` packages the assets regardless of the working directory.
 */
const CANARIES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "canaries");

/**
 * Canary schedules (D8). **Adjustable defaults**, named here rather than inlined so the
 * cadence/cost trade-off is a one-line change: 5-minute read-only availability + latency
 * probe, 30-minute full-flow walking-skeleton probe.
 */
const READONLY_SCHEDULE = Duration.minutes(5);
const FULLFLOW_SCHEDULE = Duration.minutes(30);

/**
 * The Synthetics runtime for both canaries. Pinned to a specific
 * `SYNTHETICS_NODEJS_PUPPETEER` version (not "latest") so a runtime bump is a deliberate,
 * reviewable change and the packaged scripts are validated against a known runtime. The
 * runtime provides `Synthetics`/`SyntheticsLogger` and the AWS SDK v3 ambiently.
 */
const CANARY_RUNTIME = synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_9_1;

/**
 * How long the read-only canary's single HTTP round-trip may take end to end before the
 * run is treated as failed. Generous relative to the 300 ms leaderboard budget the alarm
 * evaluates — the timeout guards against a hang, the alarm evaluates the budget.
 */
const READONLY_TIMEOUT = Duration.seconds(30);

/** The full-flow canary does several authenticated round-trips + SRP sign-in; allow more. */
const FULLFLOW_TIMEOUT = Duration.seconds(60);

/** Retain canary run artifacts only briefly — enough to investigate a failure, not to accrue cost (D8). */
const ARTIFACTS_EXPIRY = Duration.days(14);

/**
 * The adopted budget defaults (design "Observability", R6.4/R6.5/R7.2):
 *  - leaderboard top-50 **p95 < 300 ms**;
 *  - leaderboard **freshness < 2 s** (a qualifying score appears in the next read).
 * Named constants so the budget the alarms evaluate is stated once.
 */
const LEADERBOARD_P95_BUDGET_MS = 300;
const LEADERBOARD_FRESHNESS_BUDGET_SECONDS = 2;

/**
 * Availability alarm threshold: the canary's `SuccessPercent` (percent of runs that passed)
 * must stay at/above this. Below it, the probed path is unavailable.
 */
const AVAILABILITY_MIN_SUCCESS_PERCENT = 90;

export interface SyntheticsMonitoringProps {
  /** Base HTTPS URL of the shared HTTP API the canaries probe. */
  readonly apiBaseUrl: string;
  /** The public leaderboard route ("/leaderboard"). */
  readonly leaderboardPath: string;
  /** The health route ("/health") — JWT-protected, probed for a tokenless 401 liveness. */
  readonly healthPath: string;
  /** The shared Cognito user pool id (full-flow canary sign-in). */
  readonly userPoolId: string;
  /** The SPA app client id — a public client, no secret (full-flow canary sign-in). */
  readonly userPoolClientId: string;
  /**
   * The username (email) of the reserved synthetic account the full-flow canary signs in
   * as. Not a secret; the password is sourced from SSM at runtime (see below).
   */
  readonly syntheticUsername: string;
  /**
   * The **name** of an existing SSM Parameter Store SecureString holding the reserved
   * synthetic account's password. The full-flow canary reads it at runtime with
   * `ssm:GetParameter` — the value is provisioned out of band, never committed and never a
   * plaintext canary env var (R11.4). The parameter is referenced (not created) here so no
   * secret material lives in the template.
   */
  readonly syntheticCredentialParameterName: string;
}

/**
 * CloudWatch Synthetics canaries + alarms for the shared backend (task 9.2, D8), the
 * "canary model 1.C" the design's Observability section describes.
 *
 * This is an **edge/monitoring** construct: it probes the deployed API from the outside
 * and never imports or changes the pure `src/core`. Two canaries and the alarms over their
 * budgets:
 *
 *  - **Read-only canary** (`rate(5 min)`) — unauthenticated, holds no credentials. Probes
 *    the public `GET /leaderboard` (200 + well-formed body: the primary availability and
 *    p95-latency signal) and `GET /health` (tokenless 401 liveness). Its `Duration` metric
 *    is the leaderboard latency the p95 alarm evaluates; its `SuccessPercent` is the
 *    availability signal.
 *  - **Full-flow canary** (`rate(30 min)`) — walks sign in → submit a validated score →
 *    read back → leaderboard → self-clean (`DELETE /account/me`, task 12.2), as a reserved
 *    synthetic account whose password is sourced from SSM at runtime.
 *
 * **Alarms (R6.4/R6.5/R7.2).** Availability alarms on each canary's `SuccessPercent`; a
 * leaderboard **p95 < 300 ms** alarm on the read-only canary's p95 `Duration`; and a
 * **freshness < 2 s** alarm on the full-flow canary's duration (the full-flow run submits a
 * score and immediately reads it back, so its success within the freshness window is the
 * freshness signal). No SNS action is wired yet — the alarms exist and evaluate the budget;
 * wiring a notification target is a later, optional step.
 *
 * **Least privilege (R11).** Each canary gets its own execution role with only what
 * Synthetics needs — write to its own artifacts-bucket prefix, `cloudwatch:PutMetricData`
 * (scoped to the `CloudWatchSynthetics` namespace), and its own log group — via the managed
 * `CloudWatchSyntheticsExecutionRolePolicy`-equivalent grants CDK attaches, plus, for the
 * full-flow canary only, read on the one SSM credential parameter. Neither role gets a
 * wildcard-admin or `*:*` grant.
 *
 * **Cost.** The artifacts bucket has a 14-day lifecycle expiry so canary run artifacts do
 * not accrue storage cost; the schedules are adjustable named defaults.
 */
export class SyntheticsMonitoring extends Construct {
  /** The read-only availability + latency canary (5-min). */
  public readonly readonlyCanary: synthetics.Canary;

  /** The full-flow walking-skeleton canary (30-min). */
  public readonly fullFlowCanary: synthetics.Canary;

  /** The S3 bucket holding canary run artifacts (screenshots, HAR, logs), with expiry. */
  public readonly artifactsBucket: s3.Bucket;

  /** All alarms this construct creates (availability + latency/freshness budgets). */
  public readonly alarms: readonly cloudwatch.Alarm[];

  public constructor(scope: Construct, id: string, props: SyntheticsMonitoringProps) {
    super(scope, id);

    // One artifacts bucket for both canaries, with a lifecycle expiry so run artifacts are
    // kept only long enough to investigate a failure (D8 cost note). Block public access
    // and enforce TLS — the artifacts can contain response bodies, so treat them as
    // non-public (R11).
    this.artifactsBucket = new s3.Bucket(this, "CanaryArtifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: ARTIFACTS_EXPIRY }],
      // Artifacts are disposable monitoring output, so the bucket is safe to remove with
      // the stack (and auto-empty) rather than retained.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const leaderboardQuery = defaultLeaderboardQuery();

    // --- Read-only canary: public leaderboard + tokenless health liveness ---------------
    // Its own least-privilege role: CDK attaches the standard Synthetics execution grants
    // (artifacts prefix write, scoped PutMetricData, own log group) to a role we own, so it
    // is auditable and carries nothing broader. No SSM/Cognito access — it never signs in.
    const readonlyRole = this.makeCanaryRole("ReadonlyCanaryRole", "readonly");
    this.readonlyCanary = new synthetics.Canary(this, "ReadonlyCanary", {
      canaryName: "maze-platform-readonly",
      runtime: CANARY_RUNTIME,
      role: readonlyRole,
      schedule: synthetics.Schedule.rate(READONLY_SCHEDULE),
      timeout: READONLY_TIMEOUT,
      // Trace the canary's own HTTP requests with X-Ray so a probe correlates with the
      // backend API→Lambda→DynamoDB trace it triggers (task 9.3). Supported on the pinned
      // nodejs-puppeteer runtime.
      activeTracing: true,
      artifactsBucketLocation: {
        bucket: this.artifactsBucket as s3.IBucket,
        prefix: "readonly",
      },
      artifactsBucketLifecycleRules: [{ expiration: ARTIFACTS_EXPIRY }],
      startAfterCreation: true,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(path.join(CANARIES_DIR, "readonly")),
        handler: "readonly-canary.handler",
      }),
      environmentVariables: {
        MAZE_API_BASE_URL: props.apiBaseUrl,
        MAZE_LEADERBOARD_PATH: props.leaderboardPath,
        MAZE_HEALTH_PATH: props.healthPath,
        MAZE_LEADERBOARD_QUERY: leaderboardQuery,
      },
    });

    // --- Full-flow canary: auth → submit → read back → leaderboard → self-clean ---------
    // Its own role, with the same Synthetics baseline PLUS read on exactly one SSM
    // parameter (the synthetic account's password). Referenced by name (SecureString), so
    // no secret material is created in the template; the value is provisioned out of band.
    const credentialParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "SyntheticCredentialParam",
      { parameterName: props.syntheticCredentialParameterName },
    );

    const fullFlowRole = this.makeCanaryRole("FullFlowCanaryRole", "fullflow");
    // Least privilege: read on the one credential parameter only — not `ssm:*`, not all
    // parameters. `grantRead` scopes the resource to this parameter's ARN.
    credentialParam.grantRead(fullFlowRole);

    this.fullFlowCanary = new synthetics.Canary(this, "FullFlowCanary", {
      canaryName: "maze-platform-fullflow",
      runtime: CANARY_RUNTIME,
      role: fullFlowRole,
      schedule: synthetics.Schedule.rate(FULLFLOW_SCHEDULE),
      timeout: FULLFLOW_TIMEOUT,
      // Trace the full authenticated flow with X-Ray so the canary's submit/read requests
      // correlate with the backend seam trace (task 9.3).
      activeTracing: true,
      artifactsBucketLocation: {
        bucket: this.artifactsBucket as s3.IBucket,
        prefix: "fullflow",
      },
      artifactsBucketLifecycleRules: [{ expiration: ARTIFACTS_EXPIRY }],
      startAfterCreation: true,
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(path.join(CANARIES_DIR, "fullflow")),
        handler: "fullflow-canary.handler",
      }),
      environmentVariables: {
        MAZE_API_BASE_URL: props.apiBaseUrl,
        MAZE_COGNITO_USER_POOL_ID: props.userPoolId,
        MAZE_COGNITO_CLIENT_ID: props.userPoolClientId,
        MAZE_SYNTHETIC_USERNAME: props.syntheticUsername,
        // The parameter NAME (not its value): the canary fetches the secret at runtime.
        MAZE_SYNTHETIC_CREDENTIAL_PARAM: props.syntheticCredentialParameterName,
        MAZE_CANARY_SEED: String(defaultCanarySeed()),
      },
    });

    this.alarms = this.createAlarms();
  }

  /**
   * Build one least-privilege canary execution role. Synthetics requires the role to be
   * assumable by `lambda.amazonaws.com` (canaries run as Lambda) and to hold the standard
   * execution grants.
   *
   * **Why we attach the grants explicitly.** When a custom `role` is passed to the L2
   * `Canary`, CDK does *not* attach its default execution policy — that only happens when
   * the L2 synthesizes its own role (`this.role = props.role ?? this.createDefaultRole()`).
   * Owning the role here keeps the permission set explicit and auditable, but it means the
   * baseline grants a canary needs to write artifacts, emit metrics, and create its log
   * group are ours to attach. We mirror exactly the scoped statements the L2's
   * `createDefaultRole` would have produced (no wildcard admin, metrics scoped to the
   * `CloudWatchSynthetics` namespace, logs scoped to the `cwsyn-*` engine log groups, S3
   * writes scoped to this canary's artifacts prefix), plus the X-Ray write actions that
   * `activeTracing: true` requires.
   *
   * @param id logical construct id for the role
   * @param artifactsPrefix the canary's own prefix in the shared artifacts bucket; S3
   *   `PutObject` is scoped to this prefix only.
   */
  private makeCanaryRole(id: string, artifactsPrefix: string): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Least-privilege execution role for a Maze Game Platform Synthetics canary.",
    });

    // The Synthetics library resolves the artifacts bucket's region before uploading.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListAllMyBuckets"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketLocation"],
        resources: [this.artifactsBucket.bucketArn],
      }),
    );
    // Write run artifacts (logs, HAR, screenshots) only under this canary's own prefix.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [this.artifactsBucket.arnForObjects(`${artifactsPrefix}/*`)],
      }),
    );
    // Emit the CloudWatchSynthetics run metrics (Duration, SuccessPercent, …) — scoped to
    // that namespace so the grant cannot publish arbitrary metrics.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "CloudWatchSynthetics" },
        },
      }),
    );
    // Create and write the engine Lambda's own log group (named `cwsyn-*`). Without this
    // no log group ever forms and the run fails before the Synthetics library reports.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          Stack.of(this).formatArn({
            service: "logs",
            resource: "log-group",
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            resourceName: "/aws/lambda/cwsyn-*",
          }),
        ],
      }),
    );
    // X-Ray write actions required by `activeTracing: true` so the canary's requests are
    // traced (task 9.3). These are the same actions the managed AWSXRayDaemonWriteAccess
    // policy grants; both are resource-wildcard by design for the X-Ray write path.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
        resources: ["*"],
      }),
    );

    return role;
  }

  /**
   * Create the CloudWatch alarms over the canaries' availability and the leaderboard
   * latency/freshness budgets. No SNS action is attached — the alarms exist and evaluate
   * the budget; wiring a notification target is an optional later step.
   */
  private createAlarms(): cloudwatch.Alarm[] {
    // Availability: each canary's SuccessPercent must stay at/above the floor. A dip means
    // the probed path (public read, or the full authenticated flow) is failing.
    const readonlyAvailability = new cloudwatch.Alarm(this, "ReadonlyAvailabilityAlarm", {
      alarmName: "maze-platform-readonly-availability",
      alarmDescription:
        "Read-only canary success percent below floor: public leaderboard/health unavailable (R6.4).",
      metric: this.readonlyCanary.metricSuccessPercent({ period: Duration.minutes(5) }),
      threshold: AVAILABILITY_MIN_SUCCESS_PERCENT,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    const fullFlowAvailability = new cloudwatch.Alarm(this, "FullFlowAvailabilityAlarm", {
      alarmName: "maze-platform-fullflow-availability",
      alarmDescription:
        "Full-flow canary success percent below floor: the authenticated walking-skeleton path is failing (R7.2).",
      metric: this.fullFlowCanary.metricSuccessPercent({ period: Duration.minutes(30) }),
      threshold: AVAILABILITY_MIN_SUCCESS_PERCENT,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // Leaderboard latency: the read-only canary's p95 run duration is the public
    // leaderboard read latency. Alarm when p95 exceeds the 300 ms budget (R6.4).
    const leaderboardLatency = new cloudwatch.Alarm(this, "LeaderboardP95LatencyAlarm", {
      alarmName: "maze-platform-leaderboard-p95-latency",
      alarmDescription: `Leaderboard read p95 above the ${LEADERBOARD_P95_BUDGET_MS} ms budget (R6.4).`,
      metric: this.readonlyCanary.metricDuration({
        period: Duration.minutes(5),
        statistic: cloudwatch.Stats.percentile(95),
      }),
      threshold: LEADERBOARD_P95_BUDGET_MS,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Freshness: the full-flow canary submits a score and immediately reads it back and
    // sees it on the leaderboard within one run; if the write is not visible within the
    // < 2 s freshness budget the read-back/leaderboard steps fail (dropping SuccessPercent)
    // — and a run whose duration stalls well past the freshness budget is the freshness
    // signal (R6.5). Alarm when the full-flow run's p95 duration exceeds the budget.
    const freshness = new cloudwatch.Alarm(this, "LeaderboardFreshnessAlarm", {
      alarmName: "maze-platform-leaderboard-freshness",
      alarmDescription: `Full-flow submit→read-back exceeds the ${LEADERBOARD_FRESHNESS_BUDGET_SECONDS}s freshness budget (R6.5).`,
      metric: this.fullFlowCanary.metricDuration({
        period: Duration.minutes(30),
        statistic: cloudwatch.Stats.percentile(95),
      }),
      // metricDuration is emitted in milliseconds; the budget is in seconds.
      threshold: LEADERBOARD_FRESHNESS_BUDGET_SECONDS * 1000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    return [readonlyAvailability, fullFlowAvailability, leaderboardLatency, freshness];
  }
}

/**
 * A known, well-formed leaderboard scope query string for the read-only canary. Small maze
 * params so the read is cheap; the scope need not have entries — a 200 with an empty
 * `standings: []` is still a healthy availability signal.
 */
function defaultLeaderboardQuery(): string {
  return "?rows=7&columns=7&seed=424242&timeLimitSeconds=60";
}

/** The fixed, known-solvable seed the full-flow canary rebuilds its maze from. */
function defaultCanarySeed(): number {
  return 424242;
}
