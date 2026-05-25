import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

const ddbMock = mockClient(DynamoDBDocumentClient)

import { handler } from '../listSessions'

beforeAll(() => {
  process.env.SESSIONS_TABLE = 'TestSessionsTable'
})

beforeEach(() => {
  ddbMock.reset()
})

function makeEvent(sub = 'user-sub-123'): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: 'GET /research/history',
    rawPath: '/research/history',
    rawQueryString: '',
    headers: {},
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
      http: { method: 'GET', path: '/research/history', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'jest' },
      requestId: 'req-1',
      routeKey: 'GET /research/history',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2WithJWTAuthorizer
}

describe('listSessions', () => {
  it('returns sessions from GSI query', async () => {
    const sessions = [
      { sessionId: 'sess-2', userId: 'user-sub-123', status: 'complete', startedAt: '2025-01-02T00:00:00Z' },
      { sessionId: 'sess-1', userId: 'user-sub-123', status: 'complete', startedAt: '2025-01-01T00:00:00Z' },
    ]
    ddbMock.on(QueryCommand).resolves({ Items: sessions })

    const res = await handler(makeEvent(), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(200)

    const body = JSON.parse((res as { body: string }).body)
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions[0].sessionId).toBe('sess-2')
  })

  it('queries with ScanIndexForward false and Limit 20', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    await handler(makeEvent(), {} as never, jest.fn())

    const calls = ddbMock.commandCalls(QueryCommand)
    expect(calls).toHaveLength(1)
    const input = calls[0].args[0].input
    expect(input.ScanIndexForward).toBe(false)
    expect(input.Limit).toBe(20)
    expect(input.IndexName).toBe('userId-startedAt-index')
  })

  it('returns empty array when no sessions exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    const res = await handler(makeEvent(), {} as never, jest.fn())
    const body = JSON.parse((res as { body: string }).body)
    expect(body.sessions).toEqual([])
  })
})
