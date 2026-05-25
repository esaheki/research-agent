import Anthropic from '@anthropic-ai/sdk'
import { getSecret } from '../lib/secrets'

const CHARS_8K = 8_000 * 4

interface ExtractInput {
  question: string
  url: string
  content: string
}

export interface ExtractionResult {
  url: string
  keyPoints: string[]
  relevance: number
  conflictsFound: boolean
}

interface ParsedExtraction {
  keyPoints?: string[]
  relevance?: number
  conflictsFound?: boolean
}

function parseExtraction(url: string, text: string): ExtractionResult {
  let parsed: ParsedExtraction = {}
  try {
    parsed = JSON.parse(text) as ParsedExtraction
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0]) as ParsedExtraction
      } catch {
        // fall through to defaults
      }
    }
  }
  return {
    url,
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    relevance: typeof parsed.relevance === 'number' ? parsed.relevance : 0.5,
    conflictsFound: Boolean(parsed.conflictsFound),
  }
}

export const handler = async (event: ExtractInput): Promise<ExtractionResult> => {
  const { question, url, content } = event
  const truncated = content.slice(0, CHARS_8K)

  const apiKey = await getSecret(process.env.ANTHROPIC_API_KEY_SSM_PATH!)
  const anthropic = new Anthropic({ apiKey })

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `Extract key points from this web page that are relevant to the research question. Return ONLY a JSON object with this exact structure, no other text:
{
  "keyPoints": ["point 1", "point 2", ...],
  "relevance": 0.0,
  "conflictsFound": false
}

relevance: 0.0-1.0 score for how relevant this page is to the question.
conflictsFound: true if this source contradicts common knowledge or other likely sources.

Research question: ${question}
Source: ${url}

Content:
${truncated}`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? '{}'
  return parseExtraction(url, text)
}
