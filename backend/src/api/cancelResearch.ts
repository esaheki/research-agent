import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const SESSIONS_TABLE = process.env.SESSIONS_TABLE!

const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled', 'partial-complete'])

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string
  const sessionId = event.pathParameters?.['sessionId']

  if (!sessionId) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'MISSING_SESSION_ID' }) }
  }

  const result = await ddb.send(new GetCommand({ TableName: SESSIONS_TABLE, Key: { sessionId } }))
  if (!result.Item) {
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'SESSION_NOT_FOUND' }) }
  }

  const session = result.Item
  if (session['userId'] !== userId) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'FORBIDDEN' }) }
  }

  const currentStatus = session['status'] as string
  if (TERMINAL_STATUSES.has(currentStatus)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: currentStatus }),
    }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :cancelled',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':cancelled': 'cancelled' },
    }),
  )

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, status: 'cancelled' }),
  }
}
