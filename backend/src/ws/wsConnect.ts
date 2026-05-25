import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!
const SESSIONS_TABLE = process.env.SESSIONS_TABLE!
const EVENTS_TABLE = process.env.EVENTS_TABLE!

interface WsConnectEvent {
  requestContext: { connectionId: string }
  queryStringParameters?: Record<string, string>
}

function parseJwtSub(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()) as {
      sub?: string
    }
    return payload.sub
  } catch {
    return undefined
  }
}

export const handler = async (event: WsConnectEvent): Promise<{ statusCode: number }> => {
  const token = event.queryStringParameters?.['token']
  if (!token) {
    return { statusCode: 401 }
  }

  const userId = parseJwtSub(token)
  if (!userId) {
    return { statusCode: 401 }
  }

  const sessionId = event.queryStringParameters?.['sessionId']
  if (!sessionId) {
    return { statusCode: 400 }
  }

  const connectionId = event.requestContext.connectionId
  const connectedAt = new Date().toISOString()
  const ttl = Math.floor(Date.now() / 1000) + 2 * 60 * 60

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: { connectionId, sessionId, userId, connectedAt, ttl },
    }),
  )

  await ddb.send(
    new UpdateCommand({
      TableName: SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET connectionId = :cid',
      ExpressionAttributeValues: { ':cid': connectionId },
    }),
  )

  const eventsResult = await ddb.send(
    new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': sessionId },
      ScanIndexForward: true,
    }),
  )

  const wsApiEndpoint = process.env.WEBSOCKET_API_ENDPOINT
  const items = eventsResult.Items ?? []
  if (items.length > 0 && wsApiEndpoint) {
    const api = new ApiGatewayManagementApiClient({ endpoint: wsApiEndpoint })
    for (const item of items) {
      const eventData = {
        type: item['type'],
        payload: item['payload'],
        timestamp: item['timestamp'],
        eventId: item['eventId'],
      }
      try {
        await api.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(eventData),
          }),
        )
      } catch (err) {
        if (err instanceof GoneException) break
      }
    }
  }

  return { statusCode: 200 }
}
