import { getSecret } from '../lib/secrets'

export interface TavilyResult {
  url: string
  title: string
  snippet: string
  score: number
}

interface TavilyInput {
  query: string
}

interface TavilyApiResult {
  url: string
  title: string
  content: string
  score: number
}

export const handler = async (event: TavilyInput): Promise<TavilyResult[]> => {
  const apiKey = await getSecret(process.env.TAVILY_API_KEY_SSM_PATH!)

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: event.query,
      search_depth: 'advanced',
      max_results: 10,
    }),
  })

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as { results?: TavilyApiResult[] }

  return (data.results ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.content,
    score: r.score,
  }))
}
