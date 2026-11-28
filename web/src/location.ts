// "Where are you based?" filled in for the developer. First a rough guess from their connection (no prompt),
// then, if they tap "Use my location", the browser's location (it asks). Both go through BigDataCloud's
// free client-side reverse geocoder; only the resulting "City, ST" is kept.

const API = 'https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en'

interface Place {
  city?: string
  locality?: string
  principalSubdivision?: string
  principalSubdivisionCode?: string
  countryName?: string
  countryCode?: string
}

/** "Rocklin, CA" in the US and Canada, "Berlin, Germany" elsewhere; '' when the answer has no city. */
export function formatPlace(p: Place): string {
  const city = (p.city || p.locality || '').trim()
  if (!city) return ''
  const region = p.principalSubdivisionCode?.split('-')[1]
  if ((p.countryCode === 'US' || p.countryCode === 'CA') && region) return `${city}, ${region}`
  return [city, p.countryName?.replace(/ \(the\)$/, '')].filter(Boolean).join(', ')
}

async function lookup(query = ''): Promise<string> {
  try {
    const res = await fetch(`${API}${query}`, { signal: AbortSignal.timeout(6000) })
    return res.ok ? formatPlace(await res.json()) : ''
  } catch {
    return ''
  }
}

/** A city from the connection, without asking. Good enough to prefill; the developer can change it. */
export const guessLocation = () => lookup()

/**
 * The device's location (the browser asks for permission), with how accurate the phone says it is in meters.
 * Android can grant "approximate" location only, which is blurred by a few kilometers: the city can then be
 * the next town over, so callers say so.
 */
export function preciseLocation(): Promise<{ place: string; accuracy: number }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ place: '', accuracy: 0 })
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        lookup(`&latitude=${pos.coords.latitude.toFixed(4)}&longitude=${pos.coords.longitude.toFixed(4)}`).then((place) =>
          resolve({ place, accuracy: Math.round(pos.coords.accuracy || 0) }),
        ),
      () => resolve({ place: '', accuracy: 0 }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  })
}

/** What to tell the developer about where the city came from. */
export function locationNote(accuracy: number): string {
  if (accuracy > 1500)
    return `Your phone only shared an approximate location (within about ${Math.round(accuracy / 1000)} km), so this may be a nearby town. Allow “Precise” location for this site in your phone’s settings, or type your city.`
  return 'Filled in from your phone’s location.'
}
