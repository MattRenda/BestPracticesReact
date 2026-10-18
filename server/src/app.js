import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, JOB_STATUSES } from './db.js';
import { aiEnabled, generateCoverLetter } from './ai.js';
import { fetchBoard, matchesFilters, parseBoard } from './feed.js';
import { createServices } from './services.js';

const JOB_FIELDS = ['url', 'company', 'title', 'location', 'description', 'status', 'notes', 'cover_letter', 'tailored_resume'];
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

/**
 * @param db      SQLite handle
 * @param opts.fetchImpl  fetch used for job boards (tests pass a fake)
 * @param opts.agent      apply agent (optional) — enables status, resume PDFs, run-now
 * @param opts.token      if set, every /api request must send it (Authorization: Bearer …)
 */
export function createApp(db = openDb(), { fetchImpl = fetch, agent = null, token = process.env.SPROUT_TOKEN } = {}) {
  const app = express();
  const svc = createServices(db);
  app.locals.svc = svc;

  app.use(express.json({ limit: '10mb' }));

  // Optional shared-secret auth, needed when the server is reachable from your phone.
  app.use('/api', (req, res, next) => {
    if (!token || req.path === '/health') return next();
    const sent = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.token;
    if (sent === token) return next();
    res.status(401).json({ error: 'Enter your Sprout access code', auth: true });
  });

  const job404 = (req, res) => {
    const job = svc.getJob(req.params.id);
    if (!job) res.status(404).json({ error: 'Job not found' });
    return job;
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/api/health', (_req, res) => res.json({ ok: true, ai: aiEnabled(), auth: Boolean(token) }));

  // ---- profile & settings ----
  app.get('/api/profile', (_req, res) => res.json(svc.getProfile()));
  app.put('/api/profile', (req, res) => res.json(svc.saveProfile(req.body ?? {})));
  app.get('/api/settings', (_req, res) => res.json(svc.getSettings()));
  app.put('/api/settings', (req, res) => res.json(svc.saveSettings(req.body ?? {})));

  // ---- saved answers ----
  app.get('/api/answers', (_req, res) => res.json(db.prepare('SELECT * FROM answers ORDER BY id DESC').all()));
  app.post('/api/answers', (req, res) => {
    const { question, answer, tags = '' } = req.body ?? {};
    if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'Question and answer are both required' });
    const r = db.prepare('INSERT INTO answers (question, answer, tags) VALUES (?, ?, ?)').run(question.trim(), answer.trim(), tags);
    res.status(201).json(db.prepare('SELECT * FROM answers WHERE id = ?').get(r.lastInsertRowid));
  });
  app.put('/api/answers/:id', (req, res) => {
    const cur = db.prepare('SELECT * FROM answers WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Answer not found' });
    const n = { ...cur, ...req.body };
    db.prepare('UPDATE answers SET question = ?, answer = ?, tags = ? WHERE id = ?').run(n.question, n.answer, n.tags, cur.id);
    res.json(db.prepare('SELECT * FROM answers WHERE id = ?').get(cur.id));
  });
  app.delete('/api/answers/:id', (req, res) => {
    db.prepare('DELETE FROM answers WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });
  app.post('/api/answer', wrap(async (req, res) => {
    const { question, jobUrl, generate = true } = req.body ?? {};
    if (!question?.trim()) return res.status(400).json({ error: 'question is required' });
    res.json(await svc.answer(question, jobUrl, { generate }));
  }));

  // ---- sources & feed ----
  app.get('/api/sources', (_req, res) => res.json(db.prepare('SELECT * FROM sources ORDER BY name, slug').all()));
  app.post('/api/sources', (req, res) => {
    const board = parseBoard(req.body?.url);
    if (!board) return res.status(400).json({ error: 'Use a Greenhouse, Lever or Ashby board link, like jobs.lever.co/company or boards.greenhouse.io/company' });
    db.prepare('INSERT OR IGNORE INTO sources (ats, slug, name) VALUES (?, ?, ?)').run(board.ats, board.slug, req.body?.name || '');
    res.status(201).json(db.prepare('SELECT * FROM sources WHERE ats = ? AND slug = ?').get(board.ats, board.slug));
  });
  app.delete('/api/sources/:id', (req, res) => {
    db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  async function refreshFeed() {
    const settings = svc.getSettings();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO jobs (url, company, title, location, description, posted_at, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'new')",
    );
    const report = [];
    await Promise.all(
      db.prepare('SELECT * FROM sources').all().map(async (src) => {
        const label = `${src.ats}:${src.slug}`;
        try {
          const jobs = await fetchBoard(src, fetchImpl);
          let added = 0;
          for (const j of jobs.filter((j) => matchesFilters(j, settings)))
            added += Number(insert.run(j.url, j.company, j.title, j.location, j.description, j.posted_at, j.source).changes);
          db.prepare("UPDATE sources SET last_fetched_at = datetime('now'), last_error = '' WHERE id = ?").run(src.id);
          report.push({ source: label, found: jobs.length, added });
        } catch (e) {
          db.prepare('UPDATE sources SET last_error = ? WHERE id = ?').run(e.message, src.id);
          report.push({ source: label, error: e.message });
        }
      }),
    );
    return { added: report.reduce((n, r) => n + (r.added || 0), 0), report };
  }
  app.locals.refreshFeed = refreshFeed;
  app.post('/api/feed/refresh', wrap(async (_req, res) => res.json(await refreshFeed())));

  // ---- swipe deck ----
  app.get('/api/deck', (_req, res) => {
    res.json(db.prepare("SELECT * FROM jobs WHERE status = 'new' ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 60").all());
  });

  app.post('/api/jobs/:id/swipe', (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    const dir = req.body?.direction;
    const settings = svc.getSettings();
    if (dir === 'right') {
      const state = settings.askQuestions ? 'questions' : settings.requireApproval ? 'review' : 'pending';
      svc.setJob(job.id, { status: 'queued', apply_state: state, apply_error: '' });
      svc.logEvent(job.id, 'swipe', 'right');
      if (state === 'pending') agent?.kick();
    } else if (dir === 'left') {
      svc.setJob(job.id, { status: 'skipped', apply_state: '' });
      svc.logEvent(job.id, 'swipe', 'left');
    } else if (dir === 'undo') {
      if (job.apply_state === 'running' || job.status === 'applied') return res.status(409).json({ error: 'Already applying — too late to undo' });
      svc.setJob(job.id, { status: 'new', apply_state: '' });
    } else return res.status(400).json({ error: 'direction must be left, right or undo' });
    res.json(svc.getJob(job.id));
  });

  // Gap questions for one job (generated once, then cached on the job).
  app.get('/api/jobs/:id/questions', wrap(async (req, res) => {
    const job = job404(req, res);
    if (job) res.json({ questions: await svc.questionsFor(job), answers: job.context?.answers || {} });
  }));
  // Save answers; `done: true` (or skipping) releases the job to review/apply.
  app.put('/api/jobs/:id/context', (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    let updated = svc.saveContextAnswers(job, req.body?.answers || {});
    if (req.body?.done && updated.apply_state === 'questions') updated = svc.releaseAfterQuestions(updated);
    if (updated.apply_state === 'pending') agent?.kick();
    res.json(updated);
  });

  app.post('/api/jobs/:id/prepare', wrap(async (req, res) => {
    const job = job404(req, res);
    if (job) res.json(await svc.prepare(job, { force: Boolean(req.body?.force) }));
  }));
  app.post('/api/jobs/:id/approve', (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    svc.logEvent(job.id, 'approved');
    res.json(svc.approve(job));
    agent?.kick();
  });
  app.post('/api/jobs/:id/retry', (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    res.json(svc.setJob(job.id, { status: 'queued', apply_state: 'pending', apply_error: '', screenshot: '' }));
    agent?.kick();
  });

  // ---- jobs ----
  app.get('/api/jobs', (req, res) => {
    const { status, apply_state } = req.query;
    const where = [];
    const args = [];
    if (status) {
      where.push('status = ?');
      args.push(status);
    }
    if (apply_state) {
      const states = String(apply_state).split(',');
      where.push(`apply_state IN (${states.map(() => '?').join(',')})`);
      args.push(...states);
    }
    const rows = db
      .prepare(`SELECT id, url, company, title, location, status, apply_state, apply_error, applied_at, posted_at, updated_at, screenshot != '' AS has_screenshot FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`)
      .all(...args);
    res.json(rows);
  });
  app.get('/api/jobs/:id', (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    const events = db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id DESC').all(job.id);
    res.json({ ...job, events });
  });
  app.post('/api/jobs', (req, res) => {
    const b = req.body ?? {};
    if (b.status && !JOB_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
    const existing = b.url && svc.getJobByUrl(b.url);
    if (existing) {
      const patch = {};
      for (const f of JOB_FIELDS) if (b[f]) patch[f] = b[f];
      return res.json(svc.setJob(existing.id, patch));
    }
    const r = db
      .prepare('INSERT INTO jobs (url, company, title, location, description, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.url || null, b.company || '', b.title || '', b.location || '', b.description || '', b.status || 'new', b.notes || '');
    svc.logEvent(r.lastInsertRowid, 'created');
    res.status(201).json(svc.getJob(r.lastInsertRowid));
  });
  app.patch('/api/jobs/:id', (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    const b = req.body ?? {};
    if (b.status && !JOB_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
    const patch = {};
    for (const f of JOB_FIELDS) if (f in b) patch[f] = b[f];
    if (b.status === 'applied' && !job.applied_at) patch.applied_at = new Date().toISOString();
    if (b.status && b.status !== job.status) svc.logEvent(job.id, 'status', `${job.status} → ${b.status}`);
    res.json(svc.setJob(job.id, patch));
  });
  app.delete('/api/jobs/:id', (req, res) => {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });
  app.post('/api/jobs/:id/cover-letter', wrap(async (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    const text = await generateCoverLetter(svc.getProfile(), job, job.context);
    svc.setJob(job.id, { cover_letter: text });
    svc.logEvent(job.id, 'cover_letter', aiEnabled() ? 'ai' : 'template');
    res.json({ cover_letter: text, ai: aiEnabled() });
  }));
  app.get('/api/jobs/:id/screenshot', (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    if (!job.screenshot) return res.status(404).json({ error: 'No screenshot' });
    res.type('jpeg').send(Buffer.from(job.screenshot, 'base64'));
  });
  app.get('/api/jobs/:id/resume.pdf', wrap(async (req, res) => {
    const job = job404(req, res);
    if (!job) return;
    if (!agent) return res.status(503).json({ error: 'The apply agent is off, so resumes can’t be rendered' });
    const pdf = await agent.resumePdf(job, svc.getProfile());
    if (!pdf) return res.status(404).json({ error: 'No resume available — upload one in Profile' });
    res.type(pdf.type).set('content-disposition', `inline; filename="${pdf.name}"`).send(pdf.buffer);
  }));

  // ---- agent ----
  app.get('/api/agent', (_req, res) => res.json(agent ? agent.status() : { enabled: false }));
  app.post('/api/agent/run', (_req, res) => {
    if (!agent) return res.status(503).json({ error: 'The apply agent is off. Start the server without AGENT=off.' });
    agent.kick();
    res.json(agent.status());
  });

  // ---- stats ----
  app.get('/api/stats', (_req, res) => {
    const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all()) byStatus[r.status] = r.n;
    const q = (...states) =>
      db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'queued' AND apply_state IN (${states.map(() => '?').join(',')})`).get(...states).n;
    res.json({
      byStatus,
      appliedThisWeek: db.prepare("SELECT COUNT(*) n FROM jobs WHERE applied_at >= datetime('now', '-7 days')").get().n,
      appliedToday: svc.appliedToday(),
      deck: byStatus.new,
      applying: q('pending', 'running'),
      review: q('review', 'questions', 'practiced'),
      needsYou: q('needs_you', 'failed'),
      ai: aiEnabled(),
      practiceMode: svc.getSettings().practiceMode,
    });
  });

  // ---- the web app (built) ----
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  return app;
}
