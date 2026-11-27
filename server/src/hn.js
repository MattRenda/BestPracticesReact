// Startups that take applications by email, from Hacker News' monthly "Ask HN: Who is hiring?"
// threads (read through HN's public Algolia API). HireMe can send these applications itself with
// one swipe: no forms and no bot checks. Posts are only kept when the company is confirmed at 50
// people or fewer, either from YC's directory or from the post stating its team size.

import { extractSkills, htmlToText, isDevRole } from './importer.js';
import { looksLikeAgency, siteDomain } from './rules.js';
import { MAX_HEADCOUNT } from './db.js';

const API = 'https://hn.algolia.com/api/v1';
const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton(mail)?|pm|hey|fastmail|gmx|yandex|zoho)\.[a-z.]+$/i;
const NOT_APPLY = /^(privacy|security|abuse|support|help|press|legal|info|noreply|no-reply|sales|billing)@/i;
const ATS_HOSTS = /ashbyhq|greenhouse|lever\.co|workable|recruitee|bamboohr|breezy|personio|rippling|wellfound|angel\.co|ycombinator|workatastartup|linkedin|news\.ycombinator|docs\.google|notion\.(so|site)|calendly|github\.com/i;

/** HN comment HTML → text, keeping paragraph breaks (HN uses bare <p> separators). */
export function hnText(html) {
  return htmlToText(
    String(html || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => `&#${parseInt(h, 16)};`) // HN uses hex entities (&#x27; &#x2F;)
      .replace(/<p>/gi, '\n\n'),
  );
}

/** The application email in a post, including "jobs [at] acme [dot] com" spellings. */
export function findEmail(text) {
  const t = String(text || '')
    .replace(/\s*[[({<]\s*at\s*[\])}>]\s*/gi, '@')
    .replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, '.')
    .replace(/(\w)\s+at\s+(\w[\w-]*(?:\s+dot\s+\w+)+)\b/gi, (_, a, b) => `${a}@${b.replace(/\s+dot\s+/gi, '.')}`);
  const all = [...t.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0].replace(/\.$/, '').toLowerCase());
  const usable = all.filter((e) => !NOT_APPLY.test(e) && !/example\.com$/.test(e));
  return usable.find((e) => /^(jobs|careers|hiring|work|apply|join|talent|recruiting|team|hello|hi|founders?)[@+]/.test(e)) || usable[0] || '';
}

