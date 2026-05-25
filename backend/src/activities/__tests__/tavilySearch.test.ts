import { mockClient } from 'aws-sdk-client-mock'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const ssmMock = mockClient(SSMClient)

import { handler } from '../tavilySearch'

beforeAll(() => {
  process.env.TAVILY_API_KEY_SSM_PATH = '/research-agent/tavily-api-key'
})

beforeEach(() => {
  ssmMock.reset()
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'tavily-key' } })
})

const mockResults = [
  { url: 'https://example.com/a', title: 'Article A', content: 'Snippet A', score: 0.95 },
  { url: 'https://example.com/b', title: 'Article B', content: 'Snippet B', score: 0.8 },
]

describe('tavilySearch', () => {
  it('returns mapped results from Tavily API', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ results: mockResults }),
    }) as jest.MockedFunction<typeof fetch>

    const result = await handler({ query: 'quantum computing basics' })

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      url: 'https://example.com/a',
      title: 'Article A',
      snippet: 'Snippet A',
      score: 0.95,
    })
  })

  it('sends correct request to Tavily API', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ results: [] }),
    }) as jest.MockedFunction<typeof fetch>

    await handler({ query: 'my query' })

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"search_depth":"advanced"'),
      }),
    )
  })

  it('throws on non-OK API response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }) as jest.MockedFunction<typeof fetch>

    await expect(handler({ query: 'test' })).rejects.toThrow('Tavily API error: 429')
  })

  it('returns empty array when results field is missing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({}),
    }) as jest.MockedFunction<typeof fetch>

    const result = await handler({ query: 'test' })
    expect(result).toEqual([])
  })
})
