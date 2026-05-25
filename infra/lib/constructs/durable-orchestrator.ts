import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import { Construct } from 'constructs'

function camelToEnvKey(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toUpperCase()
}

export interface DurableOrchestratorProps {
  /** Path to the orchestrator Lambda entry point */
  entry: string
  /** Activity Lambdas keyed by camelCase activity name */
  activities: Record<string, lambda.IFunction>
  /** Additional environment variables (besides the auto-generated ACTIVITY_* vars) */
  environment?: Record<string, string>
  timeout?: cdk.Duration
  memorySize?: number
  bundling?: nodejs.BundlingOptions
}

/**
 * CDK construct that wires a durable orchestrator Lambda to its activity Lambdas.
 *
 * Activity function names are injected as env vars using the convention
 * `ACTIVITY_<UPPER_SNAKE_CASE>`. The orchestrator is granted InvokeFunction
 * permission on every activity.
 */
export class DurableOrchestrator extends Construct {
  public readonly handler: nodejs.NodejsFunction

  constructor(scope: Construct, id: string, props: DurableOrchestratorProps) {
    super(scope, id)

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
      bundling: props.bundling ?? { minify: true, sourceMap: false },
      timeout: props.timeout ?? cdk.Duration.minutes(12),
      memorySize: props.memorySize ?? 512,
      environment: { ...props.environment, ...activityEnv },
    })

    for (const fn of Object.values(props.activities)) {
      fn.grantInvoke(this.handler)
    }
  }
}
