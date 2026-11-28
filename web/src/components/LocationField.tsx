import { useEffect, useRef, useState } from 'react'
import { guessLocation, locationNote, preciseLocation } from '../location'

/**
 * A "City, State" box that fills itself in when it's empty (device location if allowed, else the connection's
 * city), with a "Use my location" button to redo it. Whatever the developer types wins.
 */
export function LocationField({
  value,
  onChange,
  label,
  className = 'field',
}: {
  value: string
  onChange: (v: string) => void
  label: string
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const latest = useRef({ value, onChange })
  useEffect(() => {
    latest.current = { value, onChange }
  })

  // Prefill once when the box is empty. The connection's city is quick but can be a town off (it's where the
  // internet provider is), so the device's location replaces it when the browser allows (it asks once, right
  // at this question). Nothing typed by the developer is ever replaced.
  useEffect(() => {
    if (latest.current.value) return
    let live = true
    let auto = ''
    const fill = (place: string, why: string) => {
      const cur = latest.current.value
      if (!live || !place || (cur && cur !== auto)) return
      auto = place
      latest.current.onChange(place)
      setNote(why)
    }
    guessLocation().then((place) => {
      if (!auto) fill(place, 'Filled in from your connection. Change it if it’s off.')
    })
    ;(async () => {
      const state = await navigator.permissions
        ?.query({ name: 'geolocation' })
        .then((s) => s.state)
        .catch(() => 'prompt')
      if (state === 'denied') return
      const { place, accuracy } = await preciseLocation()
      fill(place, locationNote(accuracy))
    })()
    return () => {
      live = false
    }
  }, [])

  return (
    <label className={className}>
      <span>{label}</span>
      <span className="input-with-btn">
        <input
          value={value}
          onChange={(e) => {
            setNote('')
            onChange(e.target.value)
          }}
          placeholder="City, State"
          autoComplete="address-level2"
        />
        <button
          type="button"
          className="btn ghost small"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const { place, accuracy } = await preciseLocation()
            setBusy(false)
            if (place) {
              onChange(place)
              setNote(locationNote(accuracy))
            } else setNote('Couldn’t get your location (it may be blocked for this site). Type your city instead.')
          }}
        >
          {busy ? 'Locating…' : 'Use my location'}
        </button>
      </span>
      {note && <small>{note}</small>}
    </label>
  )
}
