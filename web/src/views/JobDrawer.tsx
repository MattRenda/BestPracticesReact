import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { STATUSES, STATUS_LABEL, type Job, type JobEvent, type Status } from '../types'

type Detail = Job & { events: JobEvent[] }

export function JobDrawer({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const [job, setJob] = useState<Detail | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    api.job(id).then(setJob, (e: Error) => setMsg(e.message))
    ref.current?.showModal()
  }, [id])

  const set = <K extends keyof Job>(k: K, v: Job[K]) => setJob((j) => (j ? { ...j, [k]: v } : j))

  async function save(patch?: Partial<Job>) {
    if (!job) return
    setBusy(true)
    try {
      const body = patch ?? {
        company: job.company,
        title: job.title,
        location: job.location,
        url: job.url,
        description: job.description,
        notes: job.notes,
        cover_letter: job.cover_letter,
      }
      await api.updateJob(job.id, body)
      setJob(await api.job(job.id))
      setMsg('Saved')
      onChange()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function writeLetter() {
    if (!job) return
    setBusy(true)
    setMsg('')
    try {
      await save()
      const { cover_letter, ai } = await api.coverLetter(job.id)
      set('cover_letter', cover_letter)
      setMsg(ai ? 'Cover letter written' : 'Template letter added — set ANTHROPIC_API_KEY for a tailored one')
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!job || !confirm(`Delete ${job.company || 'this job'}? This can't be undone.`)) return
    await api.deleteJob(job.id)
    onChange()
    onClose()
  }

  return (
    <dialog ref={ref} className="drawer" onClose={onClose} aria-label="Job details">
      {!job ? (
        <p className="pad">{msg || 'Loading…'}</p>
      ) : (
        <form
          method="dialog"
          className="drawer-body"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <header className="drawer-head">
            <div>
              <input className="title-input" aria-label="Company" value={job.company} onChange={(e) => set('company', e.target.value)} placeholder="Company" />
              <input className="sub-input" aria-label="Role" value={job.title} onChange={(e) => set('title', e.target.value)} placeholder="Role" />
            </div>
            <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
              ×
            </button>
          </header>

          <label className="field">
            <span>Status</span>
            <select value={job.status} onChange={(e) => save({ status: e.target.value as Status })} disabled={busy}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>

          <div className="row2">
            <label className="field">
              <span>Location</span>
              <input value={job.location} onChange={(e) => set('location', e.target.value)} />
            </label>
            <label className="field">
              <span>Posting link</span>
              <input type="url" value={job.url ?? ''} onChange={(e) => set('url', e.target.value || null)} />
            </label>
          </div>

          <label className="field">
            <span>Job description</span>
            <textarea rows={6} value={job.description} onChange={(e) => set('description', e.target.value)} placeholder="Paste it here, or save the job from the extension to capture it automatically." />
          </label>

          <div className="field">
            <div className="field-row">
              <label htmlFor="cl">Cover letter</label>
              <button type="button" className="link-btn" onClick={writeLetter} disabled={busy}>
                {job.cover_letter ? 'Rewrite' : 'Write cover letter'}
              </button>
            </div>
            <textarea id="cl" rows={10} value={job.cover_letter} onChange={(e) => set('cover_letter', e.target.value)} />
          </div>

          <label className="field">
            <span>Notes</span>
            <textarea rows={3} value={job.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Recruiter name, referral, interview dates…" />
          </label>

          {job.events.length > 0 && (
            <details className="history">
              <summary>History</summary>
              <ul>
                {job.events.map((ev) => (
                  <li key={ev.id}>
                    <time>{new Date(ev.created_at + 'Z').toLocaleString()}</time> {describe(ev)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <footer className="drawer-foot">
            <button type="button" className="btn ghost danger" onClick={remove}>
              Delete job
            </button>
            <span className="status-msg" aria-live="polite">
              {msg}
            </span>
            <button className="btn primary" type="submit" disabled={busy}>
              Save changes
            </button>
          </footer>
        </form>
      )}
    </dialog>
  )
}

function describe(ev: JobEvent) {
  switch (ev.kind) {
    case 'created':
      return 'Added to pipeline'
    case 'status':
      return `Status: ${ev.detail
        .split(' → ')
        .map((s) => STATUS_LABEL[s as Status] ?? s)
        .join(' → ')}`
    case 'applied':
      return `Applied with the extension (${ev.detail})`
    case 'cover_letter':
      return ev.detail === 'ai' ? 'Cover letter written by Claude' : 'Template cover letter added'
    default:
      return ev.kind
  }
}
