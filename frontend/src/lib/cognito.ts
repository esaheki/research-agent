import { config } from './config'

interface Tokens {
  idToken: string
  accessToken: string
  refreshToken?: string
  expiresAt: number // unix ms
}

const TOKENS_KEY = 'research_agent_tokens'
const CODE_VERIFIER_KEY = 'pkce_code_verifier'

// ---- PKCE helpers ----

function generateRandomString(length: number): string {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return base64urlEncode(array)
}

function base64urlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let str = ''
  for (const byte of bytes) {
    str += String.fromCharCode(byte)
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder()
  const data = encoder.encode(plain)
  return crypto.subtle.digest('SHA-256', data)
}

// ---- Public API ----

export async function redirectToLogin(): Promise<void> {
  const codeVerifier = generateRandomString(64)
  sessionStorage.setItem(CODE_VERIFIER_KEY, codeVerifier)

  const hash = await sha256(codeVerifier)
  const codeChallenge = base64urlEncode(hash)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognitoClientId,
    redirect_uri: config.cognitoRedirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: 'openid email profile',
  })

  window.location.href = `https://${config.cognitoDomain}/oauth2/authorize?${params.toString()}`
}

export async function handleCallback(): Promise<Tokens | 'pending' | null> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  if (!code) return null

  const codeVerifier = sessionStorage.getItem(CODE_VERIFIER_KEY)
  if (!codeVerifier) return null

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.cognitoClientId,
    redirect_uri: config.cognitoRedirectUri,
    code,
    code_verifier: codeVerifier,
  })

  const res = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const errorText = await res.text()
    console.error('Token exchange failed', errorText)
    return errorText.includes('USER_PENDING_APPROVAL') ? 'pending' : null
  }

  // Remove only after a successful exchange so a page refresh during a slow
  // cold-start response doesn't permanently lose the verifier.
  sessionStorage.removeItem(CODE_VERIFIER_KEY)

  const data = (await res.json()) as {
    id_token: string
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  const tokens: Tokens = {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  storeTokens(tokens)
  return tokens
}

function storeTokens(tokens: Tokens): void {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens))
}

export function getStoredTokens(): Tokens | null {
  const raw = sessionStorage.getItem(TOKENS_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Tokens
  } catch {
    return null
  }
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY)
  sessionStorage.removeItem(CODE_VERIFIER_KEY)
}

export function redirectToLogout(): void {
  clearTokens()
  const params = new URLSearchParams({
    client_id: config.cognitoClientId,
    logout_uri: `${window.location.origin}/research`,
  })
  window.location.href = `https://${config.cognitoDomain}/logout?${params.toString()}`
}

export function getUserIdFromToken(idToken: string): string {
  try {
    const payload = idToken.split('.')[1]
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const parsed = JSON.parse(decoded) as { sub: string }
    return parsed.sub
  } catch {
    return ''
  }
}
