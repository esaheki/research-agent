import * as cdk from 'aws-cdk-lib'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'

export interface ResearchAgentDashboardProps {
  orchestratorFunction: lambda.Function
  synthesizeReportFunction: lambda.Function
  allFunctions: lambda.Function[]
}

const PERIOD = cdk.Duration.minutes(5)

export class ResearchAgentDashboard extends Construct {
  constructor(scope: Construct, id: string, props: ResearchAgentDashboardProps) {
    super(scope, id)

    const { orchestratorFunction, synthesizeReportFunction, allFunctions } = props

    // ── Custom metrics from structured logs ──────────────────────────────────

    const successFilter = new logs.MetricFilter(this, 'SessionSuccessFilter', {
      logGroup: orchestratorFunction.logGroup,
      metricNamespace: 'ResearchAgent',
      metricName: 'SessionComplete',
      filterPattern: logs.FilterPattern.stringValue('$.step', '=', 'orchestrator_complete'),
      metricValue: '1',
      unit: cloudwatch.Unit.COUNT,
    })

    const failedFilter = new logs.MetricFilter(this, 'SessionFailedFilter', {
      logGroup: orchestratorFunction.logGroup,
      metricNamespace: 'ResearchAgent',
      metricName: 'SessionFailed',
      filterPattern: logs.FilterPattern.stringValue('$.step', '=', 'orchestrator_failed'),
      metricValue: '1',
      unit: cloudwatch.Unit.COUNT,
    })

    const durationFilter = new logs.MetricFilter(this, 'OrchestratorDurationFilter', {
      logGroup: orchestratorFunction.logGroup,
      metricNamespace: 'ResearchAgent',
      metricName: 'OrchestratorDurationMs',
      filterPattern: logs.FilterPattern.stringValue('$.step', '=', 'orchestrator_complete'),
      metricValue: '$.durationMs',
      unit: cloudwatch.Unit.MILLISECONDS,
    })

    // Suppress unused variable warnings (filters register themselves via side effects)
    void successFilter
    void failedFilter
    void durationFilter

    const sessionComplete = new cloudwatch.Metric({
      namespace: 'ResearchAgent',
      metricName: 'SessionComplete',
      statistic: 'Sum',
      period: PERIOD,
    })
    const sessionFailed = new cloudwatch.Metric({
      namespace: 'ResearchAgent',
      metricName: 'SessionFailed',
      statistic: 'Sum',
      period: PERIOD,
    })
    const orchestratorDurationP50 = new cloudwatch.Metric({
      namespace: 'ResearchAgent',
      metricName: 'OrchestratorDurationMs',
      statistic: 'p50',
      period: PERIOD,
    })
    const orchestratorDurationP95 = new cloudwatch.Metric({
      namespace: 'ResearchAgent',
      metricName: 'OrchestratorDurationMs',
      statistic: 'p95',
      period: PERIOD,
    })

    // ── Dashboard ────────────────────────────────────────────────────────────

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'ResearchAgentDashboard',
    })

    // Row 1: session-level KPIs
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Completed Sessions (5m)',
        metrics: [sessionComplete],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Failed Sessions (5m)',
        metrics: [sessionFailed],
        width: 6,
        height: 4,
      }),
      new cloudwatch.GraphWidget({
        title: 'Completion vs. Failure Rate',
        left: [sessionComplete],
        right: [sessionFailed],
        width: 12,
        height: 4,
      }),
    )

    // Row 2: research duration
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Orchestrator Duration (p50 / p95)',
        left: [orchestratorDurationP50, orchestratorDurationP95],
        leftYAxis: { label: 'ms', min: 0 },
        width: 12,
        height: 6,
      }),
      // Lambda-native duration for the expensive synthesizeReport function
      new cloudwatch.GraphWidget({
        title: 'SynthesizeReport Lambda Duration (p50 / p95)',
        left: [
          synthesizeReportFunction.metricDuration({ statistic: 'p50', period: PERIOD }),
          synthesizeReportFunction.metricDuration({ statistic: 'p95', period: PERIOD }),
        ],
        width: 12,
        height: 6,
      }),
    )

    // Row 3: error rates per function
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors by Function',
        left: allFunctions.map((fn) =>
          fn.metricErrors({
            period: PERIOD,
            label: fn.functionName,
          }),
        ),
        width: 24,
        height: 6,
      }),
    )

    // Row 4: invocations + throttles overview
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations by Function',
        left: allFunctions.map((fn) =>
          fn.metricInvocations({
            period: PERIOD,
            label: fn.functionName,
          }),
        ),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles by Function',
        left: allFunctions.map((fn) =>
          fn.metricThrottles({
            period: PERIOD,
            label: fn.functionName,
          }),
        ),
        width: 12,
        height: 6,
      }),
    )

    // Row 5: log insights — recent sessions
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Recent Session Activity',
        logGroupNames: [orchestratorFunction.logGroup.logGroupName],
        queryString: [
          'fields @timestamp, sessionId, userId, step, status, durationMs',
          '| filter step in ["orchestrator_start", "orchestrator_complete", "orchestrator_failed"]',
          '| sort @timestamp desc',
          '| limit 50',
        ].join('\n'),
        width: 24,
        height: 8,
      }),
    )
  }
}
