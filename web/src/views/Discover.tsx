import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, salaryRange, WORK_LABEL } from '../api'
import type { ApplyField, RoleCard } from '../types'
import { Deck } from '../components/Deck'
import { ApplySetup } from '../components/ApplySetup'
import { GuestApply } from '../components/GuestApply'
import { Chips, ReportButton, Toast } from '../components/ui'
import { ago, linkSentTo, useToast } from '../lib'

function paragraphs(text: string, max = 2400) {
  return text
    .slice(0, max)
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p, i) => <p key={i}>{p}</p>)
}

/** Swipe right and HireMe applies for you. Swipe left to skip. */
export function Discover({ onChange }: { onChange: () => void }) {
  const [deck, setDeck] = useState<RoleCard[] | null>(null)
  const [needsProfile, setNeedsProfile] = useState(false)
  const [setup, setSetup] = useState<{ roleId: number; startupName: string; applyUrl: string; missing: ApplyField[]; consented: boolean } | null>(null)
  const [guestFor, setGuestFor] = useState<string | null>(null)
  const [toast, setToast] = useToast()

  const load = useCallback(() => {
    api.roleDeck().then(setDeck, (e: ApiError) => (e.data?.needsProfile ? setNeedsProfile(true) : setToast(e.message)))
  }, [setToast])
  useEffect(load, [load])

  const onSwipe = useCallback(
    async (card: RoleCard, liked: boolean) => {
      try {
        const r = await api.swipeRole(card.id, liked)
        if (liked && r.needsAccount) {
          const sentTo = linkSentTo()
          if (sentTo) setToast(`Saved. It goes out when you tap the link we sent to ${sentTo}`)
          else setGuestFor(card.startup.name)
        } else if (liked && r.application) setToast(`Applying to ${card.startup.name} for you`)
        else if (liked && r.applySetup)
          setSetup({ roleId: card.id, startupName: card.startup.name, applyUrl: r.apply_url, missing: r.applySetup.missing, consented: r.applySetup.consented })
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

  return (
    <section className="view swipe-view">
      <div className="status-strip">
        <span>
          <strong>Startups only</strong> · every company has 50 people or fewer
        </span>
        <span className="muted">Swipe right and HireMe applies for you</span>
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
      <GuestApply company={guestFor} onClose={() => setGuestFor(null)} />
      <ApplySetup
        target={setup}
        onClose={() => setSetup(null)}
        onQueued={(name) => {
          setToast(`Applying to ${name} for you`)
          onChange()
        }}
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
