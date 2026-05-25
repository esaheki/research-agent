import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface SplitPaneProps {
  left: ReactNode
  right: ReactNode
  defaultSplit?: number // 0-1, fraction for left panel
}

export function SplitPane({ left, right, defaultSplit = 0.4 }: SplitPaneProps) {
  const [splitFraction, setSplitFraction] = useState(defaultSplit)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

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
