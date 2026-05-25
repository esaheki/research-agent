import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const SESSIONS_TABLE = process.env.SESSIONS_TABLE!
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!

const COMPLETE_STATUSES = new Set(['complete', 'partial-complete'])

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

  let reportUrl: string | undefined
  if (COMPLETE_STATUSES.has(session['status'] as string)) {
    const key = `reports/${userId}/${sessionId}/report.md`
    reportUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: key }),
      { expiresIn: 900 },
    )
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: { ...session, ...(reportUrl ? { reportUrl } : {}) } }),
  }
}
