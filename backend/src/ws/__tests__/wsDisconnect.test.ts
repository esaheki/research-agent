import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb'

const ddbMock = mockClient(DynamoDBDocumentClient)

import { handler } from '../wsDisconnect'

beforeAll(() => {
  process.env.CONNECTIONS_TABLE = 'TestConnectionsTable'
})

beforeEach(() => {
  ddbMock.reset()
})

function makeEvent(connectionId = 'conn-abc123'): { requestContext: { connectionId: string } } {
  return { requestContext: { connectionId } }
}

describe('wsDisconnect', () => {
  it('deletes the connection record and returns 200', async () => {
    ddbMock.on(DeleteCommand).resolves({})

    const res = await handler(makeEvent('conn-abc123'))
    expect(res.statusCode).toBe(200)

    const deletes = ddbMock.commandCalls(DeleteCommand)
    expect(deletes).toHaveLength(1)
    expect(deletes[0].args[0].input.Key?.['connectionId']).toBe('conn-abc123')
  })

  it('returns 200 even if connection record does not exist', async () => {
    ddbMock.on(DeleteCommand).resolves({})

    const res = await handler(makeEvent('conn-nonexistent'))
    expect(res.statusCode).toBe(200)
  })
})
