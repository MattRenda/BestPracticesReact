import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, salaryRange, WORK_LABEL } from '../api'
import { GoogleButton } from '../components/GoogleButton'
import { Sheet } from '../components/ui'
import type { Hiring, HiringCompany, HiringRole, Me, WorkMode } from '../types'

/** #/hiring: startups with 50 or fewer people list their developer roles. Applications arrive by email. */
export function HiringView({ me, onChange }: { me: Me; onChange: () => void }) {
  const user = me.user && !me.user.isGuest ? me.user : null
  const userId = user?.id
  const [h, setH] = useState<Hiring | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.hiring().then(setH, (e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    if (userId) load()
  }, [userId, load])

  return (
    <div className="landing hiring">
      <header className="landing-top">
        <a className="brand" href="#/home">
          <img src="/hireme.svg" alt="" width={32} height={32} />
          <span>HireMe</span>
          <span className="brand-tag">for startups</span>
        </a>
        {user && (
          <button
            className="link-btn"
            onClick={async () => {
              await api.logout()
              onChange()
            }}
          >
            Sign out
          </button>
        )}
      </header>

      {!user ? (
        <Pitch />
      ) : !h ? (
        <p className="muted">{error || 'Loading…'}</p>
      ) : !h.startup ? (
        <AddCompany h={h} onDone={setH} onSignOut={async () => {
          await api.logout()
          onChange()
        }} />
      ) : (
        <Dashboard h={h} onChange={setH} />
      )}
    </div>
  )
}

function Pitch() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState<{ to: string; devLink?: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await api.startSignIn(email.trim(), 'hiring')
      setSent({ to: email.trim(), devLink: r.devLink })
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }

  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="kicker">For startups with 50 people or fewer</p>
        <h1>
          Post a role.
          <br />
          <em>Get developers in your inbox.</em>
        </h1>
        <p className="lede">
          Developers on HireMe swipe through engineering roles at small startups. When one swipes right on yours, you get an email with their resume, links and a
          short note. Reply to it and you’re talking to them. Free.
        </p>
      </div>

      {sent ? (
        <div className="signin-card">
          <h2 className="signin-title">Check your inbox</h2>
          <p className="muted">
            We sent a sign-in link to <strong>{sent.to}</strong>. Open it on this device to set up your company.
          </p>
          {sent.devLink && (
            <a className="btn primary wide" href={sent.devLink}>
              Open the link (no email set up on this server)
            </a>
          )}
          <button className="link-btn" onClick={() => setSent(null)}>
            Use a different email
          </button>
        </div>
      ) : (
        <form className="signin-card" onSubmit={submit}>
          <h2 className="signin-title">List your roles</h2>
          <p className="muted small">Sign in with your work email, at your company’s domain. That’s how we know you work there.</p>
          <GoogleButton divider="after" onError={setError} next="#/hiring" />
          <label className="field">
            <span className="sr-only">Work email</span>
            <input type="email" required autoComplete="email" placeholder="you@yourstartup.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary wide" disabled={busy || !email.trim()}>
            {busy ? 'One sec…' : 'Email me a sign-in link'}
          </button>
        </form>
      )}

      <div className="hero-more">
        <ul className="promises">
          <li>
            <strong>Developers only.</strong> Engineering roles, and every applicant has a full profile and resume.
          </li>
          <li>
            <strong>Startups only.</strong> Teams of 50 or fewer, hiring for themselves. No recruiters or staffing firms.
          </li>
          <li>
            <strong>Nothing new to learn.</strong> Applications arrive as email. No dashboard to check, no ATS to connect.
          </li>
        </ul>
        <p className="legal-links">
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="#/home">I’m a developer</a>
        </p>
      </div>
    </section>
  )
}

