import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, salaryRange, WORK_LABEL } from '../api'
import type { DevCard, Me, MyStartup, RoleCard } from '../types'
import { Deck } from '../components/Deck'
import { Chips, ReportButton, Sheet, Toast } from '../components/ui'
import { useToast } from '../lib'

function paragraphs(text: string, max = 2400) {
  return text
    .slice(0, max)
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p, i) => <p key={i}>{p}</p>)
}

function MatchSheet({ match, onClose }: { match: { id: number; name: string } | null; onClose: () => void }) {
  return (
    <Sheet open={!!match} onClose={onClose} label="It’s a match">
      <form method="dialog" className="match-sheet">
        <svg viewBox="0 0 64 40" width="96" height="60" aria-hidden="true">
          <circle cx="24" cy="20" r="15" fill="none" stroke="var(--moss)" strokeWidth="5" />
          <circle cx="40" cy="20" r="15" fill="none" stroke="var(--pollen)" strokeWidth="5" />
        </svg>
        <h2>It’s a match</h2>
        <p className="sheet-sub">You and {match?.name} both said yes. Say hi while it’s fresh.</p>
        <div className="sheet-actions">
          <button className="btn ghost" onClick={onClose}>
            Keep swiping
          </button>
          <a className="btn primary" href={`#/matches/${match?.id}`} onClick={onClose}>
            Send a message
          </a>
        </div>
      </form>
    </Sheet>
  )
}

// ================= Developers: swipe on roles =================

export function DevDiscover({ onChange }: { onChange: () => void }) {
  const [deck, setDeck] = useState<RoleCard[] | null>(null)
  const [needsProfile, setNeedsProfile] = useState(false)
  const [noteFor, setNoteFor] = useState<RoleCard | null>(null)
  const [note, setNote] = useState('')
  const [match, setMatch] = useState<{ id: number; name: string } | null>(null)
  const [outside, setOutside] = useState<{ name: string; url: string } | null>(null)
  const [toast, setToast] = useToast()

  const load = useCallback(() => {
    api.roleDeck().then(setDeck, (e: ApiError) => (e.data?.needsProfile ? setNeedsProfile(true) : setToast(e.message)))
  }, [setToast])
  useEffect(load, [load])

  const onSwipe = useCallback(
    async (card: RoleCard, liked: boolean) => {
      try {
        const r = await api.swipeRole(card.id, liked)
        if (r.matched && r.matchId) setMatch({ id: r.matchId, name: card.startup.name })
        else if (liked && r.external) setOutside({ name: card.startup.name, url: r.external.apply_url })
        else if (liked) {
          setNote('')
          setNoteFor(card)
        }
        onChange()
      } catch (e) {
        setToast((e as Error).message)
        throw e
      }
    },
    [onChange, setToast],
  )

  async function sendNote() {
    if (!noteFor) return
    const card = noteFor
    setNoteFor(null)
    if (!note.trim()) return
    try {
      const r = await api.swipeRole(card.id, true, note.trim())
      setToast(`Note saved — ${card.startup.name} sees it with your profile`)
      if (r.matched && r.matchId) setMatch({ id: r.matchId, name: card.startup.name })
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  if (needsProfile)
    return (
      <section className="view swipe-view">
        <div className="deck-empty static">
          <h2>Finish your profile first</h2>
          <p>Founders see your profile when you say yes to their role.</p>
          <a className="btn primary" href="#/profile">
            Set up your profile
          </a>
        </div>
      </section>
    )

  return (
    <section className="view swipe-view">
      <div className="status-strip">
        <span>
          <strong>{deck?.length ?? '–'}</strong> startups hiring
        </span>
        <span className="muted">Every one has 50 people or fewer</span>
      </div>
      <Deck
        items={deck}
        onSwipe={onSwipe}
        onUndo={async (c) => {
          try {
            await api.undoRole(c.id)
            onChange()
          } catch (e) {
            setToast((e as Error).message)
            throw e
          }
        }}
        yesLabel="Yes"
        behindLabel={(c) => c.startup.name}
        cardLabel={(c) => `${c.title} at ${c.startup.name}`}
        renderCard={(c) => <RoleCardView c={c} onReported={load} />}
        empty={
          <>
            <h2>You’ve seen every open role</h2>
            <p>New startups get verified every week. Check back soon, or make your profile stand out so founders find you.</p>
            <button className="btn ghost" onClick={load}>
              Refresh
            </button>
          </>
        }
      />

      <Sheet open={!!noteFor} onClose={() => setNoteFor(null)} label="Add a note">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            sendNote()
          }}
        >
          <h2>Say why you’re interested</h2>
          <p className="sheet-sub">
            Optional. {noteFor?.startup.name} sees this with your profile. If they say yes too, it starts your chat.
          </p>
          <label className="field">
            <span className="sr-only">Note</span>
            <textarea rows={3} maxLength={500} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="I’ve built something close to this before…" />
          </label>
          <div className="sheet-actions">
            <button type="button" className="btn ghost" onClick={() => setNoteFor(null)}>
              Skip
            </button>
            <button className="btn primary" disabled={!note.trim()}>
              Send note
            </button>
          </div>
        </form>
      </Sheet>
      <MatchSheet match={match} onClose={() => setMatch(null)} />
      <Sheet open={!!outside} onClose={() => setOutside(null)} label="Apply on their site">
        <form method="dialog">
          <h2>Apply on {outside?.name}’s site</h2>
          <p className="sheet-sub">
            {outside?.name} hasn’t joined HireMe yet, so this one goes through their own application. We saved your yes: if they join, they’ll see you were interested. You can find it later under Matches.
          </p>
          <div className="sheet-actions">
            <button className="btn ghost" onClick={() => setOutside(null)}>
              Later
            </button>
            <a className="btn primary" href={outside?.url} target="_blank" rel="noreferrer noopener" onClick={() => setOutside(null)}>
              Open application
            </a>
          </div>
        </form>
      </Sheet>
      <Toast msg={toast} />
    </section>
  )
}

