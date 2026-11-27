// Imports developer roles from startups with 50 or fewer people.
//
// Companies come from the open Y Combinator company dataset (github.com/yc-oss/api), which has team
// sizes. We only use basic facts from it (name, website, size, one-liner). Jobs come from each company's
// own public job-board API (Ashby, Greenhouse, Lever) — those APIs exist so postings can be shown elsewhere.
// We never scrape ycombinator.com: its terms of use forbid that.
//
// Imported startups are 'listed' while they're hiring and have 50 or fewer people; then 'retired'.
import { MAX_HEADCOUNT } from './db.js';
import { looksLikeAgency, siteDomain } from './rules.js';
import { importHn } from './hn.js';

const YC_SOURCES = [
  'https://yc-oss.github.io/api/companies/hiring.json',
  'https://raw.githubusercontent.com/yc-oss/api/main/companies/hiring.json',
];
const RECHECK_DAYS = 7;
const UA = 'HireMeJobImporter/1.0 (+https://hireme-startups.fly.dev)';

// ---------- small helpers ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–' };
export function htmlToText(html) {
  const decode = (s) => s.replace(/&(#\d+|[a-z]+\d*);/gi, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));
  return decode(decode(String(html || ''))) // Greenhouse double-escapes
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/ul|\/ol)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DEV_TITLE = /\b(engineer(ing)?|developer|programmer|swe|sre|devops|architect|cto|full[- ]?stack|front[- ]?end|back[- ]?end|ios|android|mobile|machine learning|ml|ai|data scientist|software|infrastructure|platform)\b/i;
const NOT_DEV = /\b(sales|account|recruit\w*|marketing|support|customer|success|solutions|business|operations|designer|intern(ship)?|hr|people|legal|finance|counsel)\b/i;
export const isDevRole = (title) => DEV_TITLE.test(title) && !NOT_DEV.test(title);

// Common tech, so roles get skills that line up with developer profiles.
const TECH = [
  'React', 'React Native', 'Next.js', 'Vue', 'Angular', 'Svelte', 'TypeScript', 'JavaScript', 'Node.js', 'Deno', 'Python', 'Django', 'Flask',
  'FastAPI', 'Go', 'Golang', 'Rust', 'Java', 'Kotlin', 'Swift', 'SwiftUI', 'Objective-C', 'C++', 'C#', '.NET', 'Ruby', 'Rails', 'PHP', 'Laravel',
  'Elixir', 'Scala', 'Haskell', 'Postgres', 'PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'Redis', 'Kafka', 'GraphQL', 'gRPC', 'AWS', 'GCP', 'Azure',
  'Kubernetes', 'Docker', 'Terraform', 'Linux', 'Bazel', 'Flutter', 'Expo', 'Electron', 'WebRTC', 'WebSockets', 'Tailwind', 'CSS', 'HTML',
  'PyTorch', 'TensorFlow', 'LLMs', 'Spark', 'Snowflake', 'dbt', 'Airflow', 'Unity', 'Unreal', 'Solidity', 'CUDA', 'Embedded', 'Firmware', 'ROS',
];
const TECH_RE = TECH.map((t) => [t, new RegExp(`(^|[^\\w.+#])${t.replace(/[.+#]/g, (c) => `\\${c}`)}(?![\\w+#]|\\.[a-z])`, 'i')]);
export function extractSkills(text, max = 10) {
  const found = [];
  for (const [name, re] of TECH_RE) if (re.test(text)) found.push(name === 'Golang' ? 'Go' : name === 'PostgreSQL' ? 'Postgres' : name);
  return [...new Set(found)].slice(0, max);
}

const updatable = ({ startup_id: _s, external_id: _e, ...rest }) => rest;

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const NOT_A_COMPANY = /^(the|us|you|your|our|this|role|team|company|job|position|opportunity|it|them|me)\b/i;
/**
 * True when a job board lists roles for several companies — a VC's portfolio board or a recruiter's —
 * rather than the startup's own. Telltales: descriptions that open "About <Other Co>", or titles
 * ending "- <Other Co>" / "@ <Other Co>", for companies other than this one.
 */
export function looksShared(jobs, companyName) {
  const me = squash(companyName);
  const others = new Map();
  let postsForOthers = 0;
  for (const j of jobs) {
    const names = new Set();
    for (const m of String(j.description || '').matchAll(/\bAbout ([A-Z][\w.&'’-]*(?: [A-Z][\w.&'’-]*){0,2})/g))
      if (!NOT_A_COMPANY.test(m[1])) names.add(m[1]);
    const t = String(j.title || '').match(/\s(?:-|–|—|@|at)\s+([A-Z][\w.&'’-]*(?: [A-Z][\w.&'’-]*){0,2})(?:\s*\(.*\))?\s*$/);
    if (t) names.add(t[1]);
    const foreign = [...names].filter((n) => {
      const k = squash(n);
      return k && k !== me && !me.includes(k) && !k.includes(me) && !/^(remote|hybrid|onsite|senior|staff|lead|founding|backend|frontend|fullstack|platform|infra|infrastructure|ai|ml|data|mobile|ios|android|us|usa|eu|emea|apac|newyork|sanfrancisco|london)$/.test(k);
    });
    if (foreign.length) postsForOthers++;
    for (const n of foreign) others.set(squash(n), (others.get(squash(n)) || 0) + 1);
  }
  return others.size >= 2 && postsForOthers >= Math.max(2, jobs.length * 0.3);
}
const workMode = (s) => (/remote/i.test(s || '') ? 'remote' : /hybrid/i.test(s || '') ? 'hybrid' : 'onsite');
const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Finds a job-board link in a page: jobs.ashbyhq.com/x, boards.greenhouse.io/x, jobs.lever.co/x… */
export function findBoardLinks(html) {
  const out = [];
  const re = /(?:https?:)?\/\/(jobs\.ashbyhq\.com|(?:job-)?boards(?:-api)?\.greenhouse\.io|jobs\.lever\.co|api\.lever\.co\/v0\/postings)\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9._-]+)/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const host = m[1];
    const slug = m[2];
    if (!slug || /^(v1|embed|api|jobs|boards)$/i.test(slug)) continue;
    const ats = host.includes('ashby') ? 'ashby' : host.includes('greenhouse') ? 'greenhouse' : 'lever';
    if (!out.some((b) => b.ats === ats && b.slug === slug)) out.push({ ats, slug });
  }
  return out;
}

