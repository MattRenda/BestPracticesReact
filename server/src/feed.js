// Pulls open roles from companies' public job boards (Greenhouse, Lever, Ashby).
// These are the boards' documented public JSON endpoints — no scraping, no login.

export const ATS = ['greenhouse', 'lever', 'ashby'];

/** Accepts a careers/board URL or "ats:slug" and returns { ats, slug } or null. */
export function parseBoard(input) {
  const s = String(input || '').trim();
  const short = s.match(/^(greenhouse|lever|ashby):([\w.-]+)$/i);
  if (short) return { ats: short[1].toLowerCase(), slug: short[2] };
  let u;
  try {
    u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const seg = u.pathname.split('/').filter(Boolean);
  const host = u.hostname;
  if (/greenhouse\.io$/.test(host)) {
    const slug = u.searchParams.get('for') || seg[0];
    return slug && slug !== 'embed' ? { ats: 'greenhouse', slug } : null;
  }
  if (host === 'jobs.lever.co' && seg[0]) return { ats: 'lever', slug: seg[0] };
  if (host === 'jobs.ashbyhq.com' && seg[0]) return { ats: 'ashby', slug: seg[0] };
  return null;
}

const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
export function htmlToText(html) {
  return String(html || '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]) // greenhouse double-escapes
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error(`Couldn't reach ${new URL(url).hostname} — check the server's internet connection`);
  }
  if (res.status === 404) throw new Error('Board not found — check the company link');
  if (!res.ok) throw new Error(`Board returned ${res.status}`);
  return res.json();
}

/** Returns normalized jobs: { url, company, title, location, description, posted_at, source }. */
export async function fetchBoard({ ats, slug, name }, fetchImpl = fetch) {
  const company = name || titleCase(slug);
  const source = `${ats}:${slug}`;
  if (ats === 'greenhouse') {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, fetchImpl);
    return (data.jobs || []).map((j) => ({
      // Hosted Greenhouse form (avoids company sites that embed it in an iframe)
      url: `https://job-boards.greenhouse.io/${slug}/jobs/${j.id}`,
      company,
      title: j.title || '',
      location: j.location?.name || '',
      description: htmlToText(j.content),
      posted_at: j.first_published || j.updated_at || null,
      source,
    }));
  }
  if (ats === 'lever') {
    const data = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`, fetchImpl);
    return (Array.isArray(data) ? data : []).map((j) => ({
      url: j.applyUrl || `${j.hostedUrl}/apply`,
      company,
      title: j.text || '',
      location: [j.categories?.location, j.workplaceType === 'remote' ? 'Remote' : ''].filter(Boolean).join(' · '),
      description: j.descriptionPlain || htmlToText(j.description),
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      source,
    }));
  }
  if (ats === 'ashby') {
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, fetchImpl);
    return (data.jobs || [])
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        url: j.applyUrl || `${j.jobUrl}/application`,
        company,
        title: j.title || '',
        location: [j.location, j.isRemote ? 'Remote' : ''].filter(Boolean).join(' · '),
        description: j.descriptionPlain || htmlToText(j.descriptionHtml),
        posted_at: j.publishedAt || null,
        source,
      }));
  }
  throw new Error(`Unsupported board type: ${ats}`);
}

const list = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** settings: { keywords, exclude, locations, remoteOk, maxAgeDays } */
export function matchesFilters(job, settings = {}) {
  const title = job.title.toLowerCase();
  const loc = job.location.toLowerCase();
  const kw = list(settings.keywords);
  const ex = list(settings.exclude);
  const locs = list(settings.locations);
  if (kw.length && !kw.some((k) => title.includes(k))) return false;
  if (ex.some((k) => title.includes(k))) return false;
  if (locs.length) {
    const remoteHit = settings.remoteOk !== false && /remote|anywhere/.test(loc);
    if (!remoteHit && !locs.some((l) => loc.includes(l))) return false;
  }
  if (settings.maxAgeDays && job.posted_at) {
    const age = (Date.now() - new Date(job.posted_at).getTime()) / 86_400_000;
    if (age > Number(settings.maxAgeDays)) return false;
  }
  return true;
}
