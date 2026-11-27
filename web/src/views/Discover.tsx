import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, salaryRange, WORK_LABEL } from '../api'
import type { Me, RoleCard } from '../types'
import { Deck } from '../components/Deck'
import { Chips, ReportButton, Toast } from '../components/ui'
import { ago, useToast } from '../lib'

function paragraphs(text: string, max = 2400) {
  return text
    .slice(0, max)
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p, i) => <p key={i}>{p}</p>)
}

const FIELD_LABEL: Record<string, string> = { name: 'your full name', phone: 'your phone', work_authorized: 'US work authorization', needs_sponsorship: 'sponsorship' }

/** Swipe right and HireMe applies for you. Swipe left to skip. Nothing to fill in here. */
export function Discover({ me, onChange }: { me: Me; onChange: () => void }) {
  const [deck, setDeck] = useState<RoleCard[] | null>(null)
  const [needsProfile, setNeedsProfile] = useState(false)
  const [missing, setMissing] = useState<string[]>([])
  const [waiting, setWaiting] = useState(0)
  const [resent, setResent] = useState(false)
  const [toast, setToast] = useToast()
  const pendingEmail = me.user?.pendingEmail ?? ''

  const load = useCallback(() => {
    api.roleDeck().then(setDeck, (e: ApiError) => (e.data?.needsProfile ? setNeedsProfile(true) : setToast(e.message)))
    api.profile().then((p) => setMissing(p.applyMissing ?? []), () => {})
  }, [setToast])
  useEffect(load, [load])

  const onSwipe = useCallback(
    async (card: RoleCard, liked: boolean) => {
      try {
        const r = await api.swipeRole(card.id, liked)
        if (r.application) setToast(`Applying to ${card.startup.name}`)
        else if (r.waiting) setWaiting((n) => n + 1)
        onChange()
      } catch (e) {
        setToast((e as Error).message)
        throw e
      }
    },
    [onChange, setToast],
  )

  if (needsProfile)
    return (
      <section className="view swipe-view">
        <div className="deck-empty static">
          <h2>Finish your profile first</h2>
          <p>HireMe fills out every application from your profile.</p>
          <a className="btn primary" href="#/profile">
            Set up your profile
          </a>
        </div>
      </section>
    )

  // A quiet note, never a form: why right swipes haven't gone out yet, if they haven't.
  let note: ReactNode = null
  if (me.user?.isGuest && pendingEmail)
    note = (
      <>
        Tap the link we sent to <strong>{pendingEmail}</strong> and your applications go out.{' '}
        {resent ? (
          'Sent again.'
        ) : (
          <button type="button" className="link-btn" onClick={() => api.startSignIn(pendingEmail).then(() => setResent(true), (e: Error) => setToast(e.message))}>
            Resend
          </button>
        )}
      </>
    )
  else if (me.user?.isGuest)
    note = (
      <>
        Add your email so HireMe can send your applications. <a href="#/profile">Add it</a>
      </>
    )
  else if (missing.length)
    note = (
      <>
        Add {missing.map((m) => FIELD_LABEL[m] ?? m).join(' and ')} and HireMe sends your right swipes. <a href="#/profile">Add {missing.length === 1 ? 'it' : 'them'}</a>
      </>
    )

  return (
    <section className="view swipe-view">
      <div className="status-strip">
        <span>
          <strong>Startups only</strong> · every company has 50 people or fewer
        </span>
        <span className="muted">Swipe right and HireMe applies for you</span>
      </div>
      {note && (
        <p className={`swipe-note${waiting ? ' lit' : ''}`} role="status">
          {waiting > 0 && <strong>{waiting} waiting. </strong>}
          {note}
        </p>
      )}
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
        yesLabel="Apply"
        behindLabel={(c) => c.startup.name}
        cardLabel={(c) => `${c.title} at ${c.startup.name}`}
        renderCard={(c) => <RoleCardView c={c} onReported={load} />}
        empty={
          <>
            <h2>You’ve seen every open role</h2>
            <p>HireMe checks startup job boards twice a day, so new roles show up often. Check back soon.</p>
            <button className="btn ghost" onClick={load}>
              Refresh
            </button>
          </>
        }
      />
      <Toast msg={toast} />
    </section>
  )
}

function RoleCardView({ c, onReported }: { c: RoleCard; onReported: () => void }) {
  const s = c.startup
  const pay = salaryRange(c.salary_min, c.salary_max)
  return (
    <>
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
          <a className="card-link" href={c.apply_url} target="_blank" rel="noreferrer noopener">
            Original posting
          </a>
          {c.posted_at && <span className="muted small">Posted {ago(c.posted_at)}</span>}
        </span>
        <ReportButton id={s.id} name={s.name} onDone={onReported} />
      </footer>
    </>
  )
}
