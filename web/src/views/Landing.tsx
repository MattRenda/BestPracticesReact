import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import { GoogleButton } from '../components/GoogleButton'

export function Landing() {
  const [intent, setIntent] = useState<'dev' | 'founder'>('dev')
  const [email, setEmail] = useState('')
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; msg?: string; devLink?: string }>({ kind: 'idle' })

  async function submit(e: FormEvent) {
    e.preventDefault()
    setState({ kind: 'sending' })
    try {
      const r = await api.startSignIn(email.trim(), intent)
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
          <p className="kicker">Startups with 50 people or fewer</p>
          <h1>
            Founders and developers,
            <br />
            <em>no one in between.</em>
          </h1>
          <p className="lede">
            Swipe on startups that are actually hiring. Founders swipe on you. When you both say yes, you’re talking to the person who decides, not a recruiter.
          </p>
          <ul className="promises">
            <li>
              <strong>No recruiters.</strong> Staffing agencies can’t sign up, and reports take listings down fast.
            </li>
            <li>
              <strong>No big companies.</strong> Every startup is verified with a company email and has 50 people or fewer.
            </li>
            <li>
              <strong>No cold applications.</strong> Chat opens only when both sides are interested.
            </li>
          </ul>
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
              <div className="segmented" role="radiogroup" aria-label="I am a">
                <button type="button" role="radio" aria-checked={intent === 'dev'} onClick={() => setIntent('dev')}>
                  I’m a developer
                </button>
                <button type="button" role="radio" aria-checked={intent === 'founder'} onClick={() => setIntent('founder')}>
                  I’m hiring at a startup
                </button>
              </div>
              <label className="field">
                <span>{intent === 'founder' ? 'Work email on your startup’s domain' : 'Email'}</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder={intent === 'founder' ? 'you@yourstartup.com' : 'you@example.com'}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              {intent === 'founder' && (
                <p className="hint">We use your email domain to verify the company, so use your work email or work Google account. Personal Gmail won’t work.</p>
              )}
              {state.kind === 'error' && (
                <p className="error" role="alert">
                  {state.msg}
                </p>
              )}
              <button className="btn primary wide" disabled={state.kind === 'sending' || !email.trim()}>
                {state.kind === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
              </button>
              <GoogleButton intent={intent} onError={(msg) => setState({ kind: 'error', msg })} />
              <p className="fine">No passwords. Free for developers and startups.</p>
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
