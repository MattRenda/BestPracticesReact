// The rules that keep HireMe startup-only: 50 people or fewer, and no recruiters or staffing firms.

// Words that usually mean a staffing or recruiting business rather than a startup hiring for itself.
const AGENCY_WORDS = /\b(recruit\w*|staffing|talent (?:partners|solutions|acquisition)|headhunt\w*|search partners|executive search|placement|manpower|outsourc\w*|consultancy)\b/i;

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()) && String(s).length <= 254;

/** "https://www.acme.io/about" → "acme.io". Returns '' if it isn't a usable public URL. */
export function siteDomain(website) {
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') && !/^[\d.]+$/.test(host) ? host : '';
  } catch {
    return '';
  }
}

export function looksLikeAgency(text) {
  return AGENCY_WORDS.test(String(text || ''));
}
