import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import type { Settings, Source } from '../types'

const ATS_NAME = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' } as const

export function SettingsView({ onChange }: { onChange: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [link, setLink] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const loadSources = () => api.sources().then(setSources, (e: Error) => setError(e.message))
  useEffect(() => {
    api.settings().then(setS, (e: Error) => setError(e.message))
    loadSources()
  }, [])

  // Every change saves immediately — no Save button to forget.
  async function update(patch: Partial<Settings>) {
    if (!s) return
    setS({ ...s, ...patch })
    try {
      await api.saveSettings(patch)
      setMsg('Saved')
      onChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function addSource(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const src = await api.addSource(link)
      setLink('')
      await loadSources()
      setMsg(`Added ${src.name || src.slug}`)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function refresh() {
    setRefreshing(true)
    setError('')
    try {
      const r = await api.refreshFeed()
      const errs = r.report.filter((x) => x.error).length
      setMsg(`${r.added} new job${r.added === 1 ? '' : 's'} added to your deck${errs ? ` · ${errs} source${errs === 1 ? '' : 's'} failed` : ''}`)
      loadSources()
      onChange()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  if (!s) return <section className="view narrow"><p>{error || 'Loading settings…'}</p></section>

  return (
    <section className="view narrow">
      <header className="view-head">
        <h1>Settings</h1>
        <p className="lede">Where jobs come from and how Sprout applies.</p>
      </header>

      <fieldset className="group">
        <legend>Companies</legend>
        <p className="group-note">Paste a company’s careers board link. Works with boards hosted on Greenhouse, Lever and Ashby — open a job on their careers page and copy the link if you’re not sure.</p>
        <form className="inline-add" onSubmit={addSource}>
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="jobs.lever.co/company or boards.greenhouse.io/company" aria-label="Careers board link" />
          <button className="btn primary" type="submit" disabled={!link.trim()}>
            Add company
          </button>
        </form>
        {sources.length > 0 && (
          <ul className="source-list">
            {sources.map((src) => (
              <li key={src.id}>
                <div>
                  <strong>{src.name || src.slug}</strong>
                  <span className="muted"> on {ATS_NAME[src.ats]}</span>
                  {src.last_error ? <p className="error small">{src.last_error}</p> : src.last_fetched_at ? <p className="muted small">Checked {new Date(src.last_fetched_at + 'Z').toLocaleString()}</p> : null}
                </div>
                <button className="link-btn danger" onClick={async () => (await api.deleteSource(src.id), loadSources())}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="btn ghost" onClick={refresh} disabled={refreshing || !sources.length}>
          {refreshing ? 'Checking boards…' : 'Check for new jobs now'}
        </button>
      </fieldset>

      <fieldset className="group">
        <legend>Which jobs reach your deck</legend>
        <Text label="Title must include any of" hint="Comma-separated" value={s.keywords} onSave={(v) => update({ keywords: v })} placeholder="engineer, developer" />
        <Text label="Skip titles with" hint="Comma-separated" value={s.exclude} onSave={(v) => update({ exclude: v })} placeholder="manager, staff, principal" />
        <Text label="Locations" hint="Comma-separated; leave blank for anywhere" value={s.locations} onSave={(v) => update({ locations: v })} placeholder="Sacramento, Roseville, San Francisco" />
        <Toggle label="Include remote jobs" checked={s.remoteOk} onChange={(v) => update({ remoteOk: v })} />
        <Num label="Only jobs posted in the last (days)" value={s.maxAgeDays} onSave={(v) => update({ maxAgeDays: v })} />
      </fieldset>

      <fieldset className="group">
        <legend>Applying</legend>
        <Toggle
          label="Practice mode"
          checked={s.practiceMode}
          onChange={(v) => update({ practiceMode: v })}
          hint="Fill every application but stop before Submit. Check a few practice runs in Review, then turn this off to apply for real."
        />
        <Toggle label="Ask me a few questions after I swipe right" checked={s.askQuestions} onChange={(v) => update({ askQuestions: v })} hint="Fills gaps between your resume and the job. Unanswered questions don’t block applying." />
        <Toggle label="Tailor my resume for each job" checked={s.tailorResume} onChange={(v) => update({ tailorResume: v })} hint="Needs an Anthropic API key on the server. Otherwise your uploaded resume is used." />
        <Toggle label="Let me approve each application first" checked={s.requireApproval} onChange={(v) => update({ requireApproval: v })} hint="Right swipes wait in Review until you approve them." />
        <Num label="Most applications per day" value={s.dailyLimit} onSave={(v) => update({ dailyLimit: v })} />
        <Num label="Check for new jobs every (hours)" value={s.autoRefreshHours} onSave={(v) => update({ autoRefreshHours: v })} />
      </fieldset>

      <p className="status-msg" aria-live="polite">
        {error ? <span className="error">{error}</span> : msg}
      </p>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

function Text({ label, hint, value, onSave, placeholder }: { label: string; hint?: string; value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value)
  return (
    <Row label={label} hint={hint}>
      <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
    </Row>
  )
}

function Num({ label, value, onSave }: { label: string; value: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value))
  return (
    <Row label={label}>
      <input type="number" min={0} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => Number(v) !== value && onSave(Number(v) || 0)} className="num" />
    </Row>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  )
}
