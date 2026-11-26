import express from 'express';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, MAX_HEADCOUNT } from './db.js';
import { createAuth } from './auth.js';
import { createMailer } from './mail.js';
import { checkStartup, emailDomain, emailMatchesDomain, looksLikeAgency, siteDomain } from './rules.js';
import { createImporter } from './importer.js';
import { createApplier, applyReadiness } from './apply/agent.js';
import { parseResume } from './resume-parse.js';

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const skillList = (s) =>
  String(s || '')
    .split(/[,\n]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
const parse = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const cleanUrl = (u) => {
  const s = str(u, 300);
  if (!s) return '';
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withProto).protocol.startsWith('http') ? withProto : '';
  } catch {
    return '';
  }
};

const REPORT_REASONS = ['recruiter', 'too_big', 'spam', 'inappropriate', 'other'];
const HIDE_AFTER_REPORTS = 3;

/**
 * @param opts.mailer      email sender (tests pass a fake)
 * @param opts.publicUrl   e.g. https://hireme.example — used in emails and cookie security
 * @param opts.adminEmails people who approve startups
 */
export function createApp(
  db = openDb(),
  {
    mailer = createMailer(),
    publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, ''),
    adminEmails = String(process.env.ADMIN_EMAILS || '').split(','),
    production = process.env.NODE_ENV === 'production',
    log = console,
    ipLimit = 12, // sign-in emails per IP per 15 minutes
    fetchImpl = fetch, // used by the job importer
    dataDir = path.dirname(process.env.DB_PATH || path.resolve('data', 'hireme.db')), // resumes and screenshots
    applierOptions = {},
    googleClientId = process.env.GOOGLE_CLIENT_ID || '',
  } = {},
) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.mailer = mailer;
  const importer = createImporter(db, { fetchImpl, log });
  app.locals.importer = importer;
  const applier = createApplier(db, {
    dataDir,
    log,
    notify: (to, subject, text) => mailer.send({ to, subject, text }).catch(() => {}),
    appLink: (hash) => `${publicUrl || ''}/#/${hash}`,
    ...applierOptions,
  });
  app.locals.applier = applier;

  const auth = createAuth(db, { mailer, publicUrl, adminEmails, production, log, ipLimit, googleClientId, fetchImpl });
  const { requireUser, requireRole, requireAdmin } = auth;

  // Resume uploads are the only big request bodies (base64 PDF up to 4 MB).
  const smallJson = express.json({ limit: '200kb' });
  const bigJson = express.json({ limit: '6mb' });
  app.use((req, res, next) => (req.path === '/api/profile/resume' ? bigJson : smallJson)(req, res, next));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', auth.middleware);
  auth.routes(app);

  const notify = (to, subject, text) =>
    mailer.send({ to, subject, text }).catch((e) => log.warn?.(`email to ${to} failed: ${e.message}`));
  const link = (req, hash) => `${auth.baseUrl(req)}/#/${hash}`;

  // ---------- shared lookups ----------
  const membership = (userId) =>
    db.prepare('SELECT s.*, m.title AS member_title FROM startup_members m JOIN startups s ON s.id = m.startup_id WHERE m.user_id = ?').get(userId);
  const memberEmails = (startupId) => db.prepare('SELECT u.email FROM startup_members m JOIN users u ON u.id = m.user_id WHERE m.startup_id = ?').all(startupId).map((r) => r.email);
  const getProfile = (userId) => {
    const p = db.prepare('SELECT * FROM dev_profiles WHERE user_id = ?').get(userId);
    return p
      ? { ...p, links: parse(p.links, {}), visible: !!p.visible, auto_apply: !!p.auto_apply, saved_answers: parse(p.saved_answers, []), resume_file: undefined, has_resume: !!p.resume_file }
      : null;
  };
  const profileComplete = (p) => !!(p && p.name && p.headline && p.skills);
  const publicStartup = (s) =>
    s && { id: s.id, name: s.name, website: s.website, domain: s.domain, headcount: s.headcount, stage: s.stage, one_liner: s.one_liner, about: s.about, location: s.location };
  const publicDev = (p) =>
    p && {
      id: p.user_id,
      name: p.name,
      headline: p.headline,
      location: p.location,
      work_pref: p.work_pref,
      years: p.years,
      skills: p.skills,
      bio: p.bio,
      experience: p.experience,
      links: p.links,
    };
  const ownRole = (req, res) => {
    const s = membership(req.user.id);
    const role = s && db.prepare('SELECT * FROM roles WHERE id = ? AND startup_id = ?').get(int(req.params.id ?? req.query.role ?? req.body?.role), s.id);
    if (!role) res.status(404).json({ error: 'Role not found' });
    return role && { role, startup: s };
  };

  /** Creates the match if both sides like each other. Returns the match id or null. */
  function maybeMatch(req, roleId, devId) {
    const devLiked = db.prepare('SELECT note FROM dev_swipes WHERE dev_id = ? AND role_id = ? AND liked = 1').get(devId, roleId);
    const startupLiked = db.prepare('SELECT 1 FROM founder_swipes WHERE dev_id = ? AND role_id = ? AND liked = 1').get(devId, roleId);
    if (!devLiked || !startupLiked) return null;
    const role = db.prepare('SELECT r.*, s.name AS startup_name FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = ?').get(roleId);
    const existing = db.prepare('SELECT id FROM matches WHERE role_id = ? AND dev_id = ?').get(roleId, devId);
    if (existing) return existing.id;
    const id = Number(db.prepare('INSERT INTO matches (role_id, dev_id, startup_id) VALUES (?, ?, ?)').run(roleId, devId, role.startup_id).lastInsertRowid);
    if (devLiked.note) db.prepare('INSERT INTO messages (match_id, sender_id, body) VALUES (?, ?, ?)').run(id, devId, devLiked.note);

    const dev = db.prepare('SELECT u.email, p.name FROM users u LEFT JOIN dev_profiles p ON p.user_id = u.id WHERE u.id = ?').get(devId);
    notify(dev.email, `You matched with ${role.startup_name}`, `${role.startup_name} is interested in you for ${role.title}, and you liked them too.\n\nSay hi: ${link(req, `matches/${id}`)}`);
    for (const to of memberEmails(role.startup_id))
      notify(to, `New match: ${dev.name || 'a developer'} for ${role.title}`, `${dev.name || 'A developer'} and ${role.startup_name} both said yes for ${role.title}.\n\nStart the conversation: ${link(req, `matches/${id}`)}`);
    return id;
  }

  // ---------- me ----------
  app.get('/api/health', (_req, res) => res.json({ ok: true, email: mailer.configured }));
  // Public settings the web app needs before sign-in. The Google client ID is public by design.
  app.get('/api/config', (_req, res) => res.json({ googleClientId: googleClientId || null }));

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    const u = req.user;
    const out = { user: u, counts: { unread: unreadCount(u) } };
    if (u.role === 'dev') {
      out.counts.needsYou = db.prepare("SELECT COUNT(*) n FROM applications WHERE dev_id = ? AND state = 'needs_you'").get(u.id).n;
      out.profile = getProfile(u.id);
      out.profileComplete = profileComplete(out.profile);
    }
    if (u.role === 'founder') {
      const s = membership(u.id);
      out.startup = s ? { ...publicStartup(s), status: s.status, review_note: s.review_note } : null;
      if (!s) {
        const d = emailDomain(u.email);
        const sameDomain = db.prepare("SELECT id, name, status, source FROM startups WHERE (domain = ? OR ? LIKE '%.' || domain) AND status NOT IN ('rejected', 'retired')").get(d, d);
        out.joinable = sameDomain ? { ...sameDomain, claimable: sameDomain.status === 'listed' } : null;
      } else {
        out.counts.interested = db
          .prepare(
            `SELECT COUNT(*) n FROM dev_swipes d JOIN roles r ON r.id = d.role_id
             WHERE r.startup_id = ? AND r.status = 'open' AND d.liked = 1
               AND NOT EXISTS (SELECT 1 FROM founder_swipes f WHERE f.role_id = d.role_id AND f.dev_id = d.dev_id)`,
          )
          .get(s.id).n;
      }
    }
    if (u.isAdmin) {
      out.counts.pendingStartups = db.prepare("SELECT COUNT(*) n FROM startups WHERE status = 'pending'").get().n;
      out.counts.openReports = db.prepare('SELECT COUNT(*) n FROM reports WHERE resolved = 0').get().n;
    }
    res.json(out);
  });

  app.post('/api/me/role', requireUser, (req, res) => {
    const role = oneOf(req.body?.role, ['dev', 'founder'], '');
    if (!role) return res.status(400).json({ error: 'Pick developer or founder' });
    const hasData = getProfile(req.user.id) || membership(req.user.id);
    if (req.user.role && req.user.role !== role && hasData)
      return res.status(409).json({ error: 'This account is already set up. Use a different email for the other side.' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.user.id);
    res.json({ role });
  });

  app.delete('/api/me', requireUser, (req, res) => {
    applier.removeFilesFor(req.user.id, db.prepare('SELECT resume_file FROM dev_profiles WHERE user_id = ?').get(req.user.id)?.resume_file);
    const s = membership(req.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    if (s && !db.prepare('SELECT 1 FROM startup_members WHERE startup_id = ?').get(s.id)) db.prepare('DELETE FROM startups WHERE id = ?').run(s.id);
    res.append('Set-Cookie', 'hm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.status(204).end();
  });

  // ---------- developer profile ----------
  app.get('/api/profile', requireRole('dev'), (req, res) => {
    const p = getProfile(req.user.id);
    res.json(p ? { ...p, applyMissing: applyReadiness(applier.profileFor(req.user.id)) } : {});
  });

  app.put('/api/profile', requireRole('dev'), (req, res) => {
    const b = req.body || {};
    const links = {
      github: cleanUrl(b.links?.github),
      linkedin: cleanUrl(b.links?.linkedin),
      portfolio: cleanUrl(b.links?.portfolio),
    };
    const p = {
      name: str(b.name, 80),
      headline: str(b.headline, 120),
      location: str(b.location, 80),
      work_pref: oneOf(b.work_pref, ['remote', 'hybrid', 'onsite', 'any'], 'any'),
      years: int(b.years),
      skills: skillList(b.skills).slice(0, 30).join(', '),
      bio: str(b.bio, 1500),
      experience: str(b.experience, 6000),
      links: JSON.stringify(links),
      salary_min: int(b.salary_min),
      visible: b.visible === false ? 0 : 1,
      phone: str(b.phone, 40),
      work_authorized: oneOf(b.work_authorized, ['yes', 'no'], ''),
      needs_sponsorship: oneOf(b.needs_sponsorship, ['yes', 'no'], ''),
      auto_apply: b.auto_apply ? 1 : 0,
      saved_answers: JSON.stringify(
        (Array.isArray(b.saved_answers) ? b.saved_answers : [])
          .map((a) => ({ question: str(a?.question, 300), answer: str(a?.answer, 2000) }))
          .filter((a) => a.question && a.answer)
          .slice(0, 100),
      ),
    };
    db.prepare(
      `INSERT INTO dev_profiles (user_id, name, headline, location, work_pref, years, skills, bio, experience, links, salary_min, visible,
         phone, work_authorized, needs_sponsorship, auto_apply, saved_answers)
       VALUES (@user_id, @name, @headline, @location, @work_pref, @years, @skills, @bio, @experience, @links, @salary_min, @visible,
         @phone, @work_authorized, @needs_sponsorship, @auto_apply, @saved_answers)
       ON CONFLICT (user_id) DO UPDATE SET name=@name, headline=@headline, location=@location, work_pref=@work_pref, years=@years,
         skills=@skills, bio=@bio, experience=@experience, links=@links, salary_min=@salary_min, visible=@visible,
         phone=@phone, work_authorized=@work_authorized, needs_sponsorship=@needs_sponsorship, auto_apply=@auto_apply,
         saved_answers=@saved_answers, updated_at=datetime('now')`,
    ).run({ user_id: req.user.id, ...p });
    const saved = getProfile(req.user.id);
    res.json({ ...saved, complete: profileComplete(saved), applyMissing: applyReadiness(applier.profileFor(req.user.id)) });
  });

  // ---------- resume file ----------
  // Upload works before the profile is saved (setup can start from a resume); the row stays
  // incomplete, and so invisible to founders, until name, headline and skills are saved.
  // With { parse: true } the response carries suggested profile fields read from the PDF.
  app.post('/api/profile/resume', requireRole('dev'), async (req, res) => {
    const buf = Buffer.from(String(req.body?.data || ''), 'base64');
    if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'Upload your resume as a PDF' });
    if (buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'That PDF is over 4 MB' });
    if (req.body?.parse && auth.limited(`resume:${req.user.id}`, 20, 24 * 3600_000))
      return res.status(429).json({ error: 'That’s a lot of resumes today. Try again tomorrow.' });
    db.prepare('INSERT OR IGNORE INTO dev_profiles (user_id) VALUES (?)').run(req.user.id);
    const file = `${req.user.id}-${Date.now()}.pdf`;
    const old = db.prepare('SELECT resume_file FROM dev_profiles WHERE user_id = ?').get(req.user.id)?.resume_file;
    writeFileSync(path.join(applier.resumesDir, file), buf);
    if (old) rmSync(path.join(applier.resumesDir, old), { force: true });
    const name = str(req.body?.name, 120).replace(/[^\w .()-]/g, '') || 'Resume.pdf';
    db.prepare('UPDATE dev_profiles SET resume_file = ?, resume_name = ? WHERE user_id = ?').run(file, name.endsWith('.pdf') ? name : `${name}.pdf`, req.user.id);
    if (!req.body?.parse) return res.json({ resume_name: name });
    const parsed = await parseResume(buf, { log });
    res.json({ resume_name: name, parsed: parsed.fields, unreadable: parsed.empty });
  });
  app.get('/api/profile/resume', requireRole('dev'), (req, res) => {
    const p = db.prepare('SELECT resume_file, resume_name FROM dev_profiles WHERE user_id = ?').get(req.user.id);
    if (!p?.resume_file) return res.status(404).json({ error: 'No resume uploaded' });
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${p.resume_name || 'Resume.pdf'}"`).sendFile(path.join(applier.resumesDir, p.resume_file));
  });
  app.delete('/api/profile/resume', requireRole('dev'), (req, res) => {
    const p = db.prepare('SELECT resume_file FROM dev_profiles WHERE user_id = ?').get(req.user.id);
    if (p?.resume_file) rmSync(path.join(applier.resumesDir, p.resume_file), { force: true });
    db.prepare('UPDATE dev_profiles SET resume_file = NULL, resume_name = NULL WHERE user_id = ?').run(req.user.id);
    res.status(204).end();
  });

  // ---------- startups ----------
  app.post('/api/startup', requireRole('founder'), (req, res) => {
    if (membership(req.user.id)) return res.status(409).json({ error: 'You’re already part of a startup' });
    const b = req.body || {};
    const { errors, flags, domain, headcount } = checkStartup(b, req.user.email);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const existing = db.prepare('SELECT id, name, status FROM startups WHERE domain = ?').get(domain);
    if (existing?.status === 'retired') return res.status(400).json({ error: `Our records show ${existing.name} has more than ${MAX_HEADCOUNT} people. Reply to your sign-in email if that’s wrong.` });
    if (existing)
      return res.status(409).json({
        error: existing.status === 'listed' ? `We already list ${existing.name} from YC’s directory. Claim it below.` : `${existing.name} is already on HireMe. Join it instead.`,
        existing: { ...existing, claimable: existing.status === 'listed' },
      });

    const id = Number(
      db
        .prepare(
          `INSERT INTO startups (name, website, domain, headcount, stage, one_liner, about, location, flags, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(str(b.name, 80), cleanUrl(b.website), domain, headcount, str(b.stage, 40), str(b.one_liner, 140), str(b.about, 2000), str(b.location, 80), flags.join('; '), req.user.id)
        .lastInsertRowid,
    );
    db.prepare('INSERT INTO startup_members (startup_id, user_id, title) VALUES (?, ?, ?)').run(id, req.user.id, str(b.title, 60));
    for (const to of adminEmails.filter(Boolean))
      notify(to.trim(), `New startup to review: ${str(b.name, 80)}`, `${str(b.name, 80)} (${domain}, ${headcount} people) signed up.${flags.length ? `\nFlags: ${flags.join('; ')}` : ''}\n\nReview: ${link(req, 'admin')}`);
    res.status(201).json(db.prepare('SELECT * FROM startups WHERE id = ?').get(id));
  });

  app.post('/api/startup/join', requireRole('founder'), (req, res) => {
    if (membership(req.user.id)) return res.status(409).json({ error: 'You’re already part of a startup' });
    const s = db.prepare('SELECT * FROM startups WHERE id = ?').get(int(req.body?.id));
    if (!s || !emailMatchesDomain(req.user.email, s.domain))
      return res.status(403).json({ error: 'You can only join a startup whose domain matches your email' });
    if (s.status === 'rejected' || s.status === 'retired') return res.status(403).json({ error: 'That startup isn’t eligible for HireMe' });
    db.prepare('INSERT INTO startup_members (startup_id, user_id, title) VALUES (?, ?, ?)').run(s.id, req.user.id, str(req.body?.title, 60));
    if (s.status === 'listed') {
      // Claiming an imported startup: the company email proves they work there, and YC's directory already
      // confirms it's a startup under the size limit, so it goes live right away. Admins are told.
      db.prepare("UPDATE startups SET status = 'approved', created_by = ?, reviewed_at = datetime('now'), review_note = 'Claimed by founder' WHERE id = ?").run(req.user.id, s.id);
      const waiting = db.prepare("SELECT COUNT(*) n FROM dev_swipes d JOIN roles r ON r.id = d.role_id WHERE r.startup_id = ? AND d.liked = 1").get(s.id).n;
      for (const to of adminEmails.filter(Boolean))
        notify(to.trim(), `${s.name} claimed on HireMe`, `${req.user.email} claimed ${s.name} (${s.domain}, ${s.headcount} people per YC). ${waiting} developer yes${waiting === 1 ? '' : 'es'} were waiting.\n\n${link(req, 'admin')}`);
    }
    res.status(201).json(db.prepare('SELECT * FROM startups WHERE id = ?').get(s.id));
  });

  app.get('/api/startup', requireRole('founder'), (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.json(null);
    const roles = db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM dev_swipes d WHERE d.role_id = r.id AND d.liked = 1
              AND NOT EXISTS (SELECT 1 FROM founder_swipes f WHERE f.role_id = r.id AND f.dev_id = d.dev_id)) AS interested,
           (SELECT COUNT(*) FROM matches m WHERE m.role_id = r.id) AS matches
         FROM roles r WHERE r.startup_id = ? ORDER BY r.status = 'open' DESC, r.created_at DESC`,
      )
      .all(s.id);
    const team = db.prepare('SELECT u.email, m.title FROM startup_members m JOIN users u ON u.id = m.user_id WHERE m.startup_id = ?').all(s.id);
    res.json({ ...s, roles, team });
  });

  app.put('/api/startup', requireRole('founder'), (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.status(404).json({ error: 'No startup yet' });
    const b = req.body || {};
    const headcount = b.headcount === undefined ? s.headcount : int(b.headcount);
    if (!headcount || headcount < 1) return res.status(400).json({ error: 'Add how many people work at the startup' });
    if (headcount > MAX_HEADCOUNT)
      return res.status(400).json({ error: `HireMe is for startups with ${MAX_HEADCOUNT} or fewer people. Congrats on growing — you’ve outgrown it.` });
    const next = {
      name: str(b.name ?? s.name, 80) || s.name,
      stage: str(b.stage ?? s.stage, 40),
      one_liner: str(b.one_liner ?? s.one_liner, 140),
      about: str(b.about ?? s.about, 2000),
      location: str(b.location ?? s.location, 80),
    };
    db.prepare('UPDATE startups SET name=?, stage=?, one_liner=?, about=?, location=?, headcount=? WHERE id=?').run(
      next.name, next.stage, next.one_liner, next.about, next.location, headcount, s.id,
    );
    if (s.status === 'approved' && looksLikeAgency(`${next.name} ${next.one_liner} ${next.about}`) && !looksLikeAgency(`${s.name} ${s.one_liner} ${s.about}`))
      db.prepare("UPDATE startups SET flags = trim(flags || '; Edited to mention recruiting', '; ') WHERE id = ?").run(s.id);
    res.json(db.prepare('SELECT * FROM startups WHERE id = ?').get(s.id));
  });

  // ---------- roles ----------
  const roleFields = (b, prev = {}) => {
    const get = (k) => (b[k] === undefined ? prev[k] : b[k]);
    return {
      title: str(get('title'), 100),
      description: str(get('description'), 6000),
      location: str(get('location'), 80),
      work_mode: oneOf(get('work_mode'), ['remote', 'hybrid', 'onsite'], 'remote'),
      salary_min: int(get('salary_min')),
      salary_max: int(get('salary_max')),
      equity: str(get('equity'), 40),
      skills: skillList(get('skills')).slice(0, 20).join(', '),
      status: oneOf(get('status'), ['open', 'closed'], 'open'),
    };
  };

  app.post('/api/roles', requireRole('founder'), (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.status(400).json({ error: 'Add your startup first' });
    const r = roleFields(req.body || {});
    if (!r.title) return res.status(400).json({ error: 'Give the role a title' });
    if (r.salary_min && r.salary_max && r.salary_min > r.salary_max) return res.status(400).json({ error: 'Salary minimum is above the maximum' });
    const id = db
      .prepare('INSERT INTO roles (startup_id, title, description, location, work_mode, salary_min, salary_max, equity, skills, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, r.title, r.description, r.location, r.work_mode, r.salary_min, r.salary_max, r.equity, r.skills, r.status).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM roles WHERE id = ?').get(id));
  });

  app.put('/api/roles/:id', requireRole('founder'), (req, res) => {
    const own = ownRole(req, res);
    if (!own) return;
    const r = roleFields(req.body || {}, own.role);
    if (!r.title) return res.status(400).json({ error: 'Give the role a title' });
    db.prepare('UPDATE roles SET title=?, description=?, location=?, work_mode=?, salary_min=?, salary_max=?, equity=?, skills=?, status=? WHERE id=?').run(
      r.title, r.description, r.location, r.work_mode, r.salary_min, r.salary_max, r.equity, r.skills, r.status, own.role.id,
    );
    res.json(db.prepare('SELECT * FROM roles WHERE id = ?').get(own.role.id));
  });

  // ---------- developer deck: roles at approved startups ----------
  app.get('/api/deck', requireRole('dev'), (req, res) => {
    const me = getProfile(req.user.id);
    if (!profileComplete(me)) return res.status(409).json({ error: 'Finish your profile first', needsProfile: true });
    const mine = new Set(skillList(me.skills));
    const rows = db
      .prepare(
        `SELECT r.*, s.name AS s_name, s.website AS s_website, s.domain AS s_domain, s.headcount AS s_headcount, s.stage AS s_stage,
                s.one_liner AS s_one_liner, s.about AS s_about, s.location AS s_location, s.status AS s_status,
                EXISTS (SELECT 1 FROM founder_swipes f WHERE f.role_id = r.id AND f.dev_id = @me AND f.liked = 1) AS interested
         FROM roles r JOIN startups s ON s.id = r.startup_id
         WHERE r.status = 'open' AND s.status IN ('approved', 'listed')
           AND NOT EXISTS (SELECT 1 FROM dev_swipes d WHERE d.role_id = r.id AND d.dev_id = @me)
           AND NOT EXISTS (SELECT 1 FROM reports x WHERE x.reporter_id = @me AND x.target_type = 'startup' AND x.target_id = s.id)
         ORDER BY COALESCE(r.posted_at, r.created_at) DESC LIMIT 2000`,
      )
      .all({ me: req.user.id });
    const scored = rows.map((r) => {
      const overlap = skillList(r.skills).filter((k) => mine.has(k));
      const modeFit = me.work_pref === 'any' || me.work_pref === r.work_mode ? 1 : 0;
      const underpays = me.salary_min && r.salary_max && r.salary_max < me.salary_min ? 1 : 0;
      // Startups whose founders are on HireMe come a little ahead of imported listings.
      const onHireMe = r.s_status === 'approved' ? 4 : 0;
      return { r, overlap, score: (r.interested ? 100 : 0) + overlap.length * 3 + modeFit * 2 - underpays * 6 + onHireMe };
    });
    scored.sort((a, b) => b.score - a.score);
    res.json(
      scored.slice(0, 30).map(({ r, overlap }) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        location: r.location,
        work_mode: r.work_mode,
        salary_min: r.salary_min,
        salary_max: r.salary_max,
        equity: r.equity,
        skills: r.skills,
        created_at: r.created_at,
        interested: !!r.interested,
        sharedSkills: overlap,
        // Imported listing whose founders haven't joined: a yes points to the company's own application page.
        external: r.s_status === 'listed' ? { apply_url: r.apply_url } : null,
        posted_at: r.posted_at,
        startup: { id: r.startup_id, name: r.s_name, website: r.s_website, domain: r.s_domain, headcount: r.s_headcount, stage: r.s_stage, one_liner: r.s_one_liner, about: r.s_about, location: r.s_location, onHireMe: r.s_status === 'approved' },
      })),
    );
  });

  app.post('/api/deck/:roleId', requireRole('dev'), (req, res) => {
    const roleId = int(req.params.roleId);
    const role = db
      .prepare("SELECT r.id, r.apply_url, s.status AS s_status FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = ? AND r.status = 'open' AND s.status IN ('approved', 'listed')")
      .get(roleId);
    if (!role) return res.status(404).json({ error: 'That role isn’t open anymore' });
    const liked = req.body?.liked ? 1 : 0;
    db.prepare(
      `INSERT INTO dev_swipes (dev_id, role_id, liked, note) VALUES (?, ?, ?, ?)
       ON CONFLICT (dev_id, role_id) DO UPDATE SET liked = excluded.liked, note = excluded.note, created_at = datetime('now')`,
    ).run(req.user.id, roleId, liked, liked ? str(req.body?.note, 500) : '');
    const matchId = liked ? maybeMatch(req, roleId, req.user.id) : null;
    const out = { matched: !!matchId, matchId, external: null, application: null, applySetup: null };
    if (liked && role.s_status === 'listed') {
      out.external = { apply_url: role.apply_url };
      const p = applier.profileFor(req.user.id);
      const missing = applyReadiness(p);
      if (p?.auto_apply && !missing.length) out.application = publicApplication(applier.enqueue(req.user.id, roleId));
      else out.applySetup = { missing, consented: !!p?.auto_apply };
    }
    res.json(out);
  });

  // ---------- applications HireMe makes for developers ----------
  const publicApplication = (a) =>
    a && {
      id: a.id,
      role_id: a.role_id,
      state: a.state,
      error: a.error,
      missing: parse(a.missing, []),
      answers: parse(a.answers, []),
      cover_note: a.cover_note,
      has_screenshot: !!a.screenshot,
      created_at: a.created_at,
      updated_at: a.updated_at,
      submitted_at: a.submitted_at,
    };
  const ownApplication = (req, res) => {
    const a = db.prepare('SELECT * FROM applications WHERE id = ? AND dev_id = ?').get(int(req.params.id), req.user.id);
    if (!a) res.status(404).json({ error: 'Application not found' });
    return a;
  };

  app.post('/api/applications', requireRole('dev'), (req, res) => {
    const roleId = int(req.body?.roleId);
    const role = db.prepare("SELECT r.id FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = ? AND r.status = 'open' AND s.status = 'listed'").get(roleId);
    if (!role) return res.status(404).json({ error: 'That role isn’t open for applying through HireMe' });
    if (req.body?.consent) db.prepare('UPDATE dev_profiles SET auto_apply = 1 WHERE user_id = ?').run(req.user.id);
    const p = applier.profileFor(req.user.id);
    if (!p?.auto_apply) return res.status(400).json({ error: 'Turn on “Apply for me” first' });
    const missing = applyReadiness(p);
    if (missing.length) return res.status(400).json({ error: 'Finish your application details first', missing });
    db.prepare(
      `INSERT INTO dev_swipes (dev_id, role_id, liked) VALUES (?, ?, 1) ON CONFLICT (dev_id, role_id) DO UPDATE SET liked = 1`,
    ).run(req.user.id, roleId);
    res.status(201).json(publicApplication(applier.enqueue(req.user.id, roleId)));
  });

  app.get('/api/applications', requireRole('dev'), (req, res) => {
    const rows = db
      .prepare(
        `SELECT a.*, r.title, r.apply_url, r.status AS role_status, s.name AS startup_name, s.domain, s.headcount
         FROM applications a JOIN roles r ON r.id = a.role_id JOIN startups s ON s.id = r.startup_id
         WHERE a.dev_id = ? AND a.state != 'canceled' ORDER BY a.state = 'needs_you' DESC, a.updated_at DESC LIMIT 300`,
      )
      .all(req.user.id);
    res.json(rows.map((a) => ({ ...publicApplication(a), title: a.title, apply_url: a.apply_url, role_status: a.role_status, startup_name: a.startup_name, domain: a.domain, headcount: a.headcount })));
  });

  app.get('/api/applications/:id/screenshot', requireRole('dev'), (req, res) => {
    const a = ownApplication(req, res);
    if (!a) return;
    if (!a.screenshot) return res.status(404).json({ error: 'No screenshot' });
    res.type('image/jpeg').sendFile(path.join(applier.shotsDir, a.screenshot));
  });

  /** The developer answers the questions HireMe couldn't, then it tries again. Answers are saved for next time. */
  app.post('/api/applications/:id/answers', requireRole('dev'), (req, res) => {
    const a = ownApplication(req, res);
    if (!a) return;
    const given = (Array.isArray(req.body?.answers) ? req.body.answers : [])
      .map((x) => ({ question: str(x?.question, 300), answer: str(x?.answer, 2000) }))
      .filter((x) => x.question && x.answer);
    if (!given.length) return res.status(400).json({ error: 'Answer the questions first' });
    const norm = (q) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const p = db.prepare('SELECT saved_answers FROM dev_profiles WHERE user_id = ?').get(req.user.id);
    const saved = parse(p?.saved_answers, []).filter((s) => !given.some((g) => norm(g.question) === norm(s.question)));
    db.prepare('UPDATE dev_profiles SET saved_answers = ? WHERE user_id = ?').run(JSON.stringify([...given, ...saved].slice(0, 100)), req.user.id);
    res.json(publicApplication(applier.enqueue(req.user.id, a.role_id)));
  });

  app.post('/api/applications/:id/retry', requireRole('dev'), (req, res) => {
    const a = ownApplication(req, res);
    if (!a) return;
    res.json(publicApplication(applier.enqueue(req.user.id, a.role_id)));
  });

  /** "I finished it myself on their site." */
  app.post('/api/applications/:id/self', requireRole('dev'), (req, res) => {
    const a = ownApplication(req, res);
    if (!a) return;
    db.prepare("UPDATE applications SET state = 'self_applied', updated_at = datetime('now') WHERE id = ?").run(a.id);
    res.status(204).end();
  });

  app.delete('/api/applications/:id', requireRole('dev'), (req, res) => {
    const a = ownApplication(req, res);
    if (!a) return;
    if (!['queued', 'needs_you', 'failed'].includes(a.state)) return res.status(409).json({ error: 'That application was already sent' });
    db.prepare("UPDATE applications SET state = 'canceled', updated_at = datetime('now') WHERE id = ?").run(a.id);
    res.status(204).end();
  });

  // Roles a developer said yes to at startups that aren't on HireMe yet — so they can apply on the company's site.
  app.get('/api/saved', requireRole('dev'), (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT r.id, r.title, r.apply_url, r.status, d.created_at AS liked_at, s.name AS startup_name, s.domain, s.headcount
           FROM dev_swipes d JOIN roles r ON r.id = d.role_id JOIN startups s ON s.id = r.startup_id
           WHERE d.dev_id = ? AND d.liked = 1 AND s.status = 'listed'
             AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.dev_id = d.dev_id AND a.role_id = d.role_id AND a.state != 'canceled')
           ORDER BY d.created_at DESC LIMIT 200`,
        )
        .all(req.user.id),
    );
  });

  app.delete('/api/deck/:roleId', requireRole('dev'), (req, res) => {
    const roleId = int(req.params.roleId);
    if (db.prepare('SELECT 1 FROM matches WHERE role_id = ? AND dev_id = ?').get(roleId, req.user.id))
      return res.status(409).json({ error: 'You already matched — find it in Matches' });
    db.prepare('DELETE FROM dev_swipes WHERE dev_id = ? AND role_id = ?').run(req.user.id, roleId);
    res.status(204).end();
  });

  // ---------- founder deck: developers, for one of your roles ----------
  const approvedFounder = (req, res) => {
    const s = membership(req.user.id);
    if (!s) return res.status(400).json({ error: 'Add your startup first' }), null;
    if (s.status !== 'approved')
      return res.status(403).json({ error: 'You can browse developers once we’ve verified your startup', pending: true }), null;
    return s;
  };

  app.get('/api/deck/devs', requireRole('founder'), (req, res) => {
    if (!approvedFounder(req, res)) return;
    const own = ownRole(req, res);
    if (!own) return;
    const want = new Set(skillList(own.role.skills));
    const rows = db
      .prepare(
        `SELECT p.*, d.note AS like_note, (d.liked = 1) AS liked_role
         FROM dev_profiles p
         JOIN users u ON u.id = p.user_id AND u.role = 'dev'
         LEFT JOIN dev_swipes d ON d.dev_id = p.user_id AND d.role_id = @role
         WHERE p.visible = 1 AND p.name != '' AND p.headline != '' AND p.skills != ''
           AND (d.liked IS NULL OR d.liked = 1)
           AND NOT EXISTS (SELECT 1 FROM founder_swipes f WHERE f.role_id = @role AND f.dev_id = p.user_id)
           AND NOT EXISTS (SELECT 1 FROM reports x WHERE x.reporter_id = p.user_id AND x.target_type = 'startup' AND x.target_id = @startup)
           AND NOT EXISTS (SELECT 1 FROM reports x JOIN startup_members sm ON sm.user_id = x.reporter_id
                           WHERE sm.startup_id = @startup AND x.target_type = 'dev' AND x.target_id = p.user_id)
         ORDER BY p.updated_at DESC LIMIT 500`,
      )
      .all({ role: own.role.id, startup: own.startup.id });
    const scored = rows.map((p) => {
      const overlap = skillList(p.skills).filter((k) => want.has(k));
      return { p, overlap, score: (p.liked_role ? 100 : 0) + overlap.length * 3 };
    });
    scored.sort((a, b) => b.score - a.score);
    res.json(
      scored.slice(0, 30).map(({ p, overlap }) => ({
        ...publicDev({ ...p, links: parse(p.links, {}) }),
        likedRole: !!p.liked_role,
        note: p.liked_role ? p.like_note : '',
        sharedSkills: overlap,
      })),
    );
  });

  app.post('/api/deck/devs/:devId', requireRole('founder'), (req, res) => {
    if (!approvedFounder(req, res)) return;
    const own = ownRole(req, res);
    if (!own) return;
    const devId = int(req.params.devId);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'dev'").get(devId)) return res.status(404).json({ error: 'Developer not found' });
    const liked = req.body?.liked ? 1 : 0;
    db.prepare(
      `INSERT INTO founder_swipes (role_id, dev_id, liked, by_user) VALUES (?, ?, ?, ?)
       ON CONFLICT (role_id, dev_id) DO UPDATE SET liked = excluded.liked, by_user = excluded.by_user, created_at = datetime('now')`,
    ).run(own.role.id, devId, liked, req.user.id);
    const matchId = liked ? maybeMatch(req, own.role.id, devId) : null;
    res.json({ matched: !!matchId, matchId });
  });

  app.delete('/api/deck/devs/:devId', requireRole('founder'), (req, res) => {
    const own = ownRole(req, res);
    if (!own) return;
    const devId = int(req.params.devId);
    if (db.prepare('SELECT 1 FROM matches WHERE role_id = ? AND dev_id = ?').get(own.role.id, devId))
      return res.status(409).json({ error: 'You already matched — find it in Matches' });
    db.prepare('DELETE FROM founder_swipes WHERE role_id = ? AND dev_id = ?').run(own.role.id, devId);
    res.status(204).end();
  });

  // ---------- matches & chat ----------
  // A message counts as unread only if it came from the other side (not you, not a teammate).
  const FROM_OTHER_SIDE = '(CASE WHEN @isDev = 1 THEN g.sender_id != @me ELSE g.sender_id = m.dev_id END)';

  /** Matches visible to this user: their own as a dev, or their startup's as a founder. */
  function matchesFor(user) {
    if (user.role === 'dev') return { where: 'm.dev_id = ?', arg: user.id };
    const s = membership(user.id);
    return s ? { where: 'm.startup_id = ?', arg: s.id } : null;
  }
  function unreadCount(user) {
    const scope = matchesFor(user);
    if (!scope) return 0;
    return db
      .prepare(
        `SELECT COUNT(*) n FROM messages g JOIN matches m ON m.id = g.match_id
         LEFT JOIN match_reads r ON r.match_id = m.id AND r.user_id = @me
         WHERE ${scope.where.replace('?', '@arg')} AND m.closed_by IS NULL AND ${FROM_OTHER_SIDE} AND g.id > COALESCE(r.last_read_id, 0)`,
      )
      .get({ me: user.id, arg: scope.arg, isDev: user.role === 'dev' ? 1 : 0 }).n;
  }
  const matchFor = (req, res) => {
    const scope = matchesFor(req.user);
    const m = scope && db.prepare(`SELECT m.* FROM matches m WHERE m.id = ? AND ${scope.where}`).get(int(req.params.id), scope.arg);
    if (!m) res.status(404).json({ error: 'Match not found' });
    return m;
  };

  app.get('/api/matches', requireUser, (req, res) => {
    const scope = matchesFor(req.user);
    if (!scope) return res.json([]);
    const rows = db
      .prepare(
        `SELECT m.id, m.created_at, m.closed_by, r.title AS role_title, s.name AS startup_name, s.domain, p.name AS dev_name, p.headline AS dev_headline,
           (SELECT body FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_body,
           (SELECT created_at FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_at,
           (SELECT COUNT(*) FROM messages g WHERE g.match_id = m.id AND ${FROM_OTHER_SIDE}
              AND g.id > COALESCE((SELECT last_read_id FROM match_reads WHERE match_id = m.id AND user_id = @me), 0)) AS unread
         FROM matches m JOIN roles r ON r.id = m.role_id JOIN startups s ON s.id = m.startup_id
         LEFT JOIN dev_profiles p ON p.user_id = m.dev_id
         WHERE ${scope.where.replace('?', '@arg')}
         ORDER BY m.closed_by IS NOT NULL, COALESCE(last_at, m.created_at) DESC`,
      )
      .all({ me: req.user.id, arg: scope.arg, isDev: req.user.role === 'dev' ? 1 : 0 });
    res.json(rows.map((r) => ({ ...r, closed: r.closed_by != null })));
  });

  app.get('/api/matches/:id', requireUser, (req, res) => {
    const m = matchFor(req, res);
    if (!m) return;
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(m.role_id);
    const startup = db.prepare('SELECT * FROM startups WHERE id = ?').get(m.startup_id);
    const after = int(req.query.after) || 0;
    const messages = db
      .prepare(
        `SELECT g.id, g.body, g.created_at, g.sender_id, (g.sender_id = @me) AS mine,
           CASE WHEN g.sender_id = @dev THEN 'dev' ELSE 'startup' END AS side
         FROM messages g WHERE g.match_id = @id AND g.id > @after ORDER BY g.id LIMIT 500`,
      )
      .all({ me: req.user.id, dev: m.dev_id, id: m.id, after })
      .map((g) => ({ ...g, mine: !!g.mine }));
    res.json({
      id: m.id,
      created_at: m.created_at,
      closed: m.closed_by != null,
      role,
      startup: publicStartup(startup),
      dev: publicDev(getProfile(m.dev_id)),
      messages,
    });
  });

  app.post('/api/matches/:id/read', requireUser, (req, res) => {
    const m = matchFor(req, res);
    if (!m) return;
    const last = int(req.body?.lastId) || 0;
    db.prepare(
      `INSERT INTO match_reads (match_id, user_id, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT (match_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    ).run(m.id, req.user.id, last);
    res.status(204).end();
  });

  app.post('/api/matches/:id/messages', requireUser, (req, res) => {
    const m = matchFor(req, res);
    if (!m) return;
    if (m.closed_by != null) return res.status(409).json({ error: 'This conversation was closed' });
    const body = str(req.body?.body, 4000);
    if (!body) return res.status(400).json({ error: 'Write a message' });
    if (auth.limited(`msg:${req.user.id}`, 40, 60_000)) return res.status(429).json({ error: 'Slow down a little' });
    const id = Number(db.prepare('INSERT INTO messages (match_id, sender_id, body) VALUES (?, ?, ?)').run(m.id, req.user.id, body).lastInsertRowid);
    db.prepare(
      `INSERT INTO match_reads (match_id, user_id, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT (match_id, user_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
    ).run(m.id, req.user.id, id);

    // Email the other side if they haven't been around, at most once an hour per conversation.
    const others =
      req.user.id === m.dev_id
        ? db.prepare('SELECT u.id, u.email, u.last_seen_at FROM startup_members sm JOIN users u ON u.id = sm.user_id WHERE sm.startup_id = ?').all(m.startup_id)
        : db.prepare('SELECT id, email, last_seen_at FROM users WHERE id = ?').all(m.dev_id);
    const fromName = req.user.id === m.dev_id ? getProfile(m.dev_id)?.name || 'The developer' : db.prepare('SELECT name FROM startups WHERE id = ?').get(m.startup_id).name;
    for (const o of others) {
      const away = !o.last_seen_at || Date.now() - new Date(`${o.last_seen_at}Z`).getTime() > 10 * 60_000;
      const rr = db.prepare('SELECT last_emailed_at FROM match_reads WHERE match_id = ? AND user_id = ?').get(m.id, o.id);
      const recently = rr?.last_emailed_at && Date.now() - new Date(`${rr.last_emailed_at}Z`).getTime() < 60 * 60_000;
      if (!away || recently) continue;
      db.prepare(
        `INSERT INTO match_reads (match_id, user_id, last_emailed_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT (match_id, user_id) DO UPDATE SET last_emailed_at = datetime('now')`,
      ).run(m.id, o.id);
      notify(o.email, `New message from ${fromName}`, `${fromName} wrote:\n\n${body.slice(0, 600)}\n\nReply: ${link(req, `matches/${m.id}`)}`);
    }
    res.status(201).json({ id });
  });

  app.post('/api/matches/:id/close', requireUser, (req, res) => {
    const m = matchFor(req, res);
    if (!m) return;
    db.prepare('UPDATE matches SET closed_by = ? WHERE id = ? AND closed_by IS NULL').run(req.user.id, m.id);
    res.status(204).end();
  });

  // ---------- reports ----------
  app.post('/api/reports', requireUser, (req, res) => {
    const type = oneOf(req.body?.type, ['startup', 'dev'], '');
    const reason = oneOf(req.body?.reason, REPORT_REASONS, '');
    const targetId = int(req.body?.id);
    if (!type || !reason || !targetId) return res.status(400).json({ error: 'Pick what you’re reporting and why' });
    const exists = type === 'startup' ? db.prepare('SELECT * FROM startups WHERE id = ?').get(targetId) : db.prepare("SELECT * FROM users WHERE id = ? AND role = 'dev'").get(targetId);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    db.prepare(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, detail) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, resolved = 0`,
    ).run(req.user.id, type, targetId, reason, str(req.body?.detail, 1000));

    let hidden = false;
    if (type === 'startup' && ['approved', 'listed'].includes(exists.status)) {
      const n = db.prepare("SELECT COUNT(DISTINCT reporter_id) n FROM reports WHERE target_type = 'startup' AND target_id = ? AND resolved = 0 AND reason IN ('recruiter','too_big')").get(targetId).n;
      if (n >= HIDE_AFTER_REPORTS) {
        db.prepare("UPDATE startups SET status = 'pending', flags = trim(flags || '; Hidden after reports', '; ') WHERE id = ?").run(targetId);
        hidden = true;
      }
    }
    const name = type === 'startup' ? exists.name : getProfile(targetId)?.name || exists.email;
    for (const to of adminEmails.filter(Boolean))
      notify(to.trim(), `Report: ${name} (${reason})${hidden ? ' — now hidden' : ''}`, `${req.user.email} reported ${type} “${name}” for ${reason}.\n${str(req.body?.detail, 1000)}\n\n${link(req, 'admin')}`);
    res.status(201).json({ ok: true });
  });

  // ---------- admin ----------
  app.get('/api/admin/queue', requireAdmin, (_req, res) => {
    const startups = db
      .prepare(
        `SELECT s.*, (SELECT GROUP_CONCAT(u.email, ', ') FROM startup_members m JOIN users u ON u.id = m.user_id WHERE m.startup_id = s.id) AS members,
           (SELECT COUNT(*) FROM reports x WHERE x.target_type = 'startup' AND x.target_id = s.id AND x.resolved = 0) AS reports
         FROM startups s WHERE s.status NOT IN ('listed', 'retired') OR EXISTS (SELECT 1 FROM reports x WHERE x.target_type = 'startup' AND x.target_id = s.id AND x.resolved = 0)
         ORDER BY s.status = 'pending' DESC, s.created_at DESC LIMIT 300`,
      )
      .all();
    const reports = db
      .prepare(
        `SELECT x.*, u.email AS reporter,
           CASE x.target_type WHEN 'startup' THEN (SELECT name FROM startups WHERE id = x.target_id)
                              ELSE (SELECT COALESCE(NULLIF(p.name, ''), u2.email) FROM users u2 LEFT JOIN dev_profiles p ON p.user_id = u2.id WHERE u2.id = x.target_id) END AS target_name
         FROM reports x LEFT JOIN users u ON u.id = x.reporter_id WHERE x.resolved = 0 ORDER BY x.created_at DESC`,
      )
      .all();
    const stats = {
      devs: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'dev'").get().n,
      founders: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'founder'").get().n,
      openRoles: db.prepare("SELECT COUNT(*) n FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.status = 'open' AND s.status IN ('approved', 'listed')").get().n,
      listed: db.prepare("SELECT COUNT(*) n FROM startups WHERE status = 'listed'").get().n,
      importedRoles: db.prepare("SELECT COUNT(*) n FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.status = 'open' AND s.status = 'listed'").get().n,
      matches: db.prepare('SELECT COUNT(*) n FROM matches').get().n,
    };
    res.json({ startups, reports, stats });
  });

  app.post('/api/admin/startups/:id', requireAdmin, (req, res) => {
    const s = db.prepare('SELECT * FROM startups WHERE id = ?').get(int(req.params.id));
    if (!s) return res.status(404).json({ error: 'Startup not found' });
    const status = oneOf(req.body?.status, ['approved', 'rejected', 'pending'], '');
    if (!status) return res.status(400).json({ error: 'Pick approve or reject' });
    const note = str(req.body?.note, 500);
    db.prepare("UPDATE startups SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?").run(status, note, s.id);
    if (status !== 'pending') {
      db.prepare("UPDATE reports SET resolved = 1 WHERE target_type = 'startup' AND target_id = ?").run(s.id);
      const text =
        status === 'approved'
          ? `${s.name} is verified on HireMe. Your open roles are now in front of developers, and you can start swiping.\n\n${link(req, 'discover')}`
          : `We couldn’t verify ${s.name} for HireMe.${note ? `\n\n${note}` : ''}\n\nHireMe is only for startups with ${MAX_HEADCOUNT} or fewer people hiring for themselves. Reply to this email if we got it wrong.`;
      for (const to of memberEmails(s.id)) notify(to, status === 'approved' ? `${s.name} is live on HireMe` : `About ${s.name} on HireMe`, text);
    }
    res.json(db.prepare('SELECT * FROM startups WHERE id = ?').get(s.id));
  });

  app.get('/api/admin/import', requireAdmin, (_req, res) => {
    const runs = db.prepare('SELECT * FROM import_runs ORDER BY id DESC LIMIT 5').all().map((r) => ({ ...r, errors: parse(r.errors, []) }));
    res.json({ running: importer.running, runs });
  });

  app.post('/api/admin/import', requireAdmin, (_req, res) => {
    const already = importer.running;
    importer.start().catch((e) => log.error?.('import failed', e));
    res.status(202).json({ running: true, already });
  });

  app.get('/api/admin/applier', requireAdmin, (_req, res) => {
    const counts = Object.fromEntries(db.prepare('SELECT state, COUNT(*) n FROM applications GROUP BY state').all().map((r) => [r.state, r.n]));
    res.json({ ...applier.status(), counts, ai: !!process.env.ANTHROPIC_API_KEY });
  });

  /** Fills a real imported role's form with a made-up applicant and reports what happened. Never submits. */
  app.post('/api/admin/applier-test', requireAdmin, async (req, res) => {
    const role =
      (int(req.body?.roleId) && db.prepare('SELECT r.*, s.name AS s_name, s.ats, s.ats_slug FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = ?').get(int(req.body.roleId))) ||
      db
        .prepare("SELECT r.*, s.name AS s_name, s.ats, s.ats_slug FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.status = 'open' AND s.status = 'listed' AND r.apply_url IS NOT NULL ORDER BY RANDOM() LIMIT 1")
        .get();
    if (!role) return res.status(404).json({ error: 'No imported roles to test with yet — run the import first' });
    const url = role.external_id?.startsWith('greenhouse:') && role.ats_slug ? `https://job-boards.greenhouse.io/${role.ats_slug}/jobs/${role.external_id.split(':')[1]}` : role.apply_url;
    try {
      const r = await applier.testRun(url, { company: role.s_name, title: role.title, description: role.description });
      res.json({ role: { id: role.id, title: role.title, startup: role.s_name, url }, state: r.state, error: r.error, missing: r.missing, answers: r.answers, fieldsFilled: r.fieldsFilled, screenshot: r.screenshot });
    } catch (e) {
      res.status(500).json({ error: `The test browser failed: ${String(e.message).split('\n')[0]}` });
    }
  });

  app.post('/api/admin/reports/:id/resolve', requireAdmin, (req, res) => {
    db.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').run(int(req.params.id));
    res.status(204).end();
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- the web app (built) ----------
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    log.error?.(err);
    res.status(500).json({ error: 'Something went wrong on our side' });
  });

  return app;
}

export { siteDomain };
