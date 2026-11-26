// Verifies the ID token that Google's "Sign in with Google" button hands the browser.
// Only the public client ID is needed (no client secret): we check Google's RS256 signature
// against its published keys, the audience, issuer, expiry, and that Google verified the email.
import { createPublicKey, verify } from 'node:crypto';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export function createGoogleVerifier({ clientId, fetchImpl = fetch, now = () => Date.now() }) {
  let keys = [];
  let fetchedAt = 0;

  async function loadKeys(force = false) {
    if (!force && keys.length && now() - fetchedAt < 6 * 3600_000) return keys;
    const res = await fetchImpl(CERTS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Couldn’t load Google’s signing keys (${res.status})`);
    keys = (await res.json()).keys || [];
    fetchedAt = now();
    return keys;
  }

  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

  /** Returns { email, name, hd } or throws with a message safe to show the person. */
  return async function verifyIdToken(token) {
    if (!clientId) throw new Error('Google sign-in isn’t set up on this server');
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('Invalid Google sign-in');
    let header, payload;
    try {
      header = decode(parts[0]);
      payload = decode(parts[1]);
    } catch {
      throw new Error('Invalid Google sign-in');
    }
    if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid Google sign-in');

    let jwk = (await loadKeys()).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await loadKeys(true)).find((k) => k.kid === header.kid); // Google rotated keys
    if (!jwk) throw new Error('Invalid Google sign-in');
    const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('Invalid Google sign-in');

    const t = Math.floor(now() / 1000);
    if (!ISSUERS.has(payload.iss)) throw new Error('Invalid Google sign-in');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(clientId)) throw new Error('Invalid Google sign-in');
    if (!payload.exp || payload.exp < t - 60) throw new Error('That Google sign-in expired. Try again.');
    if (payload.iat && payload.iat > t + 300) throw new Error('Invalid Google sign-in');
    if (!payload.email || payload.email_verified !== true) throw new Error('Google hasn’t verified that email address');
    return { email: String(payload.email).toLowerCase(), name: payload.name || '', hd: payload.hd || '' };
  };
}
