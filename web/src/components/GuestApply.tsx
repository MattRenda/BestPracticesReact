import { useEffect, useState, type ChangeEvent } from 'react'
import { api, uploadResumeFile } from '../api'
import type { DevProfile } from '../types'
import { CONSENT_TEXT } from './ApplySetup'
import { SaveAccount } from './SaveAccount'
import { Sheet } from './ui'

/**
 * A guest swiped right. Applications need a real email (and a phone and resume), so this is the
 * moment to ask, framed as "where should they reach you?". Once they tap the emailed link or use
 * Google, everything they swiped right on goes out.
 */
export function GuestApply({ company, onClose }: { company: string | null; onClose: () => void }) {
  const [p, setP] = useState<DevProfile | null>(null)
  const [phone, setPhone] = useState('')
  const [consent, setConsent] = useState(true)
  const [resume, setResume] = useState('')
  const [uploadError, setUploadError] = useState('')

  useEffect(() => {
    if (!company) return
    let live = true
    api.profile().then((x) => {
      if (!live) return
      setP(x)
      setPhone(x.phone ?? '')
      setResume(x.has_resume ? x.resume_name || 'Resume.pdf' : '')
    })
    return () => {
      live = false
    }
  }, [company])

  const needsResume = !!p && !p.has_resume && !p.experience && !resume

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadError('')
    try {
      setResume((await uploadResumeFile(file)).resume_name)
    } catch (err) {
      setUploadError((err as Error).message)
    }
  }

  /** Saves what applications need before signing in, so the claim can send them right away. */
  async function before() {
    if (!p) return 'One moment…'
    if (!phone.trim()) return 'Add a phone number — applications ask for one.'
    if (needsResume) return 'Add your resume — applications ask for one.'
    if (!consent) return 'Check the box so HireMe can apply for you.'
    await api.saveProfile({ ...p, phone: phone.trim(), auto_apply: true })
  }

  return (
    <Sheet open={!!company} onClose={onClose} label="Send your application">
      <SaveAccount
        title={`Send it to ${company}`}
        sub={`Where should ${company} reach you? HireMe fills out their application and sends it.`}
        before={before}
        onClose={onClose}
        sentText={(email) => (
          <>
            Tap the link we sent to <strong>{email}</strong> and your application to {company} goes out. Keep swiping: anything else you swipe right on goes out then too.
          </>
        )}
      >
        <label className="field">
          <span>Phone</span>
          <input type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        {p && !p.has_resume && !p.experience && (
          <div className="field">
            <span className="field-label">Resume</span>
            {resume ? (
              <p className="small">✓ {resume}</p>
            ) : (
              <p className="resume-row">
                <label className="btn ghost small upload">
                  Upload PDF
                  <input type="file" accept="application/pdf,.pdf" onChange={upload} />
                </label>
              </p>
            )}
            {uploadError && <p className="error">{uploadError}</p>}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="small">{CONSENT_TEXT}</span>
        </label>
      </SaveAccount>
    </Sheet>
  )
}
