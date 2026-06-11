import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { handleCallback, redirectToLogin } from '../lib/cognito'

type CallbackState = 'loading' | 'pending' | 'error'

export function CallbackPage() {
  const navigate = useNavigate()
  const handledRef = useRef(false)
  const [state, setState] = useState<CallbackState>('loading')

  useEffect(() => {
    if (handledRef.current) return
    handledRef.current = true

    const hasCode = new URLSearchParams(window.location.search).has('code')

    void (async () => {
      const result = await handleCallback()
      if (result && result !== 'pending') {
        navigate('/research', { replace: true })
      } else if (result === 'pending') {
        setState('pending')
      } else if (hasCode) {
        // A code was present but the exchange failed (expired code, missing verifier, etc.)
        setState('error')
      } else {
        navigate('/research', { replace: true })
      }
    })()
  }, [navigate])

  if (state === 'pending') {
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

  if (state === 'error') {
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
        <p style={{ fontSize: '2rem' }}>⚠️</p>
        <h2 style={{ margin: 0 }}>Sign-in failed</h2>
        <p style={{ color: 'var(--color-text-secondary)', maxWidth: '400px' }}>
          Something went wrong during sign-in. This can happen if the page was refreshed mid-flow.
        </p>
        <button
          onClick={() => void redirectToLogin()}
          style={{
            marginTop: '8px',
            padding: '10px 24px',
            borderRadius: '6px',
            border: 'none',
            background: 'var(--color-accent)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          Try signing in again
        </button>
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
