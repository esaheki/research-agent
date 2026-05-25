import { mockClient } from 'aws-sdk-client-mock'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

const ssmMock = mockClient(SSMClient)
const ddbMock = mockClient(DynamoDBDocumentClient)

// Build an async iterable that yields streaming events
function makeStream(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e
    },
  }
}

const mockStream = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { stream: mockStream } })),
}))

import { handler } from '../synthesizeReport'

const EXTRACTIONS = [
  { url: 'https://a.com', keyPoints: ['Point 1'], relevance: 0.9, conflictsFound: false },
  { url: 'https://b.com', keyPoints: ['Point 2'], relevance: 0.7, conflictsFound: true },
]

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY_SSM_PATH = '/research-agent/anthropic-api-key'
  process.env.EVENTS_TABLE = 'TestEventsTable'
})

beforeEach(() => {
  ssmMock.reset()
  ddbMock.reset()
  mockStream.mockReset()
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'key' } })
  ddbMock.on(PutCommand).resolves({})
})

describe('synthesizeReport', () => {
  it('concatenates text deltas into the returned report', async () => {
    mockStream.mockReturnValue(
      makeStream([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '# Report\n' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Content here.' } },
      ]),
    )

    const result = await handler({
      sessionId: 'sess-1',
      question: 'What is AI?',
      extractions: EXTRACTIONS,
    })

    expect(result.report).toBe('# Report\nContent here.')
  })

  it('emits REPORT_CHUNK events to DynamoDB for each text delta', async () => {
    mockStream.mockReturnValue(
      makeStream([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk1' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk2' } },
      ]),
    )

    await handler({ sessionId: 'sess-1', question: 'q', extractions: EXTRACTIONS })

    const puts = ddbMock.commandCalls(PutCommand)
    const types = puts.map((c) => c.args[0].input.Item?.['type'])
    expect(types.filter((t) => t === 'REPORT_CHUNK')).toHaveLength(2)
  })

  it('emits THINKING_CHUNK events to DynamoDB for thinking deltas', async () => {
    mockStream.mockReturnValue(
      makeStream([
        {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'Reasoning step...' },
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Report text.' } },
      ]),
    )

    await handler({ sessionId: 'sess-1', question: 'q', extractions: EXTRACTIONS })

    const puts = ddbMock.commandCalls(PutCommand)
    const types = puts.map((c) => c.args[0].input.Item?.['type'])
    expect(types).toContain('THINKING_CHUNK')
    expect(types).toContain('REPORT_CHUNK')
  })

  it('uses claude-sonnet-4-6 model', async () => {
    mockStream.mockReturnValue(makeStream([]))

    await handler({ sessionId: 'sess-1', question: 'q', extractions: EXTRACTIONS })

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    )
  })

  it('enables extended thinking with 8000 budget_tokens', async () => {
    mockStream.mockReturnValue(makeStream([]))

    await handler({ sessionId: 'sess-1', question: 'q', extractions: EXTRACTIONS })

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: 'enabled', budget_tokens: 8000 },
      }),
    )
  })
})
