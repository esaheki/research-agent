import Anthropic from '@anthropic-ai/sdk'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { getSecret } from '../lib/secrets'
import { emitEvent } from '../lib/events'
import { ExtractionResult } from './extractKeyPoints'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const EVENTS_TABLE = process.env.EVENTS_TABLE!

interface SynthesizeInput {
  sessionId: string
  question: string
  extractions: ExtractionResult[]
}

export interface SynthesizeResult {
  report: string
}

// Type for streaming deltas from Anthropic
interface ThinkingDelta {
  type: 'thinking_delta'
  thinking: string
}
interface TextDelta {
  type: 'text_delta'
  text: string
}
type ContentDelta = ThinkingDelta | TextDelta | { type: string }

export const handler = async (event: SynthesizeInput): Promise<SynthesizeResult> => {
  const { sessionId, question, extractions } = event

  const sourceSummary = extractions
    .map((e, i) => {
      const points = e.keyPoints.map((p) => `  - ${p}`).join('\n')
      const conflictTag = e.conflictsFound ? ' [CONTAINS CONFLICTS]' : ''
      return `Source ${i + 1}: ${e.url} (relevance: ${e.relevance.toFixed(2)})${conflictTag}\n${points || '  (no key points extracted)'}`
    })
    .join('\n\n')

  const hasConflicts = extractions.some((e) => e.conflictsFound)

  const prompt = `You are a research analyst. Write a comprehensive, well-structured research report based on the following information extracted from multiple web sources.

Research Question: ${question}

Extracted Information:
${sourceSummary}

Write the report in this exact structure using markdown:

## Executive Summary
(2-3 sentences summarising the answer)

## Key Findings
(bullet list of the most important findings)

## Detailed Analysis
(subsections per major theme; use [text](url) inline hyperlinks when citing sources)

${hasConflicts ? '## Conflicting Views\n(begin each conflict with a [CONFLICT] marker on its own line so the frontend can highlight it)\n\n' : ''}Important:
- Use inline hyperlinks [text](url) when referencing sources
- Mark conflicting claims as [CONFLICT] on a separate line followed by the explanation
- Be comprehensive, analytical, and avoid redundancy`

  const apiKey = await getSecret(process.env.ANTHROPIC_API_KEY_SSM_PATH!)
  const anthropic = new Anthropic({ apiKey })

  let report = ''

  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 16_000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    messages: [{ role: 'user', content: prompt }],
  })

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      const delta = chunk.delta as ContentDelta
      if (delta.type === 'thinking_delta') {
        await emitEvent(ddb, EVENTS_TABLE, sessionId, 'THINKING_CHUNK', {
          text: (delta as ThinkingDelta).thinking,
        })
      } else if (delta.type === 'text_delta') {
        const text = (delta as TextDelta).text
        report += text
        await emitEvent(ddb, EVENTS_TABLE, sessionId, 'REPORT_CHUNK', { markdown: text })
      }
    }
  }

  return { report }
}
