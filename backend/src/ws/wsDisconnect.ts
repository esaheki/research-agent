import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!

export const handler = async (event: { requestContext: { connectionId: string } }): Promise<{ statusCode: number }> => {
  const connectionId = event.requestContext.connectionId

  await ddb.send(
    new DeleteCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId },
    }),
  )

  return { statusCode: 200 }
}
