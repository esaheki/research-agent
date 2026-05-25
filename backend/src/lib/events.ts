import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

export async function emitEvent(
  ddb: DynamoDBDocumentClient,
  eventsTable: string,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const eventId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60

  await ddb.send(
    new PutCommand({
      TableName: eventsTable,
      Item: { sessionId, eventId, type, payload, timestamp: new Date().toISOString(), ttl },
    }),
  )
}
