import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import { GoogleButton } from '../components/GoogleButton'
import type { Me } from '../types'

/** Remember the home page in history, so the browser's back button returns here from the app. */
function leaveHomeFor(hash: string) {
  history.replaceState(null, '', '/#/home')
  location.hash = hash
}

/** The home page. Signed-out visitors start here; signed-in people can come back to it (#/home). */
export function Landing({ me, onStart }: { me?: Me; onStart: () => void }) {
  const user = me?.user ?? null
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // One way in for everyone. Typing an email doesn't stop you at "check your inbox": a guest session
  // starts and you go straight to the questions, while the link (confirm, or sign back in if you've
  // been here before) waits in your inbox. Google signs you in on the spot.
  async function continueWithEmail(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.startGuest()
      await api.startSignIn(email.trim())
      leaveHomeFor('#/profile')
      onStart()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="landing">
      <header className="landing-top">
        <a className="brand" href="#/home">
          <img src="/hireme.svg" alt="" width={32} height={32} />
          <span>HireMe</span>
        </a>
        {user && (
          <a className="btn ghost small" href="#/discover">
            {me?.profileComplete ? 'Open HireMe' : 'Continue setting up'}
          </a>
        )}
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">For developers · startups with 50 people or fewer</p>
          <h1>
            Swipe right.
            <br />
            <em>We apply for you.</em>
          </h1>
          <p className="lede">
            Engineering jobs at small startups, one card at a time. Swipe right and HireMe fills out the application from your profile and sends it. Free.
          </p>
        </div>

        {user ? (
          <div className="signin-card">
            <h2 className="signin-title">{user.isGuest ? 'You’re partway in' : 'You’re signed in'}</h2>
            <p className="muted">
              {user.isGuest
                ? user.pendingEmail
                  ? `Waiting for you to confirm ${user.pendingEmail}.`
                  : 'Your answers are saved on this device until you add your email.'
                : user.email}
            </p>
            <button type="button" className="btn primary wide" onClick={() => leaveHomeFor('#/discover')}>
              {me?.profileComplete ? 'Keep swiping' : 'Continue setting up'}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                if (user.isGuest && !confirm('Start over? What you’ve answered so far will be lost.')) return
                await api.logout()
                location.hash = ''
                onStart()
              }}
            >
              {user.isGuest ? 'Start over' : 'Sign out'}
            </button>
          </div>
        ) : (
          <form className="signin-card" onSubmit={continueWithEmail}>
            <h2 className="signin-title">Get started</h2>
            <p className="muted small">New or coming back, it’s the same button. No passwords.</p>
            <GoogleButton divider="after" onError={setError} />
            <label className="field">
              <span className="sr-only">Email</span>
              <input type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="btn primary wide" disabled={busy || !email.trim()}>
              {busy ? 'One sec…' : 'Continue with email'}
            </button>
          </form>
        )}

        <div className="hero-more">
          <ul className="promises">
            <li>
              <strong>Startups only.</strong> Every company has 50 people or fewer. No big companies, ever.
            </li>
            <li>
              <strong>No recruiters.</strong> Roles come straight from startups’ own job boards, and staffing agencies are filtered out.
            </li>
            <li>
              <strong>Swipe and done.</strong> HireMe answers the extra questions from your resume, positive but never made up, and shows you exactly what it sent.
            </li>
          </ul>
          <p className="legal-links">
            <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
          </p>
        </div>
      </section>
    </div>
  )
}

export function SignIn({ token, onDone }: { token: string; onDone: () => void }) {
  const [error, setError] = useState('')
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    api.verify(token).then(
      async (r) => {
        // Applications that went out because of this sign-in are waiting in Applications.
        history.replaceState(null, '', r.sent?.length ? '/#/applications' : '/#/discover')
        await onDone()
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      },
      (e: Error) => setError(e.message),
    )
  }, [token, onDone])
  return (
    <main className="gate">
      <div>
        <img src="/hireme.svg" alt="" width={44} height={44} />
        {error ? (
          <>
            <h1>That link didn’t work</h1>
            <p className="error">{error}</p>
            <a className="btn primary" href="/#/">
              Get a new link
            </a>
          </>
        ) : (
          <h1>Signing you in…</h1>
        )}
      </div>
    </main>
  )
}
