// Startups list their own developer roles on HireMe. Applications to them are emailed to the startup.
//
// Who can list: someone signed in with an email at the company's own domain (so we know they work
// there), for a company of 50 people or fewer that isn't a recruiter or staffing firm. Listings go
// live right away; people can still report them and admins can take them down.

import { isEmail, looksLikeAgency, siteDomain } from './rules.js';
import { extractSkills, isDevRole } from './importer.js';
import { FREE_MAIL } from './hn.js';
import { ATS_SYSTEMS } from './apply/ats-api.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const MODES = ['remote', 'hybrid', 'onsite'];
const MAX_OPEN_ROLES = 25;

const emailDomain = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';
/** acme.io matches acme.io and eng.acme.io. */
const sameCompany = (email, domain) => {
  const d = emailDomain(email);
  return !!domain && (d === domain || d.endsWith(`.${domain}`));
};

export function hiringRoutes(app, { db, requireUser, maxHeadcount, secrets = null, atsApi = null, syncBoard = async () => null, notifyAdmins = () => {}, log = console }) {
  const membership = (userId) =>
    db.prepare('SELECT s.* FROM startup_members m JOIN startups s ON s.id = m.startup_id WHERE m.user_id = ?').get(userId);

  const roleOut = (r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    location: r.location,
    work_mode: r.work_mode,
    salary_min: r.salary_min,
    salary_max: r.salary_max,
    equity: r.equity,
    status: r.status,
    created_at: r.created_at,
    applications: r.applications ?? 0,
  });

  function view(user) {
    const s = membership(user.id);
    const domain = emailDomain(user.email);
    const base = {
      email: user.email,
      workEmail: !!user.email && !FREE_MAIL.test(user.email) && !user.isGuest,
      suggestedWebsite: domain && !FREE_MAIL.test(user.email) ? `https://${domain}` : '',
    };
    if (!s) {
      const existing = base.workEmail ? db.prepare('SELECT name, website, headcount, status FROM startups WHERE domain = ?').get(domain) : null;
      return { ...base, startup: null, existing: existing && existing.status !== 'rejected' ? existing : null };
    }
    const roles = db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM applications a WHERE a.role_id = r.id AND a.state = 'submitted') AS applications
         FROM roles r WHERE r.startup_id = ? AND r.source = 'direct' ORDER BY r.status = 'open' DESC, r.created_at DESC`,
      )
      .all(s.id)
      .map(roleOut);
    const imported = db.prepare("SELECT COUNT(*) n FROM roles WHERE startup_id = ? AND source IN ('ats', 'hn') AND status = 'open'").get(s.id).n;
    return {
      ...base,
      startup: {
        id: s.id,
        name: s.name,
        website: s.website,
        domain: s.domain,
        headcount: s.headcount,
        location: s.location,
        one_liner: s.one_liner,
        about: s.about,
        apply_email: s.apply_email || user.email,
        status: ['listed', 'approved'].includes(s.status) ? 'live' : s.status === 'retired' ? 'too_big' : 'hidden',
      },
      roles,
      imported,
      // Their applicant system: connected (never the key itself), or what HireMe found on its own.
      ats: s.ats_api
        ? { system: s.ats_api, board: s.ats_api_board, connected_at: s.ats_api_at, error: s.ats_api_error || '' }
        : null,
      atsFound: !s.ats_api && ATS_SYSTEMS.includes(s.ats) ? { system: s.ats, board: s.ats_slug } : null,
    };
  }

  /** Validates the company fields. Returns an error message or null. */
  function checkCompany(b, { creating }) {
    if (creating && !str(b.name, 120)) return 'Add your company’s name';
    const hc = int(b.headcount);
    if (b.headcount !== undefined || creating) {
      if (!hc || hc < 1) return 'How many people work at the company?';
      if (hc > maxHeadcount) return `HireMe is only for startups with ${maxHeadcount} people or fewer`;
    }
    if (looksLikeAgency(`${b.name || ''} ${b.one_liner || ''} ${b.about || ''}`))
      return 'HireMe is for startups hiring for themselves, not recruiters or staffing firms';
    return null;
  }

  app.get('/api/hiring', requireUser, (req, res) => res.json(view(req.user)));

  // Create the company (or join it, if HireMe already lists it, e.g. from YC or Hacker News).
  app.post('/api/hiring/startup', requireUser, (req, res) => {
    const u = req.user;
    if (u.isGuest || !u.email) return res.status(403).json({ error: 'Sign in with your work email first' });
    if (membership(u.id)) return res.json(view(u));
    if (FREE_MAIL.test(u.email)) return res.status(403).json({ error: 'Sign in with your work email (you@yourcompany.com), so we know you work there' });
    const b = req.body || {};
    const domain = siteDomain(str(b.website, 300)) || emailDomain(u.email);
    if (!sameCompany(u.email, domain)) return res.status(403).json({ error: `Your email has to be at ${domain}. Sign in with your work email for that site.` });

    const existing = db.prepare('SELECT * FROM startups WHERE domain = ?').get(domain);
    if (existing) {
      if (existing.status === 'rejected') return res.status(403).json({ error: 'HireMe doesn’t list this company. If that’s a mistake, reply to any HireMe email.' });
      if (existing.headcount > maxHeadcount && !(int(b.headcount) <= maxHeadcount))
        return res.status(403).json({ error: `HireMe has this company at ${existing.headcount} people, over the ${maxHeadcount}-person limit` });
      const problem = checkCompany({ ...b, name: b.name || existing.name, headcount: b.headcount ?? existing.headcount }, { creating: false });
      if (problem) return res.status(400).json({ error: problem });
      db.prepare('INSERT INTO startup_members (startup_id, user_id) VALUES (?, ?)').run(existing.id, u.id);
      db.prepare(
        `UPDATE startups SET headcount = COALESCE(?, headcount), location = COALESCE(NULLIF(?, ''), location), one_liner = COALESCE(NULLIF(?, ''), one_liner),
           status = CASE WHEN status = 'retired' THEN 'listed' ELSE status END WHERE id = ?`,
      ).run(int(b.headcount), str(b.location, 120), str(b.one_liner, 200), existing.id);
      notifyAdmins(`Joined on HireMe: ${existing.name}`, `${u.email} joined ${existing.name} (${domain}) to post roles.`);
      return res.json(view(u));
    }

    const problem = checkCompany(b, { creating: true });
    if (problem) return res.status(400).json({ error: problem });
    const website = /^https?:\/\//i.test(str(b.website, 300)) ? str(b.website, 300) : `https://${domain}`;
    const id = Number(
      db
        .prepare(
          `INSERT INTO startups (name, website, domain, headcount, location, one_liner, about, status, source, created_by, apply_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'listed', 'direct', ?, ?)`,
        )
        .run(str(b.name, 120), website, domain, int(b.headcount), str(b.location, 120), str(b.one_liner, 200), str(b.about, 2000), u.id, u.email).lastInsertRowid,
    );
    db.prepare('INSERT INTO startup_members (startup_id, user_id) VALUES (?, ?)').run(id, u.id);
    notifyAdmins(`New startup on HireMe: ${str(b.name, 120)}`, `${u.email} listed ${str(b.name, 120)} (${domain}, ${int(b.headcount)} people).`);
    log.info?.(`[hiring] ${u.email} listed ${domain}`);
    res.status(201).json(view(u));
  });

  app.put('/api/hiring/startup', requireUser, (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.status(404).json({ error: 'Add your company first' });
    const b = req.body || {};
    const problem = checkCompany({ name: b.name ?? s.name, one_liner: b.one_liner, about: b.about, headcount: b.headcount }, { creating: false });
    if (problem) return res.status(400).json({ error: problem });
    const applyEmail = b.apply_email !== undefined ? str(b.apply_email, 254).toLowerCase() : null;
    if (applyEmail !== null && (!isEmail(applyEmail) || !sameCompany(applyEmail, s.domain)))
      return res.status(400).json({ error: `Applications have to go to an address at ${s.domain}` });
    db.prepare(
      `UPDATE startups SET name = COALESCE(NULLIF(?, ''), name), headcount = COALESCE(?, headcount), location = COALESCE(?, location),
         one_liner = COALESCE(?, one_liner), about = COALESCE(?, about), apply_email = COALESCE(?, apply_email) WHERE id = ?`,
    ).run(
      b.name !== undefined ? str(b.name, 120) : null,
      int(b.headcount),
      b.location !== undefined ? str(b.location, 120) : null,
      b.one_liner !== undefined ? str(b.one_liner, 200) : null,
      b.about !== undefined ? str(b.about, 2000) : null,
      applyEmail,
      s.id,
    );
    if (applyEmail) db.prepare("UPDATE roles SET apply_email = ? WHERE startup_id = ? AND source = 'direct'").run(applyEmail, s.id);
    res.json(view(req.user));
  });

  // ---------- the startup's applicant system ----------
  // With its API key, HireMe applies to the roles on its job board through the system's official API: no
  // forms, no CAPTCHAs, and applicants land straight in their ATS. The key is sealed before it's stored and
  // never sent back to the browser.

  app.put('/api/hiring/ats', requireUser, async (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.status(404).json({ error: 'Add your company first' });
    if (!atsApi || !secrets) return res.status(503).json({ error: 'Not available right now' });
    const system = String(req.body?.system || '');
    const key = String(req.body?.key || '').trim();
    const board = String(req.body?.board || '')
      .trim()
      .replace(/^https?:\/\/[^/]+\//i, '')
      .split(/[/?#]/)[0];
    const problem = await atsApi.verify({ system, key, board }).catch(() => 'Couldn’t reach that system. Try again in a minute.');
    if (problem) return res.status(400).json({ error: problem });
    db.prepare(
      "UPDATE startups SET ats_api = ?, ats_api_board = ?, ats_api_key = ?, ats_api_at = datetime('now'), ats_api_error = NULL, ats = ?, ats_slug = ?, ats_checked_at = datetime('now') WHERE id = ?",
    ).run(system, board, secrets.seal(key), system, board, s.id);
    // Bring their roles in now rather than at the next import.
    let synced = null;
    try {
      synced = await syncBoard(s.id, system, board);
    } catch (e) {
      log.warn?.(`[hiring] board sync for ${s.domain}: ${e.message}`);
    }
    log.info?.(`[hiring] ${s.domain} connected ${system}/${board}${synced ? `, ${synced.roles_added} roles added` : ''}`);
    res.json(view(req.user));
  });

  app.delete('/api/hiring/ats', requireUser, (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.status(404).json({ error: 'Add your company first' });
    db.prepare('UPDATE startups SET ats_api = NULL, ats_api_board = NULL, ats_api_key = NULL, ats_api_at = NULL, ats_api_error = NULL WHERE id = ?').run(s.id);
    res.json(view(req.user));
  });

  function roleFields(b) {
    const title = str(b.title, 120);
    if (!title) return { error: 'Add a job title' };
    if (!isDevRole(title)) return { error: 'HireMe is for developer roles. Use a title like “Software Engineer” or “Founding Engineer”.' };
    const description = str(b.description, 8000);
    if (description.length < 40) return { error: 'Add a short description of the role (a few sentences)' };
    const min = int(b.salary_min);
    const max = int(b.salary_max);
    if (min && max && max < min) return { error: 'The top of the salary range is below the bottom' };
    return {
      row: {
        title,
        description,
        location: str(b.location, 120),
        work_mode: MODES.includes(b.work_mode) ? b.work_mode : 'remote',
        salary_min: min,
        salary_max: max,
        equity: str(b.equity, 40),
        skills: extractSkills(`${title}\n${description}`, 10).join(', '),
      },
    };
  }

  app.post('/api/hiring/roles', requireUser, (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.status(404).json({ error: 'Add your company first' });
    const open = db.prepare("SELECT COUNT(*) n FROM roles WHERE startup_id = ? AND source = 'direct' AND status = 'open'").get(s.id).n;
    if (open >= MAX_OPEN_ROLES) return res.status(400).json({ error: `Up to ${MAX_OPEN_ROLES} open roles at a time. Close one first.` });
    const { row, error } = roleFields(req.body || {});
    if (error) return res.status(400).json({ error });
    db.prepare(
      `INSERT INTO roles (startup_id, source, title, description, location, work_mode, salary_min, salary_max, equity, skills, apply_url, apply_email, posted_at)
       VALUES (@startup_id, 'direct', @title, @description, @location, @work_mode, @salary_min, @salary_max, @equity, @skills, '', @apply_email, datetime('now'))`,
    ).run({ ...row, startup_id: s.id, apply_email: s.apply_email || req.user.email });
    res.status(201).json(view(req.user));
  });

  app.put('/api/hiring/roles/:id', requireUser, (req, res) => {
    const s = membership(req.user.id);
    const role = s && db.prepare("SELECT * FROM roles WHERE id = ? AND startup_id = ? AND source = 'direct'").get(Number(req.params.id), s.id);
    if (!role) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (b.status === 'open' || b.status === 'closed') {
      if (b.status === 'open' && role.status !== 'open') {
        const open = db.prepare("SELECT COUNT(*) n FROM roles WHERE startup_id = ? AND source = 'direct' AND status = 'open'").get(s.id).n;
        if (open >= MAX_OPEN_ROLES) return res.status(400).json({ error: `Up to ${MAX_OPEN_ROLES} open roles at a time. Close one first.` });
      }
      db.prepare('UPDATE roles SET status = ? WHERE id = ?').run(b.status, role.id);
    }
    if (b.title !== undefined) {
      const { row, error } = roleFields({ ...role, ...b });
      if (error) return res.status(400).json({ error });
      db.prepare(
        `UPDATE roles SET title=@title, description=@description, location=@location, work_mode=@work_mode, salary_min=@salary_min,
           salary_max=@salary_max, equity=@equity, skills=@skills WHERE id=@id`,
      ).run({ ...row, id: role.id });
    }
    res.json(view(req.user));
  });
}