function RoleCardView({ c, onReported }: { c: RoleCard; onReported: () => void }) {
  const s = c.startup
  const pay = salaryRange(c.salary_min, c.salary_max)
  return (
    <>
      {c.interested && <p className="ribbon">{s.name} is interested in you</p>}
      {c.external && !c.interested && <p className="ribbon quiet">From YC’s startup directory · not on HireMe yet</p>}
      <header className="card-head">
        <h2 className="card-company">{s.name}</h2>
        <p className="card-size">
          {s.headcount} {s.headcount === 1 ? 'person' : 'people'}
          {s.stage && ` · ${s.stage}`}
          {s.location && ` · ${s.location}`}
        </p>
        <p className="card-title">{c.title}</p>
        <p className="card-meta">{[WORK_LABEL[c.work_mode], c.location, pay, c.equity && `${c.equity} equity`].filter(Boolean).join('  ·  ')}</p>
      </header>
      <div className="card-body">
        {s.one_liner && <p className="one-liner">{s.one_liner}</p>}
        <Chips list={c.skills} highlight={c.sharedSkills} />
        {c.description ? paragraphs(c.description) : <p className="muted">No description yet.</p>}
        {s.about && (
          <>
            <h3 className="card-sub">About {s.name}</h3>
            {paragraphs(s.about, 1200)}
          </>
        )}
      </div>
      <footer className="card-foot">
        <span className="card-links">
          <a className="card-link" href={s.website} target="_blank" rel="noreferrer noopener">
            {s.domain}
          </a>
          {c.external && (
            <a className="card-link" href={c.external.apply_url} target="_blank" rel="noreferrer noopener">
              Original posting
            </a>
          )}
        </span>
        <ReportButton type="startup" id={s.id} name={s.name} onDone={onReported} />
      </footer>
    </>
  )
}

// ================= Founders: swipe on developers, per role =================

