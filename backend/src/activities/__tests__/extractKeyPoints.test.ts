import { mockClient } from 'aws-sdk-client-mock'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const ssmMock = mockClient(SSMClient)

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

import { handler } from '../extractKeyPoints'

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY_SSM_PATH = '/research-agent/anthropic-api-key'
})

beforeEach(() => {
  ssmMock.reset()
  mockCreate.mockReset()
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'key' } })
})

const VALID_RESPONSE = JSON.stringify({
  keyPoints: ['Point A', 'Point B'],
  relevance: 0.85,
  conflictsFound: false,
})

describe('extractKeyPoints', () => {
  it('returns structured extraction on valid response', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: VALID_RESPONSE }] })

    const result = await handler({
      question: 'What is AI?',
      url: 'https://example.com',
      content: 'AI is a field of computer science...',
    })

    expect(result).toEqual({
      url: 'https://example.com',
      keyPoints: ['Point A', 'Point B'],
      relevance: 0.85,
      conflictsFound: false,
    })
  })

  it('extracts JSON from surrounding text', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: `Sure! Here's the result:\n${VALID_RESPONSE}\nDone.` }],
    })

    const result = await handler({ question: 'q', url: 'https://u.com', content: 'c' })
    expect(result.keyPoints).toEqual(['Point A', 'Point B'])
  })

  it('returns defaults on completely unparseable response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'This page is not relevant.' }],
    })

    const result = await handler({ question: 'q', url: 'https://u.com', content: 'c' })
    expect(result).toEqual({ url: 'https://u.com', keyPoints: [], relevance: 0.5, conflictsFound: false })
  })

  it('sets conflictsFound true when model indicates conflicts', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ keyPoints: ['Conflict point'], relevance: 0.6, conflictsFound: true }),
        },
      ],
    })

    const result = await handler({ question: 'q', url: 'https://u.com', content: 'c' })
    expect(result.conflictsFound).toBe(true)
  })

  it('truncates content to 8K tokens before sending to model', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: VALID_RESPONSE }] })

    const longContent = 'x'.repeat(200_000)
    await handler({ question: 'q', url: 'https://u.com', content: longContent })

    const prompt = mockCreate.mock.calls[0][0].messages[0].content as string
    // 8K tokens ≈ 32K chars; the prompt itself adds overhead but the content should be truncated
    expect(prompt.length).toBeLessThan(60_000)
  })
})
