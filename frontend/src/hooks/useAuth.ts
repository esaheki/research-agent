import { useEffect, useState } from 'react'
import { clearTokens, getStoredTokens, getUserIdFromToken, redirectToLogin, redirectToLogout } from '../lib/cognito'

interface AuthState {
  isAuthenticated: boolean
  userId: string | null
  idToken: string | null
  isLoading: boolean
}

export function useAuth(): AuthState & { logout: () => void } {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    userId: null,
    idToken: null,
    isLoading: true,
  })

  useEffect(() => {
    const tokens = getStoredTokens()

    if (!tokens) {
      setState({ isAuthenticated: false, userId: null, idToken: null, isLoading: false })
      return
    }

    if (Date.now() >= tokens.expiresAt) {
      clearTokens()
      setState({ isAuthenticated: false, userId: null, idToken: null, isLoading: false })
      void redirectToLogin()
      return
    }

    const userId = getUserIdFromToken(tokens.idToken)
    setState({
      isAuthenticated: true,
      userId,
      idToken: tokens.idToken,
      isLoading: false,
    })
  }, [])

  function logout(): void {
    redirectToLogout()
  }

  return { ...state, logout }
}
