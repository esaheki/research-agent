import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import { Construct } from 'constructs'

function camelToEnvKey(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toUpperCase()
}

export interface DurableOrchestratorProps {
  entry: string
  activities: Record<string, lambda.IFunction>
  environment?: Record<string, string>
  /** Total durable execution timeout (default 10 min). Must be >= invocation timeout. */
  executionTimeout?: cdk.Duration
  /** How long checkpoints are retained (default 30 days). */
  retentionPeriod?: cdk.Duration
  memorySize?: number
  bundling?: nodejs.BundlingOptions
}

/**
 * CDK construct that creates a real AWS Lambda Durable Function orchestrator.
 *
 * Adds durableConfig, the AWSLambdaBasicDurableExecutionRolePolicy, a version,
 * and a 'live' alias. Use aliasArn when invoking — durable functions require
 * a qualified ARN (version or alias).
 */
export class DurableOrchestrator extends Construct {
  public readonly handler: nodejs.NodejsFunction
  public readonly alias: lambda.Alias
  public readonly aliasArn: string

  constructor(scope: Construct, id: string, props: DurableOrchestratorProps) {
    super(scope, id)

    const executionTimeout = props.executionTimeout ?? cdk.Duration.minutes(10)

    const activityEnv = Object.fromEntries(
      Object.entries(props.activities).map(([name, fn]) => [
        `ACTIVITY_${camelToEnvKey(name)}`,
        fn.functionName,
      ]),
    )

    this.handler = new nodejs.NodejsFunction(this, 'Handler', {
      entry: props.entry,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: props.bundling ?? {
        minify: true,
        sourceMap: false,
        // The durable SDK's CJS bundle uses `new Function("return import.meta")` to detect
        // ESM context. In the nodejs:22.DurableFunction runtime this returns a truthy object
        // whose `.url` is not a valid string, causing fileURLToPath(undefined) at module load.
        // Injecting a proper import.meta.url polyfill via banner+define prevents the crash.
        banner: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
        define: {
          'import.meta.url': '__importMetaUrl',
        },
      },
      // Single invocation timeout — must be <= executionTimeout. Keep short since the
      // durable runtime suspends between ctx.invoke() calls (no CPU billed while waiting).
      timeout: cdk.Duration.seconds(30),
      memorySize: props.memorySize ?? 512,
      tracing: lambda.Tracing.ACTIVE,
      environment: { ...props.environment, ...activityEnv },
      durableConfig: {
        executionTimeout,
        retentionPeriod: props.retentionPeriod ?? cdk.Duration.days(30),
      },
    })

    // Required: checkpoint read/write permissions
    this.handler.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicDurableExecutionRolePolicy',
      ),
    )

    // Durable functions must be invoked via a qualified ARN (version or alias)
    const version = this.handler.currentVersion
    this.alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: 'live',
      version,
    })
    this.aliasArn = this.alias.functionArn

    for (const fn of Object.values(props.activities)) {
      fn.grantInvoke(this.handler)
    }
  }
}
