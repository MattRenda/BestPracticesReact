import { useCallback, useEffect, useState } from 'react'
import { api, withToken } from '../api'
import type { Job } from '../types'
import { QuestionsSheet } from './QuestionsSheet'

/** Everything waiting on you: failed applications, approvals, practice runs, unanswered questions. */
export function ReviewView({ onChange }: { onChange: () => void }) {
  const [needs, setNeeds] = useState<Job[]>([])
  const [review, setReview] = useState<Job[]>([])
  const [questions, setQuestions] = useState<Job[]>([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [asking, setAsking] = useState<Job | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [n, r, q] = await Promise.all([
        api.jobs({ status: 'queued', apply_state: 'needs_you,failed' }),
        api.jobs({ status: 'queued', apply_state: 'review,practiced' }),
        api.jobs({ status: 'queued', apply_state: 'questions' }),
      ])
      setNeeds(n)
      setReview(r)
      setQuestions(q)
      setLoaded(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    // state is only set after the requests resolve
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const after = () => {
    load()
    onChange()
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn()
      after()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function askFor(j: Job) {
    const { questions: qs, answers } = await api.questions(j.id)
    setAsking({ ...j, context: { questions: qs, answers } })
  }

  const empty = loaded && !needs.length && !review.length && !questions.length

  return (
    <section className="view narrow">
      <header className="view-head">
        <h1>Review</h1>
        <p className="lede">Applications that need a decision or a hand from you.</p>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {empty && <p className="empty">Nothing needs you right now. Go swipe.</p>}

      {needs.length > 0 && (
        <section className="review-group">
          <h2>Finish these yourself</h2>
          <p className="group-note">Sprout stopped rather than guess. Open the posting, finish it, then mark it applied — or fix your profile and retry.</p>
          <ul className="review-list">
            {needs.map((j) => (
              <li key={j.id}>
                <div className="review-row">
                  <div>
                    <strong>{j.company}</strong> <span className="muted">{j.title}</span>
                    <p className="review-why">{j.apply_error}</p>
                  </div>
                </div>
                <div className="actions">
                  {j.url && (
                    <a className="btn primary small" href={j.url} target="_blank" rel="noreferrer">
                      Open posting
                    </a>
                  )}
                  <button className="link-btn" onClick={() => act(() => api.updateJob(j.id, { status: 'applied' }))}>
                    Mark applied
                  </button>
                  <button className="link-btn" onClick={() => act(() => api.retry(j.id))}>
                    Retry
                  </button>
                  {Boolean(j.has_screenshot) && (
                    <a className="link-btn" href={withToken(`/jobs/${j.id}/screenshot`)} target="_blank" rel="noreferrer">
                      See where it stopped
                    </a>
                  )}
                  <button className="link-btn danger" onClick={() => act(() => api.updateJob(j.id, { status: 'skipped' }))}>
                    Give up
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {review.length > 0 && (
        <section className="review-group">
          <h2>Ready to send</h2>
          <p className="group-note">Check what Sprout will submit. Edits save automatically when you approve.</p>
          <ul className="review-list">
            {review.map((j) => (
              <li key={j.id}>
                <button className="review-row as-button" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}>
                  <div>
                    <strong>{j.company}</strong> <span className="muted">{j.title}</span>
                    {j.apply_state === 'practiced' && <p className="review-why">Practice run — filled but not submitted</p>}
                  </div>
                  <span className="chev" aria-hidden="true">
                    {open === j.id ? '−' : '+'}
                  </span>
                </button>
                {open === j.id && <ReviewDetail id={j.id} practiced={j.apply_state === 'practiced'} onDone={after} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {questions.length > 0 && (
        <section className="review-group">
          <h2>Waiting on your answers</h2>
          <p className="group-note">These apply anyway after 30 minutes without your answers.</p>
          <ul className="review-list">
            {questions.map((j) => (
              <li key={j.id} className="review-row">
                <div>
                  <strong>{j.company}</strong> <span className="muted">{j.title}</span>
                </div>
                <button className="btn ghost small" onClick={() => askFor(j)}>
                  Answer
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {asking && (
        <QuestionsSheet
          job={asking}
          onDone={() => {
            setAsking(null)
            after()
          }}
        />
      )}
    </section>
  )
}

function ReviewDetail({ id, practiced, onDone }: { id: number; practiced: boolean; onDone: () => void }) {
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .prepare(id)
      .then(setJob, (e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }, [id])

  async function approve() {
    if (!job) return
    setBusy(true)
    try {
      await api.updateJob(job.id, { cover_letter: job.cover_letter, tailored_resume: job.tailored_resume })
      await api.approve(job.id)
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  async function skip() {
    if (!job) return
    await api.updateJob(job.id, { status: 'skipped' })
    onDone()
  }

  if (!job) return <p className="pad-sm muted">{error || 'Writing the cover letter and resume…'}</p>

  const answered = (job.context?.questions ?? []).filter((q) => job.context?.answers?.[q.id])

  return (
    <div className="review-detail">
      {answered.length > 0 && (
        <dl className="qa">
          {answered.map((q) => (
            <div key={q.id}>
              <dt>{q.question}</dt>
              <dd>{job.context.answers![q.id]}</dd>
            </div>
          ))}
        </dl>
      )}
      <label className="field">
        <span>Cover letter</span>
        <textarea rows={9} value={job.cover_letter} onChange={(e) => setJob({ ...job, cover_letter: e.target.value })} />
      </label>
      {job.tailored_resume ? (
        <label className="field">
          <span>
            Tailored resume ·{' '}
            <a href={withToken(`/jobs/${job.id}/resume.pdf`)} target="_blank" rel="noreferrer">
              preview PDF
            </a>
          </span>
          <textarea rows={12} className="mono-ish" value={job.tailored_resume} onChange={(e) => setJob({ ...job, tailored_resume: e.target.value })} />
        </label>
      ) : (
        <p className="group-note">Your uploaded resume will be attached. Add an Anthropic API key to get one tailored per job.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="btn primary" onClick={approve} disabled={busy}>
          {practiced ? 'Run again' : 'Approve and apply'}
        </button>
        <button className="btn ghost" onClick={skip} disabled={busy}>
          Skip this job
        </button>
      </div>
    </div>
  )
}
