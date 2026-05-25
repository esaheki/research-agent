import { useEffect, useMemo, useRef, useState } from 'react'
import type { ResearchEvent } from '../../lib/types'

interface EventStreamProps {
  events: ResearchEvent[]
}

function getCardStyle(type: ResearchEvent['type']): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '10px 14px',
    marginBottom: '8px',
    borderRadius: '6px',
    background: 'var(--color-card-bg)',
    borderLeft: '4px solid',
    fontSize: '13px',
    lineHeight: '1.5',
  }

  switch (type) {
    case 'DECOMPOSING':
      return { ...base, borderLeftColor: '#6b7280' }
    case 'SEARCHING':
      return { ...base, borderLeftColor: '#3b82f6' }
    case 'RANKING_SOURCES':
      return { ...base, borderLeftColor: '#8b5cf6' }
    case 'FETCHING_PAGE':
      return { ...base, borderLeftColor: '#8b5cf6' }
    case 'EXTRACTING':
      return { ...base, borderLeftColor: '#8b5cf6' }
    case 'SYNTHESIZING':
      return { ...base, borderLeftColor: '#f97316' }
    case 'THINKING_CHUNK':
      return { ...base, borderLeftColor: '#f97316' }
    case 'COMPLETE':
      return { ...base, borderLeftColor: '#22c55e', background: 'var(--color-success-bg)' }
    case 'PARTIAL_COMPLETE':
      return { ...base, borderLeftColor: '#eab308', background: 'var(--color-warning-bg)' }
    case 'ERROR':
      return { ...base, borderLeftColor: '#ef4444', background: 'var(--color-error-bg)' }
    default:
      return base
  }
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ marginTop: '8px' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-text-secondary)',
          fontSize: '12px',
          padding: '0',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <span>{expanded ? '▼' : '▶'}</span>
        <span>Thinking... ({text.length} chars)</span>
      </button>
      {expanded && (
        <pre
          style={{
            marginTop: '6px',
            padding: '8px',
            background: 'var(--color-code-bg)',
            borderRadius: '4px',
            fontSize: '11px',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--color-text-secondary)',
            maxHeight: '300px',
            overflowY: 'auto',
          }}
        >
          {text}
        </pre>
      )}
    </div>
  )
}

export function EventStream({ events }: EventStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  // Build display-friendly event list: merge THINKING_CHUNKs into SYNTHESIZING cards
  const displayItems = useMemo(() => {
    type DisplayItem =
      | { kind: 'event'; event: ResearchEvent }
      | { kind: 'synthesizing-with-thinking'; synthesizingEvent: ResearchEvent; thinkingText: string }

    const items: DisplayItem[] = []
    let lastSynthesizingIndex = -1

    for (const event of events) {
      if (event.type === 'REPORT_CHUNK') {
        // not shown in event stream
        continue
      }
      if (event.type === 'THINKING_CHUNK') {
        // Merge into most recent SYNTHESIZING card
        if (lastSynthesizingIndex >= 0) {
          const existing = items[lastSynthesizingIndex]
          if (existing.kind === 'synthesizing-with-thinking') {
            items[lastSynthesizingIndex] = {
              kind: 'synthesizing-with-thinking',
              synthesizingEvent: existing.synthesizingEvent,
              thinkingText: existing.thinkingText + event.payload.text,
            }
          }
        }
        continue
      }
      if (event.type === 'SYNTHESIZING') {
        lastSynthesizingIndex = items.length
        items.push({ kind: 'synthesizing-with-thinking', synthesizingEvent: event, thinkingText: '' })
        continue
      }
      items.push({ kind: 'event', event })
    }

    return items
  }, [events])

  function renderEventContent(event: ResearchEvent): React.ReactNode {
    switch (event.type) {
      case 'DECOMPOSING':
        return <span>Decomposing question...</span>
      case 'SEARCHING':
        return <span>Searching: <em>{event.payload.query}</em></span>
      case 'RANKING_SOURCES':
        return <span>Ranking sources...</span>
      case 'FETCHING_PAGE':
        return <span>Fetching <strong>{event.payload.domain}</strong>...</span>
      case 'EXTRACTING':
        return <span>Extracting insights from {event.payload.url}...</span>
      case 'COMPLETE':
        return <span>&#10003; Complete</span>
      case 'PARTIAL_COMPLETE':
        return <span>&#9888; Partial Complete</span>
      case 'ERROR':
        return <span>&#10007; Error: {event.payload.message}</span>
      default:
        return null
    }
  }

  return (
    <div
      style={{
        padding: '12px',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <h2 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--color-text-secondary)' }}>
        Research Progress
      </h2>

      {displayItems.map((item, idx) => {
        if (item.kind === 'synthesizing-with-thinking') {
          return (
            <div key={idx} style={getCardStyle('SYNTHESIZING')}>
              <span>Synthesizing report...</span>
              {item.thinkingText && <ThinkingBlock text={item.thinkingText} />}
            </div>
          )
        }
        return (
          <div key={idx} style={getCardStyle(item.event.type)}>
            {renderEventContent(item.event)}
          </div>
        )
      })}

      <div ref={bottomRef} />
    </div>
  )
}
