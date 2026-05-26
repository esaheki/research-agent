import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import type { SessionSummary } from '../lib/types'

const STATUS_COLORS: Record<SessionSummary['status'], string> = {
  complete: '#22c55e',
  'partial-complete': '#eab308',
  failed: '#ef4444',
  cancelled: '#9ca3af',
  pending: '#3b82f6',
  running: '#3b82f6',
}

const STATUS_LABELS: Record<SessionSummary['status'], string> = {
  complete: 'Complete',
  'partial-complete': 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Pending',
  running: 'Running',
}

function StatusBadge({ status }: { status: SessionSummary['status'] }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '11px',
        fontWeight: 600,
        background: STATUS_COLORS[status] + '22',
        color: STATUS_COLORS[status],
        border: `1px solid ${STATUS_COLORS[status]}55`,
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

export function HistoryPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.listSessions()
        setSessions(data.sessions)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load history')
      } finally {
        setIsLoading(false)
      }
    })()
  }, [])

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '24px 20px', minHeight: '100dvh', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <Link to="/research" style={{ color: 'var(--color-primary)', fontSize: '14px' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>Research History</h1>
      </div>

      {isLoading && (
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading history...</p>
      )}

      {error && (
        <p style={{ color: 'var(--color-error)' }}>Error: {error}</p>
      )}

      {!isLoading && !error && sessions.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '48px 20px',
            color: 'var(--color-text-secondary)',
          }}
        >
          <p style={{ fontSize: '16px' }}>No research sessions yet.</p>
          <Link to="/research" className="btn btn-primary" style={{ marginTop: '16px', display: 'inline-block' }}>
            Start your first research
          </Link>
        </div>
      )}

      {sessions.map((session) => (
        <Link
          key={session.sessionId}
          to={`/research/session/${session.sessionId}`}
          style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
          <div
            style={{
              padding: '14px 16px',
              marginBottom: '10px',
              borderRadius: '8px',
              background: 'var(--color-card-bg)',
              border: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              transition: 'border-color 0.15s',
            }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-primary)'
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-border)'
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {session.question}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                {new Date(session.startedAt).toLocaleString()}
              </p>
            </div>
            <StatusBadge status={session.status} />
          </div>
        </Link>
      ))}
    </div>
  )
}