/** "We're a team of 12", "a 6-person team", "15 employees" → 12 / 6 / 15. Engineers-only counts don't bound the team. */
export function teamSizeFrom(text) {
  const t = String(text || '');
  const m =
    t.match(/\bteam of (?:about |around |~)?(\d{1,4})\b/i) ||
    t.match(/\b(?:about |around |~)?(\d{1,4})[- ](?:person|people|employees?|member)\b/i) ||
    t.match(/\bwe(?:'re| are) (?:a |only |just )?(?:about |around |~)?(\d{1,4})(?: of us| people| person)\b/i);
  return m ? Number(m[1]) : null;
}

/** Seed / founding-team posts are small by definition even when no headcount is given. */
export function earlyStageFrom(text) {
  const t = String(text || '');
  if (/\bpre-?seed\b/i.test(t)) return 'Pre-seed';
  if (/\bseed[- ](?:stage|round|funded|backed)\b|\b(?:raised|closed) (?:a |our )?(?:\$[\d.]+\s?[mk] )?seed\b|\$[\d.]+\s?m seed\b/i.test(t)) return 'Seed';
  if (/\b(?:founding|first) (?:full[- ]?stack |software |backend |frontend |product |ai |ml )?(?:engineer|developer|hire|engineering hire)s?\b/i.test(t)) return 'Founding team';
  return null;
}

/**
 * One "Who is hiring?" post → { company, title, location, workMode, email, website, teamSize, yc, text }
 * or null when it isn't an email-apply engineering post.
 */
export function parseHiringPost(html) {
  const text = hnText(html);
  if (!text) return null;
  const header = text.split('\n')[0];
  const segs = header.split(/\s+\|\s+|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;
  const rawCompany = segs[0];
  const company = rawCompany.replace(/\s*\((?:YC|Y Combinator)[^)]*\)/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const yc = /\((?:YC|Y Combinator)\b/i.test(header);
  if (!company || company.length > 60) return null;
  const roleSeg = segs.slice(1).find((s) => isDevRole(s)) || '';
  if (!roleSeg && !isDevRole(header)) return null;
  if (/do not email|don'?t email|no emails|apply (only )?(via|through|at) (our|the) (site|website|form|link)/i.test(text)) return null;
  if (looksLikeAgency(`${header} ${text.slice(0, 400)}`) || /\bour client\b|on behalf of/i.test(text)) return null;
  const email = findEmail(text);
  if (!email) return null;
  const locSeg = segs.slice(1).find((s) => /remote|onsite|on-site|hybrid|\b[A-Z][a-z]+,?\s+[A-Z]{2}\b|san francisco|new york|nyc|london|berlin|toronto|seattle|austin|boston/i.test(s) && s !== roleSeg) || '';
  const links = [...String(html).matchAll(/href="([^"]+)"/gi)].map((m) => m[1].replace(/&#x2F;/g, '/').replace(/&amp;/g, '&'));
  const site = links.find((u) => /^https?:\/\//.test(u) && !ATS_HOSTS.test(u)) || segs.map((s) => s.match(/\b(?:https?:\/\/)?([a-z0-9-]+\.(?:com|io|ai|co|dev|app|so|xyz|tech|org|net))\b/i)?.[0]).find(Boolean) || '';
  const website = site ? (/^https?:\/\//.test(site) ? site : `https://${site}`) : !FREE_MAIL.test(email) ? `https://${email.split('@')[1]}` : '';
  const title = (roleSeg || segs.find((s) => isDevRole(s)) || 'Software Engineer').replace(/\s+/g, ' ').slice(0, 120);
  return {
    company,
    title,
    location: locSeg.slice(0, 120),
    workMode: /remote/i.test(locSeg || header) ? 'remote' : /hybrid/i.test(locSeg || header) ? 'hybrid' : 'onsite',
    email,
    website,
    teamSize: teamSizeFrom(text),
    stage: earlyStageFrom(text),
    yc,
    text: text.slice(0, 6000),
  };
}

/** Imports email-apply roles from the latest "Who is hiring?" threads. Adds to `stats`. */
export async function importHn(db, { fetchImpl = fetch, log = console, stats, months = 2 } = {}) {
  const get = async (url) => {
    const r = await fetchImpl(url, { headers: { 'user-agent': 'HireMe job importer (+https://hireme-startups.fly.dev)' } });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r.json();
  };
  const found = await get(`${API}/search_by_date?tags=story,author_whoishiring&hitsPerPage=12`);
  const threads = (found.hits || []).filter((h) => /who is hiring/i.test(h.title || '')).slice(0, months);
  const seen = new Set();
  const n = { posts: 0, email: 0, added: 0 };
  for (const th of threads) {
    const item = await get(`${API}/items/${th.objectID}`);
    for (const c of item.children || []) {
      if (!c.text) continue;
      n.posts++;
      const p = parseHiringPost(c.text);
      if (!p) continue;
      n.email++;
      const domain = siteDomain(p.website);
      // Size: YC's directory first, then what the post says. Unknown size stays out.
      const known = (domain && db.prepare('SELECT * FROM startups WHERE domain = ?').get(domain)) || db.prepare('SELECT * FROM startups WHERE lower(name) = lower(?)').get(p.company);
      // 0 = size not stated but the post is seed / founding-team, which is under 50 by definition.
      const headcount = known?.headcount || p.teamSize || (p.stage ? 0 : null);
      if (headcount == null || headcount > MAX_HEADCOUNT) continue;
      if (known && ['rejected', 'pending', 'retired'].includes(known.status)) continue;
      let startupId = known?.id;
      if (!startupId) {
        startupId = Number(
          db
            .prepare("INSERT INTO startups (name, website, domain, headcount, location, status, source, one_liner, stage) VALUES (?, ?, ?, ?, ?, 'listed', 'hn', '', ?)")
            .run(p.company, p.website || '', domain || `${p.company.toLowerCase().replace(/\W+/g, '')}.hn`, headcount, p.location, p.stage || '').lastInsertRowid,
        );
        stats.startups_added++;
      }
      const externalId = `hn:${c.id}`;
      seen.add(externalId);
      const row = {
        startup_id: startupId,
        external_id: externalId,
        title: p.title,
        description: p.text,
        location: p.location,
        work_mode: p.workMode,
        skills: extractSkills(p.text, 10).join(', '),
        apply_url: `https://news.ycombinator.com/item?id=${c.id}`,
        apply_email: p.email,
        posted_at: c.created_at || null,
      };
      const existing = db.prepare('SELECT id FROM roles WHERE external_id = ?').get(externalId);
      if (existing) {
        db.prepare("UPDATE roles SET title=@title, description=@description, location=@location, work_mode=@work_mode, skills=@skills, apply_email=@apply_email, status='open' WHERE id=@id").run({
          title: row.title,
          description: row.description,
          location: row.location,
          work_mode: row.work_mode,
          skills: row.skills,
          apply_email: row.apply_email,
          id: existing.id,
        });
        stats.roles_updated++;
      } else {
        db.prepare(
          `INSERT INTO roles (startup_id, external_id, source, title, description, location, work_mode, skills, apply_url, apply_email, posted_at)
           VALUES (@startup_id, @external_id, 'hn', @title, @description, @location, @work_mode, @skills, @apply_url, @apply_email, @posted_at)`,
        ).run(row);
        stats.roles_added++;
        n.added++;
      }
    }
  }
  // Posts from older threads close
  if (threads.length)
    for (const r of db.prepare("SELECT id, external_id FROM roles WHERE source = 'hn' AND status = 'open'").all())
      if (!seen.has(r.external_id)) {
        db.prepare("UPDATE roles SET status = 'closed' WHERE id = ?").run(r.id);
        stats.roles_closed++;
      }
  log.info?.(`[import] Hacker News: ${n.posts} posts, ${n.email} take email applications, +${n.added} roles at startups of ${MAX_HEADCOUNT} or fewer`);
  return n;
}
