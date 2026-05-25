import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { PreTokenGenerationTriggerEvent } from 'aws-lambda'

const ddbMock = mockClient(DynamoDBDocumentClient)

import { handler } from '../cognitoPreTokenGen'

beforeAll(() => {
  process.env.USER_APPROVALS_TABLE = 'TestApprovalsTable'
})

beforeEach(() => {
  ddbMock.reset()
})

function makeEvent(sub = 'user-sub-123'): PreTokenGenerationTriggerEvent {
  return {
    version: '1',
    triggerSource: 'TokenGeneration_Authentication',
    region: 'us-east-1',
    userPoolId: 'us-east-1_Test',
    userName: 'Google_12345',
    callerContext: { awsSdkVersion: '3.x', clientId: 'client-id' },
    request: {
      userAttributes: { sub, email: 'test@example.com' },
      groupConfiguration: {},
    },
    response: { claimsOverrideDetails: {} },
  }
}

describe('cognitoPreTokenGen', () => {
  it('returns the event unchanged for an approved user', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-sub-123', status: 'approved' } })

    const event = makeEvent()
    const result = await handler(event, {} as never, jest.fn())
    expect(result).toEqual(event)
  })

  it('throws for a pending user', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-sub-123', status: 'pending' } })

    await expect(handler(makeEvent(), {} as never, jest.fn())).rejects.toThrow(
      'USER_PENDING_APPROVAL',
    )
  })

  it('throws for a rejected user', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-sub-123', status: 'rejected' } })

    await expect(handler(makeEvent(), {} as never, jest.fn())).rejects.toThrow(
      'USER_PENDING_APPROVAL',
    )
  })

  it('throws when no record exists (unregistered user)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })

    await expect(handler(makeEvent(), {} as never, jest.fn())).rejects.toThrow(
      'USER_PENDING_APPROVAL',
    )
  })

  it('propagates unexpected DynamoDB errors', async () => {
    ddbMock.on(GetCommand).rejects(new Error('ServiceUnavailable'))

    await expect(handler(makeEvent(), {} as never, jest.fn())).rejects.toThrow('ServiceUnavailable')
  })
})
