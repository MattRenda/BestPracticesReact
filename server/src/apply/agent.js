// The applying agent. When a developer says yes to a role at a startup that isn't on HireMe yet, it opens the
// company's application page in a headless browser, fills it from the developer's profile, attaches their
// resume, submits, and checks the application went through. One application at a time.
//
// It never solves CAPTCHAs and never guesses factual answers (work authorization, sponsorship, salary,
// start date, demographics…). Those come back to the developer as "needs you", and their answers are saved
// so the next form that asks gets them automatically.
import { languageOf, LANGUAGE_NAMES } from '../lang.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverNote, draftAnswer, FACTUAL } from './ai.js';
import { letterHtml, profileResume, resumeHtml } from './resume.js';
import { autoAnswer } from './answers.js';

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
  return {
    salary: String(p?.form_salary || '').trim() || (p?.salary_min ? `$${Number(p.salary_min).toLocaleString('en-US')}` : 'Flexible — happy to discuss'),
    notice,
    startDate: start.toISOString().slice(0, 10),
    // Open by default: a yes keeps doors open, and the developer can switch either to No.
    relocate: ['yes', 'no'].includes(p?.form_relocate) ? p.form_relocate : 'yes',
    onsite: ['yes', 'no'].includes(p?.form_onsite) ? p.form_onsite : 'yes',
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

// Failures from "are you human?" checks. The developer can take these on themselves from Applications.
export const CHECK_BLOCKED = 'Didn’t go through: the site has a bot check (CAPTCHA). Prove you’re human to send it, or apply on their site';
const CHECK_BLOCKED_SUBMIT = 'Didn’t go through: a bot check (CAPTCHA) appeared when submitting. Prove you’re human to send it, or apply on their site';
const CHECK_UNSOLVED = 'Didn’t go through: the “are you human?” check wasn’t finished. You can try again or apply on their site';
/** Applications a person can finish by doing the site's human check themselves. */
export const humanCheckable = (a) => a?.state === 'failed' && /bot check|CAPTCHA|human/i.test(a.error || '');

export function createApplier(
  db,
  {
    dataDir,
    secrets = null,
    atsApi = null,
    env = process.env,
    log = console,
    notify = () => {},
    sendMail = null,
    mailReady = () => !!sendMail,
    appLink = () => '',
    gapMs,
    pollMs = 15_000,
    dailyCap = 30,
    emailDailyCap = Number(env.EMAIL_DAILY_CAP) || 300, // stays under the mail provider's daily limit
    autoStart = true,
  } = {},
) {
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
  /**
   * "Are you human?" checks, done by the developer themselves: HireMe shows them the site's own check (a live
   * picture of just that box, refreshed twice a second) and passes their taps through. Nothing here solves or
   * skips a check; when the developer doesn't finish it, the application fails as before.
   * Resolves true once the check is gone (passed), false on timeout or if they give up.
   */
  async function humanCheck(page, human, { timeoutMs = 4 * 60_000 } = {}) {
    human.status('Prove you’re human: tap the check below, the way you would on their site.');
    const end = Date.now() + timeoutMs;
    let clear = 0;
    while (Date.now() < end && !human.cancelled) {
      const el = await captchaElement(page);
      if (!el) {
        if (++clear >= 2) {
          human.frame(null);
          return true;
        }
      } else {
        clear = 0;
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          const shot = await page.screenshot({ type: 'jpeg', quality: 70, clip: box }).catch(() => null);
          if (shot) human.frame(shot, box.width, box.height);
          for (const t of human.takeTaps()) await page.mouse.click(box.x + t.x * box.width, box.y + t.y * box.height).catch(() => {});
        }
      }
      if (human.doneTapped) {
        human.doneTapped = false;
        if (!(await captchaElement(page))) return true;
      }
      await sleep(500);
    }
    human.frame(null);
    return false;
  }
  /** The visible check on the page: the picture challenge if one is open, else the checkbox. */
  async function captchaElement(page) {
    let best = null;
    for (const f of page.frames()) {
      const u = f.url();
      if (!CAPTCHA_FRAME.test(u) || /[?&]size=invisible/.test(u)) continue;
      const el = await f.frameElement().catch(() => null);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width < 30 || box.height < 30) continue;
      const area = box.width * box.height;
      if (!best || area > best.area) best = { el, area };
    }
    return best?.el ?? null;
  }

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
  async function applyTo({ url, profile, job, practice = false, roleId = null, human = null }) {
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
      // Claude when there's a key, then HireMe's own rules: optimistic, grounded in the resume.
      const options = Array.isArray(payload.options) ? payload.options.map(String).slice(0, 60) : [];
      const drafted = await answerFor(profile, job, payload.question, options, payload.short);
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

      // HireMe applies in English. A posting or form in another language is dropped quietly, for everyone.
      const texts = await page
        .evaluate(() => [document.body?.innerText || '', [...document.querySelectorAll('label, legend')].map((e) => e.innerText).join(' ')])
        .catch(() => ['', '']);
      const pageLang = [languageOf(texts[1]), languageOf(texts[0])].find((l) => l && l !== 'en') || '';
      if (pageLang && pageLang !== 'en') {
        if (roleId) db.prepare('UPDATE roles SET lang = ? WHERE id = ?').run(pageLang, roleId);
        return await done('canceled', `The application is in ${LANGUAGE_NAMES[pageLang] || 'another language'}, so HireMe skipped it`);
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
      if (await hasCaptcha(page)) {
        if (!human) return await done('failed', CHECK_BLOCKED, [], filled);
        if (!(await humanCheck(page, human))) return await done('failed', CHECK_UNSOLVED, [], filled);
      }
      if (practice) return await done('practiced', 'Filled but not submitted (test)', [], filled);

      const submit = await findSubmit(page);
      if (!submit) return await done('failed', 'Didn’t go through: HireMe couldn’t find the Submit button. You can apply on their site', [], filled);
      const startUrl = page.url();
      human?.status('Sending…');
      await submit.click({ timeout: 5000 });
      let checked = false;
      for (let waited = 0; waited < 25_000; waited += 1000) {
        await sleep(1000);
        const u = page.url();
        if ((u !== startUrl && /confirm|thank|success|submitted|complete/i.test(u)) || SUCCESS.test(await pageText(page))) return await done('submitted', '', [], filled);
        if (await hasCaptcha(page, { challengeOnly: true })) {
          // The developer can prove they're human themselves; otherwise it's a quiet failure.
          if (!human || checked) return await done('failed', human ? CHECK_UNSOLVED : CHECK_BLOCKED_SUBMIT, [], filled);
          checked = true;
          if (!(await humanCheck(page, human))) return await done('failed', CHECK_UNSOLVED, [], filled);
          human.status('Sending…');
          // Most sites send the form once the check passes; if it's still on the form, press Submit again.
          await sleep(1500);
          if (page.url() === startUrl && !SUCCESS.test(await pageText(page))) await (await findSubmit(page))?.click({ timeout: 5000 }).catch(() => {});
          waited = 0;
          continue;
        }
        if (waited >= 3000) {
          const errors = await validationErrors(page);
          if (errors.length) return await done('failed', `Didn’t go through: the form didn’t accept it (${errors.slice(0, 3).join('; ')})`, [], filled);
        }
      }
      return await done('failed', 'May not have gone through: the site didn’t show a confirmation, often a hidden bot check. You can apply on their site to be sure', [], filled);
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
    if (r.state === 'needs_you' || r.state === 'review') {
      // Failures stay quiet (listed under Applications); only things the developer can act on get an email.
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

  async function processOne(app, human = null) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(app.role_id);
    const startup = role && db.prepare('SELECT * FROM startups WHERE id = ?').get(role.startup_id);
    const profile = profileFor(app.dev_id);
    if (!role || role.status !== 'open') return { state: 'failed', error: 'This role was taken down' };
    if (!profile) return { state: 'failed', error: 'Profile not found' };
    const job = { company: startup.name, title: role.title, description: role.description, source: role.source };
    if (role.apply_email) return emailApplication({ app, role, startup, profile, job });
    if (atsApi && secrets && startup.ats_api && !startup.ats_api_error && role.source === 'ats' && String(role.external_id).startsWith(`${startup.ats_api}:`))
      return apiApplication({ app, role, startup, profile, job });
    const url = targetUrl(role, startup);
    if (!url) return { state: 'failed', error: 'No application page for this role' };
    // "Review before sending": fill everything, stop short of Submit, and wait for the developer's OK.
    if (profile.review_first && !app.approved) {
      const r = await applyTo({ url, profile, job, practice: true, roleId: role.id });
      return r.state === 'practiced' ? { ...r, state: 'review', error: '' } : r;
    }
    return applyTo({ url, profile, job, roleId: role.id, human });
  }

  /**
   * Startups that take applications by email get one: a cover note, the resume as a PDF and the
   * developer's links, sent "<Name> via HireMe" with the developer as Reply-To and on CC.
   */
  /** The cover note without its own greeting and sign-off; the email adds those once. */
  function noteBody(note) {
    const lines = String(note || '').trim().split('\n');
    if (/^(hi|hello|hey|dear)\b.*[,:!]?\s*$/i.test(lines[0] || '') && lines[0].length < 120) lines.shift();
    const end = lines.findLastIndex((l) => /^(thanks|thank you|best|cheers|regards|best regards|sincerely)\b[^.]{0,20}[,!.]?\s*$/i.test(l.trim()));
    if (end >= 0 && end >= lines.length - 3) lines.splice(end);
    return lines.join('\n').trim();
  }

  /**
   * A form question's answer. Facts (work authorization, sponsorship, salary, location, demographics…) come
   * from HireMe's rules and the developer's profile only. Everything else goes to the language model when one
   * is set up (it sees the resume and the job), with the rules as the fallback.
   */
  async function answerFor(profile, job, question, options = [], short = true) {
    const rules = () => autoAnswer({ question, options, short, profile, defaults: formDefaults(profile), job }) || '';
    if (FACTUAL.test(question)) return rules();
    return (await draftAnswer(env, { ...profile, facts: factsFor(profile) }, profile.email, job, question, short, options)) || rules();
  }

  /** Straight into the startup's applicant system, through its official API (the startup connected it). */
  async function apiApplication({ app, role, startup, profile, job }) {
    const note = await coverNote(env, profile, profile.email, job);
    const answer = async (question, options, short) => savedAnswer(profile, question) || (await answerFor(profile, job, question, options, short));
    if (profile.review_first && !app.approved)
      return { state: 'review', coverNote: note, answers: [{ question: `Goes to ${startup.name} through`, answer: startup.ats_api, source: 'api' }] };
    const r = await atsApi.submit({
      system: startup.ats_api,
      key: secrets.open(startup.ats_api_key),
      board: startup.ats_api_board,
      externalId: role.external_id,
      profile,
      resume: await resumeFor(profile),
      note,
      answer,
    });
    if (r.keyRejected) {
      // Stop using a key the startup revoked; the roles fall back to their normal treatment.
      db.prepare('UPDATE startups SET ats_api_error = ? WHERE id = ?').run('The API key stopped working. Connect it again.', startup.id);
    }
    return { ...r, coverNote: note };
  }

  async function emailApplication({ app, role, startup, profile, job }) {
    if (!sendMail || !mailReady()) return { state: 'needs_you', error: 'Email isn’t set up on HireMe yet, so this one wasn’t sent. Apply by email yourself: ' + role.apply_email };
    const sentToday = db
      .prepare(
        `SELECT COUNT(*) n FROM applications a JOIN roles r ON r.id = a.role_id
         WHERE r.apply_email IS NOT NULL AND a.state = 'submitted' AND a.submitted_at > datetime('now', '-1 day')`,
      )
      .get().n;
    if (sentToday >= emailDailyCap) return { state: 'queued', error: '', retryLater: true };
    const note = await coverNote(env, profile, profile.email, job);
    const answers = [{ question: 'Sent by email to', answer: role.apply_email, source: 'email' }];
    if (profile.review_first && !app.approved) return { state: 'review', coverNote: note, answers };
    const resume = await resumeFor(profile);
    const links = [['LinkedIn', profile.links?.linkedin], ['GitHub', profile.links?.github], ['Portfolio', profile.links?.portfolio]].filter(([, u]) => u);
    const text = [
      `Hi ${startup.name} team,`,
      '',
      noteBody(note),
      '',
      role.source === 'hn' ? `I saw the ${role.title} role in the Hacker News “Who is hiring?” thread. My resume is attached.` : `I saw the ${role.title} role on HireMe. My resume is attached.`,
      '',
      'Thanks,',
      profile.name,
      [profile.headline, [profile.location, profile.phone, profile.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
      ...links.map(([k, u]) => `${k}: ${u}`),
    ]
      .filter((l) => l !== undefined && l !== null)
      .join('\n');
    await sendMail({
      to: role.apply_email,
      cc: profile.email,
      replyTo: profile.email,
      fromName: `${profile.name} via HireMe`,
      subject: `Application: ${role.title} — ${profile.name}`,
      text,
      attachments: [{ filename: resume.name, content: Buffer.from(resume.buffer), contentType: 'application/pdf' }],
    });
    return { state: 'submitted', coverNote: note, answers };
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
        if (result.retryLater) {
          // Daily email limit reached: put it back and stop until the next poll.
          db.prepare("UPDATE applications SET state = 'queued' WHERE id = ?").run(app.id);
          state.current = null;
          break;
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
    /**
     * Runs one blocked application now, with the developer watching so they can do the site's human check.
     * `human` is a live session (see app.js). Records and returns the result like the queue does.
     */
    async liveApply(appId, human) {
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId);
      if (!app) return { state: 'failed', error: 'Not found' };
      db.prepare("UPDATE applications SET state = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(app.id);
      human.status('Filling in the application…');
      let result;
      try {
        result = await processOne(app, human);
      } catch (e) {
        result = { state: 'failed', error: String(e.message || e).split('\n')[0].slice(0, 200) };
      } finally {
        releaseBrowserSoon();
      }
      record(app, result);
      log.info?.(`[apply] #${app.id} (with the developer): ${result.state}${result.error ? ` (${result.error})` : ''}`);
      return result;
    },
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
