/**
 * Orchestrator tests were removed when migrating to AWS Lambda Durable Functions.
 *
 * The previous tests mocked LambdaClient.InvokeCommand directly, but the durable
 * SDK's ctx.invoke() routes through the durable execution API — not LambdaClient —
 * so those mocks no longer intercept anything.
 *
 * Orchestrator integration tests should be written using LocalDurableTestRunner
 * from @aws/durable-execution-sdk-js-testing, which simulates the full durable
 * execution checkpoint/replay lifecycle locally.
 *
 * See: https://docs.aws.amazon.com/durable-execution/getting-started/testing/
 */
