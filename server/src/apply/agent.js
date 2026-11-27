// The applying agent. When a developer says yes to a role at a startup that isn't on HireMe yet, it opens the
// company's application page in a headless browser, fills it from the developer's profile, attaches their
// resume, submits, and checks the application went through. One application at a time.
//
// It never solves CAPTCHAs and never guesses factual answers (work authorization, sponsorship, salary,
// start date, demographics…). Those come back to the developer as "needs you", and their answers are saved
// so the next form that asks gets them automatically.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverNote, draftAnswer } from './ai.js';
import { letterHtml, profileResume, resumeHtml } from './resume.js';

const FILLER = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'filler.js'), 'utf8');
const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose|self)|choose not/i;
const SUCCESS = /thank(s| you) for (applying|your (application|interest))|application (was |has been )?(received|submitted|sent)|we('ve| have) received your application|successfully (submitted|applied)|your application is complete/i;
const CAPTCHA_FRAME = /recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (q) =>
  String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const parse = (s, f) => {
  try {
    return JSON.parse(s) ?? f;
  } catch {
    return f;
  }
};

/** What a developer still needs before HireMe can apply for them. */
export function applyReadiness(p) {
  const missing = [];
  if (!p?.name || !p.name.trim().includes(' ')) missing.push('name');
  if (!p?.phone) missing.push('phone');
  if (!['yes', 'no'].includes(p?.work_authorized)) missing.push('work_authorized');
  if (!['yes', 'no'].includes(p?.needs_sponsorship)) missing.push('needs_sponsorship');
  // No resume uploaded is fine: HireMe builds one from the profile (see resumeFor).
  return missing;
}

/**
 * What HireMe answers on common form questions it can't read off the profile. The developer sees and
 * can change every one of these on their profile; these are only the starting points.
 */
export function formDefaults(p, now = new Date()) {
  const notice = String(p?.form_notice || '').trim() || '2 weeks';
  const weeks = Number(notice.match(/(\d+)\s*week/i)?.[1] ?? (/immediate|now|asap/i.test(notice) ? 0 : 2));
  const start = new Date(now.getTime() + weeks * 7 * 86_400_000);
  const remote = p?.work_pref === 'remote';
  return {
    salary: String(p?.form_salary || '').trim() || (p?.salary_min ? `$${Number(p.salary_min).toLocaleString('en-US')}` : 'Flexible — happy to discuss'),
    notice,
    startDate: start.toISOString().slice(0, 10),
    relocate: ['yes', 'no'].includes(p?.form_relocate) ? p.form_relocate : remote ? 'no' : 'yes',
    onsite: ['yes', 'no'].includes(p?.form_onsite) ? p.form_onsite : remote ? 'no' : 'yes',
  };
}

/** The developer's facts, for Claude to answer factual questions from (and nothing else). */
function factsFor(p) {
  const d = formDefaults(p);
  const yn = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : 'unknown');
  return [
    `Based in: ${p.location || 'unknown'}`,
    `Prefers to work: ${p.work_pref || 'any'}`,
    `Authorized to work in the US: ${yn(p.work_authorized)}`,
    `Needs visa sponsorship: ${yn(p.needs_sponsorship)}`,
    `Willing to relocate: ${yn(d.relocate)}`,
    `Open to working in an office / on-site / hybrid: ${yn(d.onsite)}`,
    `Salary expectation: ${d.salary}`,
    `Notice period / can start: ${d.notice} (around ${d.startDate})`,
    p.years != null ? `Years of professional experience: ${p.years}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function launchBrowser(env) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    ({ chromium } = await import('playwright-core'));
  }
  const opts = { headless: true, args: ['--disable-dev-shm-usage'] };
  if (env.CHROME_PATH) return chromium.launch({ ...opts, executablePath: env.CHROME_PATH });
  return chromium.launch(opts);
}

export function createApplier(db, { dataDir, env = process.env, log = console, notify = () => {}, appLink = () => '', gapMs, pollMs = 15_000, dailyCap = 30, autoStart = true } = {}) {
  const resumesDir = path.join(dataDir, 'resumes');
  const shotsDir = path.join(dataDir, 'shots');
  mkdirSync(resumesDir, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });

  let browser = null;
  let idleTimer = null;
  let busy = false;
  let stopped = false;
  const state = { running: false, current: null, last: null };
  const lastEmailed = new Map();

  // ---------- profile ----------

  function profileFor(devId) {
    const row = db.prepare('SELECT p.*, u.email FROM dev_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?').get(devId);
    if (!row) return null;
    return { ...row, links: parse(row.links, {}), saved_answers: parse(row.saved_answers, []) };
  }

  /** The shape the in-page filler expects. */
  function fillerProfile(p) {
    const [firstName, ...rest] = String(p.name || '').trim().split(/\s+/);
    const [city, st] = String(p.location || '').split(',').map((s) => s.trim());
    const firstJob = String(p.experience || '').split('\n').find((l) => l.trim());
    const jm = firstJob?.match(/^(.+?)\s+[—–-]\s+(.+?)(?:\s*\(|$)/);
    const yn = (v) => (v === 'yes' || v === 'no' ? v : '');
    const d = formDefaults(p);
    return {
      firstName,
      lastName: rest.join(' '),
      email: p.email,
      phone: p.phone || '',
      linkedin: p.links.linkedin || '',
      github: p.links.github || '',
      portfolio: p.links.portfolio || p.links.github || '',
      location: p.location || '',
      city: city || '',
      state: st || '',
      country: 'United States',
      currentTitle: jm?.[1] || '',
      currentCompany: jm?.[2] || '',
      yearsExperience: p.years != null ? String(p.years) : '',
      salaryExpectation: d.salary,
      noticePeriod: d.notice,
      startDate: d.startDate,
      willingToRelocate: d.relocate,
      openToOnsite: d.onsite,
      workAuthorized: yn(p.work_authorized),
      requireSponsorship: yn(p.needs_sponsorship),
      referralSource: 'Job board',
    };
  }

  function savedAnswer(p, question) {
    const n = norm(question);
    return p.saved_answers.find((a) => norm(a.question) === n)?.answer || '';
  }

  // ---------- browser ----------

  async function getBrowser() {
    clearTimeout(idleTimer);
    if (!browser || !browser.isConnected()) browser = await launchBrowser(env);
    return browser;
  }
  function releaseBrowserSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => browser?.close().catch(() => {}), 3 * 60_000);
    idleTimer.unref?.();
  }
  async function renderPdf(html) {
    const page = await (await getBrowser()).newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  }
  const fileBase = (p) => String(p.name || 'Applicant').trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '');

  async function resumeFor(p) {
    if (p.resume_file) {
      try {
        return { name: p.resume_name || `${fileBase(p)}_Resume.pdf`, type: 'application/pdf', buffer: readFileSync(path.join(resumesDir, p.resume_file)) };
      } catch {
        /* file missing — fall back to the generated one */
      }
    }
    return { name: `${fileBase(p)}_Resume.pdf`, type: 'application/pdf', buffer: await renderPdf(resumeHtml(profileResume(p, p.email))) };
  }
  const toPayload = (f) => f && { name: f.name, type: f.type, data: Buffer.from(f.buffer).toString('base64') };

  async function shot(page) {
    try {
      return await page.screenshot({ fullPage: true, type: 'jpeg', quality: 55 });
    } catch (e) {
      log.warn?.(`screenshot failed: ${e.message}`);
      return null;
    }
  }
  async function visibleCount(page, selector) {
    let n = 0;
    for (const f of page.frames()) n += await f.locator(selector).filter({ visible: true }).count().catch(() => 0);
    return n;
  }
  /**
   * A CAPTCHA a person would have to solve. Invisible ones (reCAPTCHA v3/Enterprise "size=invisible",
   * which Ashby uses on every form) show a small badge and need nothing from anyone, so they don't count;
   * neither do challenge frames parked off-screen until they're needed.
   */
  async function hasCaptcha(page, { challengeOnly = false } = {}) {
    for (const f of page.frames()) {
      const u = f.url();
      if (!CAPTCHA_FRAME.test(u)) continue;
      if (/[?&]size=invisible/.test(u)) continue;
      if (challengeOnly && !/bframe|captcha/.test(u)) continue;
      const el = await f.frameElement().catch(() => null);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width > 30 && box.height > 30 && box.y > -50 && box.x > -50) return true;
    }
    return false;
  }
  async function pageText(page) {
    let t = '';
    for (const f of page.frames()) t += ' ' + (await f.locator('body').innerText({ timeout: 2000 }).catch(() => ''));
    return t;
  }
  async function validationErrors(page) {
    const msgs = [];
    for (const f of page.frames()) {
      const loc = f.locator('[aria-invalid="true"], .error:not(:empty), [class*="error-message"], [class*="field-error"], [role="alert"]').filter({ visible: true });
      const n = Math.min(await loc.count().catch(() => 0), 5);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        const t = ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
        if (t) msgs.push(t.slice(0, 120));
      }
    }
    return [...new Set(msgs)];
  }
  async function chooseCombo(frame, combo) {
    if (!combo.want) return false;
    const input = frame.locator(`[data-hireme-id="${combo.id}"]`);
    const decline = combo.want === 'decline' || DECLINE.test(combo.want);
    const yesNo = combo.want.match(/^(yes|no)\b/i)?.[1];
    const typed = decline ? '' : yesNo || combo.want.slice(0, 40);
    try {
      await input.click({ timeout: 3000 });
      if (typed) await input.fill(typed);
      await sleep(500);
      const options = frame.locator('[role="option"]').filter({ visible: true });
      const pattern = decline ? DECLINE : new RegExp(yesNo ? `^\\s*${yesNo}\\b` : escRe(typed.slice(0, 25)), 'i');
      const match = options.filter({ hasText: pattern }).first();
      if (await match.count()) {
        await match.click({ timeout: 3000 });
        return true;
      }
      await input.press('Escape').catch(() => {});
    } catch {
      /* fall through */
    }
    return false;
  }
  async function findSubmit(page) {
    const sel = 'button[type="submit"], input[type="submit"], button:has-text("Submit application"), button:has-text("Submit Application"), button:has-text("Submit")';
    for (const f of page.frames()) {
      const loc = f.locator(sel).filter({ visible: true });
      if (await loc.count().catch(() => 0)) return loc.last();
    }
    return null;
  }

  /**
   * Fills (and unless practicing, submits) one application.
   * @returns {{state:'submitted'|'needs_you'|'failed'|'practiced', error, missing:string[], answers:object[], fieldsFilled, screenshot:Buffer|null}}
   */
  async function applyTo({ url, profile, job, practice = false }) {
    const answers = [];
    const resume = await resumeFor(profile);
    const note = await coverNote(env, profile, profile.email, job);
    const letter = { name: `${fileBase(profile)}_Cover_Letter.pdf`, type: 'application/pdf', buffer: await renderPdf(letterHtml(note)) };
    const fp = { ...fillerProfile(profile), resumeFile: toPayload(resume), coverLetterFile: toPayload(letter) };

    const context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await context.exposeFunction('__hiremeSend', async (type, payload) => {
      if (type !== 'answer') return { ok: false };
      const saved = savedAnswer(profile, payload.question);
      if (saved) {
        answers.push({ question: payload.question, answer: saved, source: 'saved' });
        return { ok: true, data: { answer: saved } };
      }
      const drafted = await draftAnswer(env, { ...profile, facts: factsFor(profile) }, profile.email, job, payload.question, payload.short);
      if (drafted) answers.push({ question: payload.question, answer: drafted, source: 'drafted' });
      return { ok: true, data: { answer: drafted } };
    });
    const page = await context.newPage();
    const done = async (state, error = '', missing = [], fieldsFilled = 0) => ({ state, error, missing, answers, fieldsFilled, coverNote: note, screenshot: await shot(page) });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

      if ((await visibleCount(page, 'input:not([type=hidden]), textarea')) < 3) {
        const name = /^\s*(apply|apply now|apply for this (job|position|role)|i'?m interested)\s*$/i;
        const apply = page.getByRole('link', { name }).or(page.getByRole('button', { name })).or(page.getByRole('tab', { name: /application/i })).first();
        if (await apply.count()) {
          await apply.click().catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        }
      }

      let filled = 0;
      const missing = [];
      for (const frame of page.frames()) {
        const res = await frame
          .evaluate(FILLER)
          .then(() => frame.evaluate((ctx) => window.__hireme.run(ctx), { profile: fp, coverLetter: note }))
          .catch((e) => (log.warn?.(`fill failed in ${frame.url()}: ${e.message}`), null));
        if (!res) continue;
        filled += res.filled;
        missing.push(...res.missing);
        for (const c of res.combos) {
          if (await chooseCombo(frame, c)) filled++;
          else if (c.required) missing.push(c.question);
        }
      }
      const uniq = [...new Set(missing.map((m) => m.trim()).filter(Boolean))];

      if (!filled) return await done('failed', 'No application form found on the page');
      if (uniq.length) return await done('needs_you', `${uniq.length === 1 ? 'A question' : `${uniq.length} questions`} only you can answer`, uniq, filled);
      if (await hasCaptcha(page)) return await done('needs_you', 'The form has a CAPTCHA, so finish this one on their site', [], filled);
      if (practice) return await done('practiced', 'Filled but not submitted (test)', [], filled);

      const submit = await findSubmit(page);
      if (!submit) return await done('needs_you', 'Couldn’t find the Submit button, so finish this one on their site', [], filled);
      const startUrl = page.url();
      await submit.click({ timeout: 5000 });
      for (let waited = 0; waited < 25_000; waited += 1000) {
        await sleep(1000);
        const u = page.url();
        if ((u !== startUrl && /confirm|thank|success|submitted|complete/i.test(u)) || SUCCESS.test(await pageText(page))) return await done('submitted', '', [], filled);
        if (await hasCaptcha(page, { challengeOnly: true })) return await done('needs_you', 'A CAPTCHA appeared when submitting, so finish this one on their site', [], filled);
        if (waited >= 3000) {
          const errors = await validationErrors(page);
          if (errors.length) return await done('needs_you', `The form didn’t accept it: ${errors.slice(0, 3).join('; ')}`, [], filled);
        }
      }
      return await done('needs_you', 'Sent, but the site didn’t confirm it. Check the screenshot, or apply on their site to be sure', [], filled);
    } finally {
      await context.close().catch(() => {});
    }
  }

  // ---------- queue ----------

  /** Where to actually apply: Greenhouse's hosted form avoids company pages that wrap it in an iframe. */
  function targetUrl(role, startup) {
    if (role.external_id?.startsWith('greenhouse:') && startup.ats === 'greenhouse' && startup.ats_slug)
      return `https://job-boards.greenhouse.io/${startup.ats_slug}/jobs/${role.external_id.split(':')[1]}`;
    return role.apply_url;
  }

  function enqueue(devId, roleId) {
    db.prepare(
      `INSERT INTO applications (dev_id, role_id, state) VALUES (?, ?, 'queued')
       ON CONFLICT (dev_id, role_id) DO UPDATE SET state = 'queued', error = '', missing = '[]', updated_at = datetime('now')
       WHERE applications.state IN ('needs_you', 'failed', 'canceled', 'review')`,
    ).run(devId, roleId);
    kick();
    return db.prepare('SELECT * FROM applications WHERE dev_id = ? AND role_id = ?').get(devId, roleId);
  }

  function claimNext() {
    const app = db
      .prepare(
        `SELECT a.* FROM applications a WHERE a.state = 'queued'
           AND (SELECT COUNT(*) FROM applications b WHERE b.dev_id = a.dev_id AND b.state IN ('submitted', 'running')
                AND b.updated_at > datetime('now', '-1 day')) < ?
         ORDER BY a.updated_at LIMIT 1`,
      )
      .get(dailyCap);
    if (!app) return null;
    const ok = db.prepare("UPDATE applications SET state = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ? AND state = 'queued'").run(app.id).changes;
    return ok ? app : null;
  }

  function record(app, r) {
    let shotName = null;
    if (r.screenshot) {
      shotName = `${app.id}.jpg`;
      writeFileSync(path.join(shotsDir, shotName), r.screenshot);
    }
    db.prepare(
      `UPDATE applications SET state = ?, error = ?, missing = ?, answers = ?, cover_note = ?, screenshot = COALESCE(?, screenshot),
         updated_at = datetime('now'), submitted_at = CASE WHEN ? = 'submitted' THEN datetime('now') ELSE submitted_at END
       WHERE id = ?`,
    ).run(r.state, r.error || '', JSON.stringify(r.missing || []), JSON.stringify(r.answers || []), r.coverNote || '', shotName, r.state, app.id);
    if (r.state === 'needs_you' || r.state === 'failed' || r.state === 'review') {
      const dev = db.prepare('SELECT u.email, u.last_seen_at FROM users u WHERE u.id = ?').get(app.dev_id);
      const away = !dev.last_seen_at || Date.now() - new Date(`${dev.last_seen_at}Z`).getTime() > 10 * 60_000;
      const recent = Date.now() - (lastEmailed.get(app.dev_id) || 0) < 2 * 3600_000;
      if (dev && away && !recent) {
        lastEmailed.set(app.dev_id, Date.now());
        const role = db.prepare('SELECT r.title, s.name FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.id = ?').get(app.role_id);
        if (r.state === 'review')
          notify(dev.email, `Your application to ${role.name} is ready to check`, `HireMe filled out your application for ${role.title} at ${role.name}. Check it and send it:\n\n${appLink('applications')}`);
        else notify(dev.email, `Your application to ${role.name} needs you`, `HireMe started your application for ${role.title} at ${role.name}, but needs a hand: ${r.error}.\n\n${appLink('applications')}`);
      }
    }
  }

  async function processOne(app) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(app.role_id);
    const startup = role && db.prepare('SELECT * FROM startups WHERE id = ?').get(role.startup_id);
    const profile = profileFor(app.dev_id);
    if (!role || role.status !== 'open') return { state: 'failed', error: 'This role was taken down' };
    if (!profile) return { state: 'failed', error: 'Profile not found' };
    const url = targetUrl(role, startup);
    if (!url) return { state: 'failed', error: 'No application page for this role' };
    const job = { company: startup.name, title: role.title, description: role.description };
    // "Review before sending": fill everything, stop short of Submit, and wait for the developer's OK.
    if (profile.review_first && !app.approved) {
      const r = await applyTo({ url, profile, job, practice: true });
      return r.state === 'practiced' ? { ...r, state: 'review', error: '' } : r;
    }
    return applyTo({ url, profile, job });
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    state.running = true;
    try {
      for (;;) {
        const app = claimNext();
        if (!app) break;
        state.current = { id: app.id };
        let result;
        try {
          result = await processOne(app);
        } catch (e) {
          result = { state: 'failed', error: String(e.message || e).split('\n')[0].slice(0, 200) };
        }
        record(app, result);
        state.last = { id: app.id, state: result.state, error: result.error, at: new Date().toISOString() };
        log.info?.(`[apply] #${app.id}: ${result.state}${result.error ? ` (${result.error})` : ''}`);
        state.current = null;
        await sleep(gapMs ?? 5_000 + Math.random() * 10_000);
      }
    } finally {
      busy = false;
      state.running = false;
      state.current = null;
      releaseBrowserSoon();
    }
  }
  function kick() {
    if (autoStart) setTimeout(() => tick().catch((e) => log.error?.(e)), 0);
  }

  // Anything left "running" from a restart goes back in the queue.
  db.prepare("UPDATE applications SET state = 'queued' WHERE state = 'running'").run();
  const interval = autoStart ? setInterval(() => tick().catch((e) => log.error?.(e)), pollMs) : null;
  interval?.unref?.();

  return {
    applyReadiness,
    profileFor,
    enqueue,
    tick,
    applyTo,
    resumesDir,
    shotsDir,
    status: () => ({ ...state }),
    /** Admin check against a real job form with a made-up applicant. Never submits. */
    async testRun(url, job) {
      const profile = {
        name: 'Test Applicant', email: 'test@example.com', phone: '555-010-0000', location: 'Sacramento, CA', headline: 'Software engineer',
        years: 5, skills: 'React, Node.js', bio: '', experience: 'Software Engineer — Example Co (2020 – present)\n• Built web apps',
        links: {}, saved_answers: [], work_authorized: 'yes', needs_sponsorship: 'no',
      };
      try {
        const r = await applyTo({ url, profile, job, practice: true });
        return { ...r, screenshot: r.screenshot ? r.screenshot.toString('base64') : '' };
      } finally {
        releaseBrowserSoon();
      }
    },
    removeFilesFor(devId, resumeFile) {
      if (resumeFile) rmSync(path.join(resumesDir, resumeFile), { force: true });
      for (const a of db.prepare('SELECT screenshot FROM applications WHERE dev_id = ? AND screenshot IS NOT NULL').all(devId))
        rmSync(path.join(shotsDir, a.screenshot), { force: true });
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(idleTimer);
      await browser?.close().catch(() => {});
    },
  };
}
