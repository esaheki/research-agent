import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'

const ddbMock = mockClient(DynamoDBDocumentClient)
const lambdaMock = mockClient(LambdaClient)

import { handler, OrchestratorInput } from '../researchOrchestrator'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function payload(value: unknown): any {
  return Buffer.from(JSON.stringify(value))
}

const ENV = {
  EVENTS_TABLE: 'TestEventsTable',
  SESSIONS_TABLE: 'TestSessionsTable',
  ACTIVITY_DECOMPOSE_QUERY: 'fn-decompose',
  ACTIVITY_TAVILY_SEARCH: 'fn-tavily',
  ACTIVITY_RANK_URLS: 'fn-rank',
  ACTIVITY_FETCH_PAGE: 'fn-fetch',
  ACTIVITY_EXTRACT_KEY_POINTS: 'fn-extract',
  ACTIVITY_SYNTHESIZE_REPORT: 'fn-synthesize',
  ACTIVITY_PERSIST_REPORT: 'fn-persist',
}

const BASE_INPUT: OrchestratorInput = {
  sessionId: 'sess-001',
  userId: 'user-001',
  question: 'What is quantum computing?',
}

beforeAll(() => {
  Object.assign(process.env, ENV)
})

afterEach(() => {
  jest.useRealTimers()
})

function setupHappyPath() {
  ddbMock.reset()
  lambdaMock.reset()

  ddbMock.on(PutCommand).resolves({})
  ddbMock.on(UpdateCommand).resolves({})

  lambdaMock.on(InvokeCommand, { FunctionName: 'fn-decompose' }).resolves({
    Payload: payload(['query A', 'query B']),
  })
  lambdaMock.on(InvokeCommand, { FunctionName: 'fn-tavily' }).resolves({
    Payload: payload([{ url: 'https://a.com', title: 'A', snippet: 's', score: 0.9 }]),
  })
  lambdaMock.on(InvokeCommand, { FunctionName: 'fn-rank' }).resolves({
    Payload: payload(['https://a.com']),
  })
  lambdaMock.on(InvokeCommand, { FunctionName: 'fn-fetch' }).resolves({
    Payload: payload({ url: 'https://a.com', content: 'Page content' }),
  })
  lambdaMock.on(InvokeCommand, { FunctionName: 'fn-extract' }).resolves({
    Payload: payload({ url: 'https://a.com', keyPoints: ['kp1'], relevance: 0.8, conflictsFound: false }),
  })
  lambdaMock.on(InvokeCommand, { FunctionName: 'fn-synthesize' }).resolves({
    Payload: payload({ report: '# Report\n\nDone.' }),
  })
  lambdaMock.on(InvokeCommand, { FunctionName: 'fn-persist' }).resolves({
    Payload: payload({ reportKey: 'reports/user-001/sess-001/report.md' }),
  })
}

