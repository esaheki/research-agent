import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { randomUUID } from 'crypto'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const lambda = new LambdaClient({})

const SESSIONS_TABLE = process.env.SESSIONS_TABLE!
const ORCHESTRATOR_FUNCTION_NAME = process.env.ORCHESTRATOR_FUNCTION_NAME!

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string

  let body: { question?: string }
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'INVALID_JSON' }) }
  }

  const question = body.question?.trim()
  if (!question) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'MISSING_QUESTION' }) }
  }

  const existing = await ddb.send(
    new QueryCommand({
      TableName: SESSIONS_TABLE,
      IndexName: 'userId-startedAt-index',
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: '#status = :running',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':uid': userId, ':running': 'running' },
    }),
  )
  if (existing.Items && existing.Items.length > 0) {
    const runningSession = existing.Items[0]
    return {
      statusCode: 409,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'SESSION_ALREADY_RUNNING', sessionId: runningSession['sessionId'] }),
    }
  }

  const sessionId = randomUUID()
  const startedAt = new Date().toISOString()

  await ddb.send(
    new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: { sessionId, userId, question, status: 'pending', startedAt },
    }),
  )

  await lambda.send(
    new InvokeCommand({
      FunctionName: ORCHESTRATOR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: JSON.stringify({ sessionId, userId, question }),
    }),
  )

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }
}
