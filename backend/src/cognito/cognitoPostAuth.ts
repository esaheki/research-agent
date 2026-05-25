import { PostAuthenticationTriggerHandler } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sns = new SNSClient({})

const TABLE = process.env.USER_APPROVALS_TABLE!
const TOPIC_ARN = process.env.NEW_USER_TOPIC_ARN!

export const handler: PostAuthenticationTriggerHandler = async (event) => {
  const userId = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email'] ?? 'unknown'
  const given = event.request.userAttributes['given_name'] ?? ''
  const family = event.request.userAttributes['family_name'] ?? ''
  const name = `${given} ${family}`.trim() || email

  // Skip if already registered (repeat sign-in of any status)
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId } }))
  if (existing.Item) return event

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { userId, email, name, status: 'pending', registeredAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(userId)',
      }),
    )
  } catch (err: unknown) {
    // Another concurrent invocation already wrote the record — safe to skip
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err
    return event
  }

  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: `[Research Agent] New user pending approval: ${email}`,
      Message: [
        `A new user has signed in and is awaiting your approval.`,
        ``,
        `Name:    ${name}`,
        `Email:   ${email}`,
        `User ID: ${userId}`,
        ``,
        `To approve via AWS CLI:`,
        `  aws dynamodb update-item \\`,
        `    --table-name ${TABLE} \\`,
        `    --key '{"userId":{"S":"${userId}"}}' \\`,
        `    --update-expression "SET #s = :v, approvedAt = :t" \\`,
        `    --expression-attribute-names '{"#s":"status"}' \\`,
        `    --expression-attribute-values '{":v":{"S":"approved"},":t":{"S":"'$(date -u +%FT%TZ)'"}}'`,
      ].join('\n'),
    }),
  )

  return event
}
