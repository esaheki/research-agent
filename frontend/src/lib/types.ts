export type ResearchEvent =
  | { type: 'DECOMPOSING'; payload: { question: string } }
  | { type: 'SEARCHING'; payload: { query: string; queryIndex: number } }
  | { type: 'RANKING_SOURCES'; payload: Record<string, never> }
  | { type: 'FETCHING_PAGE'; payload: { url: string; domain: string; pageIndex: number } }
  | { type: 'EXTRACTING'; payload: { url: string; pageIndex: number } }
  | { type: 'THINKING_CHUNK'; payload: { text: string } }
  | { type: 'REPORT_CHUNK'; payload: { markdown: string } }
  | { type: 'SYNTHESIZING'; payload: Record<string, never> }
  | { type: 'COMPLETE'; payload: { sessionId: string } }
  | { type: 'PARTIAL_COMPLETE'; payload: { sessionId: string; failedSteps: string[] } }
  | { type: 'ERROR'; payload: { step: string; message: string } }

export interface SessionSummary {
  sessionId: string
  question: string
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled' | 'partial-complete'
  startedAt: string
}

export interface SessionDetail extends SessionSummary {
  reportMarkdown?: string
  reportUrl?: string
  completedAt?: string
}
