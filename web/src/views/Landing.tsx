import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import { GoogleButton } from '../components/GoogleButton'

export function Landing() {
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
        <span className="brand">
          <img src="/hireme.svg" alt="" width={32} height={32} />
          <span>HireMe</span>
        </span>
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
              <h2 className="signin-title">Start swiping</h2>
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
              <p className="fine">No passwords. Free.</p>
            </>
          )}
        </form>
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
      async () => {
        history.replaceState(null, '', '/#/discover')
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
