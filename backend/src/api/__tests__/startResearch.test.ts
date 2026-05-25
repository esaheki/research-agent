import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

const ddbMock = mockClient(DynamoDBDocumentClient)
const lambdaMock = mockClient(LambdaClient)

import { handler } from '../startResearch'

beforeAll(() => {
  process.env.SESSIONS_TABLE = 'TestSessionsTable'
  process.env.ORCHESTRATOR_FUNCTION_NAME = 'TestOrchestratorFn'
})

beforeEach(() => {
  ddbMock.reset()
  lambdaMock.reset()
})

function makeEvent(
  body: object,
  sub = 'user-sub-123',
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: 'POST /research',
    rawPath: '/research',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
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
      http: { method: 'POST', path: '/research', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'jest' },
      requestId: 'req-1',
      routeKey: 'POST /research',
      stage: '$default',
      time: '01/Jan/2025:00:00:00 +0000',
      timeEpoch: 1735689600000,
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2WithJWTAuthorizer
}

describe('startResearch', () => {
  it('returns 400 when question is missing', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    const res = await handler(makeEvent({}), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(400)
    const body = JSON.parse((res as { body: string }).body)
    expect(body.error).toBe('MISSING_QUESTION')
  })

  it('returns 400 when question is empty string', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    const res = await handler(makeEvent({ question: '   ' }), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(400)
  })

  it('returns 409 when user already has a running session', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ sessionId: 'existing-session', status: 'running' }] })

    const res = await handler(makeEvent({ question: 'What is AI?' }), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(409)
    const body = JSON.parse((res as { body: string }).body)
    expect(body.error).toBe('SESSION_ALREADY_RUNNING')
    expect(body.sessionId).toBe('existing-session')
  })

  it('starts a session and returns sessionId on happy path', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] })
    ddbMock.on(PutCommand).resolves({})
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 })

    const res = await handler(makeEvent({ question: 'What is AI?' }), {} as never, jest.fn())
    expect((res as { statusCode: number }).statusCode).toBe(200)

    const body = JSON.parse((res as { body: string }).body)
    expect(typeof body.sessionId).toBe('string')
    expect(body.sessionId).toHaveLength(36)

    const puts = ddbMock.commandCalls(PutCommand)
    expect(puts).toHaveLength(1)
    expect(puts[0].args[0].input.Item?.['status']).toBe('pending')
    expect(puts[0].args[0].input.Item?.['question']).toBe('What is AI?')

    const invocations = lambdaMock.commandCalls(InvokeCommand)
    expect(invocations).toHaveLength(1)
    expect(invocations[0].args[0].input.InvocationType).toBe('Event')
  })
})
