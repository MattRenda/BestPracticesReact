import express from 'express';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, MAX_HEADCOUNT } from './db.js';
import { createAuth } from './auth.js';
import { createMailer } from './mail.js';
import { siteDomain } from './rules.js';
import { createImporter } from './importer.js';
import { createApplier, applyReadiness, formDefaults } from './apply/agent.js';
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

const REPORT_REASONS = ['recruiter', 'too_big', 'closed', 'spam', 'other'];
const HIDE_AFTER_REPORTS = 3;

/**
 * @param opts.mailer      email sender (tests pass a fake)
 * @param opts.publicUrl   e.g. https://hireme.example — used in emails and cookie security
 * @param opts.adminEmails people who see reports and run the importer
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
    sendMail: (msg) => mailer.send(msg),
    mailReady: () => mailer.configured || !production,
    appLink: (hash) => `${publicUrl || ''}/#/${hash}`,
    ...applierOptions,
  });
  app.locals.applier = applier;

  const auth = createAuth(db, { mailer, publicUrl, adminEmails, production, log, ipLimit, googleClientId, fetchImpl, claimGuest });
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
  const getProfile = (userId) => {
    const p = db.prepare('SELECT * FROM dev_profiles WHERE user_id = ?').get(userId);
    return p
      ? {
          ...p,
          links: parse(p.links, {}),
          visible: !!p.visible,
          auto_apply: undefined,
          review_first: !!p.review_first,
          saved_answers: parse(p.saved_answers, []),
          resume_file: undefined,
          has_resume: !!p.resume_file,
          form_defaults: formDefaults(p), // what HireMe will actually answer, defaults filled in
        }
      : null;
  };
  const profileComplete = (p) => !!(p && p.name && p.headline && p.skills);
  // ---------- me ----------
  app.get('/api/health', (_req, res) => res.json({ ok: true, email: mailer.configured }));
  // Public settings the web app needs before sign-in. The Google client ID is public by design.
  app.get('/api/config', (_req, res) => res.json({ googleClientId: googleClientId || null }));

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    const u = req.user;
    const profile = getProfile(u.id);
    const out = {
      user: { ...u, isGuest: !!u.isGuest, pendingEmail: u.pendingEmail || '' },
      profile,
      profileComplete: profileComplete(profile),
      counts: {
        needsYou: db.prepare("SELECT COUNT(*) n FROM applications WHERE dev_id = ? AND state = 'needs_you'").get(u.id).n,
        toReview: db.prepare("SELECT COUNT(*) n FROM applications WHERE dev_id = ? AND state = 'review'").get(u.id).n,
      },
    };
    if (u.isAdmin) out.counts.openReports = db.prepare('SELECT COUNT(*) n FROM reports WHERE resolved = 0').get().n;
    res.json(out);
  });

  // ---------- guests ----------
  /**
   * A guest (someone who started without signing up) just signed in as `userId`. Moves the guest's
   * profile and swipes over unless the account already has a finished profile, then sends the
   * applications the guest swiped right on (swiping right is the go-ahead).
   * Returns the startups HireMe started applying to.
   */
  function claimGuest(guestId, userId) {
    const liked = db.prepare('SELECT role_id FROM dev_swipes WHERE dev_id = ? AND liked = 1').all(guestId).map((r) => r.role_id);
    if (guestId !== userId) {
      const gp = db.prepare('SELECT * FROM dev_profiles WHERE user_id = ?').get(guestId);
      const tp = db.prepare('SELECT * FROM dev_profiles WHERE user_id = ?').get(userId);
      if (gp && !profileComplete(tp)) {
        if (tp?.resume_file && !gp.resume_file) db.prepare('UPDATE dev_profiles SET resume_file = ?, resume_name = ? WHERE user_id = ?').run(tp.resume_file, tp.resume_name, guestId);
        else if (tp?.resume_file) applier.removeFilesFor(userId, tp.resume_file);
        db.prepare('DELETE FROM dev_profiles WHERE user_id = ?').run(userId);
        db.prepare('UPDATE dev_profiles SET user_id = ? WHERE user_id = ?').run(userId, guestId);
      } else if (gp) {
        // Keep the account's own profile; take the guest's resume and apply settings if it has none.
        if (gp.resume_file && !tp.resume_file) db.prepare('UPDATE dev_profiles SET resume_file = ?, resume_name = ? WHERE user_id = ?').run(gp.resume_file, gp.resume_name, userId);
        else if (gp.resume_file) applier.removeFilesFor(guestId, gp.resume_file);
        db.prepare(
          `UPDATE dev_profiles SET phone = COALESCE(NULLIF(phone, ''), ?),
             work_authorized = COALESCE(NULLIF(work_authorized, ''), ?), needs_sponsorship = COALESCE(NULLIF(needs_sponsorship, ''), ?) WHERE user_id = ?`,
        ).run(gp.phone, gp.work_authorized, gp.needs_sponsorship, userId);
      }
      db.prepare('UPDATE OR IGNORE dev_swipes SET dev_id = ? WHERE dev_id = ?').run(userId, guestId);
      db.prepare('UPDATE OR IGNORE reports SET reporter_id = ? WHERE reporter_id = ?').run(userId, guestId);
      db.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1').run(guestId);
    }
    return { sent: sendLiked(userId, liked) };
  }

  /** Recent right swipes HireMe hasn't applied to yet (never tried, so a canceled one isn't sent again). */
  const unsentLiked = (userId) =>
    db
      .prepare(
        `SELECT d.role_id FROM dev_swipes d WHERE d.dev_id = ? AND d.liked = 1 AND d.created_at > datetime('now', '-14 days')
           AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.dev_id = d.dev_id AND a.role_id = d.role_id)`,
      )
      .all(userId)
      .map((r) => r.role_id);

  /** Swiping right is the go-ahead: queues applications for these roles once the developer is ready. */
  function sendLiked(userId, roleIds) {
    const p = applier.profileFor(userId);
    if (!roleIds.length || applyReadiness(p).length) return [];
    const sent = [];
    for (const id of roleIds) {
      const role = db
        .prepare(`SELECT r.id, s.name FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = @id AND ${LIVE}`)
        .get({ id, max: MAX_HEADCOUNT });
      const already = db.prepare('SELECT 1 FROM applications WHERE dev_id = ? AND role_id = ?').get(userId, id);
      if (role && !already) {
        applier.enqueue(userId, id);
        sent.push(role.name);
      }
    }
    return sent;
  }

  /** Guests who never added an email: dropped after 30 days without a visit. */
  app.locals.cleanupGuests = () => {
    const old = db
      .prepare("SELECT u.id, p.resume_file FROM users u LEFT JOIN dev_profiles p ON p.user_id = u.id WHERE u.is_guest = 1 AND COALESCE(u.last_seen_at, u.created_at) < datetime('now', '-30 days')")
      .all();
    for (const g of old) {
      applier.removeFilesFor(g.id, g.resume_file);
      db.prepare('DELETE FROM users WHERE id = ?').run(g.id);
    }
    return old.length;
  };

  app.delete('/api/me', requireUser, (req, res) => {
    applier.removeFilesFor(req.user.id, db.prepare('SELECT resume_file FROM dev_profiles WHERE user_id = ?').get(req.user.id)?.resume_file);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
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
      auto_apply: 1,
      form_salary: str(b.form_salary, 80),
      form_notice: str(b.form_notice, 60),
      form_relocate: oneOf(b.form_relocate, ['yes', 'no'], ''),
      form_onsite: oneOf(b.form_onsite, ['yes', 'no'], ''),
      review_first: b.review_first ? 1 : 0,
      saved_answers: JSON.stringify(
        (Array.isArray(b.saved_answers) ? b.saved_answers : [])
          .map((a) => ({ question: str(a?.question, 300), answer: str(a?.answer, 2000) }))
          .filter((a) => a.question && a.answer)
          .slice(0, 100),
      ),
    };
    db.prepare(
      `INSERT INTO dev_profiles (user_id, name, headline, location, work_pref, years, skills, bio, experience, links, salary_min, visible,
         phone, work_authorized, needs_sponsorship, auto_apply, saved_answers, form_salary, form_notice, form_relocate, form_onsite, review_first)
       VALUES (@user_id, @name, @headline, @location, @work_pref, @years, @skills, @bio, @experience, @links, @salary_min, @visible,
         @phone, @work_authorized, @needs_sponsorship, @auto_apply, @saved_answers, @form_salary, @form_notice, @form_relocate, @form_onsite, @review_first)
       ON CONFLICT (user_id) DO UPDATE SET name=@name, headline=@headline, location=@location, work_pref=@work_pref, years=@years,
         skills=@skills, bio=@bio, experience=@experience, links=@links, salary_min=@salary_min, visible=@visible,
         phone=@phone, work_authorized=@work_authorized, needs_sponsorship=@needs_sponsorship, auto_apply=@auto_apply,
         saved_answers=@saved_answers, form_salary=@form_salary, form_notice=@form_notice, form_relocate=@form_relocate,
         form_onsite=@form_onsite, review_first=@review_first, updated_at=datetime('now')`,
    ).run({ user_id: req.user.id, ...p });
    const saved = getProfile(req.user.id);
    // Right swipes that were waiting on missing details go out now that they're filled in.
    const sent = req.user.isGuest ? [] : sendLiked(req.user.id, unsentLiked(req.user.id));
    res.json({ ...saved, complete: profileComplete(saved), applyMissing: applyReadiness(applier.profileFor(req.user.id)), sent });
  });

  // ---------- resume file ----------
  // Upload works before the profile is saved (setup can start from a resume); the deck stays
  // locked until name, headline and skills are saved.
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
    const raw = str(req.body?.name, 120).replace(/[^\w .()-]/g, '').replace(/(\.pdf)+$/i, '').trim();
    const name = `${raw || 'Resume'}.pdf`;
    db.prepare('UPDATE dev_profiles SET resume_file = ?, resume_name = ? WHERE user_id = ?').run(file, name, req.user.id);
    if (!req.body?.parse) return res.json({ resume_name: name });
    const parsed = await parseResume(buf, { log, hints: { fileName: req.body?.name, email: req.user.email } });
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

  // ---------- the deck: open engineering roles at startups with 50 or fewer people ----------
  // A role is in the deck if its company is listed (not hidden or removed) and it has an application page.
  const LIVE = "r.status = 'open' AND r.apply_url IS NOT NULL AND s.status IN ('listed', 'approved') AND s.headcount <= @max";

  // Only roles HireMe can submit by itself with one swipe: startups that take applications by email,
  // plus form systems an admin has switched on (most guard their forms against automated submission).
  const FORM_SYSTEMS = ['ashby', 'greenhouse', 'lever', 'other'];
  const formSystems = () => {
    const v = parse(db.prepare("SELECT value FROM settings WHERE key = 'form_ats'").get()?.value, []);
    return Array.isArray(v) ? v.filter((x) => FORM_SYSTEMS.includes(x)) : [];
  };
  const systemOf = "COALESCE(NULLIF(s.ats, 'none'), 'other')";
  const SENDABLE = () => {
    const on = formSystems();
    return `(r.apply_email IS NOT NULL${on.length ? ` OR ${systemOf} IN (${on.map((x) => `'${x}'`).join(', ')})` : ''})`;
  };

  app.get('/api/deck', requireRole('dev'), (req, res) => {
    const me = getProfile(req.user.id);
    if (!profileComplete(me)) return res.status(409).json({ error: 'Finish your profile first', needsProfile: true });
    const mine = new Set(skillList(me.skills));
    const rows = db
      .prepare(
        `SELECT r.*, s.name AS s_name, s.website AS s_website, s.domain AS s_domain, s.headcount AS s_headcount, s.stage AS s_stage,
                s.one_liner AS s_one_liner, s.about AS s_about, s.location AS s_location
         FROM roles r JOIN startups s ON s.id = r.startup_id
         WHERE ${LIVE} AND ${SENDABLE()}
           AND NOT EXISTS (SELECT 1 FROM dev_swipes d WHERE d.role_id = r.id AND d.dev_id = @me)
           AND NOT EXISTS (SELECT 1 FROM reports x WHERE x.reporter_id = @me AND x.target_type = 'startup' AND x.target_id = s.id)
         ORDER BY COALESCE(r.posted_at, r.created_at) DESC LIMIT 2000`,
      )
      .all({ me: req.user.id, max: MAX_HEADCOUNT });
    const scored = rows.map((r) => {
      const overlap = skillList(r.skills).filter((k) => mine.has(k));
      const modeFit = me.work_pref === 'any' || me.work_pref === r.work_mode ? 1 : 0;
      const underpays = me.salary_min && r.salary_max && r.salary_max < me.salary_min ? 1 : 0;
      return { r, overlap, score: overlap.length * 3 + modeFit * 2 - underpays * 6 };
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
        posted_at: r.posted_at,
        apply_url: r.apply_url,
        sharedSkills: overlap,
        startup: { id: r.startup_id, name: r.s_name, website: r.s_website, domain: r.s_domain, headcount: r.s_headcount, stage: r.s_stage, one_liner: r.s_one_liner, about: r.s_about, location: r.s_location },
      })),
    );
  });

  /** Swipe right: HireMe applies (or asks for what it still needs). Swipe left: skip. */
  app.post('/api/deck/:roleId', requireRole('dev'), (req, res) => {
    const roleId = int(req.params.roleId);
    const role = db.prepare(`SELECT r.id, r.apply_url FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = @id AND ${LIVE}`).get({ id: roleId, max: MAX_HEADCOUNT });
    if (!role) return res.status(404).json({ error: 'That role isn’t open anymore' });
    const liked = req.body?.liked ? 1 : 0;
    db.prepare(
      `INSERT INTO dev_swipes (dev_id, role_id, liked) VALUES (?, ?, ?)
       ON CONFLICT (dev_id, role_id) DO UPDATE SET liked = excluded.liked, created_at = datetime('now')`,
    ).run(req.user.id, roleId, liked);
    // Swiping right applies. If HireMe can't yet (email not confirmed, or a detail missing), the swipe
    // is kept and goes out as soon as it can (claimGuest, PUT /api/profile) — nothing to fill in here.
    const out = { apply_url: role.apply_url, application: null, waiting: null };
    if (liked && req.user.isGuest) out.waiting = 'email';
    else if (liked) {
      const missing = applyReadiness(applier.profileFor(req.user.id));
      if (!missing.length) out.application = publicApplication(applier.enqueue(req.user.id, roleId));
      else out.waiting = 'profile';
    }
    res.json(out);
  });

  /** Undo the last swipe (only before HireMe has started applying). */
  app.delete('/api/deck/:roleId', requireRole('dev'), (req, res) => {
    const roleId = int(req.params.roleId);
    const a = db.prepare("SELECT * FROM applications WHERE dev_id = ? AND role_id = ? AND state != 'canceled'").get(req.user.id, roleId);
    if (a && a.state !== 'queued') return res.status(409).json({ error: 'HireMe already started that application — find it in Applications' });
    if (a) db.prepare("UPDATE applications SET state = 'canceled', updated_at = datetime('now') WHERE id = ?").run(a.id);
    db.prepare('DELETE FROM dev_swipes WHERE dev_id = ? AND role_id = ?').run(req.user.id, roleId);
    res.status(204).end();
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
    if (req.user.isGuest) return res.status(403).json({ error: 'Add your email first, so companies can reply to you', needsAccount: true });
    const roleId = int(req.body?.roleId);
    const role = db.prepare(`SELECT r.id FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = @id AND ${LIVE}`).get({ id: roleId, max: MAX_HEADCOUNT });
    if (!role) return res.status(404).json({ error: 'That role isn’t open anymore' });
    const p = applier.profileFor(req.user.id);
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

  const normQ = (q) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const givenAnswers = (body) =>
    (Array.isArray(body?.answers) ? body.answers : [])
      .map((x) => ({ question: str(x?.question, 300), answer: str(x?.answer, 2000) }))
      .filter((x) => x.question && x.answer);

  /**
   * Saves answers for reuse on every form that asks the same question. Answers that are really profile
   * facts (LinkedIn, GitHub, website, phone) go into the profile too, so differently worded questions get them.
   */
  function saveAnswers(userId, given) {
    const p = db.prepare('SELECT saved_answers, links, phone FROM dev_profiles WHERE user_id = ?').get(userId);
    if (!p) return;
    const saved = parse(p.saved_answers, []).filter((s) => !given.some((g) => normQ(g.question) === normQ(s.question)));
    const links = parse(p.links, {});
    let phone = p.phone;
    for (const g of given) {
      const q = g.question.toLowerCase();
      if (/linkedin/.test(q) && !links.linkedin) links.linkedin = cleanUrl(g.answer);
      else if (/github/.test(q) && !links.github) links.github = cleanUrl(g.answer);
      else if (/portfolio|website|personal site/.test(q) && !links.portfolio) links.portfolio = cleanUrl(g.answer);
      else if (/phone|mobile/.test(q) && !phone) phone = g.answer;
    }
    db.prepare('UPDATE dev_profiles SET saved_answers = ?, links = ?, phone = ? WHERE user_id = ?').run(JSON.stringify([...given, ...saved].slice(0, 100)), JSON.stringify(links), phone, userId);
  }

  /** Applications waiting on questions that now all have saved answers go back in the queue. */
  function requeueAnswered(userId) {
    const saved = new Set(parse(db.prepare('SELECT saved_answers FROM dev_profiles WHERE user_id = ?').get(userId)?.saved_answers, []).map((a) => normQ(a.question)));
    const waiting = db.prepare("SELECT * FROM applications WHERE dev_id = ? AND state = 'needs_you'").all(userId);
    let n = 0;
    for (const a of waiting) {
      const missing = parse(a.missing, []);
      if (missing.length && missing.every((q) => saved.has(normQ(q)))) {
        applier.enqueue(userId, a.role_id);
        n++;
      }
    }
    return n;
  }

  /** The developer answers the questions HireMe couldn't, then it tries again. Answers are saved for next time. */
  app.post('/api/applications/:id/answers', requireRole('dev'), (req, res) => {
    const a = ownApplication(req, res);
    if (!a) return;
    const given = givenAnswers(req.body);
    if (!given.length) return res.status(400).json({ error: 'Answer the questions first' });
    saveAnswers(req.user.id, given);
    const app1 = publicApplication(applier.enqueue(req.user.id, a.role_id));
    requeueAnswered(req.user.id); // others waiting on the same questions go too
    res.json(app1);
  });

  /** Answer each waiting question once; every application that was waiting on them goes back in the queue. */
  app.post('/api/applications/answers', requireRole('dev'), (req, res) => {
    const given = givenAnswers(req.body);
    if (!given.length) return res.status(400).json({ error: 'Answer the questions first' });
    saveAnswers(req.user.id, given);
    res.json({ requeued: requeueAnswered(req.user.id) });
  });

  /** "Review before sending": the developer checked it (and maybe edited answers); send it for real. */
  app.post('/api/applications/:id/send', requireRole('dev'), (req, res) => {
    const a = ownApplication(req, res);
    if (!a) return;
    if (a.state !== 'review') return res.status(409).json({ error: 'That application isn’t waiting for review' });
    const given = givenAnswers(req.body);
    if (given.length) saveAnswers(req.user.id, given); // edits are used word for word when it's filled again
    db.prepare('UPDATE applications SET approved = 1 WHERE id = ?').run(a.id);
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
    if (!['queued', 'needs_you', 'failed', 'review'].includes(a.state)) return res.status(409).json({ error: 'That application was already sent' });
    db.prepare("UPDATE applications SET state = 'canceled', updated_at = datetime('now') WHERE id = ?").run(a.id);
    res.status(204).end();
  });

  // Roles a developer swiped right on that HireMe hasn't applied to yet (setup wasn't finished).
  app.get('/api/saved', requireRole('dev'), (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT r.id, r.title, r.apply_url, r.status, d.created_at AS liked_at, s.name AS startup_name, s.domain, s.headcount
           FROM dev_swipes d JOIN roles r ON r.id = d.role_id JOIN startups s ON s.id = r.startup_id
           WHERE d.dev_id = ? AND d.liked = 1
             AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.dev_id = d.dev_id AND a.role_id = d.role_id AND a.state != 'canceled')
           ORDER BY d.created_at DESC LIMIT 200`,
        )
        .all(req.user.id),
    );
  });

  // ---------- reports ----------
  app.post('/api/reports', requireUser, (req, res) => {
    const reason = oneOf(req.body?.reason, REPORT_REASONS, '');
    const targetId = int(req.body?.id);
    if (!reason || !targetId) return res.status(400).json({ error: 'Pick why you’re reporting this company' });
    const s = db.prepare('SELECT * FROM startups WHERE id = ?').get(targetId);
    if (!s) return res.status(404).json({ error: 'Not found' });
    db.prepare(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, detail) VALUES (?, 'startup', ?, ?, ?)
       ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, resolved = 0`,
    ).run(req.user.id, targetId, reason, str(req.body?.detail, 1000));

    // Enough people saying "recruiter" or "too big" hides the company until an admin looks.
    let hidden = false;
    if (['approved', 'listed'].includes(s.status)) {
      const n = db.prepare("SELECT COUNT(DISTINCT reporter_id) n FROM reports WHERE target_type = 'startup' AND target_id = ? AND resolved = 0 AND reason IN ('recruiter','too_big')").get(targetId).n;
      if (n >= HIDE_AFTER_REPORTS) {
        db.prepare("UPDATE startups SET status = 'pending', flags = trim(flags || '; Hidden after reports', '; ') WHERE id = ?").run(targetId);
        hidden = true;
      }
    }
    for (const to of adminEmails.filter(Boolean))
      notify(to.trim(), `Report: ${s.name} (${reason})${hidden ? ' — now hidden' : ''}`, `${req.user.email} reported “${s.name}” for ${reason}.\n${str(req.body?.detail, 1000)}\n\n${link(req, 'admin')}`);
    res.status(201).json({ ok: true });
  });

  // ---------- admin ----------
  app.get('/api/admin/queue', requireAdmin, (_req, res) => {
    const reports = db
      .prepare(
        `SELECT x.*, u.email AS reporter, s.name AS target_name, s.domain, s.website, s.status AS target_status
         FROM reports x LEFT JOIN users u ON u.id = x.reporter_id JOIN startups s ON s.id = x.target_id
         WHERE x.resolved = 0 AND x.target_type = 'startup' ORDER BY x.created_at DESC`,
      )
      .all();
    // Hidden after reports ('pending') or removed by an admin ('rejected').
    const hidden = db.prepare("SELECT id, name, domain, website, status, flags, headcount FROM startups WHERE status IN ('pending', 'rejected') ORDER BY status, name LIMIT 300").all();
    const stats = {
      devs: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'dev' AND is_guest = 0").get().n,
      guests: db.prepare('SELECT COUNT(*) n FROM users WHERE is_guest = 1').get().n,
      openRoles: db.prepare(`SELECT COUNT(*) n FROM roles r JOIN startups s ON s.id = r.startup_id WHERE ${LIVE} AND ${SENDABLE()}`).get({ max: MAX_HEADCOUNT }).n,
      listed: db.prepare("SELECT COUNT(*) n FROM startups WHERE status IN ('listed', 'approved')").get().n,
      submitted: db.prepare("SELECT COUNT(*) n FROM applications WHERE state = 'submitted'").get().n,
    };
    res.json({ reports, hidden, stats });
  });

  /** Hide a company ('rejected': the importer leaves it alone) or put it back ('listed'). */
  app.post('/api/admin/startups/:id', requireAdmin, (req, res) => {
    const s = db.prepare('SELECT * FROM startups WHERE id = ?').get(int(req.params.id));
    if (!s) return res.status(404).json({ error: 'Company not found' });
    const status = oneOf(req.body?.status, ['listed', 'rejected'], '');
    if (!status) return res.status(400).json({ error: 'Pick show or remove' });
    db.prepare("UPDATE startups SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?").run(status, str(req.body?.note, 500), s.id);
    db.prepare("UPDATE reports SET resolved = 1 WHERE target_type = 'startup' AND target_id = ?").run(s.id);
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

  /** How each way of applying is doing, and which form systems are in the deck. */
  app.get('/api/admin/apply-methods', requireAdmin, (_req, res) => {
    const on = formSystems();
    const methods = [
      { id: 'email', label: 'Email (Hacker News “Who is hiring?”)', always: true },
      ...FORM_SYSTEMS.map((id) => ({ id, label: id === 'other' ? 'Other forms' : id[0].toUpperCase() + id.slice(1), enabled: on.includes(id) })),
    ];
    for (const m of methods) {
      const where = m.id === 'email' ? 'r.apply_email IS NOT NULL' : `r.apply_email IS NULL AND ${systemOf} = '${m.id}'`;
      m.openRoles = db.prepare(`SELECT COUNT(*) n FROM roles r JOIN startups s ON s.id = r.startup_id WHERE ${LIVE} AND ${where}`).get({ max: MAX_HEADCOUNT }).n;
      const a = db
        .prepare(
          `SELECT COUNT(*) tried, SUM(a.state = 'submitted') sent, SUM(a.state IN ('needs_you', 'failed')) stuck
           FROM applications a JOIN roles r ON r.id = a.role_id JOIN startups s ON s.id = r.startup_id
           WHERE ${where} AND a.state IN ('submitted', 'needs_you', 'failed')`,
        )
        .get();
      Object.assign(m, { tried: a.tried, sent: a.sent || 0, stuck: a.stuck || 0 });
    }
    res.json(methods);
  });

  app.post('/api/admin/apply-methods', requireAdmin, (req, res) => {
    const on = (Array.isArray(req.body?.enabled) ? req.body.enabled : []).filter((x) => FORM_SYSTEMS.includes(x));
    db.prepare("INSERT INTO settings (key, value) VALUES ('form_ats', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(on));
    res.json({ enabled: on });
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
