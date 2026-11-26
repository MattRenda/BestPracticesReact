import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, salaryRange, WORK_LABEL } from '../api'
import type { Me, MyStartup, RoleListing, Startup, WorkMode } from '../types'
import { Sheet, Toast } from '../components/ui'
import { useToast } from '../lib'
import { DeleteAccount } from './DevProfile'

export function StartupView({ me, onChange }: { me: Me; onChange: () => void }) {
  const [s, setS] = useState<MyStartup | null | undefined>(undefined)
  const [toast, setToast] = useToast()
  const load = useCallback(() => api.startup().then(setS, (e: Error) => setToast(e.message)), [setToast])
  useEffect(() => {
    load()
  }, [load])

  if (s === undefined) return <p className="muted">Loading…</p>
  if (!s)
    return (
      <>
        <NewStartup me={me} onDone={() => (load(), onChange())} />
        <Toast msg={toast} />
      </>
    )

  return (
    <section className="view narrow">
      <header className="view-head">
        <h1>{s.name}</h1>
        <StatusLine s={s} />
      </header>
      <Roles s={s} onChange={() => (load(), onChange())} />
      <CompanyForm s={s} onSaved={() => (load(), onChange())} />
      <fieldset className="group">
        <legend>Team</legend>
        <p className="group-note">Teammates join by signing in with an email on {s.domain}.</p>
        <ul className="plain">
          {s.team.map((t) => (
            <li key={t.email}>
              {t.email}
              {t.title && <span className="muted"> · {t.title}</span>}
            </li>
          ))}
        </ul>
        <DeleteAccount />
      </fieldset>
      <Toast msg={toast} />
    </section>
  )
}

function StatusLine({ s }: { s: MyStartup }) {
  if (s.status === 'approved')
    return (
      <p className="lede">
        <span className="pill ok">Verified</span> {s.headcount} people · {s.domain}
      </p>
    )
  if (s.status === 'rejected')
    return (
      <p className="lede">
        <span className="pill bad">Not verified</span> {s.review_note || 'HireMe is only for startups with 50 or fewer people hiring for themselves.'}
      </p>
    )
  return (
    <p className="lede">
      <span className="pill wait">Being verified</span> We check every startup by hand. Add your roles now; they go live as soon as you’re verified.
    </p>
  )
}

// ---------- signup ----------

function NewStartup({ me, onDone }: { me: Me; onDone: () => void }) {
  const domain = me.user?.email.split('@')[1] ?? ''
  const [f, setF] = useState({ name: '', website: domain ? `https://${domain}` : '', headcount: '', stage: '', one_liner: '', about: '', location: '', title: '' })
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const [existing, setExisting] = useState<{ id: number; name: string } | null>(me.joinable ?? null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.createStartup({ ...f, headcount: Number(f.headcount), confirmNotAgency: confirm })
      location.hash = '#/startup'
      onDone()
    } catch (err) {
      const ex = (err as ApiError).data?.existing as { id: number; name: string } | undefined
      if (ex) setExisting(ex)
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function join() {
    if (!existing) return
    try {
      await api.joinStartup(existing.id, f.title)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section className="view narrow">
      <header className="view-head">
        <h1>Add your startup</h1>
        <p className="lede">HireMe is only for startups with 50 or fewer people hiring for themselves. We verify every one by hand, usually within a day.</p>
      </header>

      {existing && (
        <div className="callout">
          <p>
            <strong>{existing.name}</strong> is already on HireMe with your email domain.
          </p>
          <label className="field">
            <span>Your title (optional)</span>
            <input value={f.title} onChange={set('title')} placeholder="CTO" />
          </label>
          <button className="btn primary" onClick={join}>
            Join {existing.name}
          </button>
        </div>
      )}

      <form onSubmit={submit}>
        <fieldset className="group">
          <legend>Company</legend>
          <div className="row2">
            <label className="field">
              <span>Startup name</span>
              <input required value={f.name} onChange={set('name')} />
            </label>
            <label className="field">
              <span>Website</span>
              <input required value={f.website} onChange={set('website')} placeholder="https://yourstartup.com" />
              <small>Must match your email: {domain}</small>
            </label>
          </div>
          <div className="row3">
            <label className="field">
              <span>People, including founders</span>
              <input required type="number" min={1} max={50} value={f.headcount} onChange={set('headcount')} />
            </label>
            <label className="field">
              <span>Stage</span>
              <select value={f.stage} onChange={set('stage')}>
                <option value="">—</option>
                {['Pre-seed', 'Seed', 'Series A', 'Series B', 'Bootstrapped', 'Profitable'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Based in</span>
              <input value={f.location} onChange={set('location')} placeholder="Remote · Sacramento" />
            </label>
          </div>
          <label className="field">
            <span>One line about what you do</span>
            <input maxLength={140} value={f.one_liner} onChange={set('one_liner')} placeholder="Scheduling software for small clinics" />
          </label>
          <label className="field">
            <span>More about the startup (optional)</span>
            <textarea rows={4} value={f.about} onChange={set('about')} placeholder="What you’re building, who it’s for, traction, team." />
          </label>
          <label className="field">
            <span>Your title</span>
            <input value={f.title} onChange={set('title')} placeholder="Co-founder & CTO" />
          </label>
          <label className="check">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>We’re hiring for our own startup. We’re not a recruiter, staffing agency or outsourcing firm.</span>
          </label>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="sticky-save">
          <button className="btn primary" disabled={busy || !confirm}>
            Submit for verification
          </button>
        </div>
      </form>
    </section>
  )
}

// ---------- company details ----------

function CompanyForm({ s, onSaved }: { s: MyStartup; onSaved: () => void }) {
  const [f, setF] = useState<Partial<Startup>>(s)
  const [msg, setMsg] = useState('')
  const set = (k: keyof Startup) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }))
  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await api.saveStartup({ ...f, headcount: Number(f.headcount) })
      setMsg('Saved')
      onSaved()
    } catch (err) {
      setMsg((err as Error).message)
    }
  }
  return (
    <form onSubmit={save}>
      <fieldset className="group">
        <legend>Company details</legend>
        <div className="row3">
          <label className="field">
            <span>Name</span>
            <input value={f.name ?? ''} onChange={set('name')} />
          </label>
          <label className="field">
            <span>People</span>
            <input type="number" min={1} max={50} value={f.headcount ?? ''} onChange={set('headcount')} />
          </label>
          <label className="field">
            <span>Stage</span>
            <input value={f.stage ?? ''} onChange={set('stage')} />
          </label>
        </div>
        <label className="field">
          <span>One line about what you do</span>
          <input maxLength={140} value={f.one_liner ?? ''} onChange={set('one_liner')} />
        </label>
        <label className="field">
          <span>About</span>
          <textarea rows={4} value={f.about ?? ''} onChange={set('about')} />
        </label>
        <label className="field">
          <span>Based in</span>
          <input value={f.location ?? ''} onChange={set('location')} />
        </label>
        <div className="row-end">
          <span className="status-msg">{msg}</span>
          <button className="btn ghost">Save details</button>
        </div>
      </fieldset>
    </form>
  )
}

