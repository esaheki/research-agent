import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

const ddbMock = mockClient(DynamoDBDocumentClient)
const s3Mock = mockClient(S3Client)

// Mock presigner before importing handler
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url.example.com/report.md?X-Amz-Signature=abc'),
}))

import { handler } from '../getSession'

beforeAll(() => {
  process.env.SESSIONS_TABLE = 'TestSessionsTable'
  process.env.ASSETS_BUCKET = 'test-bucket'
})

beforeEach(() => {
  ddbMock.reset()
  s3Mock.reset()
})

function makeEvent(sessionId: string, sub = 'user-sub-123'): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: 'GET /research/{sessionId}',
    rawPath: `/research/${sessionId}`,
    rawQueryString: '',
    headers: {},
    pathParameters: { sessionId },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: {
        jwt: { claims: { sub }, scopes: [] },
        principalId: sub,
        integrationLatency: 0,
      },
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: `/research/${sessionId}`, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'jest' },
      requestId: 'req-1',
      routeKey: 'GET /research/{sessionId}',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2WithJWTAuthorizer
}

describe('getSession', () => {
  it('returns 404 when session does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })

    const res = await handler(makeEvent('sess-999'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(404)
  })

  it('returns 403 when session belongs to a different user', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', userId: 'other-user', status: 'running' } })

    const res = await handler(makeEvent('sess-1'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(403)
  })

  it('returns session without reportUrl when status is pending', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', userId: 'user-sub-123', status: 'pending' } })

    const res = await handler(makeEvent('sess-1'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(200)
    const body = JSON.parse((res as { body: string }).body)
    expect(body.session.reportUrl).toBeUndefined()
  })

  it('returns session with presigned reportUrl when status is complete', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', userId: 'user-sub-123', status: 'complete' } })
    s3Mock.on(GetObjectCommand).resolves({})

    const res = await handler(makeEvent('sess-1'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(200)
    const body = JSON.parse((res as { body: string }).body)
    expect(body.session.reportUrl).toContain('signed-url')
  })

  it('returns reportUrl when status is partial-complete', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', userId: 'user-sub-123', status: 'partial-complete' } })
    s3Mock.on(GetObjectCommand).resolves({})

    const res = await handler(makeEvent('sess-1'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(200)
    const body = JSON.parse((res as { body: string }).body)
    expect(body.session.reportUrl).toBeDefined()
  })
})
