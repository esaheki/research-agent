import { PreTokenGenerationTriggerHandler } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE = process.env.USER_APPROVALS_TABLE!

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const userId = event.request.userAttributes['sub']

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId } }))

  if (!result.Item || result.Item['status'] !== 'approved') {
    // Throwing from a Cognito trigger blocks token issuance.
    // The message is surfaced to the client as an authentication error.
    throw new Error('USER_PENDING_APPROVAL: Your account is awaiting admin approval.')
  }

  return event
}
