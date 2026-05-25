import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'

const ddbMock = mockClient(DynamoDBDocumentClient)
const apiMock = mockClient(ApiGatewayManagementApiClient)

import { handler } from '../wsConnect'

const VALID_JWT = (() => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: 'user-sub-123', email: 'test@example.com' })).toString('base64url')
  const sig = 'fake-signature'
  return `${header}.${payload}.${sig}`
})()

beforeAll(() => {
  process.env.CONNECTIONS_TABLE = 'TestConnectionsTable'
  process.env.SESSIONS_TABLE = 'TestSessionsTable'
  process.env.EVENTS_TABLE = 'TestEventsTable'
  process.env.WEBSOCKET_API_ENDPOINT = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod'
})

beforeEach(() => {
  ddbMock.reset()
  apiMock.reset()
})

function makeEvent(
  token?: string,
  sessionId?: string,
  connectionId = 'conn-abc123',
): { requestContext: { connectionId: string }; queryStringParameters?: Record<string, string> } {
  return {
    requestContext: { connectionId },
    queryStringParameters: {
      ...(token ? { token } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  }
}

describe('wsConnect', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await handler(makeEvent(undefined, 'sess-1'))
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 when token has invalid JWT structure', async () => {
    const res = await handler(makeEvent('not-a-jwt', 'sess-1'))
    expect(res.statusCode).toBe(401)
  })

  it('returns 200 and writes connection to DynamoDB', async () => {
    ddbMock.on(PutCommand).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    const res = await handler(makeEvent(VALID_JWT, 'sess-1'))
    expect(res.statusCode).toBe(200)

    const puts = ddbMock.commandCalls(PutCommand)
    expect(puts).toHaveLength(1)
    expect(puts[0].args[0].input.Item?.['connectionId']).toBe('conn-abc123')
    expect(puts[0].args[0].input.Item?.['sessionId']).toBe('sess-1')
    expect(puts[0].args[0].input.Item?.['userId']).toBe('user-sub-123')
  })

  it('replays existing events to the connection', async () => {
    ddbMock.on(PutCommand).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { sessionId: 'sess-1', eventId: 'evt-1', type: 'DECOMPOSING', payload: {}, timestamp: '2025-01-01T00:00:00Z' },
        { sessionId: 'sess-1', eventId: 'evt-2', type: 'SEARCHING', payload: {}, timestamp: '2025-01-01T00:00:01Z' },
      ],
    })
    apiMock.on(PostToConnectionCommand).resolves({})

    const res = await handler(makeEvent(VALID_JWT, 'sess-1'))
    expect(res.statusCode).toBe(200)

    const posts = apiMock.commandCalls(PostToConnectionCommand)
    expect(posts).toHaveLength(2)
  })

  it('updates the session with the connectionId', async () => {
    ddbMock.on(PutCommand).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    await handler(makeEvent(VALID_JWT, 'sess-1'))

    const updates = ddbMock.commandCalls(UpdateCommand)
    expect(updates).toHaveLength(1)
    expect(updates[0].args[0].input.ExpressionAttributeValues?.[':cid']).toBe('conn-abc123')
  })
})
