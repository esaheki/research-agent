import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import './index.css'
import { useAuth } from './hooks/useAuth'
import { redirectToLogin } from './lib/cognito'
import { CallbackPage } from './pages/CallbackPage'
import { HistoryPage } from './pages/HistoryPage'
import { HomePage } from './pages/HomePage'
import { ResearchPage } from './pages/ResearchPage'
import { SessionPage } from './pages/SessionPage'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void redirectToLogin()
    }
  }, [isAuthenticated, isLoading])

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '12px',
        }}
      >
        <div className="spinner" />
        <span style={{ color: 'var(--color-text-secondary)' }}>Loading...</span>
      </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  return <>{children}</>
}

function ResearchRoot() {
  const { isAuthenticated, isLoading, logout } = useAuth()

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '12px',
        }}
      >
        <div className="spinner" />
        <span style={{ color: 'var(--color-text-secondary)' }}>Loading...</span>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <HomePage />
  }

  return <ResearchPage onLogout={logout} />
}

function RedirectToResearch() {
  useEffect(() => {
    window.location.replace('/research')
  }, [])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/research/callback" element={<CallbackPage />} />
        <Route path="/research" element={<ResearchRoot />} />
        <Route
          path="/research/history"
          element={
            <PrivateRoute>
              <HistoryPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/research/session/:id"
          element={
            <PrivateRoute>
              <SessionPage />
            </PrivateRoute>
          }
        />
        <Route path="/" element={<RedirectToResearch />} />
      </Routes>
    </BrowserRouter>
  )
}
