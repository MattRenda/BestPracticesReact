import { useEffect, useState } from 'react'

export function useToast(): [string, (m: string) => void] {
  const [msg, setMsg] = useState('')
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(''), 3500)
    return () => clearTimeout(t)
  }, [msg])
  return [msg, setMsg]
}

export function ago(iso: string | null | undefined) {
  if (!iso) return ''
  const t = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime()
  const mins = Math.floor((Date.now() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`
}

export const SENT_KEY = 'hireme-link-sent'

/** The email a sign-in link was sent to from this browser, while the person is still a guest. */
export function linkSentTo(): string {
  try {
    return localStorage.getItem(SENT_KEY) || ''
  } catch {
    return ''
  }
}
export function forgetLinkSent() {
  try {
    localStorage.removeItem(SENT_KEY)
  } catch {
    /* nothing kept */
  }
}
