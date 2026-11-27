import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AdminQueue, ImportRun } from '../types'
import { Toast } from '../components/ui'
import { ago, useToast } from '../lib'

const REASON: Record<string, string> = { recruiter: 'Recruiter / agency', too_big: 'Over 50 people', closed: 'Job closed', spam: 'Spam', inappropriate: 'Inappropriate', other: 'Other' }

export function AdminView({ onChange }: { onChange: () => void }) {
  const [q, setQ] = useState<AdminQueue | null>(null)
  const [toast, setToast] = useToast()
  const load = useCallback(() => api.adminQueue().then(setQ, (e: Error) => setToast(e.message)), [setToast])
  useEffect(() => {
    load()
  }, [load])

  const act = (fn: () => Promise<unknown>, msg: string) =>
    fn().then(
      () => {
        setToast(msg)
        load()
        onChange()
      },
      (e: Error) => setToast(e.message),
    )

  if (!q) return <p className="muted">Loading…</p>
  return (
    <section className="view">
      <header className="view-head">
        <h1>Admin</h1>
        <p className="lede">
          {q.stats.devs} developers · {q.stats.openRoles} live roles at {q.stats.listed} startups · {q.stats.submitted} applications sent
        </p>
      </header>
      <ImportPanel onDone={load} />
      <ApplierPanel />

      <section className="group">
        <h2 className="group-title">Reports</h2>
        {!q.reports.length && <p className="muted small">No open reports.</p>}
        <ul className="admin-list">
          {q.reports.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.target_name}</strong>{' '}
                <a href={r.website} target="_blank" rel="noreferrer noopener" className="small">
                  {r.domain}
                </a>{' '}
                <span className="pill bad">{REASON[r.reason] ?? r.reason}</span>
                <p className="muted small">
                  Reported by {r.reporter ?? 'deleted user'} · {ago(r.created_at)}
                  {r.target_status === 'pending' && ' · hidden until you decide'}
                </p>
                {r.detail && <p className="small">{r.detail}</p>}
              </div>
              <div className="admin-actions">
                <button className="btn ghost small" onClick={() => act(() => api.setListed(r.target_id, false), `${r.target_name} removed`)}>
                  Remove company
                </button>
                <button className="link-btn quiet" onClick={() => act(() => (r.target_status === 'pending' ? api.setListed(r.target_id, true) : api.resolveReport(r.id)), 'Report dismissed')}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {q.hidden.length > 0 && (
        <section className="group">
          <h2 className="group-title">Hidden companies</h2>
          <ul className="admin-list">
            {q.hidden.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>{s.name}</strong>{' '}
                  <a href={s.website} target="_blank" rel="noreferrer noopener" className="small">
                    {s.domain}
                  </a>
                  <p className="muted small">
                    {s.headcount} people · {s.status === 'pending' ? 'hidden after reports' : 'removed by an admin'}
                    {s.flags && ` · ${s.flags}`}
                  </p>
                </div>
                <button className="btn ghost small" onClick={() => act(() => api.setListed(s.id, true), `${s.name} is back in the deck`)}>
                  Show again
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Toast msg={toast} />
    </section>
  )
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<{ running: boolean; runs: ImportRun[] } | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(() => api.importStatus().then(setState, (e: Error) => setError(e.message)), [])
  useEffect(() => {
    refresh()
  }, [refresh])
  // While a run is going, check every few seconds
  useEffect(() => {
    if (!state?.running) return
    const t = setInterval(() => {
      api.importStatus().then((s) => {
        setState(s)
        if (!s.running) onDone()
      }, () => {})
    }, 4000)
    return () => clearInterval(t)
  }, [state?.running, onDone])

  const last = state?.runs[0]
  return (
    <section className="group">
      <div className="group-row">
        <h2 className="group-title">Imported jobs</h2>
        <button
          className="btn ghost small"
          disabled={!state || state.running}
          onClick={() =>
            api.runImport().then(
              () => setState((s) => s && { ...s, running: true }),
              (e: Error) => setError(e.message),
            )
          }
        >
          {state?.running ? 'Importing…' : 'Run import now'}
        </button>
      </div>
      <p className="small">Engineering roles from YC startups with 50 or fewer people, read from their own job boards. Runs automatically twice a day.</p>
      {last && (
        <p className="muted small">
          Last run {ago(last.started_at)}
          {last.finished_at
            ? `: ${last.companies ?? 0} startups checked, ${last.boards ?? 0} job boards, ${last.roles_added ?? 0} new roles, ${last.roles_closed ?? 0} closed.`
            : ' — still running.'}
        </p>
      )}
      {last?.errors?.length ? (
        <details className="small">
          <summary>{last.errors.length} problems in the last run</summary>
          <ul>
            {last.errors.slice(0, 20).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function ApplierPanel() {
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.applierStatus>> | null>(null)
  const [test, setTest] = useState<Awaited<ReturnType<typeof api.applierTest>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    api.applierStatus().then(setSt, (e: Error) => setError(e.message))
  }, [])
  const c = st?.counts ?? {}
  return (
    <section className="group">
      <div className="group-row">
        <h2 className="group-title">Applying for developers</h2>
        <button
          className="btn ghost small"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError('')
            api.applierTest().then(setTest, (e: Error) => setError(e.message)).finally(() => setBusy(false))
          }}
        >
          {busy ? 'Testing… (up to a minute)' : 'Test on a real job form'}
        </button>
      </div>
      <p className="small">
        {c.submitted ?? 0} submitted · {c.needs_you ?? 0} need the developer · {c.failed ?? 0} failed · {(c.queued ?? 0) + (c.running ?? 0)} in progress.{' '}
        {st && (st.ai ? 'Claude drafts open-ended answers.' : 'No ANTHROPIC_API_KEY set, so open-ended answers use a basic template.')}
      </p>
      {st?.last && (
        <p className="muted small">
          Last: application #{st.last.id} {st.last.state}
          {st.last.error ? ` (${st.last.error})` : ''} {ago(st.last.at)}
        </p>
      )}
      {test && (
        <div className="callout small">
          <p>
            <strong>
              {test.role.startup}: {test.role.title}
            </strong>{' '}
            <a href={test.role.url} target="_blank" rel="noreferrer noopener">
              form
            </a>
          </p>
          <p>
            Filled {test.fieldsFilled} fields with a made-up applicant (nothing was submitted). Result: {test.state === 'practiced' ? 'ready to submit' : test.error}
          </p>
          {test.missing.length > 0 && <p>Would ask the developer: {test.missing.join('; ')}</p>}
          {test.screenshot && (
            <details>
              <summary>Screenshot</summary>
              <img className="shot-img" src={`data:image/jpeg;base64,${test.screenshot}`} alt="The filled form" />
            </details>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
