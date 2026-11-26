import { useState } from 'react'
import { api } from '../api'

export function ChooseRole({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState('')
  const pick = (role: 'dev' | 'founder') =>
    api.setRole(role).then(
      () => {
        location.hash = role === 'dev' ? '#/profile' : '#/startup'
        onDone()
      },
      (e: Error) => setError(e.message),
    )
  return (
    <main className="gate">
      <div className="choose">
        <img src="/hireme.svg" alt="" width={44} height={44} />
        <h1>What brings you here?</h1>
        <button className="choice" onClick={() => pick('dev')}>
          <strong>I’m a developer</strong>
          <span>Swipe on startups. Talk to founders directly.</span>
        </button>
        <button className="choice" onClick={() => pick('founder')}>
          <strong>I’m hiring at a startup</strong>
          <span>50 people or fewer. Needs your work email.</span>
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  )
}
