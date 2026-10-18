import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Job } from '../types'

/** Shown right after a right swipe when Sprout wants a little more context for this job. */
export function QuestionsSheet({ job, onDone }: { job: Job; onDone: () => void }) {
  const questions = job.context?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>(job.context?.answers ?? {})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function finish(save: boolean) {
    setBusy(true)
    try {
      await api.saveContext(job.id, save ? answers : {}, true)
      ref.current?.close()
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} className="sheet" aria-labelledby="sheet-title" onCancel={(e) => (e.preventDefault(), finish(false))}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          finish(true)
        }}
      >
        <h2 id="sheet-title">A few questions for {job.company}</h2>
        <p className="sheet-sub">Your answers go into this application’s resume, cover letter and form answers.</p>
        {questions.map((q, i) => (
          <label className="field" key={q.id}>
            <span>{q.question}</span>
            <textarea
              rows={2}
              autoFocus={i === 0}
              placeholder={q.placeholder}
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            />
          </label>
        ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn ghost" onClick={() => finish(false)} disabled={busy}>
            Skip questions
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save and apply
          </button>
        </div>
      </form>
    </dialog>
  )
}
