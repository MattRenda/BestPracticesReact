import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, AuthError, setToken } from './api'
import type { AgentStatus, Stats } from './types'
import { SwipeView } from './views/SwipeView'
import { ReviewView } from './views/ReviewView'
import { Pipeline } from './views/Pipeline'
import { ProfileView } from './views/ProfileView'
import { AnswersView } from './views/AnswersView'
import { SettingsView } from './views/SettingsView'

type View = 'swipe' | 'review' | 'applications' | 'profile' | 'answers' | 'settings'
const VIEWS: View[] = ['swipe', 'review', 'applications', 'profile', 'answers', 'settings']

const NAV: { id: View; label: string; icon: ReactNode }[] = [
  { id: 'swipe', label: 'Swipe', icon: <path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="2" /> },
  { id: 'review', label: 'Review', icon: <path d="M4 12l5 5L20 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /> },
  { id: 'applications', label: 'Applied', icon: <path d="M4 20h16M7 20v-6M12 20V8M17 20v-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /> },
  { id: 'profile', label: 'Profile', icon: <><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></> },
  { id: 'settings', label: 'Settings', icon: <><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></> },
]

function readView(): View {
  const h = location.hash.slice(1) as View
  return VIEWS.includes(h) ? h : 'swipe'
}

export default function App() {
  const [view, setView] = useState<View>(readView)
  const [stats, setStats] = useState<Stats | null>(null)
  const [agent, setAgent] = useState<AgentStatus | null>(null)
  const [needAuth, setNeedAuth] = useState(false)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(() => {
    api.stats().then(
      (s) => {
        setStats(s)
        setOffline(false)
        setNeedAuth(false)
      },
      (e) => (e instanceof AuthError ? setNeedAuth(true) : setOffline(true)),
    )
    api.agent().then(setAgent, () => {})
  }, [])

  useEffect(() => {
    refresh()
    const poll = setInterval(() => document.visibilityState === 'visible' && refresh(), 8000)
    const onHash = () => setView(readView())
    window.addEventListener('hashchange', onHash)
    return () => {
      clearInterval(poll)
      window.removeEventListener('hashchange', onHash)
    }
  }, [refresh])

  if (needAuth) return <AccessCode onDone={refresh} />

  const badge = (id: View) => (id === 'review' && stats ? stats.needsYou + stats.review : 0)

  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="#swipe">
          <img src="/sprout.svg" alt="" width={28} height={28} />
          <span>Sprout</span>
        </a>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} aria-current={view === n.id || (n.id === 'profile' && view === 'answers') ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                {n.icon}
              </svg>
              <span>{n.label}</span>
              {badge(n.id) > 0 && <span className="badge">{badge(n.id)}</span>}
            </a>
          ))}
        </nav>
        {stats && (
          <p className="rail-stat">
            <strong>{stats.appliedThisWeek}</strong> applied in the last 7 days
            <span className="rail-ai">{stats.ai ? 'Claude is writing your materials' : 'Templates only — add ANTHROPIC_API_KEY on the server for tailored writing'}</span>
          </p>
        )}
      </aside>
      <main className="main">
        {offline && (
          <div className="banner" role="alert">
            Can’t reach the Sprout server. Start it with <code>npm start</code>, then reload.
          </div>
        )}
        {view === 'swipe' && <SwipeView stats={stats} agent={agent} onChange={refresh} />}
        {view === 'review' && <ReviewView onChange={refresh} />}
        {view === 'applications' && <Pipeline onChange={refresh} />}
        {view === 'profile' && <ProfileView />}
        {view === 'answers' && <AnswersView />}
        {view === 'settings' && <SettingsView onChange={refresh} />}
      </main>
    </div>
  )
}

function AccessCode({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    setToken(code.trim())
    try {
      await api.stats()
      onDone()
    } catch (err) {
      setError(err instanceof AuthError ? 'That code doesn’t match SPROUT_TOKEN on the server.' : (err as Error).message)
    }
  }
  return (
    <main className="gate">
      <form onSubmit={submit}>
        <img src="/sprout.svg" alt="" width={48} height={48} />
        <h1>Sprout</h1>
        <label className="field">
          <span>Access code</span>
          <input type="password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} autoComplete="current-password" />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={!code.trim()}>
          Unlock
        </button>
      </form>
    </main>
  )
}
