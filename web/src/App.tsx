import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'
import type { Me } from './types'
import { Landing, SignIn } from './views/Landing'
import { Discover } from './views/Discover'
import { Applications } from './views/Applications'
import { DevProfileView } from './views/DevProfile'
import { AdminView } from './views/Admin'
import { Privacy, Terms } from './views/Legal'

/** Hash routes: #/discover, #/applications, #/profile, #/admin, #/signin/<token> */
function readRoute() {
  const [page = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/')
  return { page, arg }
}

const ICONS: Record<string, ReactNode> = {
  discover: <path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="2" />,
  applications: (
    <>
      <path d="M6 3h9l4 4v14H6V3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 21c1-4 4-6 8-6s7 2 8 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  admin: <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [route, setRoute] = useState(readRoute)
  const [offline, setOffline] = useState(false)

  const refresh = useCallback(
    () =>
      api.me().then(
        (m) => {
          setMe(m)
          setOffline(false)
        },
        () => setOffline(true),
      ),
    [],
  )

  useEffect(() => {
    refresh()
    const onHash = () => {
      setRoute(readRoute())
      refresh()
    }
    window.addEventListener('hashchange', onHash)
    const poll = setInterval(() => document.visibilityState === 'visible' && refresh(), 15_000)
    return () => {
      window.removeEventListener('hashchange', onHash)
      clearInterval(poll)
    }
  }, [refresh])

  // Public pages at real paths (Google's sign-in screen links to these)
  if (location.pathname === '/privacy') return <Privacy />
  if (location.pathname === '/terms') return <Terms />
  if (route.page === 'signin' && route.arg) return <SignIn token={route.arg} onDone={refresh} />
  if (!me) return offline ? <p className="pad">Can’t reach HireMe right now. Check your connection and reload.</p> : null
  if (!me.user) return <Landing />

  const { user, counts } = me
  const tabs = ['discover', 'applications', 'profile', ...(user.isAdmin ? ['admin'] : [])]
  const labels: Record<string, string> = { discover: 'Discover', applications: 'Applications', profile: 'Profile', admin: 'Admin' }
  const badges: Record<string, number> = { applications: counts?.needsYou ?? 0, admin: counts?.openReports ?? 0 }

  // Old links to #/matches go to Applications. New developers set up their profile first.
  let page = route.page === 'matches' ? 'applications' : tabs.includes(route.page) ? route.page : 'discover'
  if (!me.profileComplete && page === 'discover') page = 'profile'
  const onboarding = !me.profileComplete

  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="#/discover">
          <img src="/hireme.svg" alt="" width={30} height={30} />
          <span>HireMe</span>
        </a>
        <nav aria-label="Main">
          {tabs.map((t) => (
            <a key={t} href={`#/${t}`} aria-current={page === t ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                {ICONS[t]}
              </svg>
              <span>{labels[t]}</span>
              {badges[t] > 0 && <span className="badge">{badges[t]}</span>}
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          <p className="rail-who">
            {me.profile?.name || 'Developer'}
            <span>{user.email}</span>
          </p>
          <button
            className="link-btn"
            onClick={async () => {
              await api.logout()
              location.hash = ''
              refresh()
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        {offline && (
          <div className="banner" role="alert">
            Can’t reach HireMe right now. We’ll keep trying.
          </div>
        )}
        {page === 'discover' && <Discover onChange={refresh} />}
        {page === 'applications' && <Applications onChange={refresh} />}
        {page === 'profile' && <DevProfileView onboarding={onboarding} onSaved={refresh} />}
        {page === 'admin' && user.isAdmin && <AdminView onChange={refresh} />}
      </main>
    </div>
  )
}
