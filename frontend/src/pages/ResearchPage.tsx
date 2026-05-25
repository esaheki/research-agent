import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { EventStream } from '../components/EventStream/EventStream'
import { ReportViewer } from '../components/ReportViewer/ReportViewer'
import { SplitPane } from '../components/SplitPane/SplitPane'
import { useIsMobile } from '../hooks/useMobile'
import { useResearch } from '../hooks/useResearch'

interface CancelModalProps {
  onConfirm: () => void
  onCancel: () => void
}

function CancelModal({ onConfirm, onCancel }: CancelModalProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--color-surface)',
          borderRadius: '8px',
          padding: '24px',
          maxWidth: '360px',
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>
          Cancel current research session?
        </h2>
        <p style={{ color: 'var(--color-text-secondary)', marginBottom: '20px', fontSize: '14px' }}>
          The ongoing research will be cancelled and a new session will start.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Keep current
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            Cancel &amp; start new
          </button>
        </div>
      </div>
    </div>
  )
}

interface ResearchPageProps {
  onLogout: () => void
}

export function ResearchPage({ onLogout }: ResearchPageProps) {
  const { submit, sessionId, events, report, isRunning, isPartial, error, cancel } = useResearch()
  const isMobile = useIsMobile()
  const [question, setQuestion] = useState('')
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const q = question.trim()
      if (!q) return

      if (isRunning) {
        setPendingQuestion(q)
        setShowCancelModal(true)
        return
      }

      setIsSubmitting(true)
      await submit(q)
      setIsSubmitting(false)
    },
    [question, isRunning, submit],
  )

  const handleCancelConfirm = useCallback(async () => {
    setShowCancelModal(false)
    if (pendingQuestion) {
      await cancel()
      setIsSubmitting(true)
      await submit(pendingQuestion)
      setIsSubmitting(false)
      setPendingQuestion(null)
    }
  }, [cancel, pendingQuestion, submit])

  const handleCancelDismiss = useCallback(() => {
    setShowCancelModal(false)
    setPendingQuestion(null)
  }, [])

  const isStarting = isSubmitting || (sessionId !== null && events.length === 0 && isRunning)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <header
        style={{
          padding: isMobile ? '10px 16px' : '12px 20px',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: isMobile ? '15px' : '18px', fontWeight: 700, flex: 1 }}>
          Research Agent
        </h1>
        <nav style={{ display: 'flex', gap: isMobile ? '8px' : '12px', alignItems: 'center' }}>
          <Link to="/research/history" style={{ color: 'var(--color-primary)', fontSize: '13px' }}>
            History
          </Link>
          <button className="btn btn-secondary btn-sm" onClick={onLogout}>
            Sign out
          </button>
        </nav>
      </header>

      {/* Question input */}
      <div
        style={{
          padding: isMobile ? '12px 16px' : '16px 20px',
          borderBottom: '1px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            gap: '8px',
          }}
        >
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a research question..."
            disabled={isSubmitting}
            style={{ flex: 1 }}
            className="input"
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting || !question.trim()}
            style={isMobile ? { width: '100%' } : undefined}
          >
            {isRunning ? 'New Research' : 'Research'}
          </button>
        </form>

        {error && (
          <p style={{ color: 'var(--color-error)', fontSize: '13px', marginTop: '8px' }}>
            Error: {error}
          </p>
        )}

        {isStarting && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '13px', marginTop: '8px' }}>
            Starting research...
          </p>
        )}
      </div>

      {/* Main split-pane area */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <SplitPane
          left={<EventStream events={events} />}
          right={<ReportViewer markdown={report} isPartial={isPartial} />}
          defaultSplit={0.4}
        />
      </div>

      {showCancelModal && (
        <CancelModal onConfirm={() => void handleCancelConfirm()} onCancel={handleCancelDismiss} />
      )}
    </div>
  )
}
