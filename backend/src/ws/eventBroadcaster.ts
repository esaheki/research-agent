import { DynamoDBClient, AttributeValue } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi'
import { DynamoDBStreamEvent } from 'aws-lambda'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!
const SESSIONS_TABLE = process.env.SESSIONS_TABLE!
const WS_API_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  if (!WS_API_ENDPOINT) {
    return
  }

  const api = new ApiGatewayManagementApiClient({ endpoint: WS_API_ENDPOINT })

  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue

    const item = unmarshall(
      record.dynamodb.NewImage as Record<string, AttributeValue>,
    )
    const sessionId = item['sessionId'] as string | undefined
    if (!sessionId) continue

    // Find active WebSocket connection for this session via the sessions table.
    // wsConnect (Phase 5) writes connectionId onto the session record.
    const session = await ddb.send(
      new GetCommand({ TableName: SESSIONS_TABLE, Key: { sessionId } }),
    )
    const connectionId = session.Item?.['connectionId'] as string | undefined
    if (!connectionId) continue

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
      if (err instanceof GoneException) {
        await ddb.send(
          new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } }),
        )
      }
    }
  }
}
