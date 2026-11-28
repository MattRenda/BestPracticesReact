import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'

/** Native <dialog> as a bottom sheet. Closes on Escape. */
export function Sheet({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={label}
      onClose={onClose}
      onCancel={onClose}
      // A tap on the dimmed backdrop (the dialog itself, outside its content) closes it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {open && children}
    </dialog>
  )
}

export function Toast({ msg }: { msg: string }) {
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null
}

export function Chips({ list, highlight = [] }: { list: string; highlight?: string[] }) {
  const items = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!items.length) return null
  const hi = new Set(highlight.map((h) => h.toLowerCase()))
  return (
    <ul className="chips">
      {items.map((s) => (
        <li key={s} className={hi.has(s.toLowerCase()) ? 'hit' : undefined}>
          {s}
        </li>
      ))}
    </ul>
  )
}

const REASONS: [string, string][] = [
  ['recruiter', 'It’s a recruiter or staffing agency'],
  ['too_big', 'The company has more than 50 people'],
  ['closed', 'The job isn’t open anymore'],
  ['spam', 'Spam or a fake listing'],
  ['other', 'Something else'],
]

export function ReportButton({ id, name, onDone }: { id: number; name: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [detail, setDetail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | string>('idle')

  async function send() {
    setState('sending')
    try {
      await api.report(id, reason, detail)
      setState('done')
      onDone?.()
    } catch (e) {
      setState((e as Error).message)
    }
  }

  return (
    <>
      <button className="link-btn quiet" onClick={() => setOpen(true)}>
        Report
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} label={`Report ${name}`}>
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          {state === 'done' ? (
            <>
              <h2>Thanks — we’ll take a look</h2>
              <p className="sheet-sub">You won’t see {name} in your deck anymore.</p>
              <div className="sheet-actions">
                <button type="button" className="btn primary" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Report {name}</h2>
              <p className="sheet-sub">HireMe is only for startups with 50 or fewer people hiring for themselves.</p>
              <fieldset className="field radios">
                {REASONS.map(([k, label]) => (
                  <label key={k}>
                    <input type="radio" name="reason" value={k} checked={reason === k} onChange={() => setReason(k)} />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label className="field">
                <span>Anything else? (optional)</span>
                <textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} />
              </label>
              {state !== 'idle' && state !== 'sending' && <p className="error">{state}</p>}
              <div className="sheet-actions">
                <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={!reason || state === 'sending'}>
                  Send report
                </button>
              </div>
            </>
          )}
        </form>
      </Sheet>
    </>
  )
}

