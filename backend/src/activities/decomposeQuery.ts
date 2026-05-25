import Anthropic from '@anthropic-ai/sdk'
import { getSecret } from '../lib/secrets'

interface DecomposeInput {
  question: string
}

export const handler = async (event: DecomposeInput): Promise<string[]> => {
  const apiKey = await getSecret(process.env.ANTHROPIC_API_KEY_SSM_PATH!)
  const anthropic = new Anthropic({ apiKey })

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Break down this research question into 3-5 specific, diverse search queries that together cover different angles of the topic. Return ONLY a JSON array of strings, no other text.

Question: ${event.question}

Example output: ["query 1", "query 2", "query 3"]`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? '[]'

  try {
    const queries = JSON.parse(text) as string[]
    if (!Array.isArray(queries) || queries.length === 0) throw new Error('empty array')
    return queries.slice(0, 5)
  } catch {
    const match = text.match(/\[[\s\S]*?\]/)
    if (match) return (JSON.parse(match[0]) as string[]).slice(0, 5)
    throw new Error(`Failed to parse sub-queries from response: ${text.slice(0, 200)}`)
  }
}
