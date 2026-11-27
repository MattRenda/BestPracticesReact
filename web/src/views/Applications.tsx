import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Application, ApplyField, SavedRole } from '../types'
import { ApplySetup } from '../components/ApplySetup'
import { Sheet, Toast } from '../components/ui'
import { ago, useToast } from '../lib'

/** Everything HireMe applied to for you, what needs your answer, and right swipes it hasn't sent yet. */
export function Applications({ onChange }: { onChange: () => void }) {
  const [apps, setApps] = useState<Application[] | null>(null)
  const [saved, setSaved] = useState<SavedRole[]>([])
  const [openApp, setOpenApp] = useState<Application | null>(null)
  const [setup, setSetup] = useState<{ roleId: number; startupName: string; applyUrl: string; missing: ApplyField[]; consented: boolean } | null>(null)
  const [toast, setToast] = useToast()

  const load = useCallback(() => {
    api.applications().then(setApps, (e: Error) => setToast(e.message))
    api.saved().then(setSaved, () => {})
  }, [setToast])
  useEffect(() => {
    load()
    // Keep in-progress applications fresh
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 8000)
    return () => clearInterval(t)
  }, [load])

  async function applyNow(r: SavedRole) {
    try {
      const p = await api.profile()
      const missing = p.applyMissing ?? []
      if (p.auto_apply && !missing.length) {
        await api.apply(r.id, false)
        setToast(`Applying to ${r.startup_name} for you`)
        load()
        onChange()
      } else setSetup({ roleId: r.id, startupName: r.startup_name, applyUrl: r.apply_url, missing, consented: !!p.auto_apply })
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  const needsYou = apps?.filter((a) => a.state === 'needs_you') ?? []
  const rest = apps?.filter((a) => a.state !== 'needs_you') ?? []
  const sent = apps?.filter((a) => a.state === 'submitted' || a.state === 'self_applied').length ?? 0

  return (
    <section className="view narrow applications">
      <header className="view-head compact">
        <h1>Applications</h1>
        {apps && apps.length > 0 && (
          <p className="lede">
            {sent} sent{needsYou.length ? ` · ${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you` : ''}
          </p>
        )}
      </header>

      {apps === null ? (
        <p className="muted">Loading…</p>
      ) : !apps.length && !saved.length ? (
        <div className="empty-box">
          <p>
            <strong>No applications yet.</strong>
          </p>
          <p className="muted">Swipe right on a role and HireMe fills out and sends the application. You’ll see every one here.</p>
          <a className="btn ghost small" href="#/discover">
            Start swiping
          </a>
        </div>
      ) : null}

      {needsYou.length > 0 && <AppList title="Needs you" note="A question HireMe can’t answer for you. Answer it once and it’s saved for other forms." apps={needsYou} onOpen={setOpenApp} />}
      {rest.length > 0 && <AppList title={needsYou.length ? 'Everything else' : ''} apps={rest} onOpen={setOpenApp} />}

      {saved.length > 0 && (
        <section className="saved">
          <h2>Not sent yet</h2>
          <p className="muted small">You swiped right, but HireMe still needed a few details before it could apply.</p>
          <ul className="threads">
            {saved.map((r) => (
              <li key={r.id} className="saved-row">
                <span className="t-top">
                  <strong>{r.startup_name}</strong>
                  <time>{ago(r.liked_at)}</time>
                </span>
                <span className="t-role">{r.title}</span>
                <span className="saved-actions">
                  {r.status === 'closed' ? (
                    <span className="muted small">No longer posted</span>
                  ) : (
                    <>
                      <button type="button" className="btn primary small" onClick={() => applyNow(r)}>
                        Apply for me
                      </button>
                      <a className="link-btn" href={r.apply_url} target="_blank" rel="noreferrer noopener">
                        Their site ↗
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ApplicationSheet
        app={openApp}
        onClose={() => setOpenApp(null)}
        onChanged={() => {
          load()
          onChange()
        }}
      />
      <ApplySetup
        target={setup}
        onClose={() => setSetup(null)}
        onQueued={(name) => {
          setToast(`Applying to ${name} for you`)
          load()
          onChange()
        }}
      />
      <Toast msg={toast} />
    </section>
  )
}

function AppList({ title, note, apps, onOpen }: { title: string; note?: string; apps: Application[]; onOpen: (a: Application) => void }) {
  return (
    <section className="saved">
      {title && <h2>{title}</h2>}
      {note && <p className="muted small">{note}</p>}
      <ul className="threads">
        {apps.map((a) => (
          <li key={a.id}>
            <button type="button" className="thread-btn" onClick={() => onOpen(a)}>
              <span className="t-top">
                <strong>{a.startup_name}</strong>
                <time>{ago(a.submitted_at || a.updated_at)}</time>
              </span>
              <span className="t-role">{a.title}</span>
              <span className="t-last">
                <StateChip state={a.state} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

const STATE_LABEL: Record<Application['state'], string> = {
  queued: 'Waiting to apply',
  running: 'Applying now…',
  submitted: 'Applied',
  needs_you: 'Needs you',
  failed: 'Couldn’t apply',
  canceled: 'Canceled',
  self_applied: 'You applied',
}
function StateChip({ state }: { state: Application['state'] }) {
  const tone = state === 'submitted' || state === 'self_applied' ? 'ok' : state === 'needs_you' ? 'wait' : state === 'failed' ? 'bad' : ''
  return <span className={`pill ${tone}`}>{STATE_LABEL[state]}</span>
}

function ApplicationSheet({ app, onClose, onChanged }: { app: Application | null; onClose: () => void; onChanged: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState<Application | null>(app)
  if (current?.id !== app?.id) {
    setCurrent(app)
    setAnswers({})
    setError('')
  }
  if (!app) return null

  const act = async (fn: () => Promise<unknown>, close = true) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChanged()
      if (close) onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const unanswered = app.missing.filter((q) => !answers[q]?.trim())

  return (
    <Sheet open={!!app} onClose={onClose} label={`Application to ${app.startup_name}`}>
      <div className="role-form">
        <h2>{app.startup_name}</h2>
        <p className="sheet-sub">
          {app.title} · <StateChip state={app.state} />
          {app.submitted_at && ` on ${new Date(`${app.submitted_at.replace(' ', 'T')}Z`).toLocaleDateString()}`}
        </p>
        {app.error && app.state !== 'submitted' && <p className="callout small">{app.error}</p>}

        {app.state === 'needs_you' && app.missing.length > 0 && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              act(() => api.answerApplication(app.id, app.missing.map((q) => ({ question: q, answer: answers[q].trim() }))))
            }}
          >
            <p className="small">Answer these and HireMe will finish the application. Your answers are saved for other forms that ask the same thing.</p>
            {app.missing.map((q) => (
              <label key={q} className="field">
                <span>{q}</span>
                <input value={answers[q] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q]: e.target.value }))} required />
              </label>
            ))}
            <div className="sheet-actions">
              <button className="btn primary" disabled={busy || unanswered.length > 0}>
                Answer and apply
              </button>
            </div>
          </form>
        )}

        {app.has_screenshot && (
          <details className="shot">
            <summary>What the form looked like</summary>
            <img src={`/api/applications/${app.id}/screenshot?v=${encodeURIComponent(app.updated_at)}`} alt="Screenshot of the application form" loading="lazy" />
          </details>
        )}
        {(app.answers.length > 0 || app.cover_note) && (
          <details>
            <summary>What HireMe sent</summary>
            {app.answers.map((a, i) => (
              <p key={i} className="small">
                <strong>{a.question}</strong>
                <br />
                {a.answer} <span className="muted">({a.source === 'saved' ? 'your saved answer' : 'drafted from your profile'})</span>
              </p>
            ))}
            {app.cover_note && <p className="small pre">{app.cover_note}</p>}
          </details>
        )}
        {error && <p className="error">{error}</p>}
        <div className="sheet-actions wrap">
          {app.apply_url && ['needs_you', 'failed'].includes(app.state) && (
            <a className="btn ghost" href={app.apply_url} target="_blank" rel="noreferrer noopener">
              Finish on their site
            </a>
          )}
          {['needs_you', 'failed'].includes(app.state) && (
            <button className="btn ghost" disabled={busy} onClick={() => act(() => api.selfApplied(app.id))}>
              I applied myself
            </button>
          )}
          {app.state === 'failed' && app.role_status === 'open' && (
            <button className="btn ghost" disabled={busy} onClick={() => act(() => api.retryApplication(app.id))}>
              Try again
            </button>
          )}
          {['queued', 'needs_you', 'failed'].includes(app.state) && (
            <button className="link-btn quiet" disabled={busy} onClick={() => act(() => api.cancelApplication(app.id))}>
              Cancel
            </button>
          )}
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Sheet>
  )
}
