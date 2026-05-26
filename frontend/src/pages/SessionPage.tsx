import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ReportViewer } from '../components/ReportViewer/ReportViewer'
import { useIsMobile } from '../hooks/useMobile'
import { api } from '../lib/api'
import type { SessionDetail } from '../lib/types'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

function ChatPanel({ sessionId, isMobile }: { sessionId: string; isMobile: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || isLoading) return

    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setInput('')
    setIsLoading(true)

    try {
      const { message } = await api.chat(sessionId, text)
      setMessages((prev) => [...prev, { role: 'assistant', content: message }])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to get response'
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${errMsg}` }])
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div
      style={{
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        height: isMobile ? '45vh' : '320px',
      }}
    >
      <h2 style={{ margin: '12px 16px', fontSize: '14px', fontWeight: 600 }}>Ask about this report</h2>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
        {messages.length === 0 && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '13px' }}>
            Ask a follow-up question about the report above.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: '12px',
              display: 'flex',
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
              gap: '8px',
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: '8px 12px',
                borderRadius: '8px',
                background: msg.role === 'user' ? 'var(--color-primary)' : 'var(--color-card-bg)',
                color: msg.role === 'user' ? '#fff' : 'inherit',
                fontSize: '13px',
                lineHeight: '1.5',
              }}
            >
              {msg.role === 'assistant' ? (
                <div className="chat-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '13px' }}>Thinking...</p>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => void handleSend(e)}
        style={{ padding: '10px 16px', display: 'flex', gap: '8px', borderTop: '1px solid var(--color-border)' }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question..."
          disabled={isLoading}
          className="input"
          style={{ flex: 1 }}
        />
        <button type="submit" className="btn btn-primary" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

export function SessionPage() {
  const { id } = useParams<{ id: string }>()
  const isMobile = useIsMobile()
  const [session, setSession] = useState<SessionDetail | null>(null)
  const [reportMarkdown, setReportMarkdown] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    void (async () => {
      try {
        const data = await api.getSession(id)
        setSession(data)

        // Fetch report markdown if available via URL
        if (data.reportUrl) {
          const res = await fetch(data.reportUrl)
          if (res.ok) {
            setReportMarkdown(await res.text())
          }
        } else if (data.reportMarkdown) {
          setReportMarkdown(data.reportMarkdown)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session')
      } finally {
        setIsLoading(false)
      }
    })()
  }, [id])

  if (isLoading) {
    return (
      <div style={{ padding: '24px' }}>
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading session...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '24px' }}>
        <p style={{ color: 'var(--color-error)' }}>Error: {error}</p>
        <Link to="/research/history">← Back to history</Link>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <header
        style={{
          padding: isMobile ? '10px 16px' : '12px 20px',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexShrink: 0,
        }}
      >
        <Link
          to="/research/history"
          style={{ color: 'var(--color-primary)', fontSize: '13px', flexShrink: 0 }}
        >
          ← History
        </Link>
        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? '13px' : '16px',
            fontWeight: 600,
            flex: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {session?.question ?? 'Research Session'}
        </h1>
      </header>

      {/* Report + Chat */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ReportViewer
            markdown={reportMarkdown}
            isPartial={session?.status === 'partial-complete'}
          />
        </div>
        {id && <ChatPanel sessionId={id} isMobile={isMobile} />}
      </div>
    </div>
  )
}
