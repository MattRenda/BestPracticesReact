import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { api } from '../api'
import type { AgentStatus, Job, Stats } from '../types'
import { QuestionsSheet } from './QuestionsSheet'

const THRESHOLD = 110
const ATS_NAME: Record<string, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' }

function ago(iso: string | null) {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'Posted today'
  if (days === 1) return 'Posted yesterday'
  if (days < 30) return `Posted ${days} days ago`
  return `Posted ${Math.floor(days / 30)} mo ago`
}

type Fling = { dir: 'left' | 'right' } | null

export function SwipeView({ stats, agent, onChange }: { stats: Stats | null; agent: AgentStatus | null; onChange: () => void }) {
  const [deck, setDeck] = useState<Job[] | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false })
  const [fling, setFling] = useState<Fling>(null)
  const [asking, setAsking] = useState<Job[]>([])
  const [toast, setToast] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [hasSources, setHasSources] = useState(true)
  const start = useRef({ x: 0, y: 0, t: 0 })

  const load = useCallback(() => {
    api.deck().then(setDeck, (e: Error) => setToast(e.message))
    api.sources().then((s) => setHasSources(s.length > 0), () => {})
  }, [])
  useEffect(load, [load])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const top = deck?.[0]

  const commit = useCallback(
    async (job: Job, dir: 'left' | 'right') => {
      setDeck((d) => d?.filter((j) => j.id !== job.id) ?? d)
      setHistory((h) => [job, ...h].slice(0, 20))
      try {
        const updated = await api.swipe(job.id, dir)
        onChange()
        if (dir === 'right' && updated.apply_state === 'questions') {
          const { questions } = await api.questions(job.id)
          if (questions.length) setAsking((a) => [...a, { ...updated, context: { ...updated.context, questions } }])
          else await api.saveContext(job.id, {}, true)
        }
      } catch (e) {
        setToast((e as Error).message)
        setDeck((d) => (d ? [job, ...d] : d))
      }
    },
    [onChange],
  )

  const swipe = useCallback(
    (dir: 'left' | 'right') => {
      if (!top || fling) return
      setFling({ dir })
      setTimeout(() => {
        setFling(null)
        setDrag({ x: 0, y: 0, active: false })
        commit(top, dir)
      }, 230)
    },
    [top, fling, commit],
  )

  const undo = useCallback(async () => {
    const [last, ...rest] = history
    if (!last) return
    try {
      await api.swipe(last.id, 'undo')
      setHistory(rest)
      setAsking((a) => a.filter((j) => j.id !== last.id))
      setDeck((d) => [last, ...(d ?? [])])
      onChange()
    } catch (e) {
      setToast((e as Error).message)
    }
  }, [history, onChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (asking.length || (e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.key === 'ArrowRight') swipe('right')
      else if (e.key === 'ArrowLeft') swipe('left')
      else if (e.key === 'z' || e.key === 'Backspace') undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [swipe, undo, asking.length])

  function onDown(e: RPointerEvent) {
    if (fling || (e.target as HTMLElement).closest('a, button')) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, y: e.clientY, t: performance.now() }
    setDrag({ x: 0, y: 0, active: true })
  }
  function onMove(e: RPointerEvent) {
    if (!drag.active) return
    setDrag({ x: e.clientX - start.current.x, y: (e.clientY - start.current.y) * 0.25, active: true })
  }
  function onUp() {
    if (!drag.active) return
    const v = Math.abs(drag.x) / Math.max(1, performance.now() - start.current.t)
    if (Math.abs(drag.x) > THRESHOLD || (v > 0.65 && Math.abs(drag.x) > 40)) swipe(drag.x > 0 ? 'right' : 'left')
    else setDrag({ x: 0, y: 0, active: false })
  }

  async function refresh() {
    setRefreshing(true)
    try {
      const r = await api.refreshFeed()
      const errs = r.report.filter((x) => x.error)
      setToast(r.added ? `${r.added} new job${r.added === 1 ? '' : 's'} added` : errs.length ? errs[0].error! : 'No new matches right now')
      load()
      onChange()
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  const x = fling ? (fling.dir === 'right' ? 1 : -1) * (window.innerWidth + 200) : drag.x
  const rot = x / 18
  const applyOpacity = Math.max(0, Math.min(1, x / THRESHOLD))
  const skipOpacity = Math.max(0, Math.min(1, -x / THRESHOLD))

  return (
    <section className="view swipe-view">
      <StatusStrip stats={stats} agent={agent} />

      {stats?.practiceMode && (
        <p className="practice-note">
          Practice mode: applications are filled, not submitted. Check them in <a href="#review">Review</a>, then turn it off in{' '}
          <a href="#settings">Settings</a>.
        </p>
      )}

      <div className="deck" aria-live="polite">
        {deck === null ? (
          <p className="deck-empty">Loading your deck…</p>
        ) : !top ? (
          <div className="deck-empty">
            {hasSources ? (
              <>
                <h2>You’re through the deck</h2>
                <p>Sprout checks your companies for new roles every few hours.</p>
                <button className="btn primary" onClick={refresh} disabled={refreshing}>
                  {refreshing ? 'Checking…' : 'Check for new jobs'}
                </button>
              </>
            ) : (
              <>
                <h2>Pick companies to pull jobs from</h2>
                <p>Paste their careers links in Settings — Greenhouse, Lever and Ashby boards work.</p>
                <a className="btn primary" href="#settings">
                  Add companies
                </a>
              </>
            )}
          </div>
        ) : (
          <>
            {deck[1] && (
              <article className="card behind" aria-hidden="true">
                <h2 className="card-company">{deck[1].company}</h2>
              </article>
            )}
            <article
              key={top.id}
              className={`card ${drag.active ? 'dragging' : ''}`}
              style={{ transform: `translate(${x}px, ${fling ? 0 : drag.y}px) rotate(${rot}deg)` }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag({ x: 0, y: 0, active: false })}
              aria-label={`${top.title} at ${top.company}`}
            >
              <span className="stamp stamp-apply" style={{ opacity: applyOpacity }} aria-hidden="true">
                Apply
              </span>
              <span className="stamp stamp-skip" style={{ opacity: skipOpacity }} aria-hidden="true">
                Skip
              </span>
              <header className="card-head">
                <h2 className="card-company">{top.company}</h2>
                <p className="card-title">{top.title}</p>
                <p className="card-meta">
                  {[top.location, ago(top.posted_at), top.source && `via ${ATS_NAME[top.source.split(':')[0]] ?? top.source}`].filter(Boolean).join('  ·  ')}
                </p>
              </header>
              <div className="card-body">
                {top.description ? (
                  top.description
                    .slice(0, 2400)
                    .split(/\n{2,}/)
                    .map((p, i) => <p key={i}>{p}</p>)
                ) : (
                  <p className="muted">No description provided.</p>
                )}
              </div>
              {top.url && (
                <a className="card-link" href={top.url} target="_blank" rel="noreferrer">
                  View full posting
                </a>
              )}
            </article>
          </>
        )}
      </div>

      <div className="swipe-actions">
        <button className="round skip" onClick={() => swipe('left')} disabled={!top} aria-label="Skip (left arrow)">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
        </button>
        <button className="round undo" onClick={undo} disabled={!history.length} aria-label="Undo last swipe (Z)">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M9 7H5V3M5.5 7.5A8 8 0 1 1 4 13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="round apply" onClick={() => swipe('right')} disabled={!top} aria-label="Apply (right arrow)">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <path d="M12 21V10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M12 12c0-4.4 2.8-7 7.5-7 0 4.4-2.8 7-7.5 7Z" fill="currentColor" />
            <path d="M12 15c0-3.4-2.2-5.4-6-5.4 0 3.4 2.2 5.4 6 5.4Z" fill="currentColor" opacity=".7" />
          </svg>
        </button>
      </div>
      <p className="swipe-hint">Swipe or use ← → · Z to undo</p>

      {asking[0] && (
        <QuestionsSheet
          key={asking[0].id}
          job={asking[0]}
          onDone={() => {
            setAsking((a) => a.slice(1))
            onChange()
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </section>
  )
}

function StatusStrip({ stats, agent }: { stats: Stats | null; agent: AgentStatus | null }) {
  if (!stats) return null
  let line = ''
  if (agent?.current) line = `Applying to ${agent.current.company}…`
  else if (stats.applying) line = `${stats.applying} waiting to apply`
  else if (agent?.note) line = agent.note
  else if (agent && !agent.enabled) line = 'Apply agent is off'
  return (
    <div className="status-strip">
      <span>
        <strong>{stats.deck}</strong> in deck
      </span>
      <span>
        <strong>{stats.appliedToday}</strong> applied today
      </span>
      {stats.needsYou > 0 && (
        <a href="#review" className="needs">
          <strong>{stats.needsYou}</strong> need you
        </a>
      )}
      {line && <span className={`agent-line ${agent?.current ? 'live' : ''}`}>{line}</span>}
    </div>
  )
}
