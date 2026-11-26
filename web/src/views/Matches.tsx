import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, salaryRange, WORK_LABEL } from '../api'
import type { MatchDetail, MatchSummary, Me, Message, SavedRole } from '../types'
import { Chips, ReportButton, Toast } from '../components/ui'
import { ago, useToast } from '../lib'

export function Matches({ me, openId, onChange }: { me: Me; openId: number | null; onChange: () => void }) {
  const [list, setList] = useState<MatchSummary[] | null>(null)
  const [saved, setSaved] = useState<SavedRole[]>([])
  const isDev = me.user?.role === 'dev'
  useEffect(() => {
    if (isDev) api.saved().then(setSaved, () => {})
  }, [isDev])

  const load = useCallback(() => api.matches().then(setList, () => {}), [])
  useEffect(() => {
    load()
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 10_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <section className={`view matches ${openId ? 'has-open' : ''}`}>
      <div className="match-list">
        <header className="view-head compact">
          <h1>Matches</h1>
        </header>
        {list === null ? (
          <p className="muted">Loading…</p>
        ) : !list.length ? (
          <div className="empty-box">
            <p>
              <strong>No matches yet.</strong>
            </p>
            <p className="muted">
              {isDev ? 'When a startup you said yes to says yes back, you’ll be able to chat here.' : 'When a developer you said yes to likes your role too, you’ll be able to chat here.'}
            </p>
            <a className="btn ghost small" href="#/discover">
              Go swipe
            </a>
          </div>
        ) : (
          <ul className="threads">
            {list.map((m) => (
              <li key={m.id}>
                <a href={`#/matches/${m.id}`} aria-current={openId === m.id ? 'page' : undefined} className={m.closed ? 'closed' : ''}>
                  <span className="t-top">
                    <strong>{isDev ? m.startup_name : m.dev_name || 'Developer'}</strong>
                    <time>{ago(m.last_at || m.created_at)}</time>
                  </span>
                  <span className="t-role">{isDev ? m.role_title : `${m.role_title}${m.dev_headline ? ` · ${m.dev_headline}` : ''}`}</span>
                  <span className="t-last">{m.closed ? 'Conversation closed' : m.last_body || 'New match — say hi'}</span>
                  {m.unread > 0 && <span className="badge">{m.unread}</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
        {saved.length > 0 && (
          <section className="saved">
            <h2>Apply on their site</h2>
            <p className="muted small">You said yes to these, but the startups aren’t on HireMe yet.</p>
            <ul className="threads">
              {saved.map((r) => (
                <li key={r.id}>
                  <a href={r.apply_url} target="_blank" rel="noreferrer noopener" className={r.status === 'closed' ? 'closed' : ''}>
                    <span className="t-top">
                      <strong>{r.startup_name}</strong>
                      <time>{ago(r.liked_at)}</time>
                    </span>
                    <span className="t-role">{r.title}</span>
                    <span className="t-last">{r.status === 'closed' ? 'No longer posted' : 'Open application ↗'}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="thread-pane">
        {openId ? (
          <Thread key={openId} id={openId} isDev={isDev} onActivity={() => (load(), onChange())} />
        ) : (
          list?.length ? <p className="muted pad">Pick a conversation.</p> : null
        )}
      </div>
    </section>
  )
}

function Thread({ id, isDev, onActivity }: { id: number; isDev: boolean; onActivity: () => void }) {
  const [m, setM] = useState<MatchDetail | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const [toast, setToast] = useToast()
  const bottom = useRef<HTMLDivElement>(null)
  const lastId = messages.at(-1)?.id ?? 0

  useEffect(() => {
    api.match(id).then(
      (d) => {
        setM(d)
        setMessages(d.messages)
      },
      (e: Error) => setError(e.message),
    )
  }, [id])

  // Poll for new messages while the thread is open.
  useEffect(() => {
    if (!m) return
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      api.match(id, lastId).then((d) => {
        if (d.messages.length) setMessages((cur) => [...cur, ...d.messages.filter((x) => !cur.some((c) => c.id === x.id))])
        if (d.closed !== m.closed) setM(d)
      }, () => {})
    }, 4000)
    return () => clearInterval(t)
  }, [id, m, lastId])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
    if (lastId) api.markRead(id, lastId).then(onActivity, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, id])

  async function send(e: FormEvent) {
    e.preventDefault()
    const body = draft.trim()
    if (!body) return
    setDraft('')
    try {
      const r = await api.send(id, body)
      setMessages((cur) => [...cur, { id: r.id, body, created_at: new Date().toISOString(), sender_id: 0, mine: true, side: isDev ? 'dev' : 'startup' }])
    } catch (err) {
      setDraft(body)
      setToast((err as Error).message)
    }
  }

  async function close() {
    if (!confirm('Close this conversation? Neither side will be able to send more messages.')) return
    await api.closeMatch(id)
    setM((cur) => cur && { ...cur, closed: true })
    onActivity()
  }

  if (error) return <p className="error pad">{error}</p>
  if (!m) return <p className="muted pad">Loading…</p>

  const other = isDev ? m.startup.name : m.dev?.name || 'Developer'

  return (
    <div className="thread">
      <header className="thread-head">
        <a className="back only-phone" href="#/matches">
          Matches
        </a>
        <div>
          <h2>{other}</h2>
          <p className="muted small">
            {m.role.title}
            {isDev ? ` · ${m.startup.headcount} people` : m.dev?.headline ? ` · ${m.dev.headline}` : ''}
          </p>
        </div>
        <button className="btn ghost small" onClick={() => setShowInfo((s) => !s)} aria-expanded={showInfo}>
          {showInfo ? 'Hide details' : isDev ? 'Role details' : 'Profile'}
        </button>
      </header>

      {showInfo && (
        <div className="thread-info">
          {isDev ? (
            <>
              <p className="card-meta">{[WORK_LABEL[m.role.work_mode], m.role.location, salaryRange(m.role.salary_min, m.role.salary_max), m.role.equity && `${m.role.equity} equity`].filter(Boolean).join(' · ')}</p>
              {m.startup.one_liner && <p className="one-liner">{m.startup.one_liner}</p>}
              <Chips list={m.role.skills} />
              <p className="pre">{m.role.description}</p>
              <p>
                <a href={m.startup.website} target="_blank" rel="noreferrer noopener">
                  {m.startup.domain}
                </a>
              </p>
            </>
          ) : (
            m.dev && (
              <>
                <p className="card-meta">{[m.dev.years != null && `${m.dev.years} yrs`, m.dev.location, WORK_LABEL[m.dev.work_pref]].filter(Boolean).join(' · ')}</p>
                <Chips list={m.dev.skills} />
                {m.dev.bio && <p className="pre">{m.dev.bio}</p>}
                {m.dev.experience && <p className="pre">{m.dev.experience}</p>}
                <p className="card-links">
                  {Object.entries(m.dev.links || {})
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <a key={k} href={v} target="_blank" rel="noreferrer noopener">
                        {k === 'github' ? 'GitHub' : k === 'linkedin' ? 'LinkedIn' : 'Website'}
                      </a>
                    ))}
                </p>
              </>
            )
          )}
          <p className="thread-actions">
            {!m.closed && (
              <button className="link-btn quiet" onClick={close}>
                Close conversation
              </button>
            )}
            {isDev ? <ReportButton type="startup" id={m.startup.id} name={m.startup.name} /> : m.dev && <ReportButton type="dev" id={m.dev.id} name={m.dev.name} />}
          </p>
        </div>
      )}

      <div className="messages" aria-live="polite">
        <p className="match-note">
          You matched {ago(m.created_at)}. {isDev ? `You’re talking with the ${m.startup.name} team directly.` : 'Keep it human — this person said yes to you.'}
        </p>
        {messages.map((g) => (
          <div key={g.id} className={`msg ${g.mine ? 'mine' : g.side === (isDev ? 'dev' : 'startup') ? 'mine teammate' : ''}`}>
            <p>{g.body}</p>
            <time>{ago(g.created_at)}</time>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {m.closed ? (
        <p className="closed-note">This conversation is closed.</p>
      ) : (
        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="draft">
            Message
          </label>
          <textarea
            id="draft"
            rows={1}
            value={draft}
            maxLength={4000}
            placeholder={`Message ${other}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <button className="btn primary" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      )}
      <Toast msg={toast} />
    </div>
  )
}
