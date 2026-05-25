import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { PostAuthenticationTriggerEvent } from 'aws-lambda'

const ddbMock = mockClient(DynamoDBDocumentClient)
const snsMock = mockClient(SNSClient)

// Import after mocks are set up
import { handler } from '../cognitoPostAuth'

const TABLE = 'TestApprovalsTable'
const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:TestTopic'

beforeAll(() => {
  process.env.USER_APPROVALS_TABLE = TABLE
  process.env.NEW_USER_TOPIC_ARN = TOPIC_ARN
})

beforeEach(() => {
  ddbMock.reset()
  snsMock.reset()
})

function makeEvent(attrs: Record<string, string> = {}): PostAuthenticationTriggerEvent {
  return {
    version: '1',
    triggerSource: 'PostAuthentication_Authentication',
    region: 'us-east-1',
    userPoolId: 'us-east-1_Test',
    userName: 'Google_12345',
    callerContext: { awsSdkVersion: '3.x', clientId: 'client-id' },
    request: {
      userAttributes: {
        sub: 'user-sub-123',
        email: 'test@example.com',
        given_name: 'Test',
        family_name: 'User',
        ...attrs,
      },
      newDeviceUsed: false,
    },
    response: {},
  }
}

describe('cognitoPostAuth', () => {
  it('writes a pending record and publishes SNS for a brand-new user', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    snsMock.on(PublishCommand).resolves({ MessageId: 'msg-1' })

    const event = makeEvent()
    const result = await handler(event, {} as never, jest.fn())

    expect(result).toEqual(event)

    const puts = ddbMock.commandCalls(PutCommand)
    expect(puts).toHaveLength(1)
    expect(puts[0].args[0].input.Item).toMatchObject({
      userId: 'user-sub-123',
      email: 'test@example.com',
      name: 'Test User',
      status: 'pending',
    })

    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1)
    const msg = snsMock.commandCalls(PublishCommand)[0].args[0].input.Message ?? ''
    expect(msg).toContain('user-sub-123')
    expect(msg).toContain('test@example.com')
  })

  it('skips write and SNS publish when the user already has a record', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-sub-123', status: 'pending' } })

    const event = makeEvent()
    const result = await handler(event, {} as never, jest.fn())

    expect(result).toEqual(event)
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0)
  })

  it('handles a race-condition ConditionalCheckFailedException gracefully', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    const condError = Object.assign(new Error('Condition failed'), {
      name: 'ConditionalCheckFailedException',
    })
    ddbMock.on(PutCommand).rejects(condError)

    const event = makeEvent()
    const result = await handler(event, {} as never, jest.fn())

    expect(result).toEqual(event)
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0)
  })

  it('propagates unexpected DynamoDB errors', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).rejects(new Error('ProvisionedThroughputExceededException'))

    await expect(handler(makeEvent(), {} as never, jest.fn())).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    )
  })

  it('falls back to email when name attributes are missing', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    snsMock.on(PublishCommand).resolves({ MessageId: 'msg-2' })

    await handler(
      makeEvent({ sub: 'user-sub-456', email: 'noname@example.com', given_name: '', family_name: '' }),
      {} as never,
      jest.fn(),
    )

    const puts = ddbMock.commandCalls(PutCommand)
    expect(puts[0].args[0].input.Item?.name).toBe('noname@example.com')
  })
})
