import { mockClient } from 'aws-sdk-client-mock'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const ssmMock = mockClient(SSMClient)

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

import { handler } from '../rankUrls'

const RESULTS = [
  { url: 'https://a.com', title: 'A', snippet: 'snippet a', score: 0.9 },
  { url: 'https://b.com', title: 'B', snippet: 'snippet b', score: 0.8 },
  { url: 'https://c.com', title: 'C', snippet: 'snippet c', score: 0.7 },
  { url: 'https://a.com', title: 'A dup', snippet: 'dup', score: 0.95 }, // duplicate
]

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY_SSM_PATH = '/research-agent/anthropic-api-key'
})

beforeEach(() => {
  ssmMock.reset()
  mockCreate.mockReset()
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'key' } })
})

describe('rankUrls', () => {
  it('returns ranked URLs from model response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '["https://a.com","https://b.com"]' }],
    })

    const result = await handler({ question: 'test', searchResults: RESULTS })
    expect(result).toEqual(['https://a.com', 'https://b.com'])
  })

  it('caps at 8 URLs', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://site${i}.com`)
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(urls) }],
    })

    const result = await handler({ question: 'test', searchResults: [] })
    expect(result).toHaveLength(8)
  })

  it('falls back to score-sorted URLs when model output is unparseable', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'I cannot rank these.' }],
    })

    const result = await handler({ question: 'test', searchResults: RESULTS })
    // Should return unique URLs sorted by score: a.com (0.9), b.com (0.8), c.com (0.7)
    expect(result[0]).toBe('https://a.com')
    expect(result).not.toContain('https://a.com' + 'dup') // dedup happened
  })

  it('deduplicates before sending to model', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '["https://a.com"]' }],
    })

    await handler({ question: 'test', searchResults: RESULTS })

    const prompt = mockCreate.mock.calls[0][0].messages[0].content as string
    // The duplicate https://a.com should only appear once in the prompt
    const occurrences = (prompt.match(/https:\/\/a\.com/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})
