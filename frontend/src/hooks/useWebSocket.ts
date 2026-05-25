import { useEffect, useRef, useState } from 'react'
import { config } from '../lib/config'
import type { ResearchEvent } from '../lib/types'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

export function useWebSocket(
  sessionId: string | null,
  idToken: string | null,
): {
  events: ResearchEvent[]
  isConnected: boolean
} {
  const [events, setEvents] = useState<ResearchEvent[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const retriesRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    // Reset events when sessionId changes
    if (sessionId !== sessionIdRef.current) {
      setEvents([])
      sessionIdRef.current = sessionId
    }

    if (!sessionId || !idToken) {
      return
    }

    retriesRef.current = 0

    function connect(): void {
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }

      const url = `${config.wsApiUrl}?token=${encodeURIComponent(idToken!)}&sessionId=${encodeURIComponent(sessionId!)}`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setIsConnected(true)
        retriesRef.current = 0
      }

      ws.onmessage = (evt: MessageEvent<string>) => {
        try {
          const event = JSON.parse(evt.data) as ResearchEvent
          setEvents((prev) => [...prev, event])
        } catch {
          // ignore malformed messages
        }
      }

      ws.onerror = () => {
        // onerror always precedes onclose; handle reconnection in onclose
      }

      ws.onclose = () => {
        setIsConnected(false)
        wsRef.current = null
        if (retriesRef.current < MAX_RETRIES) {
          retriesRef.current += 1
          retryTimerRef.current = setTimeout(connect, RETRY_DELAY_MS)
        }
      }
    }

    connect()

    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
      setIsConnected(false)
    }
  }, [sessionId, idToken])

  return { events, isConnected }
}
