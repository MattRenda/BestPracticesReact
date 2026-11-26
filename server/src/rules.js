// The rules that keep HireMe startup-only: company email domains, headcount, and no recruiters.
import { MAX_HEADCOUNT } from './db.js';

// Personal mailbox providers. Founders must sign up with an address on their company's domain.
const FREE_MAIL = new Set(
  `gmail.com googlemail.com yahoo.com ymail.com rocketmail.com outlook.com hotmail.com live.com msn.com
  icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.net mail.com zoho.com
  yandex.com yandex.ru hey.com fastmail.com fastmail.fm tutanota.com tuta.io duck.com mailbox.org
  qq.com 163.com 126.com naver.com web.de comcast.net att.net sbcglobal.net verizon.net`.split(/\s+/),
);

// Words that usually mean a staffing or recruiting business rather than a startup hiring for itself.
const AGENCY_WORDS = /\b(recruit\w*|staffing|talent (?:partners|solutions|acquisition)|headhunt\w*|search partners|executive search|placement|manpower|outsourc\w*|consultancy)\b/i;

export const emailDomain = (email) => String(email).split('@')[1]?.toLowerCase().trim() || '';

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()) && String(s).length <= 254;

export const isFreeMail = (email) => FREE_MAIL.has(emailDomain(email));

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

/** The email must be on the company's domain (or a subdomain of it, like eng.acme.io). */
export function emailMatchesDomain(email, domain) {
  const d = emailDomain(email);
  return !!domain && (d === domain || d.endsWith(`.${domain}`));
}

/**
 * Validates a new startup. Returns { errors: string[], flags: string[] }.
 * Errors block signup; flags are shown to the admin in the approval queue.
 */
export function checkStartup(input, founderEmail) {
  const errors = [];
  const flags = [];
  const domain = siteDomain(input.website);
  const headcount = Number(input.headcount);

  if (!String(input.name || '').trim()) errors.push('Add your startup’s name.');
  if (!domain) errors.push('Add your startup’s website, like acme.io.');
  if (!Number.isInteger(headcount) || headcount < 1) errors.push('Add how many people work at the startup, including founders.');
  else if (headcount > MAX_HEADCOUNT) errors.push(`HireMe is for startups with ${MAX_HEADCOUNT} or fewer people.`);
  if (!input.confirmNotAgency) errors.push('Confirm you’re hiring for your own startup, not recruiting for other companies.');
  if (isFreeMail(founderEmail)) errors.push('Sign in with your work email on your startup’s domain, not a personal address.');
  else if (domain && !emailMatchesDomain(founderEmail, domain))
    errors.push(`Your sign-in email (${emailDomain(founderEmail)}) has to match your startup’s website (${domain}).`);

  const text = `${input.name} ${input.one_liner} ${input.about} ${domain}`;
  if (AGENCY_WORDS.test(text)) flags.push('Mentions recruiting, staffing or outsourcing');
  if (headcount >= 40 && headcount <= MAX_HEADCOUNT) flags.push(`Close to the limit (${headcount} people)`);
  return { errors, flags, domain, headcount };
}

export function looksLikeAgency(text) {
  return AGENCY_WORDS.test(String(text || ''));
}
