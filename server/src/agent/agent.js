// The apply agent: works through jobs you swiped right on, one at a time, in a
// headless browser. For each job it fills the employer's form, attaches your
// (tailored) resume, submits, and confirms the application went through.
// Anything it can't do honestly — a CAPTCHA, a required question it can't answer,
// a validation error — goes to your "needs you" pile with a screenshot.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { letterHtml, resumeHtml } from './resume.js';

const FILLER = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'filler.js'), 'utf8');
const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose|self)|choose not/i;
const SUCCESS = /thank(s| you) for (applying|your (application|interest))|application (was |has been )?(received|submitted|sent)|we('ve| have) received your application|successfully (submitted|applied)|your application is complete/i;
const CAPTCHA_FRAME = /recaptcha\/api2\/(anchor|bframe)|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function launchBrowser() {
  const { chromium } = await import('playwright');
  const opts = { headless: process.env.AGENT_HEADLESS !== 'false' };
  if (process.env.CHROME_PATH) return chromium.launch({ ...opts, executablePath: process.env.CHROME_PATH });
  try {
    return await chromium.launch(opts);
  } catch {
    try {
      return await chromium.launch({ ...opts, channel: 'chrome' });
    } catch {
      throw new Error('No browser found for the apply agent. In server/, run: npx playwright install chromium — or set CHROME_PATH.');
    }
  }
}

/**
 * @param svc   services from createServices
 * @param opts.gapMs     pause between applications (default 20–60s, randomized)
 * @param opts.pollMs    how often to check the queue (default 60s)
 */
export function createAgent(svc, { gapMs, pollMs = 60_000, log = console } = {}) {
  let browser = null;
  let idleTimer = null;
  let busy = false;
  let stopped = false;
  const state = { enabled: true, running: false, current: null, last: null, note: '' };

  async function getBrowser() {
    clearTimeout(idleTimer);
    if (!browser || !browser.isConnected()) browser = await launchBrowser();
    return browser;
  }
  function releaseBrowserSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => browser?.close().catch(() => {}), 5 * 60_000);
    idleTimer.unref?.();
  }

  async function renderPdf(html) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  }

  const fileBase = (p) => [p.firstName, p.lastName].filter(Boolean).join('_') || 'Applicant';

  /** Tailored resume as PDF if there is one, else your uploaded file. */
  async function resumePdf(job, profile) {
    if (job.tailored_resume) {
      const buffer = await renderPdf(resumeHtml(job.tailored_resume));
      return { name: `${fileBase(profile)}_Resume.pdf`, type: 'application/pdf', buffer };
    }
    if (profile.resumeFile?.data) {
      return { name: profile.resumeFile.name, type: profile.resumeFile.type, buffer: Buffer.from(profile.resumeFile.data, 'base64') };
    }
    return null;
  }

  const toPayload = (f) => f && { name: f.name, type: f.type, data: Buffer.from(f.buffer).toString('base64') };

  async function shot(page) {
    try {
      return (await page.screenshot({ fullPage: true, type: 'jpeg', quality: 55 })).toString('base64');
    } catch {
      return '';
    }
  }

  async function visibleCount(page, selector) {
    let n = 0;
    for (const f of page.frames()) n += await f.locator(selector).filter({ visible: true }).count().catch(() => 0);
    return n;
  }

  async function hasCaptcha(page, { challengeOnly = false } = {}) {
    for (const f of page.frames()) {
      if (!CAPTCHA_FRAME.test(f.url())) continue;
      if (challengeOnly && !/bframe|captcha/.test(f.url())) continue;
      const el = await f.frameElement().catch(() => null);
      const box = el && (await el.boundingBox().catch(() => null));
      if (box && box.width > 30 && box.height > 30) return true;
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

  // Drive a custom dropdown (react-select and similar) with real clicks and typing.
  async function chooseCombo(frame, combo) {
    if (!combo.want) return false;
    const input = frame.locator(`[data-sprout-id="${combo.id}"]`);
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

  /** Apply to one job. Returns { state, error, fieldsFilled, screenshot }. */
  async function applyTo(job) {
    job = await svc.prepare(job);
    const settings = svc.getSettings();
    const profile = svc.getProfile();
    const resume = await resumePdf(job, profile);
    const letter = job.cover_letter ? { name: `${fileBase(profile)}_Cover_Letter.pdf`, type: 'application/pdf', buffer: await renderPdf(letterHtml(job.cover_letter)) } : null;
    const fillProfile = { ...profile, resumeFile: toPayload(resume), coverLetterFile: toPayload(letter) };

    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await context.exposeFunction('__sproutSend', async (type, payload) => {
      try {
        if (type === 'answer') return { ok: true, data: await svc.answer(payload.question, job.url) };
        return { ok: false, error: `unknown message ${type}` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    const page = await context.newPage();
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

      // Some postings show the form only after an Apply click.
      if ((await visibleCount(page, 'input:not([type=hidden]), textarea')) < 3) {
        const apply = page.getByRole('link', { name: /^\s*(apply|apply now|apply for this (job|position)|i'?m interested)\s*$/i })
          .or(page.getByRole('button', { name: /^\s*(apply|apply now|apply for this (job|position)|i'?m interested)\s*$/i }))
          .first();
        if (await apply.count()) {
          await apply.click().catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        }
      }

      let filled = 0;
      const missing = [];
      for (const frame of page.frames()) {
        // Evaluated over the DevTools protocol, so the site's CSP doesn't block it.
        const res = await frame
          .evaluate(FILLER)
          .then(() => frame.evaluate((ctx) => window.__sprout.run(ctx), { profile: fillProfile, coverLetter: job.cover_letter }))
          .catch((e) => (log.warn?.(`fill failed in ${frame.url()}: ${e.message}`), null));
        if (!res) continue;
        filled += res.filled;
        missing.push(...res.missing);
        for (const c of res.combos) {
          if (await chooseCombo(frame, c)) filled++;
          else if (c.required) missing.push(c.question);
        }
      }

      if (!filled) return { state: 'failed', error: 'No application form found on the page', fieldsFilled: 0, screenshot: await shot(page) };
      if (missing.length)
        return { state: 'needs_you', error: `Couldn't answer: ${[...new Set(missing)].slice(0, 4).join('; ')}`, fieldsFilled: filled, screenshot: await shot(page) };
      if (await hasCaptcha(page)) return { state: 'needs_you', error: 'The form has a CAPTCHA — finish this one yourself', fieldsFilled: filled, screenshot: await shot(page) };
      if (settings.practiceMode) return { state: 'practiced', error: 'Practice mode — filled but not submitted', fieldsFilled: filled, screenshot: await shot(page) };

      const submit = await findSubmit(page);
      if (!submit) return { state: 'needs_you', error: 'Couldn’t find the Submit button', fieldsFilled: filled, screenshot: await shot(page) };
      const startUrl = page.url();
      await submit.click({ timeout: 5000 });

      for (let waited = 0; waited < 25_000; waited += 1000) {
        await sleep(1000);
        const url = page.url();
        if ((url !== startUrl && /confirm|thank|success|submitted|complete/i.test(url)) || SUCCESS.test(await pageText(page)))
          return { state: 'done', error: '', fieldsFilled: filled, screenshot: await shot(page) };
        if (await hasCaptcha(page, { challengeOnly: true }))
          return { state: 'needs_you', error: 'A CAPTCHA appeared on submit — finish this one yourself', fieldsFilled: filled, screenshot: await shot(page) };
        if (waited >= 3000) {
          const errors = await validationErrors(page);
          if (errors.length) return { state: 'needs_you', error: `The form rejected it: ${errors.slice(0, 3).join('; ')}`, fieldsFilled: filled, screenshot: await shot(page) };
        }
      }
      return { state: 'needs_you', error: 'Submitted, but no confirmation appeared — check the screenshot', fieldsFilled: filled, screenshot: await shot(page) };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    state.running = true;
    state.note = '';
    try {
      for (;;) {
        const settings = svc.getSettings();
        if (svc.appliedToday() >= settings.dailyLimit) {
          state.note = `Daily limit of ${settings.dailyLimit} reached — resumes tomorrow`;
          break;
        }
        const job = svc.claimNext();
        if (!job) break;
        state.current = { id: job.id, company: job.company, title: job.title };
        let result;
        try {
          result = await applyTo(job);
        } catch (e) {
          result = { state: 'failed', error: e.message.split('\n')[0] };
        }
        svc.recordResult(job, result);
        state.last = { ...state.current, state: result.state, error: result.error, at: new Date().toISOString() };
        log.info?.(`[agent] ${job.company} — ${job.title}: ${result.state}${result.error ? ` (${result.error})` : ''}`);
        state.current = null;
        await sleep(gapMs ?? 20_000 + Math.random() * 40_000);
      }
    } finally {
      busy = false;
      state.running = false;
      state.current = null;
      releaseBrowserSoon();
    }
  }

  const interval = setInterval(() => tick().catch((e) => log.error?.(e)), pollMs);
  interval.unref?.();

  return {
    status: () => ({ ...state }),
    kick: () => setTimeout(() => tick().catch((e) => log.error?.(e)), 0),
    tick,
    applyTo,
    async resumePdf(job, profile) {
      const r = await resumePdf(job, profile);
      releaseBrowserSoon();
      return r;
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(idleTimer);
      await browser?.close().catch(() => {});
    },
  };
}
