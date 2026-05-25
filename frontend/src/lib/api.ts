import { config } from './config'
import { getStoredTokens } from './cognito'
import type { SessionDetail, SessionSummary } from './types'

function getIdToken(): string {
  const tokens = getStoredTokens()
  if (!tokens) throw new Error('Not authenticated')
  return tokens.idToken
}

async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const idToken = getIdToken()
  const res = await fetch(`${config.httpApiUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
      ...(options?.headers ?? {}),
    },
  })
  return res
}

export const api = {
  async startResearch(question: string): Promise<{ sessionId: string }> {
    const res = await apiFetch('/research', {
      method: 'POST',
      body: JSON.stringify({ question }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to start research: ${res.status} ${text}`)
    }
    return res.json() as Promise<{ sessionId: string }>
  },

  async cancelResearch(sessionId: string): Promise<void> {
    const res = await apiFetch(`/research/${sessionId}`, { method: 'DELETE' })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to cancel research: ${res.status} ${text}`)
    }
  },

  async listSessions(): Promise<{ sessions: SessionSummary[] }> {
    const res = await apiFetch('/research/history')
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to list sessions: ${res.status} ${text}`)
    }
    return res.json() as Promise<{ sessions: SessionSummary[] }>
  },

  async getSession(sessionId: string): Promise<SessionDetail> {
    const res = await apiFetch(`/research/${sessionId}`)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to get session: ${res.status} ${text}`)
    }
    const body = (await res.json()) as { session: SessionDetail }
    return body.session
  },

  async chat(sessionId: string, message: string): Promise<{ message: string }> {
    const res = await apiFetch(`/research/${sessionId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to send chat: ${res.status} ${text}`)
    }
    return res.json() as Promise<{ message: string }>
  },
}
