import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import type { Profile, YesNo } from '../types'

type TextKey = Exclude<
  { [K in keyof Profile]-?: Profile[K] extends string | undefined ? K : never }[keyof Profile],
  undefined
>

const DECLINE = 'Decline to self-identify'

export function ProfileView() {
  const [p, setP] = useState<Profile>({})
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api.profile().then(
      (data) => {
        setP(data)
        setLoaded(true)
      },
      (e: Error) => setMsg(e.message),
    )
  }, [])

  const update = (patch: Partial<Profile>) => {
    setP((cur) => ({ ...cur, ...patch }))
    setDirty(true)
    setMsg('')
  }

  const text = (k: TextKey, label: string, opts: { type?: string; placeholder?: string; auto?: string } = {}) => (
    <label className="field">
      <span>{label}</span>
      <input
        type={opts.type ?? 'text'}
        autoComplete={opts.auto}
        placeholder={opts.placeholder}
        value={(p[k] as string | undefined) ?? ''}
        onChange={(e) => update({ [k]: e.target.value })}
      />
    </label>
  )

  const yesNo = (k: 'workAuthorized' | 'requireSponsorship' | 'willingToRelocate', label: string) => (
    <fieldset className="field yesno">
      <legend>{label}</legend>
      {(['yes', 'no'] as YesNo[]).map((v) => (
        <label key={v}>
          <input type="radio" name={k} checked={p[k] === v} onChange={() => update({ [k]: v })} />
          {v === 'yes' ? 'Yes' : 'No'}
        </label>
      ))}
    </fieldset>
  )

  async function onResumeFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) return setMsg('Resume file is over 5 MB. Export a smaller PDF.')
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
    const patch: Partial<Profile> = { resumeFile: { name: file.name, type: file.type || 'application/pdf', data } }
    if (/^text\//.test(file.type) || /\.(txt|md)$/i.test(file.name)) patch.resumeText = await file.text()
    update(patch)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      setP(await api.saveProfile(p))
      setDirty(false)
      setMsg('Profile saved')
    } catch (err) {
      setMsg((err as Error).message)
    }
  }

  if (!loaded) return <section className="view"><p>{msg || 'Loading profile…'}</p></section>

  return (
    <section className="view narrow">
      <header className="view-head">
        <h1>Profile</h1>
        <p className="lede">
          Sprout fills every application from this. Fill it once, keep it current. Reusable replies live in <a href="#answers">saved answers</a>.
        </p>
      </header>

      <form className="profile-form" onSubmit={save}>
        <Group title="Contact">
          <div className="row2">
            {text('firstName', 'First name', { auto: 'given-name' })}
            {text('lastName', 'Last name', { auto: 'family-name' })}
          </div>
          <div className="row2">
            {text('email', 'Email', { type: 'email', auto: 'email' })}
            {text('phone', 'Phone', { type: 'tel', auto: 'tel' })}
          </div>
          <div className="row3">
            {text('city', 'City', { auto: 'address-level2' })}
            {text('state', 'State', { auto: 'address-level1' })}
            {text('zip', 'ZIP', { auto: 'postal-code' })}
          </div>
          {text('location', 'Location as you write it on forms', { placeholder: 'Roseville, CA' })}
        </Group>

        <Group title="Links">
          {text('linkedin', 'LinkedIn', { type: 'url' })}
          <div className="row2">
            {text('github', 'GitHub', { type: 'url' })}
            {text('portfolio', 'Website or portfolio', { type: 'url' })}
          </div>
        </Group>

        <Group title="Work">
          <div className="row2">
            {text('currentTitle', 'Current title')}
            {text('currentCompany', 'Current employer')}
          </div>
          <div className="row2">
            {text('yearsExperience', 'Years of experience', { type: 'number' })}
            {text('noticePeriod', 'Notice period or start date', { placeholder: '2 weeks' })}
          </div>
          {text('skills', 'Key skills', { placeholder: 'React, Node.js, TypeScript, Chrome extensions' })}
          <label className="field">
            <span>Short summary</span>
            <textarea rows={3} value={p.summary ?? ''} onChange={(e) => update({ summary: e.target.value })} placeholder="Two or three sentences about what you do. Used for 'tell us about yourself' and cover letters." />
          </label>
        </Group>

        <Group title="Screening questions" note="Most applications ask these. Answers are filled exactly as set here.">
          {yesNo('workAuthorized', 'Authorized to work in the US?')}
          {yesNo('requireSponsorship', 'Need visa sponsorship now or later?')}
          {yesNo('willingToRelocate', 'Willing to relocate?')}
          <div className="row2">
            {text('workArrangement', 'Preferred arrangement', { placeholder: 'Remote or hybrid' })}
            {text('salaryExpectation', 'Salary expectation', { placeholder: 'Leave blank to answer case by case' })}
          </div>
          {text('referralSource', 'How did you hear about us — default', { placeholder: 'LinkedIn' })}
        </Group>

        <Group title="Resume">
          <label className="field">
            <span>Resume file — attached to upload fields</span>
            <input type="file" accept=".pdf,.doc,.docx,.txt,.md" onChange={onResumeFile} />
            {p.resumeFile && <small>Current file: {p.resumeFile.name}</small>}
          </label>
          <label className="field">
            <span>Resume text — used to write cover letters and answers</span>
            <textarea rows={10} value={p.resumeText ?? ''} onChange={(e) => update({ resumeText: e.target.value })} placeholder="Paste the text of your resume." />
          </label>
        </Group>

        <Group title="Voluntary self-identification" note="US forms ask these optionally. Leave as declined unless you choose otherwise.">
          <div className="row2">
            {(
              [
                ['eeoGender', 'Gender'],
                ['eeoRace', 'Race / ethnicity'],
                ['eeoVeteran', 'Veteran status'],
                ['eeoDisability', 'Disability status'],
              ] as const
            ).map(([k, label]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input value={p[k] ?? DECLINE} onChange={(e) => update({ [k]: e.target.value })} />
              </label>
            ))}
          </div>
        </Group>

        <div className="sticky-save">
          <span className="status-msg" aria-live="polite">
            {msg || (dirty ? 'Unsaved changes' : '')}
          </span>
          <button className="btn primary" type="submit" disabled={!dirty}>
            Save profile
          </button>
        </div>
      </form>
    </section>
  )
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <fieldset className="group">
      <legend>{title}</legend>
      {note && <p className="group-note">{note}</p>}
      {children}
    </fieldset>
  )
}
