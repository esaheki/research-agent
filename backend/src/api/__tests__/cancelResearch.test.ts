import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

const ddbMock = mockClient(DynamoDBDocumentClient)

import { handler } from '../cancelResearch'

beforeAll(() => {
  process.env.SESSIONS_TABLE = 'TestSessionsTable'
})

beforeEach(() => {
  ddbMock.reset()
})

function makeEvent(sessionId: string, sub = 'user-sub-123'): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: 'DELETE /research/{sessionId}',
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
      http: { method: 'DELETE', path: `/research/${sessionId}`, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'jest' },
      requestId: 'req-1',
      routeKey: 'DELETE /research/{sessionId}',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2WithJWTAuthorizer
}

describe('cancelResearch', () => {
  it('returns 404 when session does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })

    const res = await handler(makeEvent('sess-999'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(404)
    expect(JSON.parse((res as { body: string }).body).error).toBe('SESSION_NOT_FOUND')
  })

  it('returns 403 when session belongs to a different user', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', userId: 'other-user', status: 'running' } })

    const res = await handler(makeEvent('sess-1', 'user-sub-123'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(403)
    expect(JSON.parse((res as { body: string }).body).error).toBe('FORBIDDEN')
  })

  it('returns 200 no-op when session is already in a terminal status', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', userId: 'user-sub-123', status: 'complete' } })

    const res = await handler(makeEvent('sess-1'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(200)
    expect(JSON.parse((res as { body: string }).body).status).toBe('complete')
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0)
  })

  it('cancels a running session and returns cancelled status', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: 'sess-1', userId: 'user-sub-123', status: 'running' } })
    ddbMock.on(UpdateCommand).resolves({})

    const res = await handler(makeEvent('sess-1'), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(200)
    const body = JSON.parse((res as { body: string }).body)
    expect(body.sessionId).toBe('sess-1')
    expect(body.status).toBe('cancelled')

    const updates = ddbMock.commandCalls(UpdateCommand)
    expect(updates).toHaveLength(1)
    expect(updates[0].args[0].input.ExpressionAttributeValues?.[':cancelled']).toBe('cancelled')
  })
})
