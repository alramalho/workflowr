import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3847'
const TOKEN_KEY = 'workflowr_token'

interface User {
  slackUserId: string
  teamId: string
  name: string
}

interface AuthContextType {
  user: User | null
  token: string | null
  loading: boolean
  logout: () => void
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  loading: true,
  logout: () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check for token in URL (redirect from OAuth)
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get('token')
    if (urlToken) {
      localStorage.setItem(TOKEN_KEY, urlToken)
      window.history.replaceState({}, '', window.location.pathname)
    }

    const stored = urlToken ?? localStorage.getItem(TOKEN_KEY)
    if (!stored) {
      setLoading(false)
      return
    }

    // Validate token
    fetch(`${API_URL}/auth/web/me`, {
      headers: { Authorization: `Bearer ${stored}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error('Invalid token')
        return r.json()
      })
      .then((data: User) => {
        setUser(data)
        setToken(stored)
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY)
      })
      .finally(() => setLoading(false))
  }, [])

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY)
    setUser(null)
    setToken(null)
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function LoginScreen() {
  return (
    <div className="app loading-screen" style={{ flexDirection: 'column', gap: '16px' }}>
      <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Sign in to continue</span>
      <a
        href={`${API_URL}/auth/web/start`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 16px',
          background: 'var(--bg-hover)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          textDecoration: 'none',
          fontSize: '13px',
          cursor: 'pointer',
        }}
      >
        Sign in with Slack
      </a>
    </div>
  )
}
