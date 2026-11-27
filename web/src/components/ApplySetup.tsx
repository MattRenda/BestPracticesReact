import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { api, uploadResumeFile } from '../api'
import type { ApplyField, DevProfile } from '../types'
import { Sheet } from './ui'

export const CONSENT_TEXT =
  'When I swipe right on a role, HireMe applies for me: it fills the startup’s application from my profile, attaches my resume, drafts answers to open-ended questions, accepts their privacy terms, and submits. It always asks me about work authorization, sponsorship, salary, start dates and similar questions instead of guessing.'

type Target = { roleId: number; startupName: string; applyUrl: string; missing: ApplyField[]; consented: boolean }

/** Shown the first time a developer swipes right, or when details HireMe needs are missing. */
export function ApplySetup({ target, onClose, onQueued }: { target: Target | null; onClose: () => void; onQueued: (startupName: string) => void }) {
  const [p, setP] = useState<DevProfile | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uploaded, setUploaded] = useState('')

  useEffect(() => {
    if (!target) return
    let live = true
    api.profile().then((x) => {
      if (!live) return
      setP(x)
      setConsent(!!x.auto_apply)
      setError('')
      setUploaded('')
    })
    return () => {
      live = false
    }
  }, [target])

  if (!target) return null
  const missing = new Set(target.missing)
  const needsResume = missing.has('resume') && !uploaded

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    try {
      const r = await uploadResumeFile(file)
      setUploaded(r.resume_name)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!p || !target) return
    setBusy(true)
    setError('')
    try {
      await api.saveProfile({ ...p, auto_apply: true })
      await api.apply(target.roleId, true)
      onQueued(target.startupName)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const set = (patch: Partial<DevProfile>) => setP((cur) => (cur ? { ...cur, ...patch } : cur))
  const yesNo = (k: 'work_authorized' | 'needs_sponsorship', legend: string) => (
    <fieldset className="field radios inline">
      <legend>{legend}</legend>
      {(['yes', 'no'] as const).map((v) => (
        <label key={v}>
          <input type="radio" name={k} required checked={p?.[k] === v} onChange={() => set({ [k]: v })} />
          {v === 'yes' ? 'Yes' : 'No'}
        </label>
      ))}
    </fieldset>
  )

  return (
    <Sheet open={!!target} onClose={onClose} label="Apply for me">
      <form onSubmit={submit} className="role-form">
        <h2>Let HireMe apply to {target.startupName}?</h2>
        <p className="sheet-sub">HireMe fills out and submits {target.startupName}’s application for you. It needs a few things first, just this once.</p>
        {!p ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {missing.has('name') && (
              <label className="field">
                <span>Full name (first and last)</span>
                <input required value={p.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
              </label>
            )}
            {missing.has('phone') && (
              <label className="field">
                <span>Phone</span>
                <input required type="tel" autoComplete="tel" value={p.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
              </label>
            )}
            {missing.has('work_authorized') && yesNo('work_authorized', 'Are you authorized to work in the US?')}
            {missing.has('needs_sponsorship') && yesNo('needs_sponsorship', 'Will you need visa sponsorship?')}
            {missing.has('resume') && (
              <div className="field">
                <span className="field-label">Resume</span>
                {uploaded ? (
                  <p className="small">✓ {uploaded}</p>
                ) : (
                  <p className="resume-row">
                    <label className="btn ghost small upload">
                      Upload PDF
                      <input type="file" accept="application/pdf,.pdf" onChange={upload} />
                    </label>
                    <span className="muted small">
                      or add your experience on your <a href="#/profile">Profile</a>
                    </span>
                  </p>
                )}
              </div>
            )}
            {!target.consented && (
              <label className="check">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span className="small">{CONSENT_TEXT}</span>
              </label>
            )}
            {error && <p className="error">{error}</p>}
            <div className="sheet-actions">
              <a className="btn ghost" href={target.applyUrl} target="_blank" rel="noreferrer noopener" onClick={onClose}>
                I’ll apply on their site
              </a>
              <button className="btn primary" disabled={busy || needsResume || !consent}>
                {busy ? 'Starting…' : 'Apply for me'}
              </button>
            </div>
          </>
        )}
      </form>
    </Sheet>
  )
}
