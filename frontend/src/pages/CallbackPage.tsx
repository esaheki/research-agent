import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { handleCallback } from '../lib/cognito'

export function CallbackPage() {
  const navigate = useNavigate()
  const handledRef = useRef(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (handledRef.current) return
    handledRef.current = true

    const params = new URLSearchParams(window.location.search)
    const hasCode = params.has('code')

    void (async () => {
      const tokens = await handleCallback()
      if (tokens) {
        navigate('/research', { replace: true })
      } else if (hasCode) {
        // Auth code was present but token exchange was blocked — account is pending approval.
        setPending(true)
      } else {
        navigate('/research', { replace: true })
      }
    })()
  }, [navigate])

  if (pending) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          flexDirection: 'column',
          gap: '16px',
          textAlign: 'center',
          padding: '0 24px',
        }}
      >
        <p style={{ fontSize: '2rem' }}>⏳</p>
        <h2 style={{ margin: 0 }}>Account pending approval</h2>
        <p style={{ color: 'var(--color-text-secondary)', maxWidth: '400px' }}>
          Your account has been registered and the admin has been notified. You'll be able to sign
          in once your account is approved.
        </p>
      </div>
    )
  }

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
