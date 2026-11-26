import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'

const THRESHOLD = 110

type Props<T extends { id: number }> = {
  items: T[] | null
  /** Called after the card has flown off. Throw to put it back. */
  onSwipe: (item: T, liked: boolean) => Promise<void>
  onUndo?: (item: T) => Promise<void>
  renderCard: (item: T) => ReactNode
  behindLabel: (item: T) => string
  cardLabel: (item: T) => string
  empty: ReactNode
  disabled?: boolean
  yesLabel?: string
}

/** A Tinder-style stack: drag, arrow keys or buttons. Z undoes. */
export function Deck<T extends { id: number }>({ items, onSwipe, onUndo, renderCard, behindLabel, cardLabel, empty, disabled, yesLabel = 'Yes' }: Props<T>) {
  const [gone, setGone] = useState<Set<number>>(new Set())
  const [history, setHistory] = useState<T[]>([])
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false })
  const [fling, setFling] = useState<'left' | 'right' | null>(null)
  const start = useRef({ x: 0, y: 0, t: 0 })

  const visible = items?.filter((i) => !gone.has(i.id)) ?? null
  const top = visible?.[0]

  // New deck from the server → forget local state (adjusting state during render, not in an effect)
  const [source, setSource] = useState(items)
  if (source !== items) {
    setSource(items)
    setGone(new Set())
    setHistory([])
  }

  const commit = useCallback(
    async (item: T, liked: boolean) => {
      setGone((g) => new Set(g).add(item.id))
      setHistory((h) => [item, ...h].slice(0, 20))
      try {
        await onSwipe(item, liked)
      } catch {
        setGone((g) => {
          const n = new Set(g)
          n.delete(item.id)
          return n
        })
        setHistory((h) => h.filter((x) => x.id !== item.id))
      }
    },
    [onSwipe],
  )

  function swipe(dir: 'left' | 'right') {
    if (!top || fling || disabled) return
    setFling(dir)
    setTimeout(() => {
      setFling(null)
      setDrag({ x: 0, y: 0, active: false })
      commit(top, dir === 'right')
    }, 230)
  }

  async function undo() {
    const [last, ...rest] = history
    if (!last || !onUndo) return
    try {
      await onUndo(last)
      setHistory(rest)
      setGone((g) => {
        const n = new Set(g)
        n.delete(last.id)
        return n
      })
    } catch {
      /* parent shows the error */
    }
  }

  // Latest handlers for the keyboard listener
  const keys = useRef({ swipe, undo })
  useEffect(() => {
    keys.current = { swipe, undo }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled || (e.target as HTMLElement).closest('input, textarea, select, dialog')) return
      if (e.key === 'ArrowRight') keys.current.swipe('right')
      else if (e.key === 'ArrowLeft') keys.current.swipe('left')
      else if (e.key === 'z') keys.current.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled])

  function onDown(e: RPointerEvent) {
    if (fling || disabled || (e.target as HTMLElement).closest('a, button')) return
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

  const x = fling ? (fling === 'right' ? 1 : -1) * (window.innerWidth + 200) : drag.x
  const yesOpacity = Math.max(0, Math.min(1, x / THRESHOLD))
  const passOpacity = Math.max(0, Math.min(1, -x / THRESHOLD))

  return (
    <>
      <div className="deck" aria-live="polite">
        {visible === null ? (
          <p className="deck-empty">Loading…</p>
        ) : !top ? (
          <div className="deck-empty">{empty}</div>
        ) : (
          <>
            {visible[1] && (
              <article className="card behind" aria-hidden="true">
                <h2 className="card-company">{behindLabel(visible[1])}</h2>
              </article>
            )}
            <article
              key={top.id}
              className={`card ${drag.active ? 'dragging' : ''}`}
              style={{ transform: `translate(${x}px, ${fling ? 0 : drag.y}px) rotate(${x / 18}deg)` }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag({ x: 0, y: 0, active: false })}
              aria-label={cardLabel(top)}
            >
              <span className="stamp stamp-apply" style={{ opacity: yesOpacity }} aria-hidden="true">
                {yesLabel}
              </span>
              <span className="stamp stamp-skip" style={{ opacity: passOpacity }} aria-hidden="true">
                Pass
              </span>
              {renderCard(top)}
            </article>
          </>
        )}
      </div>

      <div className="swipe-actions">
        <button className="round skip" onClick={() => swipe('left')} disabled={!top || disabled} aria-label="Pass (left arrow)">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
        </button>
        {onUndo && (
          <button className="round undo" onClick={undo} disabled={!history.length} aria-label="Undo last swipe (Z)">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M9 7H5V3M5.5 7.5A8 8 0 1 1 4 13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button className="round apply" onClick={() => swipe('right')} disabled={!top || disabled} aria-label={`${yesLabel} (right arrow)`}>
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
            <circle cx="9" cy="12" r="5.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <circle cx="15" cy="12" r="5.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
          </svg>
        </button>
      </div>
      <p className="swipe-hint">Swipe or use ← → · Z to undo</p>
    </>
  )
}
