// Fetches a public web page a developer pointed us at (their own website), without letting that URL reach
// HireMe's own network: only http(s) on the usual ports, every hop's address checked to be public,
// redirects followed by hand, a short timeout and a size cap.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function privateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

async function checkHost(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('not http');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('port');
  if (url.username || url.password) throw new Error('credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('local');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error('private address');
}

/** The page's HTML (at most `maxBytes`), or '' when it can't or mustn't be fetched. */
export async function fetchPublicPage(raw, { fetchImpl = fetch, maxBytes = 400_000, timeoutMs = 6000, resolve = checkHost } = {}) {
  try {
    let url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    for (let hop = 0; hop < 4; hop++) {
      await resolve(url);
      const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'HireMe (finds your LinkedIn on your own site)' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url);
        continue;
      }
      if (!res.ok || !/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || 'text/html')) return '';
      const reader = res.body?.getReader?.();
      if (!reader) return (await res.text()).slice(0, maxBytes);
      let out = '';
      const dec = new TextDecoder();
      while (out.length < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
      return out.slice(0, maxBytes);
    }
  } catch {
    /* unreachable, private or not a page */
  }
  return '';
}

/** A linkedin.com/in/… profile link on the page, normalized, or ''. */
export function linkedinIn(html) {
  const m = String(html).match(/https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([\w%-]{3,100})/i);
  return m ? `https://www.linkedin.com/in/${m[1].replace(/\/$/, '')}` : '';
}

export { privateAddress };