describe('researchOrchestrator', () => {
  it('emits events in correct order during happy path', async () => {
    setupHappyPath()

    await handler(BASE_INPUT)

    const emittedTypes = ddbMock
      .commandCalls(PutCommand)
      .map((c) => c.args[0].input.Item?.['type'])

    expect(emittedTypes).toEqual(
      expect.arrayContaining([
        'DECOMPOSING',
        'SEARCHING',
        'RANKING_SOURCES',
        'FETCHING_PAGE',
        'EXTRACTING',
        'SYNTHESIZING',
        'COMPLETE',
      ]),
    )

    const idx = (t: string) => emittedTypes.indexOf(t)
    expect(idx('DECOMPOSING')).toBeLessThan(idx('SEARCHING'))
    expect(idx('SEARCHING')).toBeLessThan(idx('RANKING_SOURCES'))
    expect(idx('RANKING_SOURCES')).toBeLessThan(idx('COMPLETE'))
  })

  it('sets session to running at start and complete at end', async () => {
    setupHappyPath()

    await handler(BASE_INPUT)

    const statuses = ddbMock
      .commandCalls(UpdateCommand)
      .map((u) => u.args[0].input.ExpressionAttributeValues?.[':s'])

    expect(statuses[0]).toBe('running')
    expect(statuses[statuses.length - 1]).toBe('complete')
  })

  it('invokes all seven activity Lambdas in a successful run', async () => {
    setupHappyPath()

    await handler(BASE_INPUT)

    const invoked = lambdaMock
      .commandCalls(InvokeCommand)
      .map((c) => c.args[0].input.FunctionName)

    expect(invoked).toContain('fn-decompose')
    expect(invoked).toContain('fn-tavily')
    expect(invoked).toContain('fn-rank')
    expect(invoked).toContain('fn-fetch')
    expect(invoked).toContain('fn-extract')
    expect(invoked).toContain('fn-synthesize')
    expect(invoked).toContain('fn-persist')
  })

  it('emits PARTIAL_COMPLETE and sets partial-complete status when search calls fail', async () => {
    jest.useFakeTimers()
    setupHappyPath()

    // First tavily call (query A) succeeds; all subsequent calls (query B + retries) fail
    let tavilyCallCount = 0
    lambdaMock.on(InvokeCommand, { FunctionName: 'fn-tavily' }).callsFake(() => {
      tavilyCallCount++
      if (tavilyCallCount === 1) {
        return { Payload: payload([{ url: 'https://a.com', title: 'A', snippet: 's', score: 0.9 }]) }
      }
      throw new Error('Tavily timeout')
    })

    const p = handler(BASE_INPUT)
    await jest.advanceTimersByTimeAsync(15_000)
    await p

    const emittedTypes = ddbMock
      .commandCalls(PutCommand)
      .map((c) => c.args[0].input.Item?.['type'])
    expect(emittedTypes).toContain('PARTIAL_COMPLETE')

    const statuses = ddbMock
      .commandCalls(UpdateCommand)
      .map((u) => u.args[0].input.ExpressionAttributeValues?.[':s'])
    expect(statuses[statuses.length - 1]).toBe('partial-complete')
  })

  it('emits PARTIAL_COMPLETE when some extraction calls fail', async () => {
    jest.useFakeTimers()
    setupHappyPath()

    // Return 2 URLs so we have 2 pages to extract from
    lambdaMock.on(InvokeCommand, { FunctionName: 'fn-rank' }).resolves({
      Payload: payload(['https://a.com', 'https://b.com']),
    })
    let fetchCount = 0
    lambdaMock.on(InvokeCommand, { FunctionName: 'fn-fetch' }).callsFake(() => {
      fetchCount++
      return {
        Payload: payload({ url: fetchCount === 1 ? 'https://a.com' : 'https://b.com', content: 'Content' }),
      }
    })

    // First 3 extract calls (page 0 + retries) fail; 4th call (page 1) succeeds
    let extractCount = 0
    lambdaMock.on(InvokeCommand, { FunctionName: 'fn-extract' }).callsFake(() => {
      extractCount++
      if (extractCount <= 3) throw new Error('Extract failed')
      return {
        Payload: payload({ url: 'https://b.com', keyPoints: ['kp'], relevance: 0.7, conflictsFound: false }),
      }
    })

    const p = handler(BASE_INPUT)
    await jest.advanceTimersByTimeAsync(15_000)
    await p

    const emittedTypes = ddbMock
      .commandCalls(PutCommand)
      .map((c) => c.args[0].input.Item?.['type'])
    expect(emittedTypes).toContain('PARTIAL_COMPLETE')
  })

  it('emits ERROR and sets session to failed when orchestration cannot continue', async () => {
    jest.useFakeTimers()
    setupHappyPath()

    lambdaMock.on(InvokeCommand, { FunctionName: 'fn-decompose' }).rejects(new Error('Decompose failed'))

    const p = handler(BASE_INPUT)
    p.catch(() => {}) // suppress unhandled-rejection warning while timers advance
    await jest.advanceTimersByTimeAsync(15_000)

    await expect(p).rejects.toThrow('Decompose failed')

    const emittedTypes = ddbMock
      .commandCalls(PutCommand)
      .map((c) => c.args[0].input.Item?.['type'])
    expect(emittedTypes).toContain('ERROR')

    const statuses = ddbMock
      .commandCalls(UpdateCommand)
      .map((u) => u.args[0].input.ExpressionAttributeValues?.[':s'])
    expect(statuses).toContain('failed')
  })
})
