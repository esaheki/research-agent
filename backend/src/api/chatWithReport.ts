import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import Anthropic from '@anthropic-ai/sdk'
import { getSecret } from '../lib/secrets'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const SESSIONS_TABLE = process.env.SESSIONS_TABLE!
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!
const ANTHROPIC_API_KEY_SSM_PATH = process.env.ANTHROPIC_API_KEY_SSM_PATH!

const COMPLETE_STATUSES = new Set(['complete', 'partial-complete'])

async function getS3Text(key: string): Promise<string | undefined> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: key }))
    return await res.Body?.transformToString()
  } catch {
    return undefined
  }
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string
  const sessionId = event.pathParameters?.['sessionId']

  if (!sessionId) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'MISSING_SESSION_ID' }) }
  }

  let body: { message?: string }
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'INVALID_JSON' }) }
  }

  const message = body.message?.trim()
  if (!message) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'MISSING_MESSAGE' }) }
  }

  const sessionResult = await ddb.send(new GetCommand({ TableName: SESSIONS_TABLE, Key: { sessionId } }))
  if (!sessionResult.Item) {
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'SESSION_NOT_FOUND' }) }
  }

  const session = sessionResult.Item
  if (session['userId'] !== userId) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'FORBIDDEN' }) }
  }

  if (!COMPLETE_STATUSES.has(session['status'] as string)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'REPORT_NOT_READY' }) }
  }

  const reportKey = `reports/${userId}/${sessionId}/report.md`
  const reportText = await getS3Text(reportKey)
  if (!reportText) {
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'REPORT_NOT_FOUND' }) }
  }

  const sourceParts: string[] = []
  for (let i = 0; i < 8; i++) {
    const text = await getS3Text(`reports/${userId}/${sessionId}/sources/${i}.txt`)
    if (text) sourceParts.push(text)
  }

  const context = [
    `# Research Report\n\n${reportText}`,
    ...sourceParts.map((s, i) => `# Source ${i + 1}\n\n${s}`),
  ].join('\n\n---\n\n')

  const apiKey = await getSecret(ANTHROPIC_API_KEY_SSM_PATH)
  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `You are a research assistant. Answer questions about the following research report and its sources.\n\n${context}`,
    messages: [{ role: 'user', content: message }],
  })

  const fullText = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { type: 'text'; text: string }).text)
    .join('')

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: fullText }),
  }
}
