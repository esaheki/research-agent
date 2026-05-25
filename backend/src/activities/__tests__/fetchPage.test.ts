import { handler } from '../fetchPage'

describe('fetchPage', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('returns page content on successful fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('# Page Title\n\nContent here.'),
    }) as jest.MockedFunction<typeof fetch>

    const result = await handler({ url: 'https://example.com/page' })

    expect(result).toEqual({ url: 'https://example.com/page', content: '# Page Title\n\nContent here.' })
    expect(global.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/page',
      expect.objectContaining({ headers: { Accept: 'text/plain' } }),
    )
  })

  it('returns error on non-OK HTTP status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as jest.MockedFunction<typeof fetch>

    const result = await handler({ url: 'https://example.com/missing' })
    expect(result).toEqual({ url: 'https://example.com/missing', error: 'HTTP 404' })
  })

  it('returns timeout error on AbortError', async () => {
    const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    global.fetch = jest.fn().mockRejectedValue(timeoutError) as jest.MockedFunction<typeof fetch>

    const result = await handler({ url: 'https://slow.com' })
    expect(result).toEqual({ url: 'https://slow.com', error: 'timeout' })
  })

  it('returns fetch_error on other network errors', async () => {
    const netError = Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' })
    global.fetch = jest.fn().mockRejectedValue(netError) as jest.MockedFunction<typeof fetch>

    const result = await handler({ url: 'https://down.com' })
    expect(result.error).toContain('fetch_error')
  })
})
