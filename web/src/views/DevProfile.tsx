import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { api } from '../api'
import type { DevProfile, WorkPref } from '../types'
import { Toast } from '../components/ui'
import { useToast } from '../lib'

const PREFS: [WorkPref, string][] = [
  ['remote', 'Remote'],
  ['hybrid', 'Hybrid'],
  ['onsite', 'On-site'],
  ['any', 'Open to anything'],
]

export function DevProfileView({ onboarding, onSaved }: { onboarding: boolean; onSaved: () => void }) {
  const [p, setP] = useState<DevProfile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useToast()

  useEffect(() => {
    api.profile().then(setP, (e: Error) => setToast(e.message))
  }, [setToast])

  const update = (patch: Partial<DevProfile>) => {
    setP((cur) => ({ ...cur, ...patch }))
    setDirty(true)
  }

  async function onImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const data = JSON.parse(await file.text()) as DevProfile
      if (typeof data !== 'object' || !data) throw new Error()
      const keys: (keyof DevProfile)[] = ['name', 'headline', 'location', 'work_pref', 'years', 'skills', 'bio', 'experience', 'links', 'salary_min']
      update(Object.fromEntries(keys.filter((k) => data[k] != null).map((k) => [k, data[k]])))
      setToast('Imported — check it over, then save')
    } catch {
      setToast('That file isn’t a HireMe profile (.json)')
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!p) return
    setSaving(true)
    try {
      const saved = await api.saveProfile(p)
      setP(saved)
      setDirty(false)
      onSaved()
      if (onboarding && saved.complete) location.hash = '#/discover'
      else setToast(saved.complete ? 'Profile saved' : 'Saved. Add your name, headline and skills to start swiping.')
    } catch (err) {
      setToast((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!p) return <p className="muted">Loading…</p>
  const text = (k: 'name' | 'headline' | 'location', label: string, placeholder = '', required = false) => (
    <label className="field">
      <span>
        {label}
        {required && <em className="req"> required</em>}
      </span>
      <input value={p[k] ?? ''} onChange={(e) => update({ [k]: e.target.value })} placeholder={placeholder} required={required} />
    </label>
  )

  return (
    <section className="view narrow">
      <header className="view-head">
        <h1>{onboarding ? 'Set up your profile' : 'Your profile'}</h1>
        <p className="lede">
          {onboarding
            ? 'This is what founders see when you say yes to their role. Your email stays private until you choose to share it.'
            : 'Founders see this when you say yes to their role, and when they’re looking for developers.'}
        </p>
        <label className="btn ghost small import">
          Import from file
          <input type="file" accept=".json,application/json" onChange={onImport} />
        </label>
      </header>

      <form onSubmit={save}>
        <fieldset className="group">
          <legend>The basics</legend>
          <div className="row2">
            {text('name', 'Name', 'Your name', true)}
            {text('location', 'Where you’re based', 'City, State')}
          </div>
          {text('headline', 'Headline', 'Senior full-stack engineer · React, Node', true)}
          <div className="row2">
            <label className="field">
              <span>Years of experience</span>
              <input type="number" min={0} max={60} value={p.years ?? ''} onChange={(e) => update({ years: e.target.value === '' ? null : Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Lowest salary you’d consider (optional)</span>
              <input type="number" min={0} step={5000} value={p.salary_min ?? ''} onChange={(e) => update({ salary_min: e.target.value === '' ? null : Number(e.target.value) })} placeholder="Only used to rank roles for you" />
            </label>
          </div>
          <fieldset className="field radios inline">
            <legend>How you want to work</legend>
            {PREFS.map(([v, label]) => (
              <label key={v}>
                <input type="radio" name="work_pref" checked={(p.work_pref ?? 'any') === v} onChange={() => update({ work_pref: v })} />
                {label}
              </label>
            ))}
          </fieldset>
        </fieldset>

        <fieldset className="group">
          <legend>What you’re good at</legend>
          <label className="field">
            <span>
              Skills <em className="req">required</em>
            </span>
            <input value={p.skills ?? ''} onChange={(e) => update({ skills: e.target.value })} placeholder="React, Node.js, TypeScript, Postgres" required />
            <small>Comma-separated. Roles that share your skills show up first.</small>
          </label>
          <label className="field">
            <span>About you</span>
            <textarea rows={4} maxLength={1500} value={p.bio ?? ''} onChange={(e) => update({ bio: e.target.value })} placeholder="What you’ve built, what you want to build next, and why a startup." />
          </label>
          <label className="field">
            <span>Experience</span>
            <textarea rows={10} maxLength={6000} value={p.experience ?? ''} onChange={(e) => update({ experience: e.target.value })} placeholder="Paste your resume’s experience section." />
          </label>
        </fieldset>

        <fieldset className="group">
          <legend>Links</legend>
          <div className="row2">
            <label className="field">
              <span>GitHub</span>
              <input type="url" value={p.links?.github ?? ''} onChange={(e) => update({ links: { ...p.links, github: e.target.value } })} placeholder="https://github.com/you" />
            </label>
            <label className="field">
              <span>LinkedIn</span>
              <input type="url" value={p.links?.linkedin ?? ''} onChange={(e) => update({ links: { ...p.links, linkedin: e.target.value } })} />
            </label>
          </div>
          <label className="field">
            <span>Website or portfolio</span>
            <input type="url" value={p.links?.portfolio ?? ''} onChange={(e) => update({ links: { ...p.links, portfolio: e.target.value } })} />
          </label>
        </fieldset>

        <fieldset className="group">
          <legend>Visibility</legend>
          <label className="toggle">
            <input type="checkbox" checked={p.visible !== false} onChange={(e) => update({ visible: e.target.checked })} />
            <span className="toggle-track" aria-hidden="true" />
            <span className="toggle-text">
              <span>Founders can find me</span>
              <small>Turn off to pause. Startups you already said yes to can still see you.</small>
            </span>
          </label>
          {!onboarding && <DeleteAccount />}
        </fieldset>

        <div className="sticky-save">
          <span className="status-msg">{dirty ? 'Unsaved changes' : ''}</span>
          <button className="btn primary" disabled={saving || (!dirty && !onboarding)}>
            {onboarding ? 'Save and start swiping' : 'Save profile'}
          </button>
        </div>
      </form>
      <Toast msg={toast} />
    </section>
  )
}

export function DeleteAccount() {
  return (
    <p className="account-actions">
      <button
        type="button"
        className="link-btn"
        onClick={async () => {
          await api.logout()
          location.hash = ''
          location.reload()
        }}
      >
        Sign out
      </button>
      <button
      type="button"
      className="link-btn danger"
      onClick={async () => {
        if (!confirm('Delete your HireMe account, profile, matches and messages? This can’t be undone.')) return
        await api.deleteAccount()
        location.hash = ''
        location.reload()
      }}
    >
        Delete my account
      </button>
    </p>
  )
}
