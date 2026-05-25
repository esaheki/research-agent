const JINA_BASE = 'https://r.jina.ai/'
const TIMEOUT_MS = 15_000

interface FetchPageInput {
  url: string
}

export interface FetchPageResult {
  url: string
  content?: string
  error?: string
}

export const handler = async (event: FetchPageInput): Promise<FetchPageResult> => {
  const { url } = event

  try {
    const response = await fetch(`${JINA_BASE}${url}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'text/plain' },
    })

    if (!response.ok) {
      return { url, error: `HTTP ${response.status}` }
    }

    const content = await response.text()
    return { url, content }
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : 'unknown'
    return { url, error: name === 'TimeoutError' ? 'timeout' : `fetch_error: ${name}` }
  }
}
