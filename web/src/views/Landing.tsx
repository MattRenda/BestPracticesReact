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
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')

  // No sign-up form: a guest account starts quietly; an email is asked for when they want to apply.
  async function start() {
    setStarting(true)
    setStartError('')
    try {
      await api.startGuest()
      leaveHomeFor('#/profile')
      onStart()
    } catch (e) {
      setStartError((e as Error).message)
      setStarting(false)
    }
  }
  const [email, setEmail] = useState('')
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; msg?: string; devLink?: string }>({ kind: 'idle' })

  async function submit(e: FormEvent) {
    e.preventDefault()
    setState({ kind: 'sending' })
    try {
      const r = await api.startSignIn(email.trim())
      setState({ kind: 'sent', devLink: r.devLink })
    } catch (err) {
      setState({ kind: 'error', msg: (err as Error).message })
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
          <div className="hero-cta">
            {user ? (
              <button type="button" className="btn primary big" onClick={() => leaveHomeFor('#/discover')}>
                {me?.profileComplete ? 'Keep swiping →' : 'Continue setting up →'}
              </button>
            ) : (
              <>
                <button type="button" className="btn primary big" onClick={start} disabled={starting}>
                  {starting ? 'One sec…' : 'Find a startup job →'}
                </button>
                <span className="muted">A few quick taps. No forms.</span>
              </>
            )}
            {startError && <p className="error">{startError}</p>}
          </div>
          <ul className="promises">
            <li>
              <strong>Startups only.</strong> Every company has 50 people or fewer. No big companies, ever.
            </li>
            <li>
              <strong>No recruiters.</strong> Roles come straight from startups’ own job boards, and staffing agencies are filtered out.
            </li>
            <li>
              <strong>You stay in charge.</strong> HireMe asks you about anything it can’t answer truthfully, like visas or salary, and shows you exactly what it sent.
            </li>
          </ul>
          <p className="legal-links">
            <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
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
        <form className="signin-card" onSubmit={submit}>
          {state.kind === 'sent' ? (
            <div className="sent">
              <h2>Check your email</h2>
              <p>
                We sent a sign-in link to <strong>{email}</strong>. It works once and expires in 20 minutes.
              </p>
              {state.devLink && (
                <p className="dev-link">
                  Email isn’t set up on this server, so here’s the link: <a href={state.devLink}>Sign in</a>
                </p>
              )}
              <button type="button" className="link-btn" onClick={() => setState({ kind: 'idle' })}>
                Use a different email
              </button>
            </div>
          ) : (
            <>
              <h2 className="signin-title">Already use HireMe?</h2>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              {state.kind === 'error' && (
                <p className="error" role="alert">
                  {state.msg}
                </p>
              )}
              <button className="btn primary wide" disabled={state.kind === 'sending' || !email.trim()}>
                {state.kind === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
              </button>
              <GoogleButton onError={(msg) => setState({ kind: 'error', msg })} />
              <p className="fine">No passwords. New here? Tap “Find a startup job”.</p>
            </>
          )}
        </form>
        )}
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
