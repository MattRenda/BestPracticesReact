import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { StageGlyph } from '../StageGlyph'
import { STATUS_LABEL, type ApplyState, type Job, type Status } from '../types'
import { JobDrawer } from './JobDrawer'

const LANES: Status[] = ['queued', 'applied', 'interviewing', 'offer']
const APPLY_LABEL: Partial<Record<ApplyState, string>> = {
  questions: 'Waiting on your answers',
  review: 'Waiting for approval',
  pending: 'In line',
  running: 'Applying now',
  needs_you: 'Needs you',
  failed: 'Needs you',
  practiced: 'Practice run done',
}
const ARCHIVE: Status[] = ['rejected', 'skipped']

function guessFromUrl(url: string): { company?: string } {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    // boards.greenhouse.io/<company>/jobs/123, jobs.lever.co/<company>/..., jobs.ashbyhq.com/<company>/...
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com/.test(u.hostname) && parts[0]) {
      return { company: parts[0].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }
    }
    return { company: u.hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0] }
  } catch {
    return {}
  }
}

export function Pipeline({ onChange }: { onChange: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [draft, setDraft] = useState({ url: '', company: '', title: '' })
  const [error, setError] = useState('')
  const [showArchive, setShowArchive] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    api.jobs().then(setJobs, (e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])

  const refresh = () => {
    load()
    onChange()
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!draft.url && !draft.company) return setError('Add a job link or a company name.')
    try {
      await api.addJob({ ...draft, url: draft.url || null, status: 'new' })
      setDraft({ url: '', company: '', title: '' })
      refresh()
      setNote('Added to the top of your deck')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const byStatus = (s: Status) => jobs.filter((j) => j.status === s)
  const archived = jobs.filter((j) => ARCHIVE.includes(j.status))

  return (
    <section className="view">
      <header className="view-head">
        <h1>Applications</h1>
        <p className="lede">Everything you’ve swiped right on, and what happened next.</p>
      </header>

      <form className="quick-add" onSubmit={add}>
        <label className="field grow">
          <span>Job link</span>
          <input
            type="url"
            placeholder="https://boards.greenhouse.io/…"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            onBlur={() => !draft.company && draft.url && setDraft((d) => ({ ...d, ...guessFromUrl(d.url) }))}
          />
        </label>
        <label className="field">
          <span>Company</span>
          <input value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
        </label>
        <label className="field">
          <span>Role</span>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <button className="btn primary" type="submit">
          Add to deck
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && !error && <p className="status-msg">{note}</p>}

      <div className="lanes">
        {LANES.map((s) => {
          const list = byStatus(s)
          return (
            <section key={s} className={`lane lane-${s}`} aria-labelledby={`lane-${s}`}>
              <h2 id={`lane-${s}`} className="lane-head">
                <StageGlyph status={s} />
                <span>{STATUS_LABEL[s]}</span>
                <span className="count">{list.length}</span>
              </h2>
              {list.length === 0 ? (
                <p className="lane-empty">
                  {s === 'queued' ? 'Swipe right on a job and it shows up here.' : 'Nothing here yet.'}
                </p>
              ) : (
                <ul className="job-list">
                  {list.map((j) => (
                    <li key={j.id}>
                      <button className="job-row" onClick={() => setOpenId(j.id)}>
                        <span className="job-company">{j.company || 'Untitled company'}</span>
                        <span className="job-title">{j.title || 'Role not set'}</span>
                        {j.applied_at && s !== 'queued' && (
                          <span className="job-meta">Applied {new Date(j.applied_at).toLocaleDateString()}</span>
                        )}
                      </button>
                      {s === 'queued' && <span className={`apply-chip ${j.apply_state}`}>{APPLY_LABEL[j.apply_state] ?? ''}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      {archived.length > 0 && (
        <div className="archive">
          <button className="link-btn" aria-expanded={showArchive} onClick={() => setShowArchive((v) => !v)}>
            {showArchive ? 'Hide' : 'Show'} {archived.length} rejected or skipped
          </button>
          {showArchive && (
            <ul className="job-list flat">
              {archived.map((j) => (
                <li key={j.id}>
                  <button className="job-row" onClick={() => setOpenId(j.id)}>
                    <StageGlyph status={j.status} size={18} />
                    <span className="job-company">{j.company}</span>
                    <span className="job-title">{j.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {openId !== null && <JobDrawer id={openId} onClose={() => setOpenId(null)} onChange={refresh} />}
    </section>
  )
}