function AddCompany({ h, onDone, onSignOut }: { h: Hiring; onDone: (h: Hiring) => void; onSignOut: () => void }) {
  const [c, setC] = useState({ name: '', website: h.suggestedWebsite, headcount: '', location: '', one_liner: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(body: Partial<HiringCompany>) {
    setBusy(true)
    setError('')
    try {
      onDone(await api.createCompany(body))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  if (!h.workEmail)
    return (
      <section className="view narrow">
        <h1>Use your work email</h1>
        <p className="lede">
          You’re signed in as <strong>{h.email}</strong>. To list a company, sign in with your email at the company’s domain (like you@yourstartup.com), so we know
          you work there.
        </p>
        <button className="btn primary" onClick={onSignOut}>
          Sign in with a different email
        </button>
      </section>
    )

  if (h.existing)
    return (
      <section className="view narrow">
        <h1>{h.existing.name} is already on HireMe</h1>
        <p className="lede">
          HireMe lists {h.existing.name} ({h.existing.website.replace(/^https?:\/\//, '')}). Since you’re at that domain, you can join it and post roles.
        </p>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy} onClick={() => submit({ website: h.existing!.website })}>
          Join {h.existing.name}
        </button>
      </section>
    )

  return (
    <section className="view narrow">
      <header className="view-head compact">
        <h1>Your company</h1>
        <p className="lede">A few facts for the cards developers see. You can change them later.</p>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit({ ...c, headcount: Number(c.headcount) })
        }}
      >
        <div className="row2">
          <label className="field">
            <span>Company name</span>
            <input required value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Website</span>
            <input required value={c.website} onChange={(e) => setC({ ...c, website: e.target.value })} placeholder="https://yourstartup.com" />
            <small>Has to match your email’s domain.</small>
          </label>
        </div>
        <div className="row2">
          <label className="field">
            <span>People at the company</span>
            <input required type="number" min={1} max={50} value={c.headcount} onChange={(e) => setC({ ...c, headcount: e.target.value })} />
            <small>Including founders. HireMe is for teams of 50 or fewer.</small>
          </label>
          <label className="field">
            <span>Where you’re based</span>
            <input value={c.location} onChange={(e) => setC({ ...c, location: e.target.value })} placeholder="San Francisco · or Remote" />
          </label>
        </div>
        <label className="field">
          <span>What you’re building, in one line</span>
          <input maxLength={200} value={c.one_liner} onChange={(e) => setC({ ...c, one_liner: e.target.value })} placeholder="Payroll for restaurants" />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </section>
  )
}

const EMPTY_ROLE: Partial<HiringRole> = { title: '', description: '', location: '', work_mode: 'remote', salary_min: null, salary_max: null, equity: '' }

function Dashboard({ h, onChange }: { h: Hiring; onChange: (h: Hiring) => void }) {
  const s = h.startup!
  const roles = h.roles ?? []
  const [editing, setEditing] = useState<Partial<HiringRole> | null>(roles.length ? null : EMPTY_ROLE)
  const [company, setCompany] = useState(false)
  const [error, setError] = useState('')

  async function act(fn: () => Promise<Hiring>) {
    setError('')
    try {
      onChange(await fn())
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const open = roles.filter((r) => r.status === 'open')
  const sentTotal = roles.reduce((n, r) => n + r.applications, 0)

  return (
    <section className="view narrow">
      <header className="view-head compact">
        <h1>
          {s.name}{' '}
          <span className={`pill ${s.status === 'live' ? 'ok' : 'bad'}`}>{s.status === 'live' ? 'Live' : s.status === 'too_big' ? 'Over 50 people' : 'Hidden'}</span>
        </h1>
        <p className="lede">
          {open.length} open {open.length === 1 ? 'role' : 'roles'} · {sentTotal} {sentTotal === 1 ? 'application' : 'applications'} so far · they go to{' '}
          <strong>{s.apply_email}</strong>{' '}
          <button className="link-btn" onClick={() => setCompany(true)}>
            Change
          </button>
        </p>
        {s.status === 'hidden' && <p className="banner">Your roles are hidden while an admin looks at a report. We’ll email you.</p>}
      </header>

      {error && <p className="error">{error}</p>}

      {roles.length > 0 && (
        <ul className="admin-list hiring-roles">
          {roles.map((r) => (
            <li key={r.id} className={r.status === 'closed' ? 'closed' : ''}>
              <div>
                <strong>{r.title}</strong> {r.status === 'closed' && <span className="pill">Closed</span>}
                <p className="muted small">
                  {[WORK_LABEL[r.work_mode], r.location, salaryRange(r.salary_min, r.salary_max), r.equity && `${r.equity} equity`].filter(Boolean).join(' · ')}
                </p>
                <p className="small">
                  {r.applications} {r.applications === 1 ? 'application' : 'applications'}
                </p>
              </div>
              <div className="row-actions">
                <button className="btn ghost small" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button className="btn ghost small" onClick={() => act(() => api.saveRole(r.id, { status: r.status === 'open' ? 'closed' : 'open' }))}>
                  {r.status === 'open' ? 'Close' : 'Reopen'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button className="btn primary" onClick={() => setEditing(EMPTY_ROLE)}>
        Post a role
      </button>
      {!!h.imported && (
        <p className="muted small hiring-note">
          HireMe also lists {h.imported} {h.imported === 1 ? 'role' : 'roles'} from your public job board. Those apply through your board, as before.
        </p>
      )}

      <Sheet open={!!editing} onClose={() => setEditing(null)} label={editing?.id ? 'Edit role' : 'Post a role'}>
        {editing && (
          <RoleForm
            key={editing.id ?? 'new'}
            role={editing}
            onCancel={() => setEditing(null)}
            onSave={async (r) => {
              const next = r.id ? await api.saveRole(r.id, r) : await api.postRole(r)
              onChange(next)
              setEditing(null)
            }}
          />
        )}
      </Sheet>

      <Sheet open={company} onClose={() => setCompany(false)} label="Company details">
        {company && (
          <CompanyForm
            company={s}
            onCancel={() => setCompany(false)}
            onSave={async (c) => {
              onChange(await api.saveCompany(c))
              setCompany(false)
            }}
          />
        )}
      </Sheet>
    </section>
  )
}

function RoleForm({ role, onSave, onCancel }: { role: Partial<HiringRole>; onSave: (r: Partial<HiringRole>) => Promise<void>; onCancel: () => void }) {
  const [r, setR] = useState(role)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const num = (v: string) => (v === '' ? null : Number(v))

  return (
    <form
      className="sheet-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
          await onSave(r)
        } catch (err) {
          setError((err as Error).message)
          setBusy(false)
        }
      }}
    >
      <h2>{role.id ? 'Edit role' : 'Post a role'}</h2>
      <label className="field">
        <span>Job title</span>
        <input required value={r.title} onChange={(e) => setR({ ...r, title: e.target.value })} placeholder="Founding Engineer" />
      </label>
      <label className="field">
        <span>What they’ll do</span>
        <textarea
          required
          rows={7}
          value={r.description}
          onChange={(e) => setR({ ...r, description: e.target.value })}
          placeholder="What they’ll build, your stack, what you’re looking for. HireMe picks out the skills to match developers."
        />
      </label>
      <fieldset className="field radios inline">
        <legend>Where</legend>
        {(['remote', 'hybrid', 'onsite'] as WorkMode[]).map((m) => (
          <label key={m}>
            <input type="radio" name="work_mode" checked={r.work_mode === m} onChange={() => setR({ ...r, work_mode: m })} /> {WORK_LABEL[m]}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>Location (optional)</span>
        <input value={r.location} onChange={(e) => setR({ ...r, location: e.target.value })} placeholder="New York · or US time zones" />
      </label>
      <div className="row2">
        <label className="field">
          <span>Salary from (optional)</span>
          <input type="number" min={0} step={5000} value={r.salary_min ?? ''} onChange={(e) => setR({ ...r, salary_min: num(e.target.value) })} />
        </label>
        <label className="field">
          <span>Salary to</span>
          <input type="number" min={0} step={5000} value={r.salary_max ?? ''} onChange={(e) => setR({ ...r, salary_max: num(e.target.value) })} />
        </label>
      </div>
      <label className="field">
        <span>Equity (optional)</span>
        <input value={r.equity} onChange={(e) => setR({ ...r, equity: e.target.value })} placeholder="0.5–1%" />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : role.id ? 'Save' : 'Post it'}
        </button>
      </div>
    </form>
  )
}

function CompanyForm({ company, onSave, onCancel }: { company: HiringCompany; onSave: (c: Partial<HiringCompany>) => Promise<void>; onCancel: () => void }) {
  const [c, setC] = useState({ ...company, headcount: String(company.headcount || '') })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form
      className="sheet-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
          await onSave({ name: c.name, headcount: Number(c.headcount), location: c.location, one_liner: c.one_liner, about: c.about, apply_email: c.apply_email })
        } catch (err) {
          setError((err as Error).message)
          setBusy(false)
        }
      }}
    >
      <h2>Company details</h2>
      <label className="field">
        <span>Send applications to</span>
        <input type="email" required value={c.apply_email} onChange={(e) => setC({ ...c, apply_email: e.target.value })} />
        <small>Any address at {company.domain}, like jobs@{company.domain}.</small>
      </label>
      <div className="row2">
        <label className="field">
          <span>Company name</span>
          <input required value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </label>
        <label className="field">
          <span>People at the company</span>
          <input required type="number" min={1} max={50} value={c.headcount} onChange={(e) => setC({ ...c, headcount: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Where you’re based</span>
        <input value={c.location} onChange={(e) => setC({ ...c, location: e.target.value })} />
      </label>
      <label className="field">
        <span>One line</span>
        <input maxLength={200} value={c.one_liner} onChange={(e) => setC({ ...c, one_liner: e.target.value })} />
      </label>
      <label className="field">
        <span>About (optional)</span>
        <textarea rows={4} value={c.about} onChange={(e) => setC({ ...c, about: e.target.value })} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
