import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import type { SavedAnswer } from '../types'

const STARTERS = [
  'Why do you want to work here?',
  'Tell us about a project you are proud of.',
  'Describe a difficult technical problem you solved.',
  'What are you looking for in your next role?',
]

export function AnswersView() {
  const [list, setList] = useState<SavedAnswer[]>([])
  const [draft, setDraft] = useState({ question: '', answer: '' })
  const [editing, setEditing] = useState<SavedAnswer | null>(null)
  const [error, setError] = useState('')

  const load = () => api.answers().then(setList, (e: Error) => setError(e.message))
  useEffect(() => {
    load()
  }, [])

  async function add(e: FormEvent) {
    e.preventDefault()
    try {
      await api.addAnswer(draft)
      setDraft({ question: '', answer: '' })
      setError('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function saveEdit() {
    if (!editing) return
    await api.updateAnswer(editing.id, editing)
    setEditing(null)
    load()
  }

  async function remove(a: SavedAnswer) {
    if (!confirm('Delete this answer?')) return
    await api.deleteAnswer(a.id)
    load()
  }

  return (
    <section className="view narrow">
      <header className="view-head">
        <a className="back" href="#profile">Profile</a>
        <h1>Saved answers</h1>
        <p className="lede">
          When a form asks something close to one of these, Sprout uses your words. Anything else gets a draft written from your resume.
        </p>
      </header>

      <form className="answer-add" onSubmit={add}>
        <label className="field">
          <span>Question</span>
          <input value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} list="starters" required />
          <datalist id="starters">
            {STARTERS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Your answer</span>
          <textarea rows={4} value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} required />
        </label>
        <button className="btn primary" type="submit">
          Save answer
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>

      {list.length === 0 ? (
        <p className="empty">No saved answers yet. Start with “Why do you want to work here?” — almost every form asks it.</p>
      ) : (
        <ul className="answer-list">
          {list.map((a) =>
            editing?.id === a.id ? (
              <li key={a.id} className="editing">
                <input value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} aria-label="Question" />
                <textarea rows={4} value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} aria-label="Answer" />
                <div className="actions">
                  <button className="btn primary" onClick={saveEdit}>Save changes</button>
                  <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </li>
            ) : (
              <li key={a.id}>
                <h3>{a.question}</h3>
                <p>{a.answer}</p>
                <div className="actions">
                  <button className="link-btn" onClick={() => setEditing(a)}>Edit</button>
                  <button className="link-btn danger" onClick={() => remove(a)}>Delete</button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  )
}
