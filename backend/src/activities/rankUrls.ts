import Anthropic from '@anthropic-ai/sdk'
import { getSecret } from '../lib/secrets'
import { TavilyResult } from './tavilySearch'

interface RankUrlsInput {
  question: string
  searchResults: TavilyResult[]
}

export const handler = async (event: RankUrlsInput): Promise<string[]> => {
  const { question, searchResults } = event

  // Deduplicate by URL before ranking
  const seen = new Set<string>()
  const unique = searchResults.filter((r) => {
    if (seen.has(r.url)) return false
    seen.add(r.url)
    return true
  })

  const apiKey = await getSecret(process.env.ANTHROPIC_API_KEY_SSM_PATH!)
  const anthropic = new Anthropic({ apiKey })

  const resultsSummary = unique
    .map(
      (r, i) =>
        `${i + 1}. [score:${r.score.toFixed(2)}] ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 200)}`,
    )
    .join('\n\n')

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Select the top 8 most relevant and trustworthy URLs to fetch for this research question. Return ONLY a JSON array of URL strings, no other text.

Research question: ${question}

Search results:
${resultsSummary}

Return format: ["https://...", "https://...", ...]`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? '[]'

  try {
    const urls = JSON.parse(text) as string[]
    return urls.slice(0, 8)
  } catch {
    const match = text.match(/\[[\s\S]*?\]/)
    if (match) return (JSON.parse(match[0]) as string[]).slice(0, 8)
    // Fallback: top 8 by score
    return unique
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((r) => r.url)
  }
}
