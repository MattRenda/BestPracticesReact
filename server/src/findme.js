// "Find me": suggests the developer's GitHub (and the LinkedIn linked from it) so they don't have to type
// them. Only public GitHub data is used. Nothing is saved until the developer taps "That's me".
//
// LinkedIn has no public search and its terms forbid scraping, so a LinkedIn link is only suggested when
// the developer's own GitHub profile links to it. The app also offers linkedin.com/in/me, which opens
// the signed-in member's own profile so they can copy its address.

import { fetchPublicPage, linkedinIn } from './safe-fetch.js';

const GH = 'https://api.github.com';

const clean = (s) => String(s || '').trim();
const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const realEmail = (e) => /@/.test(e || '') && !/\.invalid$/i.test(e) && !/noreply/i.test(e);

export function createFindMe({ fetchImpl = fetch, token = process.env.GITHUB_TOKEN, log = console, pageFetch = (u) => fetchPublicPage(u, { fetchImpl }) } = {}) {
  /** The LinkedIn link on the developer's own website, if it has one. */
  async function linkedinFromSite(site) {
    if (!site || /linkedin\.com|github\.com/i.test(site)) return '';
    return linkedinIn(await pageFetch(site).catch(() => ''));
  }

  const cache = new Map(); // key → { at, result }

  async function gh(path, accept = 'application/vnd.github+json') {
    const res = await fetchImpl(`${GH}${path}`, {
      headers: { accept, 'user-agent': 'HireMe', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error('GitHub is busy right now. Try again in a minute.'), { busy: true });
    if (!res.ok) return null;
    return res.json();
  }

  /** Candidates, best first: [{ login, name, avatar, url, location, bio, repos, linkedin, why }]. */
  async function find({ name, emails = [], location = '' }) {
    const fullName = clean(name);
    const [first = '', ...rest] = fullName.split(/\s+/);
    const last = rest.at(-1) || '';
    const mails = [...new Set(emails.map((e) => clean(e).toLowerCase()).filter(realEmail))];
    const key = JSON.stringify([norm(fullName), mails, norm(location)]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 3600_000) return hit.result;

    const scores = new Map(); // login → { score, why }
    const add = (login, score, why) => {
      if (!login) return;
      const cur = scores.get(login) || { score: 0, why: [] };
      cur.score += score;
      if (!cur.why.includes(why)) cur.why.push(why);
      scores.set(login, cur);
    };
    const q = (s) => encodeURIComponent(s);

    for (const m of mails) {
      // Commits signed with their email: the strongest sign the account is theirs.
      const commits = await gh(`/search/commits?q=${q(`author-email:${m}`)}&per_page=10`, 'application/vnd.github.cloak-preview+json').catch(rethrowBusy);
      for (const c of commits?.items || []) add(c.author?.login, 100, 'Your email is on its commits');
      const users = await gh(`/search/users?q=${q(`${m} in:email`)}`).catch(rethrowBusy);
      for (const u of users?.items || []) add(u.login, 100, 'Your email is on the profile');
    }
    if (first && last) {
      const byName = await gh(`/search/users?q=${q(`fullname:"${fullName}"`)}&per_page=8`).catch(rethrowBusy);
      for (const u of byName?.items || []) add(u.login, 40, 'Same name');
      // Usernames like mattrenda, matthew-renda, mrenda.
      const byLogin = await gh(`/search/users?q=${q(`${last} in:login`)}&per_page=30`).catch(rethrowBusy);
      const f = norm(first);
      for (const u of byLogin?.items || []) {
        const l = norm(u.login);
        if (l.includes(norm(last)) && (l.includes(f) || l.includes(f.slice(0, 4)) || l.startsWith(f[0] + norm(last)))) add(u.login, 30, 'Username matches your name');
      }
    }

    const top = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5);
    const out = [];
    for (const [login, s] of top) {
      const u = await gh(`/users/${q(login)}`).catch(() => null);
      if (!u || u.type !== 'User') continue;
      let score = s.score;
      const why = [...s.why];
      if (fullName && norm(u.name) === norm(fullName) && !why.includes('Same name')) {
        score += 40;
        why.push('Same name');
      }
      const city = norm(location.split(',')[0]);
      if (city && norm(u.location).includes(city)) {
        score += 20;
        why.push('Same city');
      }
      const socials = (await gh(`/users/${q(login)}/social_accounts`).catch(() => null)) || [];
      const linkedin =
        socials.find((a) => a.provider === 'linkedin' || /linkedin\.com\/in\//i.test(a.url))?.url ||
        (/linkedin\.com\/in\//i.test(u.blog || '') ? u.blog : '') ||
        (u.bio || '').match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w%-]+/i)?.[0] ||
        '';
      const website = u.blog && !/linkedin\.com/i.test(u.blog) ? (/^https?:/i.test(u.blog) ? u.blog : `https://${u.blog}`) : '';
      // Not on their GitHub? Their own website often links it.
      const linkedinSite = !linkedin && website && score >= 40 ? await linkedinFromSite(website) : '';
      out.push({
        login,
        name: u.name || '',
        avatar: u.avatar_url || '',
        url: u.html_url || `https://github.com/${login}`,
        location: u.location || '',
        bio: u.bio || '',
        repos: u.public_repos ?? 0,
        website,
        linkedin: linkedin ? linkedin.replace(/^http:/i, 'https:').replace(/\/$/, '') : linkedinSite,
        why,
        score,
      });
    }
    out.sort((a, b) => b.score - a.score);
    const result = out.map(({ score, ...c }) => ({ ...c, strong: score >= 100 }));
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    log.info?.(`[findme] ${result.length} GitHub candidates`);
    return result;
  }
  return { find, linkedinFromSite };
}

function rethrowBusy(e) {
  if (e?.busy) throw e;
  return null;
}