// ---------- job boards ----------

/** Normalized job: { external_id, title, description, location, work_mode, salary_min, salary_max, equity, apply_url, posted_at } */
export async function fetchBoard(ats, slug, get) {
  if (ats === 'ashby') {
    const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
    return (d?.jobs || [])
      .filter((j) => j.isListed !== false)
      .map((j) => {
        const comps = j.compensation?.summaryComponents || [];
        const sal = comps.find((c) => c.compensationType === 'Salary' && c.currencyCode === 'USD' && /YEAR/i.test(c.interval || ''));
        const mode = j.workplaceType === 'Remote' || j.isRemote ? 'remote' : j.workplaceType === 'Hybrid' ? 'hybrid' : 'onsite';
        return {
          external_id: `ashby:${j.id}`,
          title: j.title || '',
          description: j.descriptionPlain || htmlToText(j.descriptionHtml),
          location: j.location || '',
          work_mode: mode,
          salary_min: sal?.minValue ?? null,
          salary_max: sal?.maxValue ?? null,
          equity: comps.some((c) => /Equity/i.test(c.compensationType)) ? 'Offers' : '',
          apply_url: j.applyUrl || j.jobUrl || `https://jobs.ashbyhq.com/${slug}`,
          posted_at: j.publishedAt || null,
        };
      });
  }
  if (ats === 'greenhouse') {
    const d = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
    return (d?.jobs || []).map((j) => ({
      external_id: `greenhouse:${j.id}`,
      title: j.title || '',
      description: htmlToText(j.content),
      location: j.location?.name || '',
      work_mode: workMode(j.location?.name),
      salary_min: null,
      salary_max: null,
      equity: '',
      apply_url: j.absolute_url || `https://job-boards.greenhouse.io/${slug}/jobs/${j.id}`,
      posted_at: j.first_published || j.updated_at || null,
    }));
  }
  if (ats === 'lever') {
    const d = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    return (Array.isArray(d) ? d : []).map((j) => {
      const s = j.salaryRange;
      const yearly = s && s.currency === 'USD' && /year/i.test(s.interval || '');
      const lists = (j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
      return {
        external_id: `lever:${j.id}`,
        title: j.text || '',
        description: [j.descriptionPlain || htmlToText(j.description), lists, j.additionalPlain].filter(Boolean).join('\n\n'),
        location: j.categories?.location || '',
        work_mode: j.workplaceType === 'remote' ? 'remote' : j.workplaceType === 'hybrid' ? 'hybrid' : workMode(j.categories?.location),
        salary_min: yearly ? s.min ?? null : null,
        salary_max: yearly ? s.max ?? null : null,
        equity: '',
        apply_url: j.applyUrl || (j.hostedUrl ? `${j.hostedUrl}/apply` : `https://jobs.lever.co/${slug}`),
        posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      };
    });
  }
  throw new Error(`Unknown job board ${ats}`);
}

// ---------- the import ----------

export function createImporter(db, { fetchImpl = fetch, log = console, concurrency = 6, hn = true } = {}) {
  let running = null;

  /** JSON GET; returns null on 404 so callers can treat "no board" quietly. */
  async function get(url, { text = false } = {}) {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': UA, accept: text ? 'text/html' : 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
    return text ? res.text() : res.json();
  }

  async function fetchCompanies() {
    let lastErr;
    for (const url of YC_SOURCES) {
      try {
        const list = await get(url);
        if (Array.isArray(list) && list.length) return list;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Couldn’t load the YC company list: ${lastErr?.message || 'empty'}`);
  }

  /** Respects a site's robots.txt for the pages we read (homepage and careers). */
  async function allowedPaths(origin) {
    try {
      const txt = (await get(`${origin}/robots.txt`, { text: true })) || '';
      let applies = false;
      const blocked = [];
      for (const line of txt.split('\n')) {
        const [k, ...rest] = line.split(':');
        const v = rest.join(':').trim();
        if (/^user-agent$/i.test(k.trim())) applies = v === '*' || /hireme/i.test(v);
        else if (applies && /^disallow$/i.test(k.trim()) && v) blocked.push(v);
      }
      return (path) => !blocked.some((b) => path.startsWith(b));
    } catch {
      return () => true;
    }
  }

  /** Finds a company's job board: links on its site first, then name guesses checked against the posts. */
  async function discoverBoard(company, domain) {
    const origin = `https://${domain}`;
    const allowed = await allowedPaths(origin);
    for (const path of ['/', '/careers', '/jobs']) {
      if (!allowed(path)) continue;
      try {
        const html = await get(origin + path, { text: true });
        const links = html ? findBoardLinks(html) : [];
        if (links.length) return links[0];
      } catch {
        /* site down or blocks us — fall through to guesses */
      }
    }
    const nameRe = new RegExp(`\\b${company.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const guesses = [...new Set([company.slug, slugify(company.name), domain.split('.')[0]].filter(Boolean))];
    for (const slug of guesses)
      for (const ats of ['ashby', 'greenhouse', 'lever']) {
        try {
          const jobs = await fetchBoard(ats, slug, get);
          // Only trust a guessed board if its posts mention the company — names collide.
          if (jobs.length && !looksShared(jobs, company.name) && jobs.some((j) => nameRe.test(j.description) || j.description.toLowerCase().includes(domain))) return { ats, slug };
        } catch {
          /* try the next guess */
        }
      }
    return null;
  }

  async function importCompany(c, stats) {
    const domain = siteDomain(c.website || '');
    if (!domain) return;
    let s = db.prepare('SELECT * FROM startups WHERE domain = ?').get(domain);
    if (s && s.source !== 'yc') return; // added by a founder in the earlier two-sided version; leave it alone
    if (s?.status === 'rejected') return;

    const tooBig = !c.team_size || c.team_size > MAX_HEADCOUNT;
    const fields = {
      name: String(c.name).slice(0, 80),
      website: c.website.startsWith('http') ? c.website : `https://${c.website}`,
      domain,
      headcount: Math.max(1, Math.min(Number(c.team_size) || 1, 999)),
      stage: c.batch ? `YC ${c.batch.replace(/^(Winter|Summer|Spring|Fall) (\d{2})(\d{2})$/, (_, season, _c, yy) => `${season[0]}${yy}`)}` : '',
      one_liner: String(c.one_liner || '').slice(0, 140),
      about: String(c.long_description || '').slice(0, 2000),
      location: String(c.all_locations || '').split(';')[0].slice(0, 80),
      yc_slug: c.slug,
    };
    if (!s) {
      if (tooBig) return;
      const id = db
        .prepare(
          `INSERT INTO startups (name, website, domain, headcount, stage, one_liner, about, location, source, yc_slug, status, reviewed_at)
           VALUES (@name, @website, @domain, @headcount, @stage, @one_liner, @about, @location, 'yc', @yc_slug, 'listed', datetime('now'))`,
        )
        .run(fields).lastInsertRowid;
      s = db.prepare('SELECT * FROM startups WHERE id = ?').get(id);
      stats.startups_added++;
    } else if (s.status === 'listed') {
      // Keep it in sync with YC.
      const { domain: _d, yc_slug: _y, ...update } = fields;
      db.prepare('UPDATE startups SET name=@name, website=@website, headcount=@headcount, stage=@stage, one_liner=@one_liner, about=@about, location=@location WHERE id=@id').run({ ...update, id: s.id });
      if (tooBig) {
        db.prepare("UPDATE startups SET status = 'retired' WHERE id = ?").run(s.id);
        db.prepare("UPDATE roles SET status = 'closed' WHERE startup_id = ? AND source = 'ats'").run(s.id);
        stats.retired++;
        return;
      }
    } else if (s.status === 'retired') {
      if (tooBig) return;
      db.prepare("UPDATE startups SET status = 'listed' WHERE id = ?").run(s.id);
    }

    // Find (or re-check) the job board
    const fresh = s.ats_checked_at && Date.now() - new Date(`${s.ats_checked_at}Z`).getTime() < RECHECK_DAYS * 86_400_000;
    let board = s.ats && s.ats !== 'none' ? { ats: s.ats, slug: s.ats_slug } : null;
    if (!fresh && !board) {
      board = await discoverBoard(c, domain);
      db.prepare("UPDATE startups SET ats = ?, ats_slug = ?, ats_checked_at = datetime('now') WHERE id = ?").run(board?.ats || 'none', board?.slug || null, s.id);
    }
    if (!board) return;
    stats.boards++;

    let jobs;
    try {
      jobs = await fetchBoard(board.ats, board.slug, get);
    } catch (e) {
      stats.errors.push(`${c.name}: ${e.message}`);
      return;
    }
    if (jobs === null || !Array.isArray(jobs)) {
      db.prepare("UPDATE startups SET ats = NULL, ats_checked_at = NULL WHERE id = ?").run(s.id); // board moved; rediscover next run
      return;
    }
    if (looksShared(jobs, c.name)) {
      // Not this startup's own board: don't list its roles, and don't look again for a while.
      db.prepare("UPDATE startups SET ats = 'none', ats_slug = NULL, ats_checked_at = datetime('now') WHERE id = ?").run(s.id);
      const closed = db.prepare("UPDATE roles SET status = 'closed' WHERE startup_id = ? AND source = 'ats' AND status = 'open'").run(s.id).changes;
      stats.roles_closed += closed;
      stats.errors.push(`${c.name}: skipped ${board.ats}/${board.slug}, a board shared by several companies`);
      return;
    }

    const seen = new Set();
    for (const j of jobs) {
      if (!j.title || !isDevRole(j.title)) continue;
      seen.add(j.external_id);
      const skills = extractSkills(`${j.title}\n${j.description}`).join(', ');
      const row = {
        startup_id: s.id,
        external_id: j.external_id,
        title: j.title.slice(0, 100),
        description: j.description.slice(0, 6000),
        location: j.location.slice(0, 80),
        work_mode: j.work_mode,
        salary_min: j.salary_min,
        salary_max: j.salary_max,
        equity: j.equity,
        skills,
        apply_url: j.apply_url,
        posted_at: j.posted_at,
      };
      const existing = db.prepare('SELECT id FROM roles WHERE startup_id = ? AND external_id = ?').get(s.id, j.external_id);
      if (existing) {
        db.prepare(
          `UPDATE roles SET title=@title, description=@description, location=@location, work_mode=@work_mode, salary_min=@salary_min,
             salary_max=@salary_max, equity=@equity, skills=@skills, apply_url=@apply_url, posted_at=@posted_at, status='open'
           WHERE id = @id`,
        ).run({ ...updatable(row), id: existing.id });
        stats.roles_updated++;
      } else {
        db.prepare(
          `INSERT INTO roles (startup_id, external_id, source, title, description, location, work_mode, salary_min, salary_max, equity, skills, apply_url, posted_at)
           VALUES (@startup_id, @external_id, 'ats', @title, @description, @location, @work_mode, @salary_min, @salary_max, @equity, @skills, @apply_url, @posted_at)`,
        ).run(row);
        stats.roles_added++;
      }
    }
    // Close imported roles that came down from the board
    const open = db.prepare("SELECT id, external_id FROM roles WHERE startup_id = ? AND source = 'ats' AND status = 'open'").all(s.id);
    for (const r of open)
      if (!seen.has(r.external_id)) {
        db.prepare("UPDATE roles SET status = 'closed' WHERE id = ?").run(r.id);
        stats.roles_closed++;
      }
  }

  async function run({ limit } = {}) {
    const stats = { companies: 0, startups_added: 0, boards: 0, roles_added: 0, roles_updated: 0, roles_closed: 0, retired: 0, errors: [] };
    const runId = Number(db.prepare("INSERT INTO import_runs (started_at) VALUES (datetime('now'))").run().lastInsertRowid);
    try {
      let companies = (await fetchCompanies()).filter(
        (c) => c.isHiring !== false && !['Inactive', 'Acquired', 'Public'].includes(c.status) && c.website && !looksLikeAgency(`${c.name} ${c.one_liner}`),
      );
      // Companies that grew past the limit still pass through so their listings get retired.
      if (limit) companies = companies.slice(0, limit);
      stats.companies = companies.filter((c) => c.team_size && c.team_size <= MAX_HEADCOUNT).length;
      let i = 0;
      const worker = async () => {
        while (i < companies.length) {
          const c = companies[i++];
          try {
            await importCompany(c, stats);
          } catch (e) {
            stats.errors.push(`${c.name}: ${e.message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      // Startups that dropped off the hiring list: close their imported roles
      const hiring = new Set(companies.map((c) => siteDomain(c.website || '')).filter(Boolean));
      if (!limit)
        for (const s of db.prepare("SELECT id, domain FROM startups WHERE source = 'yc' AND status = 'listed'").all())
          if (!hiring.has(s.domain)) {
            const n = db.prepare("UPDATE roles SET status = 'closed' WHERE startup_id = ? AND source = 'ats' AND status = 'open'").run(s.id).changes;
            stats.roles_closed += Number(n);
          }
    } catch (e) {
      stats.errors.unshift(e.message);
    }
    // Startups that take applications by email, from Hacker News' "Who is hiring?" threads
    if (hn && !limit)
      try {
        await importHn(db, { fetchImpl, log, stats });
      } catch (e) {
        stats.errors.push(`Hacker News: ${e.message}`);
      }
    db.prepare(
      `UPDATE import_runs SET finished_at = datetime('now'), companies = ?, startups_added = ?, boards = ?, roles_added = ?, roles_updated = ?,
         roles_closed = ?, errors = ? WHERE id = ?`,
    ).run(stats.companies, stats.startups_added, stats.boards, stats.roles_added, stats.roles_updated, stats.roles_closed, JSON.stringify(stats.errors.slice(0, 50)), runId);
    log.info?.(`[import] ${stats.companies} companies, ${stats.boards} job boards, +${stats.roles_added} roles, ${stats.roles_closed} closed, ${stats.errors.length} errors`);
    return stats;
  }

  return {
    get running() {
      return !!running;
    },
    /** Starts an import unless one is already running. Resolves with its stats. */
    start(opts) {
      if (!running) running = run(opts).finally(() => (running = null));
      return running;
    },
  };
}
