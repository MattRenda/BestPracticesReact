import { LocationField } from '../components/LocationField'
import { FindMe, PasteLinkedIn } from '../components/FindMe'
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { api, uploadResumeFile } from '../api'
import type { DevProfile, Links, WorkPref } from '../types'
import { SaveAccount } from '../components/SaveAccount'
import { GoogleButton } from '../components/GoogleButton'
import { Sheet } from '../components/ui'

// A few taps, one question at a time, then straight into the deck. No "create an account" step:
// guests answer these and start swiping; an email is only asked for when they want to apply.

const KINDS: { id: string; label: string; title: string; skills: string[] }[] = [
  { id: 'frontend', label: 'Frontend', title: 'Frontend', skills: ['React', 'TypeScript', 'JavaScript', 'Next.js', 'CSS', 'Vue'] },
  { id: 'backend', label: 'Backend', title: 'Backend', skills: ['Node.js', 'Python', 'Go', 'Postgres', 'Java', 'Rails'] },
  { id: 'fullstack', label: 'Full-stack', title: 'Full-stack', skills: ['React', 'Node.js', 'TypeScript', 'Postgres', 'Python', 'AWS'] },
  { id: 'mobile', label: 'Mobile', title: 'Mobile', skills: ['React Native', 'Swift', 'Kotlin', 'iOS', 'Android', 'Flutter'] },
  { id: 'ai', label: 'AI / ML', title: 'AI/ML', skills: ['Python', 'PyTorch', 'LLMs', 'TensorFlow', 'CUDA'] },
  { id: 'data', label: 'Data', title: 'Data', skills: ['Python', 'SQL', 'Spark', 'dbt', 'Airflow', 'Snowflake'] },
  { id: 'infra', label: 'DevOps / Infra', title: 'Infrastructure', skills: ['AWS', 'Kubernetes', 'Terraform', 'Docker', 'Linux', 'GCP'] },
  { id: 'embedded', label: 'Embedded / Hardware', title: 'Embedded', skills: ['C++', 'Embedded', 'Firmware', 'Rust', 'ROS'] },
  { id: 'games', label: 'Games', title: 'Game', skills: ['Unity', 'Unreal', 'C#', 'C++'] },
]
const YEARS: [number, string][] = [
  [0, 'Just starting'],
  [1, '1–2 years'],
  [4, '3–5 years'],
  [7, '6–9 years'],
  [10, '10+ years'],
]
const WORK: [WorkPref, string][] = [
  ['remote', 'Remote'],
  ['hybrid', 'Hybrid'],
  ['onsite', 'In an office'],
  ['any', 'Open to anything'],
]

type Draft = {
  kinds: string[]
  skills: string[]
  years: number | null
  work: WorkPref | ''
  location: string
  auth: '' | 'yes' | 'no'
  sponsor: '' | 'yes' | 'no'
  links: Links
  first: string
  last: string
  // from a resume
  headline: string
  bio: string
  experience: string
  phone: string
  resume: string
  email: string
}
const EMPTY: Draft = { kinds: [], skills: [], years: null, work: '', location: '', auth: '', sponsor: '', links: {}, first: '', last: '', headline: '', bio: '', experience: '', phone: '', resume: '', email: '' }
const KEY = 'hireme-onboarding'
type Step = 'kinds' | 'skills' | 'years' | 'work' | 'auth' | 'links' | 'name' | 'review' | 'contact'

function loadDraft(): Draft {
  try {
    return { ...EMPTY, ...JSON.parse(sessionStorage.getItem(KEY) || '{}') }
  } catch {
    return EMPTY
  }
}

function headlineFor(d: Draft) {
  if (d.headline) return d.headline
  const titles = d.kinds.map((k) => KINDS.find((x) => x.id === k)?.title).filter(Boolean) as string[]
  const role = titles.length === 0 || titles.length > 2 ? 'Software engineer' : titles.length === 2 ? `${titles[0]} & ${titles[1].toLowerCase()} engineer` : `${titles[0]} engineer`
  return [role, d.skills.slice(0, 3).join(', ')].filter(Boolean).join(' · ')
}

