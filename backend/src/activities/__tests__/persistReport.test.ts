import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const ddbMock = mockClient(DynamoDBDocumentClient)
const s3Mock = mockClient(S3Client)

import { handler } from '../persistReport'

beforeAll(() => {
  process.env.SESSIONS_TABLE = 'TestSessionsTable'
  process.env.ASSETS_BUCKET = 'test-bucket'
})

beforeEach(() => {
  ddbMock.reset()
  s3Mock.reset()
  ddbMock.on(UpdateCommand).resolves({})
  s3Mock.on(PutObjectCommand).resolves({})
})

const BASE_INPUT = {
  sessionId: 'sess-123',
  userId: 'user-456',
  report: '# Report\n\nContent here.',
  sources: [
    { url: 'https://a.com', content: 'Page A content' },
    { url: 'https://b.com', content: 'Page B content' },
    { url: 'https://c.com' }, // inaccessible — no content
  ],
}

describe('persistReport', () => {
  it('uploads report.md to S3 and returns the key', async () => {
    const result = await handler(BASE_INPUT)

    expect(result.reportKey).toBe('reports/user-456/sess-123/report.md')

    const puts = s3Mock.commandCalls(PutObjectCommand)
    const reportPut = puts.find((c) => c.args[0].input.Key?.endsWith('report.md'))
    expect(reportPut?.args[0].input.Body).toBe(BASE_INPUT.report)
  })

  it('uploads source texts for pages that have content', async () => {
    await handler(BASE_INPUT)

    const puts = s3Mock.commandCalls(PutObjectCommand)
    const sourceKeys = puts
      .map((c) => c.args[0].input.Key)
      .filter((k) => k?.includes('/sources/'))

    expect(sourceKeys).toHaveLength(2) // only 2 pages have content
    expect(sourceKeys.some((k) => k?.endsWith('sources/0.txt'))).toBe(true)
    expect(sourceKeys.some((k) => k?.endsWith('sources/1.txt'))).toBe(true)
  })

  it('skips sources without content', async () => {
    await handler(BASE_INPUT)

    const puts = s3Mock.commandCalls(PutObjectCommand)
    const sourceKeys = puts
      .map((c) => c.args[0].input.Key)
      .filter((k) => k?.includes('/sources/'))

    // source index 2 (c.com, no content) should not be uploaded
    expect(sourceKeys.some((k) => k?.endsWith('sources/2.txt'))).toBe(false)
  })

  it('updates session status to complete in DynamoDB', async () => {
    await handler(BASE_INPUT)

    const updates = ddbMock.commandCalls(UpdateCommand)
    expect(updates).toHaveLength(1)
    expect(updates[0].args[0].input.ExpressionAttributeValues?.[':complete']).toBe('complete')
    expect(updates[0].args[0].input.ExpressionAttributeValues?.[':key']).toBe(
      'reports/user-456/sess-123/report.md',
    )
  })
})
