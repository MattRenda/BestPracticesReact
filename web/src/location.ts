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

/** The device's location (the browser asks for permission). '' if they say no or it fails. */
export function preciseLocation(): Promise<string> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve('')
    navigator.geolocation.getCurrentPosition(
      (pos) => lookup(`&latitude=${pos.coords.latitude.toFixed(3)}&longitude=${pos.coords.longitude.toFixed(3)}`).then(resolve),
      () => resolve(''),
      { timeout: 10000, maximumAge: 3600_000 },
    )
  })
}
