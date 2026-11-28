import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api } from '../api'

/**
 * "Prove you're human": HireMe fills the application again while the developer watches, shows them the
 * site's own "are you human?" check (a live picture of just that box) and passes their taps to it. HireMe
 * never answers the check itself; if they don't finish it, the application stays as it was.
 */
export function HumanCheck({ appId, onFinished }: { appId: number; onFinished: (sent: boolean) => void }) {
  const [message, setMessage] = useState('Starting…')
  const [image, setImage] = useState<string | null>(null)
  const [result, setResult] = useState<{ state: string; error: string } | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const latest = useRef(onFinished)
  useEffect(() => {
    latest.current = onFinished
  })

  useEffect(() => {
    let live = true
    let timer = 0
    const poll = async () => {
      try {
        const r = await api.checkStatus(appId, seq.current)
        if (!live) return
        setMessage(r.message)
        if (r.seq !== seq.current) {
          seq.current = r.seq
          if (r.image !== undefined) setImage(r.image)
        }
        if (r.finished) {
          setImage(null)
          setResult(r.result)
          latest.current(r.result?.state === 'submitted')
          return
        }
      } catch (e) {
        if (live) setError((e as Error).message)
      }
      if (live) timer = window.setTimeout(poll, 500)
    }
    api.startCheck(appId).then(poll, (e: Error) => live && setError(e.message))
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [appId])

  function tap(e: MouseEvent<HTMLImageElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    api.checkInput(appId, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }).catch(() => {})
  }

  if (result)
    return (
      <div className="human-check">
        {result.state === 'submitted' ? <p className="human-done">Sent. Nice work.</p> : <p className="callout small">{result.error || 'It didn’t go through.'}</p>}
      </div>
    )

  return (
    <div className="human-check">
      <p className="small">{message}</p>
      {error && <p className="error">{error}</p>}
      {image ? (
        <img className="human-frame" src={`data:image/jpeg;base64,${image}`} alt="The site’s are-you-human check. Tap it as you would on their site." onClick={tap} draggable={false} />
      ) : (
        <div className="human-wait" aria-hidden="true" />
      )}
      <div className="sheet-actions">
        <button type="button" className="btn ghost small" onClick={() => api.checkInput(appId, { cancel: true }).catch(() => {})}>
          Stop
        </button>
        {image && (
          <button type="button" className="btn primary small" onClick={() => api.checkInput(appId, { done: true }).catch(() => {})}>
            I’ve done it
          </button>
        )}
      </div>
    </div>
  )
}
