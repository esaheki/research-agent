import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

interface ReportViewerProps {
  markdown: string
  isPartial?: boolean
}

// Custom paragraph renderer that highlights [CONFLICT] paragraphs
const components: Components = {
  p({ children, ...props }) {
    // Check if the paragraph starts with [CONFLICT]
    const childArray = Array.isArray(children) ? children : [children]
    const firstChild = childArray[0]
    const startsWithConflict =
      typeof firstChild === 'string' && firstChild.startsWith('[CONFLICT]')

    if (startsWithConflict) {
      return (
        <p
          {...props}
          style={{
            background: 'var(--color-conflict-bg)',
            border: '1px solid var(--color-conflict-border)',
            borderLeft: '4px solid var(--color-conflict-border)',
            borderRadius: '4px',
            padding: '10px 14px',
            margin: '12px 0',
          }}
        >
          {children}
        </p>
      )
    }
    return <p {...props}>{children}</p>
  },
}

export function ReportViewer({ markdown, isPartial = false }: ReportViewerProps) {
  return (
    <div
      style={{
        padding: '16px 20px',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      {isPartial && (
        <div
          style={{
            background: 'var(--color-warning-bg)',
            border: '1px solid var(--color-warning-border)',
            borderRadius: '6px',
            padding: '10px 14px',
            marginBottom: '16px',
            color: 'var(--color-warning-text)',
            fontSize: '14px',
          }}
        >
          &#9888; This report may be incomplete due to errors during research.
        </div>
      )}

      {markdown ? (
        <div className="report-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {markdown}
          </ReactMarkdown>
        </div>
      ) : (
        <p style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
          Report will appear here as it's generated...
        </p>
      )}
    </div>
  )
}