/** "dana" in the GitHub box → https://github.com/dana; full URLs are kept. */
function normalizeLink(kind: keyof Links, v: string) {
  const t = v.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  if (/\.[a-z]{2,}(\/|$)/i.test(t)) return `https://${t.replace(/^\/+/, '')}`
  const handle = t.replace(/^@/, '')
  if (kind === 'github') return `https://github.com/${handle}`
  if (kind === 'linkedin') return `https://www.linkedin.com/in/${handle}`
  return `https://${handle}`
}

/** Guesses the kind of work from a resume's headline and skills. */
function kindsFrom(text: string) {
  const t = text.toLowerCase()
  const out: string[] = []
  if (/full[\s-]?stack/.test(t)) out.push('fullstack')
  else {
    if (/front[\s-]?end|react\b|vue|angular|css/.test(t)) out.push('frontend')
    if (/back[\s-]?end|node|django|rails|express|java\b|golang|\bgo\b|api/.test(t)) out.push('backend')
  }
  if (/mobile|ios|android|swift|kotlin|react native|flutter/.test(t)) out.push('mobile')
  if (/machine learning|\bml\b|\bai\b|pytorch|tensorflow|llm/.test(t)) out.push('ai')
  if (/data (engineer|scien)|spark|airflow|dbt|snowflake/.test(t)) out.push('data')
  if (/devops|sre|infrastructure|kubernetes|terraform/.test(t)) out.push('infra')
  if (/embedded|firmware|hardware/.test(t)) out.push('embedded')
  if (/\bgame|unity|unreal/.test(t)) out.push('games')
  return out.slice(0, 3)
}

