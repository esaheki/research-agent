import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { emitEvent } from '../lib/events'
import { log } from '../lib/logger'
import { TavilyResult } from '../activities/tavilySearch'
import { ExtractionResult } from '../activities/extractKeyPoints'
import { FetchPageResult } from '../activities/fetchPage'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export interface OrchestratorInput {
  sessionId: string
  userId: string
  question: string
}

async function updateSessionStatus(
  sessionsTable: string,
  sessionId: string,
  status: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: sessionsTable,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }),
  )
}

export const handler = withDurableExecution(async (event: OrchestratorInput, ctx: DurableContext) => {
  const { sessionId, userId, question } = event
  const failedSteps: string[] = []

  const EVENTS_TABLE = process.env.EVENTS_TABLE!
  const SESSIONS_TABLE = process.env.SESSIONS_TABLE!
  const ACTIVITY = {
    decomposeQuery: process.env.ACTIVITY_DECOMPOSE_QUERY!,
    tavilySearch: process.env.ACTIVITY_TAVILY_SEARCH!,
    rankUrls: process.env.ACTIVITY_RANK_URLS!,
    fetchPage: process.env.ACTIVITY_FETCH_PAGE!,
    extractKeyPoints: process.env.ACTIVITY_EXTRACT_KEY_POINTS!,
    synthesizeReport: process.env.ACTIVITY_SYNTHESIZE_REPORT!,
    persistReport: process.env.ACTIVITY_PERSIST_REPORT!,
  }

  await updateSessionStatus(SESSIONS_TABLE, sessionId, 'running')
  const orchestratorStart = Date.now()
  log({ step: 'orchestrator_start', sessionId, userId, question })

  try {
    // Step 1: Decompose query
    // emitEvent is a DynamoDB write — wrap in a step so it's checkpointed and
    // won't re-execute on replay when the orchestrator resumes after each invoke.
    await ctx.step('emit-decomposing', async () => {
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'DECOMPOSING', { question })
    })
    const subQueries = await ctx.invoke<{ question: string }, string[]>(
      'decomposeQuery',
      ACTIVITY.decomposeQuery,
      { question },
    )

    // Steps 2..N: Tavily search per sub-query
    const searchResults: TavilyResult[] = []
    for (let i = 0; i < subQueries.length; i++) {
      const query = subQueries[i]
      await ctx.step(`emit-searching-${i}`, async () => {
        await emitEvent(ddb, EVENTS_TABLE, sessionId, 'SEARCHING', { query, queryIndex: i })
      })
      try {
        const results = await ctx.invoke<{ query: string }, TavilyResult[]>(
          `tavilySearch-${i}`,
          ACTIVITY.tavilySearch,
          { query },
        )
        searchResults.push(...results)
      } catch {
        failedSteps.push(`tavilySearch:${i}`)
      }
    }

    // Step N+1: Rank and deduplicate URLs
    await ctx.step('emit-ranking', async () => {
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'RANKING_SOURCES', {})
    })
    const rankedUrls = await ctx.invoke<
      { question: string; searchResults: TavilyResult[] },
      string[]
    >('rankUrls', ACTIVITY.rankUrls, { question, searchResults })
    const topUrls = rankedUrls.slice(0, 8)

    // Steps N+2..N+9: Fetch pages
    const pageContents: FetchPageResult[] = []
    for (let i = 0; i < topUrls.length; i++) {
      const url = topUrls[i]
      let domain = url
      try {
        domain = new URL(url).hostname
      } catch {
        /* keep original url as domain label */
      }
      await ctx.step(`emit-fetching-${i}`, async () => {
        await emitEvent(ddb, EVENTS_TABLE, sessionId, 'FETCHING_PAGE', { url, domain, pageIndex: i })
      })
      const result = await ctx.invoke<{ url: string }, FetchPageResult>(
        `fetchPage-${i}`,
        ACTIVITY.fetchPage,
        { url },
      )
      pageContents.push(result)
    }

    // Steps N+10..N+17: Extract key points per page
    const extractions: ExtractionResult[] = []
    for (let i = 0; i < pageContents.length; i++) {
      const page = pageContents[i]
      if (!page.content) continue
      await ctx.step(`emit-extracting-${i}`, async () => {
        await emitEvent(ddb, EVENTS_TABLE, sessionId, 'EXTRACTING', { url: page.url, pageIndex: i })
      })
      try {
        const extraction = await ctx.invoke<
          { question: string; url: string; content: string },
          ExtractionResult
        >(`extractKeyPoints-${i}`, ACTIVITY.extractKeyPoints, {
          question,
          url: page.url,
          content: page.content,
        })
        extractions.push(extraction)
      } catch {
        failedSteps.push(`extractKeyPoints:${i}`)
      }
    }

    if (extractions.length === 0) {
      throw new Error('No extractions succeeded — cannot synthesize report')
    }

    // Step N+18: Synthesize report (Claude Sonnet + extended thinking)
    await ctx.step('emit-synthesizing', async () => {
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'SYNTHESIZING', {})
    })
    const { report } = await ctx.invoke<
      { sessionId: string; question: string; extractions: ExtractionResult[] },
      { report: string }
    >('synthesizeReport', ACTIVITY.synthesizeReport, { sessionId, question, extractions })

    // Step N+19: Persist to S3 + DynamoDB
    await ctx.invoke('persistReport', ACTIVITY.persistReport, {
      sessionId,
      userId,
      report,
      sources: pageContents,
    })

    const finalStatus = failedSteps.length > 0 ? 'partial-complete' : 'complete'
    await ctx.step('emit-complete', async () => {
      if (finalStatus === 'partial-complete') {
        await emitEvent(ddb, EVENTS_TABLE, sessionId, 'PARTIAL_COMPLETE', { sessionId, failedSteps })
      } else {
        await emitEvent(ddb, EVENTS_TABLE, sessionId, 'COMPLETE', { sessionId })
      }
    })

    await updateSessionStatus(SESSIONS_TABLE, sessionId, finalStatus)
    log({
      step: 'orchestrator_complete',
      sessionId,
      userId,
      status: finalStatus,
      durationMs: Date.now() - orchestratorStart,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    await emitEvent(ddb, EVENTS_TABLE, sessionId, 'ERROR', { step: 'orchestrator', message })
    await updateSessionStatus(SESSIONS_TABLE, sessionId, 'failed')
    log({
      step: 'orchestrator_failed',
      sessionId,
      userId,
      error: message,
      durationMs: Date.now() - orchestratorStart,
    })
    throw err
  }
})
