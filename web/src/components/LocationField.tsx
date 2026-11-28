import { useEffect, useRef, useState } from 'react'
import { guessLocation, preciseLocation } from '../location'

/**
 * A "City, State" box that fills itself in: a guess from the connection when it's empty, and a
 * "Use my location" button for the device's location. Whatever the developer types wins.
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

  // Prefill once, only if the box is still empty when the guess comes back.
  useEffect(() => {
    if (latest.current.value) return
    let live = true
    guessLocation().then((place) => {
      if (live && place && !latest.current.value) {
        latest.current.onChange(place)
        setNote('Filled in from your connection. Change it if it’s off.')
      }
    })
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
            const place = await preciseLocation()
            setBusy(false)
            if (place) {
              onChange(place)
              setNote('')
            } else setNote('Couldn’t get your location. Type your city instead.')
          }}
        >
          {busy ? 'Locating…' : 'Use my location'}
        </button>
      </span>
      {note && <small>{note}</small>}
    </label>
  )
}