// ---------- roles ----------

const BLANK: Partial<RoleListing> = { title: '', description: '', location: '', work_mode: 'remote', salary_min: null, salary_max: null, equity: '', skills: '', status: 'open' }

function Roles({ s, onChange }: { s: MyStartup; onChange: () => void }) {
  const [editing, setEditing] = useState<Partial<RoleListing> | null>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useToast()

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    try {
      if (editing.id) await api.saveRole(editing.id, editing)
      else await api.createRole(editing)
      setEditing(null)
      setToast(editing.id ? 'Role updated' : s.status === 'approved' ? 'Role is live' : 'Role saved — it goes live when you’re verified')
      onChange()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const num = (v: string) => (v === '' ? null : Number(v))
  const set = (patch: Partial<RoleListing>) => setEditing((cur) => ({ ...cur, ...patch }))

  return (
    <fieldset className="group">
      <legend>Open roles</legend>
      {!s.roles.length && <p className="group-note">Add the roles you’re hiring for. You swipe on developers one role at a time.</p>}
      <ul className="role-list">
        {s.roles.map((r) => (
          <li key={r.id} className={r.status === 'closed' ? 'closed' : ''}>
            <div>
              <strong>{r.title}</strong>
              <span className="muted small">
                {[WORK_LABEL[r.work_mode], r.location, salaryRange(r.salary_min, r.salary_max), r.status === 'closed' && 'Closed'].filter(Boolean).join(' · ')}
              </span>
            </div>
            <span className="role-stats">
              {!!r.interested && (
                <a href="#/discover" className="pill wait">
                  {r.interested} interested
                </a>
              )}
              {!!r.matches && <span className="muted small">{r.matches} matched</span>}
              <button className="link-btn" onClick={() => (setError(''), setEditing(r))}>
                Edit
              </button>
            </span>
          </li>
        ))}
      </ul>
      <button className="btn primary small" onClick={() => (setError(''), setEditing({ ...BLANK }))}>
        Add a role
      </button>

      <Sheet open={!!editing} onClose={() => setEditing(null)} label="Role">
        {editing && (
          <form onSubmit={save} className="role-form">
            <h2>{editing.id ? 'Edit role' : 'New role'}</h2>
            <label className="field">
              <span>Title</span>
              <input required autoFocus value={editing.title ?? ''} onChange={(e) => set({ title: e.target.value })} placeholder="Founding Engineer" />
            </label>
            <div className="row2">
              <label className="field">
                <span>Work</span>
                <select value={editing.work_mode} onChange={(e) => set({ work_mode: e.target.value as WorkMode })}>
                  <option value="remote">Remote</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="onsite">On-site</option>
                </select>
              </label>
              <label className="field">
                <span>Location</span>
                <input value={editing.location ?? ''} onChange={(e) => set({ location: e.target.value })} placeholder="US time zones" />
              </label>
            </div>
            <div className="row3">
              <label className="field">
                <span>Salary from</span>
                <input type="number" min={0} step={5000} value={editing.salary_min ?? ''} onChange={(e) => set({ salary_min: num(e.target.value) })} />
              </label>
              <label className="field">
                <span>Salary to</span>
                <input type="number" min={0} step={5000} value={editing.salary_max ?? ''} onChange={(e) => set({ salary_max: num(e.target.value) })} />
              </label>
              <label className="field">
                <span>Equity</span>
                <input value={editing.equity ?? ''} onChange={(e) => set({ equity: e.target.value })} placeholder="0.5–1%" />
              </label>
            </div>
            <label className="field">
              <span>Skills</span>
              <input value={editing.skills ?? ''} onChange={(e) => set({ skills: e.target.value })} placeholder="React, Node.js, Postgres" />
              <small>Developers with these skills show up first.</small>
            </label>
            <label className="field">
              <span>What they’ll do</span>
              <textarea rows={6} value={editing.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
            </label>
            {editing.id && (
              <label className="check">
                <input type="checkbox" checked={editing.status === 'closed'} onChange={(e) => set({ status: e.target.checked ? 'closed' : 'open' })} />
                <span>Closed — stop showing this role</span>
              </label>
            )}
            {error && <p className="error">{error}</p>}
            <div className="sheet-actions">
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary">{editing.id ? 'Save' : 'Add role'}</button>
            </div>
          </form>
        )}
      </Sheet>
      <Toast msg={toast} />
    </fieldset>
  )
}
