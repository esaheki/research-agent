import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { FetchPageResult } from './fetchPage'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const SESSIONS_TABLE = process.env.SESSIONS_TABLE!
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!

interface PersistInput {
  sessionId: string
  userId: string
  report: string
  sources: FetchPageResult[]
}

export interface PersistResult {
  reportKey: string
}

export const handler = async (event: PersistInput): Promise<PersistResult> => {
  const { sessionId, userId, report, sources } = event
  const reportKey = `reports/${userId}/${sessionId}/report.md`

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: reportKey,
      Body: report,
      ContentType: 'text/markdown',
    }),
  )

  await Promise.all(
    sources.map((source, i) => {
      if (!source.content) return Promise.resolve()
      return s3.send(
        new PutObjectCommand({
          Bucket: ASSETS_BUCKET,
          Key: `reports/${userId}/${sessionId}/sources/${i}.txt`,
          Body: `URL: ${source.url}\n\n${source.content}`,
          ContentType: 'text/plain',
        }),
      )
    }),
  )

  await ddb.send(
    new UpdateCommand({
      TableName: SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :complete, reportKey = :key, completedAt = :ts',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':complete': 'complete',
        ':key': reportKey,
        ':ts': new Date().toISOString(),
      },
    }),
  )

  return { reportKey }
}
