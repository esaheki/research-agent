import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { handleCallback } from '../lib/cognito'

export function CallbackPage() {
  const navigate = useNavigate()
  const handledRef = useRef(false)

  useEffect(() => {
    // Guard against StrictMode double-invocation
    if (handledRef.current) return
    handledRef.current = true

    void (async () => {
      const tokens = await handleCallback()
      if (tokens) {
        navigate('/research', { replace: true })
      } else {
        navigate('/research?error=auth_failed', { replace: true })
      }
    })()
  }, [navigate])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      <div className="spinner" />
      <p style={{ color: 'var(--color-text-secondary)' }}>Completing sign in...</p>
    </div>
  )
}
