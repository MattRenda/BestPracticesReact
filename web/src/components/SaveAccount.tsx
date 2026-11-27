import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import { GoogleButton } from './GoogleButton'

/**
 * Email (one-time link) or Google. For a guest, whatever they've done so far moves to the account.
 * `before` runs first (e.g. saving phone and consent); return an error message to stop.
 */
export function SaveAccount({
  title,
  sub,
  children,
  before,
  sentText,
  onClose,
}: {
  title: string
  sub?: ReactNode
  children?: ReactNode
  before?: () => Promise<string | void>
  sentText?: (email: string) => ReactNode
  onClose?: () => void
}) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; msg?: string; devLink?: string }>({ kind: 'idle' })

  async function submit(e: FormEvent) {
    e.preventDefault()
    setState({ kind: 'sending' })
    try {
      const problem = await before?.()
      if (problem) return setState({ kind: 'error', msg: problem })
      const r = await api.startSignIn(email.trim())
      setState({ kind: 'sent', devLink: r.devLink })
    } catch (err) {
      setState({ kind: 'error', msg: (err as Error).message })
    }
  }

  if (state.kind === 'sent')
    return (
      <div className="save-account sent">
        <h2>Check your email</h2>
        <p>{sentText ? sentText(email) : <>We sent a link to <strong>{email}</strong>. Tap it and you’re in — no password.</>}</p>
        {state.devLink && (
          <p className="dev-link">
            Email isn’t set up on this server, so here’s the link: <a href={state.devLink}>Sign in</a>
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="link-btn" onClick={() => setState({ kind: 'idle' })}>
            Use a different email
          </button>
          {onClose && (
            <button type="button" className="btn primary" onClick={onClose}>
              Keep swiping
            </button>
          )}
        </div>
      </div>
    )

  return (
    <form className="save-account" onSubmit={submit}>
      <h2>{title}</h2>
      {sub && <p className="sheet-sub">{sub}</p>}
      {children}
      <label className="field">
        <span>Email</span>
        <input type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {state.kind === 'error' && (
        <p className="error" role="alert">
          {state.msg}
        </p>
      )}
      <button className="btn primary wide" disabled={state.kind === 'sending' || !email.trim()}>
        {state.kind === 'sending' ? 'Sending…' : 'Email me a link'}
      </button>
      <GoogleButton before={before} onError={(msg) => setState({ kind: 'error', msg })} />
    </form>
  )
}
