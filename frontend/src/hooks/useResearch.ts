import { useCallback, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { ResearchEvent } from '../lib/types'
import { useAuth } from './useAuth'
import { useWebSocket } from './useWebSocket'

interface UseResearchReturn {
  submit: (question: string) => Promise<void>
  sessionId: string | null
  events: ResearchEvent[]
  report: string
  isRunning: boolean
  isPartial: boolean
  error: string | null
  cancel: () => Promise<void>
}

const TERMINAL_EVENTS = new Set(['COMPLETE', 'PARTIAL_COMPLETE', 'ERROR'])

export function useResearch(): UseResearchReturn {
  const { idToken } = useAuth()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { events } = useWebSocket(sessionId, idToken)

  const report = useMemo(() => {
    return events
      .filter((e): e is Extract<ResearchEvent, { type: 'REPORT_CHUNK' }> => e.type === 'REPORT_CHUNK')
      .map((e) => e.payload.markdown)
      .join('')
  }, [events])

  const isRunning = useMemo(() => {
    if (!sessionId) return false
    const hasTerminal = events.some((e) => TERMINAL_EVENTS.has(e.type))
    return !hasTerminal
  }, [sessionId, events])

  const isPartial = useMemo(() => {
    return events.some((e) => e.type === 'PARTIAL_COMPLETE')
  }, [events])

  const submit = useCallback(
    async (question: string) => {
      setError(null)
      try {
        const { sessionId: newSessionId } = await api.startResearch(question)
        setSessionId(newSessionId)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to start research'
        setError(message)
      }
    },
    [],
  )

  const cancel = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.cancelResearch(sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel research'
      setError(message)
    }
  }, [sessionId])

  return { submit, sessionId, events, report, isRunning, isPartial, error, cancel }
}
