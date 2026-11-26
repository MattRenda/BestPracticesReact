import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AdminQueue, AdminStartup, StartupStatus } from '../types'
import { Toast } from '../components/ui'
import { ago, useToast } from '../lib'

const REASON: Record<string, string> = { recruiter: 'Recruiter / agency', too_big: 'Over 50 people', spam: 'Spam', inappropriate: 'Inappropriate', other: 'Other' }

export function AdminView({ onChange }: { onChange: () => void }) {
  const [q, setQ] = useState<AdminQueue | null>(null)
  const [filter, setFilter] = useState<StartupStatus | 'all'>('pending')
  const [toast, setToast] = useToast()
  const load = useCallback(() => api.adminQueue().then(setQ, (e: Error) => setToast(e.message)), [setToast])
  useEffect(() => {
    load()
  }, [load])

  async function review(s: AdminStartup, status: StartupStatus) {
    let note = ''
    if (status === 'rejected') {
      const n = prompt(`Why can’t ${s.name} be verified? This goes in the email to them.`, 'We couldn’t confirm you’re a startup with 50 or fewer people hiring for yourselves.')
      if (n === null) return
      note = n
    }
    try {
      await api.review(s.id, status, note)
      setToast(`${s.name} ${status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'moved back to pending'}`)
      load()
      onChange()
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  if (!q) return <p className="muted">Loading…</p>
  const rows = q.startups.filter((s) => filter === 'all' || s.status === filter)

  return (
    <section className="view">
      <header className="view-head">
        <h1>Admin</h1>
        <p className="lede">
          {q.stats.devs} developers · {q.stats.founders} founders · {q.stats.openRoles} live roles · {q.stats.matches} {q.stats.matches === 1 ? 'match' : 'matches'}
        </p>
      </header>

      {q.reports.length > 0 && (
        <section className="group">
          <h2 className="group-title">Reports</h2>
          <ul className="admin-list">
            {q.reports.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.target_name || `${r.target_type} #${r.target_id}`}</strong> <span className="pill bad">{REASON[r.reason] ?? r.reason}</span>
                  <p className="muted small">
                    {r.target_type === 'startup' ? 'Startup' : 'Developer'} · reported by {r.reporter ?? 'deleted user'} · {ago(r.created_at)}
                  </p>
                  {r.detail && <p className="small">{r.detail}</p>}
                </div>
                <button
                  className="btn ghost small"
                  onClick={() =>
                    api.resolveReport(r.id).then(
                      () => (load(), onChange()),
                      (e: Error) => setToast(e.message),
                    )
                  }
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="group">
        <div className="group-row">
          <h2 className="group-title">Startups</h2>
          <div className="segmented small" role="radiogroup" aria-label="Show">
            {(['pending', 'approved', 'rejected', 'all'] as const).map((f) => (
              <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
                {f === 'pending' && ` (${q.startups.filter((s) => s.status === 'pending').length})`}
              </button>
            ))}
          </div>
        </div>
        {!rows.length && <p className="muted">Nothing here.</p>}
        <ul className="admin-list">
          {rows.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.name}</strong>{' '}
                <a href={s.website} target="_blank" rel="noreferrer noopener" className="small">
                  {s.domain}
                </a>
                <p className="small">
                  {s.headcount} people{s.stage && ` · ${s.stage}`}
                  {s.location && ` · ${s.location}`} · signed up {ago(s.created_at)}
                </p>
                {s.one_liner && <p className="small">{s.one_liner}</p>}
                <p className="muted small">Team: {s.members || '—'}</p>
                {s.flags && <p className="flag small">⚑ {s.flags}</p>}
                {s.reports > 0 && <p className="flag small">{s.reports} open report{s.reports === 1 ? '' : 's'}</p>}
              </div>
              <div className="admin-actions">
                {s.status !== 'approved' && (
                  <button className="btn primary small" onClick={() => review(s, 'approved')}>
                    Approve
                  </button>
                )}
                {s.status !== 'rejected' && (
                  <button className="btn ghost small" onClick={() => review(s, 'rejected')}>
                    Reject
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="muted small">Before approving: open the website, check the team size (LinkedIn company page is a good cross-check), and make sure they’re not a recruiting or outsourcing firm.</p>
      </section>
      <Toast msg={toast} />
    </section>
  )
}
