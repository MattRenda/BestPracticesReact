import { useState } from 'react'
import { api } from '../api'
import type { FoundAccount, FoundLinkedin } from '../types'
import { Sheet } from './ui'

type Who = { name?: string; email?: string; location?: string; website?: string }

/** One LinkedIn suggestion, wherever it came from (their GitHub, their website, web search). */
type LinkedinOption = { url: string; name: string; headline: string; location: string; why: string[]; strong: boolean }

/**
 * "Find me" for one link: a button next to the GitHub box or the LinkedIn box. It opens a sheet of matches
 * for just that link; "That's me" fills that one box and closes. Nothing is saved until they pick.
 *  - GitHub: public accounts matching their commit email, name, username and city.
 *  - LinkedIn: the link on a matching GitHub profile or their own website, then web search for their name.
 */
export function FindMe({ kind, who, onPick }: { kind: 'github' | 'linkedin'; who: Who; onPick: (url: string) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [github, setGithub] = useState<FoundAccount[]>([])
  const [linkedin, setLinkedin] = useState<LinkedinOption[]>([])
  const [needName, setNeedName] = useState(false)
  const [searchedName, setSearchedName] = useState('')
  const [typedName, setTypedName] = useState('')
  const [error, setError] = useState('')

  async function search(name = who.name) {
    setOpen(true)
    setBusy(true)
    setError('')
    try {
      const r = await api.findLinks({ ...who, name, only: kind })
      setGithub(r.candidates)
      const seen = new Set<string>()
      const options: LinkedinOption[] = []
      const add = (o: LinkedinOption) => {
        if (seen.has(o.url)) return
        seen.add(o.url)
        options.push(o)
      }
      for (const c of r.candidates)
        if (c.linkedin) add({ url: c.linkedin, name: c.name || c.login, headline: `Linked from GitHub @${c.login}`, location: c.location, why: c.why, strong: c.strong })
      if (r.linkedin) add({ url: r.linkedin.url, name: '', headline: `Linked from ${r.linkedin.from || 'your website'}`, location: '', why: ['On your own website'], strong: true })
      for (const m of r.linkedinMatches ?? []) add(m satisfies FoundLinkedin)
      setLinkedin(options)
      setNeedName(!!r.linkedinSearch?.enabled && !r.linkedinSearch.name)
      setSearchedName(r.linkedinSearch?.name ?? '')
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  const pick = (url: string) => {
    onPick(url)
    setOpen(false)
  }
  const label = kind === 'github' ? 'GitHub' : 'LinkedIn'

  return (
    <>
      <button type="button" className="btn ghost small findme-btn" onClick={() => search()}>
        Find me
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} label={`Find your ${label}`}>
        <div className="findme">
          <div className="findme-head">
            <h2>Which {label} is yours?</h2>
            <button type="button" className="link-btn findme-close" aria-label="Close" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          {busy && <p className="muted">Looking…</p>}
          {error && <p className="error">{error}</p>}

          {kind === 'github' && !busy && (
            <>
              {!github.length && !error && <p className="muted">No GitHub accounts matched. Type your username in the GitHub box instead.</p>}
              <ul className="findme-list">
                {github.map((c) => (
                  <li key={c.login} className={c.strong ? 'strong' : ''}>
                    {c.avatar && <img src={`${c.avatar}${c.avatar.includes('?') ? '&' : '?'}s=96`} alt="" width={48} height={48} />}
                    <div className="findme-info">
                      <strong>{c.name || c.login}</strong> <span className="muted small">@{c.login}</span>
                      <p className="muted small">{[c.location, `${c.repos} public ${c.repos === 1 ? 'repo' : 'repos'}`].filter(Boolean).join(' · ')}</p>
                      {c.bio && <p className="small findme-bio">{c.bio}</p>}
                      <p className="small findme-why">{c.why.join(' · ')}</p>
                      <a className="small" href={c.url} target="_blank" rel="noreferrer noopener">
                        View on GitHub
                      </a>
                    </div>
                    <button type="button" className="btn primary small" onClick={() => pick(c.url)}>
                      That’s me
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {kind === 'linkedin' && !busy && (
            <>
              {needName && !linkedin.length ? (
                <form
                  className="input-with-btn"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (typedName.trim().split(/\s+/).length >= 2) search(typedName.trim())
                  }}
                >
                  <input value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder="Your first and last name" autoComplete="name" aria-label="Your name" />
                  <button className="btn ghost small" disabled={typedName.trim().split(/\s+/).length < 2}>
                    Search
                  </button>
                </form>
              ) : (
                !linkedin.length &&
                !error && (
                  <p className="muted">
                    {searchedName ? `No LinkedIn profiles came up for “${searchedName}”.` : 'No LinkedIn profile found.'} Type your profile link into the LinkedIn box instead.
                  </p>
                )
              )}
              <ul className="findme-list">
                {linkedin.map((m) => (
                  <li key={m.url} className={m.strong ? 'strong' : ''}>
                    <div className="findme-info">
                      {m.name && <strong>{m.name}</strong>}
                      {m.headline && <p className="small">{m.headline}</p>}
                      {m.location && <p className="muted small">{m.location}</p>}
                      <p className="small findme-why">{m.why.join(' · ')}</p>
                      <a className="small" href={m.url} target="_blank" rel="noreferrer noopener">
                        {m.url.replace(/^https?:\/\/(www\.)?/, '')}
                      </a>
                    </div>
                    <button type="button" className="btn primary small" onClick={() => pick(m.url)}>
                      That’s me
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Sheet>
    </>
  )
}
