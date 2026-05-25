import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useIsMobile } from '../../hooks/useMobile'

interface SplitPaneProps {
  left: ReactNode
  right: ReactNode
  defaultSplit?: number // 0-1, fraction for left panel
  leftLabel?: string
  rightLabel?: string
}

export function SplitPane({
  left,
  right,
  defaultSplit = 0.4,
  leftLabel = 'Activity',
  rightLabel = 'Report',
}: SplitPaneProps) {
  const [splitFraction, setSplitFraction] = useState(defaultSplit)
  const [activeTab, setActiveTab] = useState<'left' | 'right'>('left')
  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const isMobile = useIsMobile()

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true

    function onMouseMove(event: MouseEvent) {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const fraction = (event.clientX - rect.left) / rect.width
      setSplitFraction(Math.max(0.15, Math.min(0.85, fraction)))
    }

    function onMouseUp() {
      isDragging.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Tab bar */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          {(['left', 'right'] as const).map((tab) => {
            const label = tab === 'left' ? leftLabel : rightLabel
            const isActive = activeTab === tab
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  flex: 1,
                  padding: '10px',
                  fontSize: '13px',
                  fontWeight: isActive ? 600 : 400,
                  background: 'none',
                  border: 'none',
                  borderBottom: isActive
                    ? '2px solid var(--color-primary)'
                    : '2px solid transparent',
                  color: isActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  transition: 'color 0.15s, border-color 0.15s',
                  marginBottom: '-1px',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* Active pane */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {activeTab === 'left' ? left : right}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Left pane */}
      <div
        style={{
          width: `${splitFraction * 100}%`,
          overflow: 'auto',
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        {left}
      </div>

      {/* Divider */}
      <div
        onMouseDown={onMouseDown}
        style={{
          width: '6px',
          cursor: 'col-resize',
          background: 'var(--color-divider)',
          flexShrink: 0,
          userSelect: 'none',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = 'var(--color-divider-hover)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = 'var(--color-divider)'
        }}
      />

      {/* Right pane */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          minWidth: 0,
        }}
      >
        {right}
      </div>
    </div>
  )
}
