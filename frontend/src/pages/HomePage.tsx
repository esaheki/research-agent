import { useIsMobile } from '../hooks/useMobile'
import { redirectToLogin } from '../lib/cognito'

const FEATURES = [
  {
    icon: '🔍',
    title: 'Multi-angle search',
    body: 'Decomposes your question into sub-queries and searches across dozens of sources in parallel.',
  },
  {
    icon: '🧠',
    title: 'Extended thinking',
    body: "Claude Sonnet reasons step-by-step with extended thinking before writing, so the report reflects genuine analysis, not just retrieval.",
  },
  {
    icon: '📄',
    title: 'Structured reports',
    body: 'Every report includes an executive summary, key findings, detailed analysis, and flagged conflicts between sources.',
  },
  {
    icon: '💬',
    title: 'Follow-up chat',
    body: 'Ask questions about any completed report. Claude answers using the full report and all original source texts as context.',
  },
]

export function HomePage() {
  const isMobile = useIsMobile()
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
      }}
    >
      {/* Nav */}
      <nav
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: isMobile ? '14px 20px' : '16px 32px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}
      >
        <span style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.01em' }}>
          Research Agent
        </span>
        <button
          className="btn btn-primary"
          onClick={() => void redirectToLogin()}
          style={{ fontSize: '13px' }}
        >
          Sign in
        </button>
      </nav>

      {/* Hero */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <section
          style={{
            width: '100%',
            maxWidth: '680px',
            padding: isMobile ? '48px 20px 40px' : '80px 24px 64px',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              fontSize: isMobile ? '1.75rem' : '2.4rem',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 1.15,
              marginBottom: '20px',
            }}
          >
            Deep research,
            <br />
            <span style={{ color: 'var(--color-primary)' }}>done in minutes</span>
          </h1>

          <p
            style={{
              fontSize: '1.05rem',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.65,
              marginBottom: '36px',
              maxWidth: '520px',
              margin: '0 auto 36px',
            }}
          >
            Ask a question. An AI agent searches the web, reads the sources, and produces a
            structured report — streamed live as it thinks.
          </p>

          <button
            className="btn btn-primary"
            onClick={() => void redirectToLogin()}
            style={{ fontSize: '15px', padding: '12px 28px', borderRadius: '8px' }}
          >
            Get started →
          </button>
        </section>

        {/* Feature grid */}
        <section
          style={{
            width: '100%',
            maxWidth: '800px',
            padding: isMobile ? '0 16px 48px' : '0 24px 80px',
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '12px',
          }}
        >
          {FEATURES.map((f) => (
            <div
              key={f.title}
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: '10px',
                padding: '20px 22px',
                display: 'flex',
                gap: '14px',
                alignItems: 'flex-start',
              }}
            >
              <span style={{ fontSize: '1.4rem', lineHeight: 1, flexShrink: 0 }}>{f.icon}</span>
              <div>
                <p style={{ fontWeight: 600, marginBottom: '4px', fontSize: '13.5px' }}>
                  {f.title}
                </p>
                <p style={{ color: 'var(--color-text-secondary)', fontSize: '13px', lineHeight: 1.55 }}>
                  {f.body}
                </p>
              </div>
            </div>
          ))}
        </section>
      </main>

      {/* Footer */}
      <footer
        style={{
          textAlign: 'center',
          padding: '16px',
          color: 'var(--color-text-secondary)',
          fontSize: '12px',
          borderTop: '1px solid var(--color-border)',
        }}
      >
        Built by{' '}
        <a href="https://esaheki.com" style={{ color: 'var(--color-text-secondary)' }}>
          Elton Saheki
        </a>
      </footer>
    </div>
  )
}