export function Onboarding({ isGuest, email, pendingEmail, onDone }: { isGuest: boolean; email: string; pendingEmail: string; onDone: () => void }) {
  const [d, setD] = useState<Draft>(() => {
    const draft = loadDraft()
    return { ...draft, email: draft.email || pendingEmail }
  })
  const [step, setStep] = useState(0)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [signIn, setSignIn] = useState(false)

  const update = (patch: Partial<Draft>) =>
    setD((cur) => {
      const next = { ...cur, ...patch }
      try {
        sessionStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* private mode: answers just aren't kept across reloads */
      }
      return next
    })

  // With a resume, most questions are already answered: confirm what we read, then only ask the rest.
  const steps: Step[] = d.resume
    ? ['review', 'work', 'auth', ...(d.links.github || d.links.linkedin || d.links.portfolio ? [] : (['links'] as Step[])), 'contact']
    : ['kinds', 'skills', 'years', 'work', 'auth', 'links', 'name', 'contact']
  const current = steps[Math.min(step, steps.length - 1)]
  const last = step >= steps.length - 1
  const next = () => (last ? finish() : setStep(step + 1))

  async function onResume(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setReading(true)
    setError('')
    try {
      const r = await uploadResumeFile(file, true)
      const p = r.parsed ?? {}
      // "Matthew J Renda" → first "Matthew J", last "Renda"
      const words = (p.name ?? '').split(/\s+/).filter(Boolean)
      const lastName = words.length > 1 ? words[words.length - 1] : ''
      const first = words.length > 1 ? words.slice(0, -1).join(' ') : words.join(' ')
      const skills = (p.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      update({
        resume: r.resume_name,
        first: d.first || first,
        last: d.last || lastName,
        headline: p.headline ?? '',
        skills: skills.length ? skills : d.skills,
        years: p.years ?? d.years,
        location: d.location || p.location || '',
        links: { ...p.links, ...Object.fromEntries(Object.entries(d.links).filter(([, v]) => v)) },
        bio: p.bio ?? '',
        experience: p.experience ?? '',
        phone: d.phone || p.phone || '',
        kinds: d.kinds.length ? d.kinds : kindsFrom(`${p.headline ?? ''} ${p.skills ?? ''}`),
      })
      setStep(0)
      if (r.unreadable) setError('That PDF is a scanned image, so we couldn’t read it. It’s saved for applications; fill in the rest here.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setReading(false)
    }
  }

  /** Saves the profile. Returns an error message instead of throwing, so Google sign-in can use it too. */
  async function saveProfile(): Promise<string | void> {
    if (!d.first.trim() || !d.last.trim()) {
      setStep(steps.indexOf(d.resume ? 'review' : 'name'))
      return 'Add your first and last name — it goes on your applications.'
    }
    if (!d.skills.length) {
      setStep(steps.indexOf(d.resume ? 'review' : 'skills'))
      return 'Pick at least one thing you work with.'
    }
    if (!/^[+()\d][\d\s().+-]{6,}$/.test(d.phone.trim())) return 'Add a phone number — every application asks for one.'
    const profile: DevProfile = {
      name: `${d.first.trim()} ${d.last.trim()}`,
      headline: headlineFor(d).slice(0, 120),
      location: d.location.trim(),
      work_pref: d.work || 'any',
      years: d.years,
      skills: d.skills.join(', '),
      bio: d.bio,
      experience: d.experience,
      links: {
        github: normalizeLink('github', d.links.github ?? ''),
        linkedin: normalizeLink('linkedin', d.links.linkedin ?? ''),
        portfolio: normalizeLink('portfolio', d.links.portfolio ?? ''),
      },
      phone: d.phone.trim(),
      work_authorized: d.auth,
      needs_sponsorship: d.sponsor,
    }
    await api.saveProfile(profile)
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      /* nothing to clean up */
    }
  }

  async function finish(e?: FormEvent) {
    e?.preventDefault()
    setSaving(true)
    setError('')
    try {
      // Guests confirm their email with a one-tap link; applications wait for it, swiping doesn't.
      if (isGuest && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) throw new Error('Add your email — startups reply to it.')
      const problem = await saveProfile()
      if (problem) throw new Error(problem)
      // A new link only if the address changed since the one sent from the home page
      if (isGuest && d.email.trim().toLowerCase() !== pendingEmail.toLowerCase()) await api.startSignIn(d.email.trim())
      location.hash = '#/discover'
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const suggested = [...new Set([...d.kinds.flatMap((k) => KINDS.find((x) => x.id === k)?.skills ?? []), ...d.skills])]

  let body: ReactNode
  let canGo = true
  switch (current) {
    case 'kinds':
      canGo = d.kinds.length > 0
      body = (
        <>
          <Q title="What do you build?" sub="Pick as many as fit." />
          <div className="ob-chips">
            {KINDS.map((k) => (
              <Chip key={k.id} on={d.kinds.includes(k.id)} onClick={() => update({ kinds: toggle(d.kinds, k.id) })}>
                {k.label}
              </Chip>
            ))}
          </div>
          <label className={`ob-resume${reading ? ' busy' : ''}`}>
            <strong>{reading ? 'Reading your resume…' : 'Have a resume? Drop it here'}</strong>
            <span>We’ll fill in most of this for you. PDF.</span>
            <input type="file" accept="application/pdf,.pdf" onChange={onResume} disabled={reading} aria-label="Upload your resume (PDF)" />
          </label>
        </>
      )
      break
    case 'skills':
      canGo = d.skills.length > 0
      body = (
        <>
          <Q title="What do you work with?" sub="Roles that use these show up first." />
          <div className="ob-chips">
            {suggested.map((s) => (
              <Chip key={s} on={d.skills.includes(s)} onClick={() => update({ skills: toggle(d.skills, s) })}>
                {s}
              </Chip>
            ))}
          </div>
          <AddSkill onAdd={(s) => update({ skills: d.skills.includes(s) ? d.skills : [...d.skills, s] })} />
        </>
      )
      break
    case 'years':
      canGo = d.years != null
      body = (
        <>
          <Q title="How long have you been at it?" sub="Professionally, give or take." />
          <div className="ob-list">
            {YEARS.map(([v, label]) => (
              <Chip
                key={v}
                big
                on={d.years === v}
                onClick={() => {
                  update({ years: v })
                  setStep(step + 1)
                }}
              >
                {label}
              </Chip>
            ))}
          </div>
        </>
      )
      break
    case 'work':
      canGo = !!d.work
      body = (
        <>
          <Q title="How do you like to work?" />
          <div className="ob-chips two">
            {WORK.map(([v, label]) => (
              <Chip key={v} big on={d.work === v} onClick={() => update({ work: v })}>
                {label}
              </Chip>
            ))}
          </div>
          <LocationField className="field ob-field" label="Where are you based?" value={d.location} onChange={(v) => update({ location: v })} />
        </>
      )
      break
    case 'auth':
      canGo = !!d.auth && !!d.sponsor
      body = (
        <>
          <Q title="Two quick ones every application asks" sub="HireMe always answers these exactly as you say." />
          <YesNo label="Can you work in the US?" value={d.auth} onChange={(v) => update({ auth: v })} />
          <YesNo label="Will you need visa sponsorship?" value={d.sponsor} onChange={(v) => update({ sponsor: v })} />
        </>
      )
      break
    case 'links':
      body = (
        <>
          <Q title="Where can startups see your work?" sub="Most applications ask for these. A username is fine, or let HireMe find you." />
          <FindMe
            who={{ name: `${d.first} ${d.last}`.trim(), email: d.email || email, location: d.location, website: d.links.portfolio }}
            links={d.links}
            onPick={(found) => update({ links: { ...d.links, ...found } })}
          />
          {(['linkedin', 'github', 'portfolio'] as const).map((k) => (
            <label key={k} className="field ob-field">
              <span>{k === 'linkedin' ? 'LinkedIn' : k === 'github' ? 'GitHub' : 'Website or portfolio'}</span>
              <span className="input-with-btn">
                <input
                  value={d.links[k] ?? ''}
                  onChange={(e) => update({ links: { ...d.links, [k]: e.target.value } })}
                  placeholder={k === 'linkedin' ? 'linkedin.com/in/you' : k === 'github' ? 'github.com/you' : 'you.dev'}
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                {k === 'linkedin' && <PasteLinkedIn onLink={(url) => update({ links: { ...d.links, linkedin: url } })} onError={() => {}} />}
              </span>
            </label>
          ))}
        </>
      )
      break
    case 'name':
      canGo = !!d.first.trim() && !!d.last.trim()
      body = (
        <>
          <Q title="Last one. What’s your name?" sub="It goes at the top of your applications." />
          <div className="row2">
            <label className="field ob-field">
              <span>First name</span>
              <input value={d.first} onChange={(e) => update({ first: e.target.value })} autoComplete="given-name" autoFocus />
            </label>
            <label className="field ob-field">
              <span>Last name</span>
              <input value={d.last} onChange={(e) => update({ last: e.target.value })} autoComplete="family-name" />
            </label>
          </div>
        </>
      )
      break
    case 'contact':
      canGo = (!isGuest || !!d.email.trim()) && !!d.phone.trim()
      body = (
        <>
          <Q title="Where should startups reach you?" sub="This goes on your applications. After this it’s just swiping." />
          {isGuest ? (
            <label className="field ob-field">
              <span>Email</span>
              <input type="email" value={d.email} onChange={(e) => update({ email: e.target.value })} autoComplete="email" placeholder="you@example.com" />
            </label>
          ) : (
            <p className="ob-known">
              Email <strong>{email}</strong>
            </p>
          )}
          <label className="field ob-field">
            <span>Phone</span>
            <input type="tel" value={d.phone} onChange={(e) => update({ phone: e.target.value })} autoComplete="tel" placeholder="(555) 010-2233" />
          </label>
          {isGuest && (
            <div className="ob-google">
              <GoogleButton before={saveProfile} onError={setError} />
            </div>
          )}
          <p className="fine ob-fine">
            Swipe right and HireMe applies for you: it fills out the startup’s application with these details and your resume, answers the extra questions positively
            from your resume (never making anything up), and sends it. Change any default answer on your profile.
            {isGuest && ' We’ll email a link to confirm your address before the first one goes out.'}
          </p>
        </>
      )
      break
    case 'review':
      canGo = !!d.first.trim() && !!d.last.trim() && d.skills.length > 0
      body = (
        <>
          <Q title="Here’s what we picked up" sub={`From ${d.resume}. Fix anything that’s off.`} />
          <div className="row2">
            <label className="field ob-field">
              <span>First name</span>
              <input value={d.first} onChange={(e) => update({ first: e.target.value })} autoComplete="given-name" />
            </label>
            <label className="field ob-field">
              <span>Last name</span>
              <input value={d.last} onChange={(e) => update({ last: e.target.value })} autoComplete="family-name" />
            </label>
          </div>
          <label className="field ob-field">
            <span>Headline</span>
            <input value={headlineFor(d)} onChange={(e) => update({ headline: e.target.value })} />
          </label>
          <label className="field ob-field narrow-field">
            <span>Years of experience</span>
            <input type="number" min={0} max={60} value={d.years ?? ''} onChange={(e) => update({ years: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <span className="field-label">Skills — tap to remove</span>
          <div className="ob-chips">
            {d.skills.map((s) => (
              <Chip key={s} on onClick={() => update({ skills: d.skills.filter((x) => x !== s) })}>
                {s} ×
              </Chip>
            ))}
          </div>
          <AddSkill onAdd={(s) => update({ skills: d.skills.includes(s) ? d.skills : [...d.skills, s] })} />
        </>
      )
      break
  }

  return (
    <main className="onboarding">
      <header className="ob-top">
        <a className="brand" href="#/home">
          <img src="/hireme.svg" alt="" width={28} height={28} />
          <span>HireMe</span>
        </a>
        {isGuest && !pendingEmail && (
          <button type="button" className="link-btn" onClick={() => setSignIn(true)}>
            Have an account? Sign in
          </button>
        )}
      </header>
      <div className="ob-progress" aria-hidden="true">
        <span style={{ width: `${((step + 1) / (steps.length + 1)) * 100}%` }} />
      </div>
      {isGuest && pendingEmail && step === 0 && (
        <p className="ob-note">
          We emailed <strong>{pendingEmail}</strong> a link. Tap it whenever: it confirms your email, or signs you straight back in if you’ve used HireMe before.
        </p>
      )}
      <form
        className="ob-step"
        key={current}
        onSubmit={(e) => {
          e.preventDefault()
          if (canGo) next()
        }}
      >
        {body}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="ob-actions">
          {step > 0 || d.resume ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setError('')
                if (step > 0) setStep(step - 1)
                else update({ resume: '' }) // back to answering by hand
              }}
            >
              Back
            </button>
          ) : (
            <a className="btn ghost" href="#/home">
              Back
            </a>
          )}
          {current !== 'years' && (
            <button className="btn primary" disabled={!canGo || saving || reading}>
              {saving ? 'Finding startups…' : last ? 'Start swiping' : current === 'links' && !Object.values(d.links).some(Boolean) ? 'Skip' : 'Continue'}
            </button>
          )}
        </div>
      </form>
      <Sheet open={signIn} onClose={() => setSignIn(false)} label="Sign in">
        <SaveAccount title="Sign in" sub="We’ll email you a link. Anything you’ve answered here comes with you." onClose={() => setSignIn(false)} />
      </Sheet>
    </main>
  )
}

function Q({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="ob-q">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </header>
  )
}

function Chip({ on, big, onClick, children }: { on: boolean; big?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`ob-chip${on ? ' on' : ''}${big ? ' big' : ''}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  )
}

function YesNo({ label, value, onChange }: { label: string; value: string; onChange: (v: 'yes' | 'no') => void }) {
  return (
    <fieldset className="ob-yesno">
      <legend>{label}</legend>
      {(['yes', 'no'] as const).map((v) => (
        <button key={v} type="button" className={`ob-chip big${value === v ? ' on' : ''}`} aria-pressed={value === v} onClick={() => onChange(v)}>
          {v === 'yes' ? 'Yes' : 'No'}
        </button>
      ))}
    </fieldset>
  )
}

function AddSkill({ onAdd }: { onAdd: (s: string) => void }) {
  const [v, setV] = useState('')
  const add = () => {
    for (const s of v.split(',').map((x) => x.trim()).filter(Boolean)) onAdd(s.slice(0, 30))
    setV('')
  }
  return (
    <label className="field ob-field">
      <span className="sr-only">Add a skill</span>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
        placeholder="Add another, like Rust or Figma"
      />
    </label>
  )
}
