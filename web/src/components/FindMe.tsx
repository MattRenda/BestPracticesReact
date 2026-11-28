import { useState } from 'react'
import { api } from '../api'
import type { FoundAccount, FoundLinkedin } from '../types'
import { Sheet } from './ui'

type Links = { github?: string; linkedin?: string; portfolio?: string }

/**
 * "Find me": looks up GitHub accounts that match the developer (commit email, name, username, city) and
 * lets them confirm theirs. The LinkedIn and website linked from that GitHub come along. Nothing is
 * saved until they tap "That's me".
 */
export function FindMe({ who, links, onPick }: { who: { name?: string; email?: string; location?: string; website?: string }; links: Links; onPick: (links: Links) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<FoundAccount[] | null>(null)
  const [siteLinkedin, setSiteLinkedin] = useState<{ url: string; from: string } | null>(null)
  const [liMatches, setLiMatches] = useState<FoundLinkedin[]>([])
  const [liSearch, setLiSearch] = useState<{ enabled: boolean; name: string }>({ enabled: false, name: '' })
  const [typedName, setTypedName] = useState('')
  const [error, setError] = useState('')

  async function search(name = who.name) {
    setOpen(true)
    setBusy(true)
    setError('')
    try {
      const r = await api.findLinks({ ...who, name, website: who.website || links.portfolio })
      setLiSearch(r.linkedinSearch ?? { enabled: false, name: '' })
      setFound(r.candidates)
      setSiteLinkedin(r.linkedin && !r.candidates.some((c) => c.linkedin === r.linkedin?.url) ? r.linkedin : null)
      const known = new Set([...r.candidates.map((c) => c.linkedin), r.linkedin?.url].filter(Boolean))
      setLiMatches((r.linkedinMatches ?? []).filter((m) => !known.has(m.url)))
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
      <button type="button" className="btn ghost small findme-btn" onClick={() => search()}>
        Find me
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} label="Find your GitHub and LinkedIn">
        <div className="findme">
          <div className="findme-head">
            <h2>Is one of these you?</h2>
            <button type="button" className="link-btn findme-close" aria-label="Close" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
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
            {siteLinkedin ? (
              <>
                <p className="small">
                  Found on {siteLinkedin.from || 'your website'}: {siteLinkedin.url.replace(/^https?:\/\/(www\.)?/, '')}
                </p>
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => {
                    onPick({ linkedin: siteLinkedin.url })
                    setOpen(false)
                  }}
                >
                  That’s my LinkedIn
                </button>
              </>
            ) : liMatches.length ? null : liSearch.enabled && !liSearch.name && !busy ? (
              <form
                className="input-with-btn"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (typedName.trim().split(/\s+/).length >= 2) search(typedName.trim())
                }}
              >
                <input value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder="Your first and last name" autoComplete="name" aria-label="Your name" />
                <button className="btn ghost small" disabled={typedName.trim().split(/\s+/).length < 2}>
                  Search LinkedIn
                </button>
              </form>
            ) : (
              <p className="muted small">
                {liSearch.enabled && liSearch.name
                  ? `No LinkedIn profiles came up for “${liSearch.name}”. Paste your profile link into the LinkedIn box instead.`
                  : 'Paste your LinkedIn profile link into the LinkedIn box.'}
              </p>
            )}
            {liMatches.length > 0 && (
              <>
                <p className="muted small">Profiles with your name in web search results. Pick yours:</p>
                <ul className="findme-list">
                  {liMatches.map((m) => (
                    <li key={m.url} className={m.strong ? 'strong' : ''}>
                      <div className="findme-info">
                        <strong>{m.name}</strong>
                        {m.headline && <p className="small">{m.headline}</p>}
                        {m.location && <p className="muted small">{m.location}</p>}
                        <p className="small findme-why">{m.why.join(' · ')}</p>
                        <a className="small" href={m.url} target="_blank" rel="noreferrer noopener">
                          {m.url.replace(/^https?:\/\/(www\.)?/, '')}
                        </a>
                      </div>
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() => {
                          onPick({ linkedin: m.url })
                          setOpen(false)
                        }}
                      >
                        That’s me
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </Sheet>
    </>
  )
}

/** One tap: reads a copied LinkedIn profile link from the clipboard (the browser asks the first time). */
export function PasteLinkedIn({ onLink, onError }: { onLink: (url: string) => void; onError: (msg: string) => void }) {
  if (!navigator.clipboard?.readText) return null
  return (
    <button
      type="button"
      className="btn ghost small"
      onClick={async () => {
        try {
          const text = await navigator.clipboard.readText()
          const slug = text.match(/linkedin\.com\/in\/([\w%-]{3,100})/i)?.[1]
          if (slug) onLink(`https://www.linkedin.com/in/${slug}`)
          else onError('That isn’t a LinkedIn profile link. On your LinkedIn profile, tap Share (or More) → Copy link, then Paste.')
        } catch {
          onError('HireMe couldn’t read the clipboard. Paste the link into the LinkedIn box instead.')
        }
      }}
    >
      Paste
    </button>
  )
}
