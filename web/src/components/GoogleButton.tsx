import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

// Minimal types for Google Identity Services (https://accounts.google.com/gsi/client)
type GoogleId = {
  initialize: (o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup'; auto_select?: boolean }) => void
  renderButton: (el: HTMLElement, o: { theme?: string; size?: string; text?: string; shape?: string; width?: number; logo_alignment?: string }) => void
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } }
  }
}

let scriptPromise: Promise<void> | null = null
function loadGis() {
  scriptPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      scriptPromise = null
      reject(new Error('Couldn’t load Google sign-in'))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

/** "Sign in with Google". Shows nothing until the server has a Google client ID configured. */
export function GoogleButton({
  onError,
  before,
  divider = 'before',
  next,
}: {
  onError: (msg: string) => void
  before?: () => Promise<string | void>
  /** Where the "or" line goes, relative to the button. */
  divider?: 'before' | 'after'
  /** Where to go after signing in (default: Discover, or Applications if applications went out). */
  next?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const latest = useRef({ onError, before, next })
  const [clientId, setClientId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    latest.current = { onError, before, next }
  })

  useEffect(() => {
    api.config().then((c) => setClientId(c.googleClientId), () => {})
  }, [])

  useEffect(() => {
    if (!clientId) return
    let live = true
    loadGis().then(
      () => {
        const el = box.current
        if (!live || !el || !window.google) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          callback: async ({ credential }) => {
            setBusy(true)
            try {
              const problem = await latest.current.before?.()
              if (problem) throw new Error(problem)
              const r = await api.googleSignIn(credential)
              // From the home page, keep it in history so the back button returns to it.
              if (!location.hash || location.hash === '#/home') history.replaceState(null, '', '/#/home')
              location.hash = latest.current.next || (r.sent?.length ? '#/applications' : '#/discover')
              location.reload()
            } catch (e) {
              latest.current.onError((e as Error).message)
              setBusy(false)
            }
          },
        })
        window.google.accounts.id.renderButton(el, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'center',
          width: Math.max(200, Math.min(400, el.offsetWidth)),
        })
      },
      (e: Error) => live && latest.current.onError(e.message),
    )
    return () => {
      live = false
    }
  }, [clientId])

  if (!clientId) return null
  const or = (
    <div className="or" role="separator">
      <span>or</span>
    </div>
  )
  return (
    <>
      {divider === 'before' && or}
      <div ref={box} className="google-btn" aria-busy={busy} />
      {divider === 'after' && or}
    </>
  )
}
