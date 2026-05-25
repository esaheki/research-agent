import { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE = process.env.USER_APPROVALS_TABLE!
const VALID_ACTIONS = new Set(['approve', 'reject'])

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = event.pathParameters?.['userId']
  const action = event.pathParameters?.['action']

  if (!userId || !action || !VALID_ACTIONS.has(action)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Path must be /admin/users/{userId}/approve|reject' }),
    }
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected'

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression: 'SET #s = :status, approvedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': newStatus, ':now': new Date().toISOString() },
        ConditionExpression: 'attribute_exists(userId)',
      }),
    )
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) }
    }
    throw err
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, status: newStatus }),
  }
}
