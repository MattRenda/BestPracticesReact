import { LocationField } from '../components/LocationField'
import { FindMe, PasteLinkedIn } from '../components/FindMe'
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { api, uploadResumeFile } from '../api'
import type { DevProfile, WorkPref } from '../types'
import { Toast } from '../components/ui'
import { SaveAccount } from '../components/SaveAccount'
import { useToast } from '../lib'

const PREFS: [WorkPref, string][] = [
  ['remote', 'Remote'],
  ['hybrid', 'Hybrid'],
  ['onsite', 'On-site'],
  ['any', 'Open to anything'],
]

export function DevProfileView({ isGuest, pendingEmail, onSaved }: { isGuest: boolean; pendingEmail: string; onSaved: () => void }) {
  const [p, setP] = useState<DevProfile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useToast()
  const [reading, setReading] = useState(false)
  const [filled, setFilled] = useState<{ from: string; count: number; unreadable: boolean } | null>(null)

  useEffect(() => {
    api.profile().then(setP, (e: Error) => setToast(e.message))
  }, [setToast])

  const update = (patch: Partial<DevProfile>) => {
    setP((cur) => ({ ...cur, ...patch }))
    setDirty(true)
  }

  async function fillFromResume(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !p) return
    setReading(true)
    try {
      const r = await uploadResumeFile(file, true)
      const [next, count] = fillEmpty(p, r.parsed ?? {})
      setP({ ...next, has_resume: true, resume_name: r.resume_name })
      if (count) setDirty(true)
      setFilled({ from: r.resume_name, count, unreadable: !!r.unreadable })
      window.scrollTo({ top: 0 })
    } catch (err) {
      setToast((err as Error).message)
    } finally {
      setReading(false)
    }
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

  // Confirming a found account or pasting a LinkedIn link is the save: no extra Save tap needed.
  async function saveLinks(found: Partial<NonNullable<DevProfile['links']>>) {
    if (!p) return
    const next = { ...p, links: { ...p.links, ...found } }
    setP(next)
    try {
      setP(await api.saveProfile(next))
      setDirty(false)
      onSaved()
      const names = [found.github && 'GitHub', found.linkedin && 'LinkedIn', found.portfolio && 'website'].filter(Boolean)
      setToast(`${names.join(' and ').replace(/ and (?=.* and )/, ', ')} saved`)
    } catch (err) {
      setDirty(true)
      setToast((err as Error).message)
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
      setToast(
        saved.sent?.length
          ? `Saved. Applying to ${saved.sent.length === 1 ? saved.sent[0] : `${saved.sent.length} startups`} you swiped right on`
          : saved.complete
            ? 'Profile saved'
            : 'Saved. Add your name, headline and skills to start swiping.',
      )
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
        <h1>Your profile</h1>
        <p className="lede">HireMe fills out every application from this. It also decides which roles show up first.</p>
        <div className="head-actions">
          <label className="btn ghost small import">
            {reading ? 'Reading…' : 'Fill in from resume'}
            <input type="file" accept="application/pdf,.pdf" onChange={fillFromResume} disabled={reading} />
          </label>
          <label className="btn ghost small import">
            Import from file
            <input type="file" accept=".json,application/json" onChange={onImport} />
          </label>
        </div>
      </header>

      {isGuest && (
        <section className="guest-save">
          <SaveAccount
            title={pendingEmail ? 'Confirm your email' : 'Add your email'}
            sub={
              pendingEmail ? (
                <>
                  We sent a link to <strong>{pendingEmail}</strong>. Tap it and your applications go out. Wrong address or no email? Send a new link here.
                </>
              ) : (
                'HireMe sends your applications once you confirm your email. No password.'
              )
            }
          />
        </section>
      )}

      {filled && (
        <p className="banner" role="status">
          {filled.unreadable ? (
            <>
              <b>{filled.from}</b> looks like a scanned image, so there was no text to read. It’s saved as your resume for applications; fill in
              the rest below.
            </>
          ) : filled.count ? (
            <>
              Filled in {filled.count} {filled.count === 1 ? 'field' : 'fields'} from <b>{filled.from}</b>. Check them over, especially your
              headline, add anything missing, then save.
            </>
          ) : (
            <>
              Nothing new to fill in from <b>{filled.from}</b>. It’s saved as your resume for applications.
            </>
          )}
        </p>
      )}

      <form onSubmit={save}>
        <fieldset className="group">
          <legend>The basics</legend>
          <div className="row2">
            {text('name', 'Name', 'Your name', true)}
            <LocationField label="Where you’re based" value={p.location ?? ''} onChange={(v) => update({ location: v })} />
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

        <ApplyingSection p={p} update={update} onResume={(patch) => setP((cur) => ({ ...cur, ...patch }))} toast={setToast} />

        <fieldset className="group">
          <legend className="legend-row">
            <span>Links</span>
            <FindMe
              who={{ name: p.name, location: p.location, website: p.links?.portfolio }}
              links={p.links ?? {}}
              onPick={saveLinks}
            />
          </legend>
          <div className="row2">
            <label className="field">
              <span>GitHub</span>
              <input type="url" value={p.links?.github ?? ''} onChange={(e) => update({ links: { ...p.links, github: e.target.value } })} placeholder="https://github.com/you" />
            </label>
            <label className="field">
              <span>LinkedIn</span>
              <span className="input-with-btn">
                <input type="url" value={p.links?.linkedin ?? ''} onChange={(e) => update({ links: { ...p.links, linkedin: e.target.value } })} placeholder="https://www.linkedin.com/in/you" />
                <PasteLinkedIn onLink={(url) => saveLinks({ linkedin: url })} onError={setToast} />
              </span>
            </label>
          </div>
          <label className="field">
            <span>Website or portfolio</span>
            <input type="url" value={p.links?.portfolio ?? ''} onChange={(e) => update({ links: { ...p.links, portfolio: e.target.value } })} />
          </label>
        </fieldset>

        {!isGuest && (
          <fieldset className="group">
            <legend>Account</legend>
            <DeleteAccount />
          </fieldset>
        )}

        <div className="sticky-save">
          <span className="status-msg">{dirty ? 'Unsaved changes' : ''}</span>
          <button className="btn primary" disabled={saving || !dirty}>
            Save profile
          </button>
        </div>
      </form>
      <Toast msg={toast} />
    </section>
  )
}

const TEXT_FIELDS = ['name', 'headline', 'location', 'phone', 'skills', 'bio', 'experience'] as const

/** Copies suggestions into fields that are still empty; never overwrites what the developer wrote. */
function fillEmpty(cur: DevProfile, s: Partial<DevProfile>): [DevProfile, number] {
  const next: DevProfile = { ...cur, links: { ...cur.links } }
  let count = 0
  for (const k of TEXT_FIELDS)
    if (s[k] && !cur[k]?.trim()) {
      next[k] = s[k]
      count++
    }
  if (s.years != null && cur.years == null) {
    next.years = s.years
    count++
  }
  for (const k of ['github', 'linkedin', 'portfolio'] as const)
    if (s.links?.[k] && !cur.links?.[k]) {
      next.links = { ...next.links, [k]: s.links[k] }
      count++
    }
  return [next, count]
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
        if (!confirm('Delete your HireMe account, profile, resume and application history? This can’t be undone.')) return
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

/** Phone, work authorization, resume and saved answers: what HireMe uses to apply for you. */
function ApplyingSection({
  p,
  update,
  onResume,
  toast,
}: {
  p: DevProfile
  update: (patch: Partial<DevProfile>) => void
  onResume: (patch: Partial<DevProfile>) => void
  toast: (m: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const yesNo = (k: 'work_authorized' | 'needs_sponsorship', legend: string) => (
    <fieldset className="field radios inline">
      <legend>{legend}</legend>
      {(['yes', 'no'] as const).map((v) => (
        <label key={v}>
          <input type="radio" name={k} checked={p[k] === v} onChange={() => update({ [k]: v })} />
          {v === 'yes' ? 'Yes' : 'No'}
        </label>
      ))}
    </fieldset>
  )

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const r = await uploadResumeFile(file)
      onResume({ has_resume: true, resume_name: r.resume_name })
      toast('Resume uploaded')
    } catch (err) {
      toast((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const answers = p.saved_answers ?? []
  return (
    <fieldset className="group">
      <legend>Applying for you</legend>
      <p className="group-note">When you swipe right, HireMe fills out and sends the startup’s application with these. Extra questions get positive answers grounded in your resume. Work authorization, sponsorship, degrees and similar facts are always answered accurately.</p>
      <label className="toggle">
        <input type="checkbox" checked={!!p.review_first} onChange={(e) => update({ review_first: e.target.checked })} />
        <span className="toggle-track" aria-hidden="true" />
        <span className="toggle-text">
          <span>Review before sending</span>
          <small>HireMe fills out each application, then waits for you to check it and tap Send. Off: it sends right away.</small>
        </span>
      </label>
      <label className="field">
        <span>Phone</span>
        <input type="tel" autoComplete="tel" value={p.phone ?? ''} onChange={(e) => update({ phone: e.target.value })} />
      </label>
      {yesNo('work_authorized', 'Authorized to work in the US?')}
      {yesNo('needs_sponsorship', 'Need visa sponsorship?')}
      <FormAnswers p={p} update={update} />
      <div className="field">
        <span className="field-label">Resume</span>
        {p.has_resume ? (
          <p className="resume-row">
            <a href="/api/profile/resume" target="_blank" rel="noreferrer">
              {p.resume_name || 'Resume.pdf'}
            </a>
            <label className="link-btn upload">
              Replace
              <input type="file" accept="application/pdf,.pdf" onChange={upload} />
            </label>
            <button
              type="button"
              className="link-btn quiet"
              onClick={() => api.deleteResume().then(() => onResume({ has_resume: false, resume_name: null }), (e: Error) => toast(e.message))}
            >
              Remove
            </button>
          </p>
        ) : (
          <p className="resume-row">
            <span className="muted small">None uploaded. HireMe makes one from your profile; uploading yours makes applications stronger.</span>
            <label className="btn ghost small upload">
              {uploading ? 'Uploading…' : 'Upload PDF'}
              <input type="file" accept="application/pdf,.pdf" onChange={upload} disabled={uploading} />
            </label>
          </p>
        )}
      </div>
      {answers.length > 0 && (
        <details className="saved-answers">
          <summary>
            {answers.length} saved answer{answers.length === 1 ? '' : 's'} HireMe reuses on forms
          </summary>
          {answers.map((a, i) => (
            <label key={i} className="field">
              <span>{a.question}</span>
              <span className="row-inline">
                <input
                  value={a.answer}
                  onChange={(e) => update({ saved_answers: answers.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })}
                />
                <button type="button" className="link-btn quiet" onClick={() => update({ saved_answers: answers.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </span>
            </label>
          ))}
        </details>
      )}
    </fieldset>
  )
}

/** The answers HireMe gives to questions almost every form asks. Blank means the default shown. */
function FormAnswers({ p, update }: { p: DevProfile; update: (patch: Partial<DevProfile>) => void }) {
  const d = p.form_defaults
  const choice = (k: 'form_relocate' | 'form_onsite', label: string, auto: string | undefined) => (
    <label className="field">
      <span>{label}</span>
      <select value={p[k] ?? ''} onChange={(e) => update({ [k]: e.target.value as '' | 'yes' | 'no' })}>
        <option value="">Automatic ({auto === 'yes' ? 'Yes' : 'No'})</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  )
  return (
    <details className="form-answers">
      <summary>Answers HireMe gives on forms</summary>
      <p className="muted small">For the questions almost every application asks. Leave a box empty to use what’s shown.</p>
      <div className="row2">
        <label className="field">
          <span>Salary expectations</span>
          <input value={p.form_salary ?? ''} onChange={(e) => update({ form_salary: e.target.value })} placeholder={d?.salary} />
        </label>
        <label className="field">
          <span>Notice period / when you can start</span>
          <input value={p.form_notice ?? ''} onChange={(e) => update({ form_notice: e.target.value })} placeholder={d?.notice} />
        </label>
      </div>
      <div className="row2">
        {choice('form_onsite', 'Open to working in an office?', d?.onsite)}
        {choice('form_relocate', 'Willing to relocate?', d?.relocate)}
      </div>
    </details>
  )
}
