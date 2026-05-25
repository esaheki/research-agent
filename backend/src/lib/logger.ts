export interface LogEntry {
  step: string
  sessionId?: string
  userId?: string
  durationMs?: number
  [key: string]: unknown
}

export function log(entry: LogEntry): void {
  console.log(JSON.stringify({ ...entry, ts: new Date().toISOString() }))
}

/** Returns a function that logs the step name + elapsed ms when called. */
export function timer(step: string, meta?: Omit<LogEntry, 'step' | 'durationMs'>): () => void {
  const start = Date.now()
  return () => log({ ...meta, step, durationMs: Date.now() - start })
}
