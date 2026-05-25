import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { emitEvent } from '../lib/events'
import { log } from '../lib/logger'
import { TavilyResult } from '../activities/tavilySearch'
import { ExtractionResult } from '../activities/extractKeyPoints'
import { FetchPageResult } from '../activities/fetchPage'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const lambdaClient = new LambdaClient({})

export interface OrchestratorInput {
  sessionId: string
  userId: string
  question: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callActivity<T>(functionName: string, payload: unknown, retries = 3): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(Math.pow(2, attempt - 1) * 2000)
    try {
      const result = await lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify(payload),
        }),
      )
      if (result.FunctionError) {
        const errPayload = JSON.parse(Buffer.from(result.Payload!).toString()) as {
          errorMessage?: string
        }
        throw new Error(errPayload.errorMessage ?? 'Activity invocation error')
      }
      return JSON.parse(Buffer.from(result.Payload!).toString()) as T
    } catch (err) {
      lastError = err as Error
    }
  }
  throw lastError
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

export const handler = async (event: OrchestratorInput): Promise<void> => {
  const { sessionId, userId, question } = event
  const failedSteps: string[] = []

  // Read env vars at invocation time so tests can set them in beforeAll/beforeEach
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
    await emitEvent(ddb, EVENTS_TABLE, sessionId, 'DECOMPOSING', { question })
    const subQueries = await callActivity<string[]>(ACTIVITY.decomposeQuery, { question })

    // Steps 2..N: Tavily search per sub-query
    const searchResults: TavilyResult[] = []
    for (let i = 0; i < subQueries.length; i++) {
      const query = subQueries[i]
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'SEARCHING', { query, queryIndex: i })
      try {
        const results = await callActivity<TavilyResult[]>(ACTIVITY.tavilySearch, { query })
        searchResults.push(...results)
      } catch {
        failedSteps.push(`tavilySearch:${i}`)
      }
    }

    // Step N+1: Rank and deduplicate URLs
    await emitEvent(ddb, EVENTS_TABLE, sessionId, 'RANKING_SOURCES', {})
    const rankedUrls = await callActivity<string[]>(ACTIVITY.rankUrls, {
      question,
      searchResults,
    })
    const topUrls = rankedUrls.slice(0, 8)

    // Steps N+2..N+9: Fetch pages
    const pageContents: FetchPageResult[] = []
    for (let i = 0; i < topUrls.length; i++) {
      const url = topUrls[i]
      let domain = url
      try {
        domain = new URL(url).hostname
      } catch {
        // keep original url as domain label
      }
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'FETCHING_PAGE', {
        url,
        domain,
        pageIndex: i,
      })
      const result = await callActivity<FetchPageResult>(ACTIVITY.fetchPage, { url })
      pageContents.push(result)
    }

    // Steps N+10..N+17: Extract key points per page
    const extractions: ExtractionResult[] = []
    for (let i = 0; i < pageContents.length; i++) {
      const page = pageContents[i]
      if (!page.content) continue
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'EXTRACTING', {
        url: page.url,
        pageIndex: i,
      })
      try {
        const extraction = await callActivity<ExtractionResult>(ACTIVITY.extractKeyPoints, {
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
    await emitEvent(ddb, EVENTS_TABLE, sessionId, 'SYNTHESIZING', {})
    const { report } = await callActivity<{ report: string }>(ACTIVITY.synthesizeReport, {
      sessionId,
      question,
      extractions,
    })

    // Step N+19: Persist to S3 + DynamoDB
    await callActivity(ACTIVITY.persistReport, { sessionId, userId, report, sources: pageContents })

    const finalStatus = failedSteps.length > 0 ? 'partial-complete' : 'complete'
    if (finalStatus === 'partial-complete') {
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'PARTIAL_COMPLETE', {
        sessionId,
        failedSteps,
      })
    } else {
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'COMPLETE', { sessionId })
    }

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
}
