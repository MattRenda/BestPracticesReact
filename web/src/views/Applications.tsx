import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Application, SavedRole } from '../types'
import { Sheet, Toast } from '../components/ui'
import { ago, useToast } from '../lib'

/** Everything HireMe applied to for you, what needs your answer, and right swipes it hasn't sent yet. */
export function Applications({ onChange }: { onChange: () => void }) {
  const [apps, setApps] = useState<Application[] | null>(null)
  const [saved, setSaved] = useState<SavedRole[]>([])
  const [openApp, setOpenApp] = useState<Application | null>(null)
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
      await api.apply(r.id)
      setToast(`Applying to ${r.startup_name}`)
      load()
      onChange()
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  const needsYou = apps?.filter((a) => a.state === 'needs_you') ?? []
  const toReview = apps?.filter((a) => a.state === 'review') ?? []
  const rest = apps?.filter((a) => a.state !== 'needs_you' && a.state !== 'review') ?? []
  // Each question once, however many applications are waiting on it.
  const questions = [...new Map(needsYou.flatMap((a) => a.missing).map((q) => [q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), q])).values()]
  const sent = apps?.filter((a) => a.state === 'submitted' || a.state === 'self_applied').length ?? 0

  return (
    <section className="view narrow applications">
      <header className="view-head compact">
        <h1>Applications</h1>
        {apps && apps.length > 0 && (
          <p className="lede">
            {sent} sent{toReview.length ? ` · ${toReview.length} ready to check` : ''}{needsYou.length ? ` · ${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you` : ''}
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

      {questions.length > 0 && (
        <AnswerOnce
          questions={questions}
          waiting={needsYou}
          onDone={(n) => {
            setToast(n ? `Sending ${n} application${n === 1 ? '' : 's'}` : 'Saved')
            load()
            onChange()
          }}
        />
      )}
      {toReview.length > 0 && <AppList title="Ready to check" note="HireMe filled these out. Check each one and send it." apps={toReview} onOpen={setOpenApp} />}
      {needsYou.length > 0 && (
        <AppList
          title={questions.length ? 'Waiting on you' : 'Needs you'}
          note={questions.length ? 'These go out once the questions above are answered.' : 'Tap one to see what happened.'}
          apps={needsYou}
          onOpen={setOpenApp}
        />
      )}
      {rest.length > 0 && <AppList title={needsYou.length || toReview.length ? 'Everything else' : ''} apps={rest} onOpen={setOpenApp} />}

      {saved.length > 0 && (
        <section className="saved">
          <h2>Not sent yet</h2>
          <p className="muted small">
            You swiped right, but HireMe still needs a detail from your <a href="#/profile">profile</a>. They go out as soon as it’s filled in.
          </p>
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
                        Send now
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
      <Toast msg={toast} />
    </section>
  )
}

/** One box per question, however many applications asked it. Answers are saved and reused on later forms. */
function AnswerOnce({ questions, waiting, onDone }: { questions: string[]; waiting: Application[]; onDone: (requeued: number) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const count = (q: string) => waiting.filter((a) => a.missing.includes(q)).length
  const given = questions.filter((q) => answers[q]?.trim())

  return (
    <form
      className="answer-once"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
          const r = await api.answerAll(given.map((q) => ({ question: q, answer: answers[q].trim() })))
          setAnswers({})
          onDone(r.requeued)
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2>
        {questions.length === 1 ? 'One question' : `${questions.length} questions`} and HireMe sends {waiting.length === 1 ? 'your application' : `${waiting.length} applications`}
      </h2>
      <p className="muted small">Answer once; HireMe remembers it for every form that asks.</p>
      {questions.map((q) => (
        <label key={q} className="field">
          <span>
            {q} {count(q) > 1 && <em className="muted">· {count(q)} applications</em>}
          </span>
          <input value={answers[q] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q]: e.target.value }))} />
        </label>
      ))}
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy || !given.length}>
        {busy ? 'Sending…' : 'Save and send'}
      </button>
    </form>
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
  review: 'Ready to check',
  submitted: 'Applied',
  needs_you: 'Needs you',
  failed: 'Didn’t go through',
  canceled: 'Canceled',
  self_applied: 'You applied',
}
function StateChip({ state }: { state: Application['state'] }) {
  const tone = state === 'submitted' || state === 'self_applied' ? 'ok' : state === 'needs_you' || state === 'review' ? 'wait' : state === 'failed' ? 'bad' : ''
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

        {app.state === 'review' && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const edited = app.answers.filter((a) => answers[a.question] !== undefined && answers[a.question].trim() !== a.answer).map((a) => ({ question: a.question, answer: answers[a.question].trim() }))
              act(() => api.sendApplication(app.id, edited))
            }}
          >
            <p className="small">HireMe filled this out and is waiting for your OK. Change any answer, then send it.</p>
            {app.answers.map((a) => (
              <label key={a.question} className="field">
                <span>{a.question}</span>
                <textarea rows={Math.min(6, Math.ceil(a.answer.length / 34) + 1)} value={answers[a.question] ?? a.answer} onChange={(e) => setAnswers((x) => ({ ...x, [a.question]: e.target.value }))} />
              </label>
            ))}
            {app.cover_note && (
              <details>
                <summary>Cover note</summary>
                <p className="small pre">{app.cover_note}</p>
              </details>
            )}
            <div className="sheet-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => act(() => api.cancelApplication(app.id))}>
                Don’t send
              </button>
              <button className="btn primary" disabled={busy}>
                Send it
              </button>
            </div>
          </form>
        )}

        {app.has_screenshot && (
          <details className="shot" open={app.state === 'review'}>
            <summary>What the form looked like</summary>
            <img src={`/api/applications/${app.id}/screenshot?v=${encodeURIComponent(app.updated_at)}`} alt="Screenshot of the application form" loading="lazy" />
          </details>
        )}
        {app.state !== 'review' && (app.answers.length > 0 || app.cover_note) && (
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
              Apply on their site
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
