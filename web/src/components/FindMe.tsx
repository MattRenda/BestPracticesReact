import { useState } from 'react'
import { api } from '../api'
import type { FoundAccount } from '../types'
import { Sheet } from './ui'

type Links = { github?: string; linkedin?: string; portfolio?: string }

/**
 * "Find me": looks up GitHub accounts that match the developer (commit email, name, username, city) and
 * lets them confirm theirs. The LinkedIn and website linked from that GitHub come along. Nothing is
 * saved until they tap "That's me".
 */
export function FindMe({ who, links, onPick }: { who: { name?: string; email?: string; location?: string }; links: Links; onPick: (links: Links) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<FoundAccount[] | null>(null)
  const [error, setError] = useState('')

  async function search() {
    setOpen(true)
    setBusy(true)
    setError('')
    try {
      setFound((await api.findLinks(who)).candidates)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  function pick(c: FoundAccount) {
    onPick({
      github: c.url,
      ...(c.linkedin ? { linkedin: c.linkedin } : {}),
      ...(c.website && !links.portfolio ? { portfolio: c.website } : {}),
    })
    setOpen(false)
  }

  return (
    <>
      <button type="button" className="btn ghost small findme-btn" onClick={search}>
        Find me
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} label="Find your GitHub and LinkedIn">
        <div className="findme">
          <h2>Is one of these you?</h2>
          <p className="muted small">Public GitHub accounts that match your name, email or city. Pick yours and HireMe fills in your links.</p>
          {busy && <p className="muted">Looking on GitHub…</p>}
          {error && <p className="error">{error}</p>}
          {found && !found.length && !busy && <p className="muted">Nothing matched. You can type your links instead.</p>}
          <ul className="findme-list">
            {found?.map((c) => (
              <li key={c.login} className={c.strong ? 'strong' : ''}>
                {c.avatar && <img src={`${c.avatar}${c.avatar.includes('?') ? '&' : '?'}s=96`} alt="" width={48} height={48} />}
                <div className="findme-info">
                  <strong>{c.name || c.login}</strong> <span className="muted small">@{c.login}</span>
                  <p className="muted small">{[c.location, `${c.repos} public ${c.repos === 1 ? 'repo' : 'repos'}`].filter(Boolean).join(' · ')}</p>
                  {c.bio && <p className="small findme-bio">{c.bio}</p>}
                  <p className="small findme-why">{c.why.join(' · ')}</p>
                  {c.linkedin && <p className="small">LinkedIn: {c.linkedin.replace(/^https?:\/\/(www\.)?/, '')}</p>}
                  <a className="small" href={c.url} target="_blank" rel="noreferrer noopener">
                    View on GitHub
                  </a>
                </div>
                <button type="button" className="btn primary small" onClick={() => pick(c)}>
                  That’s me
                </button>
              </li>
            ))}
          </ul>
          <div className="findme-linkedin">
            <strong>LinkedIn</strong>
            <p className="muted small">
              LinkedIn can’t be searched from outside. This opens your own profile (if you’re signed in to LinkedIn); copy its address and paste it in the LinkedIn box.
            </p>
            <a className="btn ghost small" href="https://www.linkedin.com/in/me/" target="_blank" rel="noreferrer noopener">
              Open my LinkedIn
            </a>
          </div>
          <div className="sheet-actions">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              None of these
            </button>
          </div>
        </div>
      </Sheet>
    </>
  )
}
