import { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE = process.env.USER_APPROVALS_TABLE!

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const status = event.queryStringParameters?.['status']

  const items = status
    ? (
        await ddb.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: 'status-registeredAt-index',
            KeyConditionExpression: '#s = :status',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':status': status },
            ScanIndexForward: false,
          }),
        )
      ).Items ?? []
    : (await ddb.send(new ScanCommand({ TableName: TABLE }))).Items ?? []

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: items }),
  }
}