export function FounderDiscover({ me, onChange }: { me: Me; onChange: () => void }) {
  const [startup, setStartup] = useState<MyStartup | null>(null)
  const [roleId, setRoleId] = useState<number | null>(null)
  const [deck, setDeck] = useState<DevCard[] | null>(null)
  const [match, setMatch] = useState<{ id: number; name: string } | null>(null)
  const [toast, setToast] = useToast()

  useEffect(() => {
    api.startup().then((s) => {
      setStartup(s)
      const open = s?.roles.filter((r) => r.status === 'open') ?? []
      // Start with the role that has the most developers waiting on you
      const best = [...open].sort((a, b) => (b.interested ?? 0) - (a.interested ?? 0))[0]
      setRoleId((cur) => cur ?? best?.id ?? null)
    }, (e: Error) => setToast(e.message))
  }, [setToast])

  const load = useCallback(() => {
    if (!roleId || me.startup?.status !== 'approved') return
    api.devDeck(roleId).then(setDeck, (e: Error) => setToast(e.message))
  }, [roleId, me.startup?.status, setToast])
  useEffect(load, [load])

  const onSwipe = useCallback(
    async (d: DevCard, liked: boolean) => {
      if (!roleId) return
      try {
        const r = await api.swipeDev(roleId, d.id, liked)
        if (r.matched && r.matchId) setMatch({ id: r.matchId, name: d.name })
        onChange()
      } catch (e) {
        setToast((e as Error).message)
        throw e
      }
    },
    [roleId, onChange, setToast],
  )

  if (me.startup?.status !== 'approved')
    return (
      <section className="view swipe-view">
        <div className="deck-empty static">
          <h2>{me.startup?.status === 'rejected' ? `We couldn’t verify ${me.startup.name}` : `We’re verifying ${me.startup?.name}`}</h2>
          <p>
            {me.startup?.status === 'rejected'
              ? me.startup.review_note || 'HireMe is only for startups with 50 or fewer people hiring for themselves.'
              : 'We check every startup by hand to keep recruiters and big companies out. You’ll get an email when you’re live, usually within a day.'}
          </p>
          {me.startup?.status === 'pending' && (
            <a className="btn primary" href="#/startup">
              Add your open roles meanwhile
            </a>
          )}
        </div>
      </section>
    )

  const open = startup?.roles.filter((r) => r.status === 'open') ?? []

  return (
    <section className="view swipe-view">
      {startup && !open.length ? (
        <div className="deck-empty static">
          <h2>Add a role to start swiping</h2>
          <p>You swipe on developers for a specific role. Developers who like that role show up first.</p>
          <a className="btn primary" href="#/startup">
            Add a role
          </a>
        </div>
      ) : (
        <>
          <div className="status-strip role-pick">
            <label>
              <span className="sr-only">Role</span>
              <select
                value={roleId ?? ''}
                onChange={(e) => {
                  setDeck(null)
                  setRoleId(Number(e.target.value))
                }}
              >
                {open.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                    {r.interested ? ` — ${r.interested} interested` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Deck
            items={deck}
            onSwipe={onSwipe}
            onUndo={async (d) => {
              if (!roleId) return
              try {
                await api.undoDev(roleId, d.id)
                onChange()
              } catch (e) {
                setToast((e as Error).message)
                throw e
              }
            }}
            behindLabel={(d) => d.name}
            cardLabel={(d) => `${d.name}, ${d.headline}`}
            renderCard={(d) => <DevCardView d={d} onReported={load} />}
            empty={
              <>
                <h2>No more developers for this role right now</h2>
                <p>New developers join every day. Developers who say yes to your role jump to the front.</p>
                <button className="btn ghost" onClick={load}>
                  Refresh
                </button>
              </>
            }
          />
        </>
      )}
      <MatchSheet match={match} onClose={() => setMatch(null)} />
      <Toast msg={toast} />
    </section>
  )
}

function DevCardView({ d, onReported }: { d: DevCard; onReported: () => void }) {
  const links = Object.entries(d.links || {}).filter(([, v]) => v) as [string, string][]
  return (
    <>
      {d.likedRole && <p className="ribbon">Said yes to this role</p>}
      <header className="card-head">
        <h2 className="card-company">{d.name}</h2>
        <p className="card-title">{d.headline}</p>
        <p className="card-meta">
          {[d.years != null && `${d.years} yrs experience`, d.location, d.work_pref && WORK_LABEL[d.work_pref]].filter(Boolean).join('  ·  ')}
        </p>
      </header>
      <div className="card-body">
        {d.note && <blockquote className="note">“{d.note}”</blockquote>}
        <Chips list={d.skills} highlight={d.sharedSkills} />
        {d.bio && paragraphs(d.bio, 1500)}
        {d.experience && (
          <>
            <h3 className="card-sub">Experience</h3>
            <div className="experience">{paragraphs(d.experience, 4000)}</div>
          </>
        )}
      </div>
      <footer className="card-foot">
        <span className="card-links">
          {links.map(([k, v]) => (
            <a key={k} className="card-link" href={v} target="_blank" rel="noreferrer noopener">
              {k === 'github' ? 'GitHub' : k === 'linkedin' ? 'LinkedIn' : 'Website'}
            </a>
          ))}
        </span>
        <ReportButton type="dev" id={d.id} name={d.name} onDone={onReported} />
      </footer>
    </>
  )
}
