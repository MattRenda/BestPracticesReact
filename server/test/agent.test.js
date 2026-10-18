// End-to-end: the agent applies to a local Greenhouse-style form in a real headless browser.
// Skips when no browser is installed (set CHROME_PATH or run `npx playwright install chromium`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createServices } from '../src/services.js';
import { createAgent } from '../src/agent/agent.js';

delete process.env.ANTHROPIC_API_KEY;
const here = path.dirname(fileURLToPath(import.meta.url));

let site, base, db, svc, agent, submissions = [], browserOk = true;

before(async () => {
  const app = express();
  app.use(express.json());
  app.get('/job', (_req, res) => res.sendFile(path.join(here, 'fixtures/apply.html')));
  app.get('/recaptcha/api2/anchor', (_req, res) => res.send('<div>I am not a robot</div>'));
  app.post('/submit', (req, res) => (submissions.push(req.body), res.json({ ok: true })));
  app.get('/thanks', (_req, res) => res.send('<h1>Thank you for applying!</h1>'));
  site = app.listen(0);
  await new Promise((r) => site.once('listening', r));
  base = `http://127.0.0.1:${site.address().port}`;

  db = openDb(':memory:');
  svc = createServices(db);
  svc.saveProfile({
    firstName: 'Matt', lastName: 'Renda', email: 'matt@example.com', phone: '916-555-0100',
    linkedin: 'https://linkedin.com/in/matt', workAuthorized: 'yes', requireSponsorship: 'no',
    summary: 'Full-stack developer.', resumeFile: { name: 'resume.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') },
  });
  svc.saveSettings({ practiceMode: false, tailorResume: false });
  agent = createAgent(svc, { gapMs: 0, pollMs: 3_600_000, log: { info() {}, warn() {}, error() {} } });
  try {
    await agent.resumePdf({ tailored_resume: '# Test' }, {});
  } catch {
    browserOk = false;
  }
});
after(async () => {
  await agent?.stop();
  site?.close();
});

async function queueAndRun(query) {
  db.prepare("INSERT INTO jobs (url, company, title, status, apply_state) VALUES (?, 'Acme', 'Senior React Engineer', 'queued', 'pending')").run(`${base}/job${query}`);
  const job = svc.claimNext();
  const result = await agent.applyTo(job);
  svc.recordResult(job, result);
  return { job: svc.getJob(job.id), result };
}

test('agent fills, uploads, picks dropdowns, consents and submits', async (t) => {
  if (!browserOk) return t.skip('no browser available');
  // AI is off in tests, so the open question is answered from saved answers.
  db.prepare("INSERT INTO answers (question, answer) VALUES ('Why do you want to work here?', 'Because Acme builds tools I use daily.')").run();
  const { job, result } = await queueAndRun('');
  assert.equal(result.state, 'done', `${result.state}: ${result.error}`);
  assert.equal(job.status, 'applied');
  const s = submissions.at(-1);
  assert.equal(s.first_name, 'Matt');
  assert.equal(s.last_name, 'Renda');
  assert.equal(s.email, 'matt@example.com');
  assert.equal(s['urls[LinkedIn]'], 'https://linkedin.com/in/matt');
  assert.equal(s.auth, '1');
  assert.equal(s.sponsor, 'no');
  assert.equal(s.gender, "I don't wish to answer");
  assert.equal(s.why, 'Because Acme builds tools I use daily.');
  assert.equal(s.consent, 'on');
  assert.equal(s.resume.name, 'resume.pdf');
  assert.ok(s.resume.size > 0);
  assert.ok(job.cover_letter.includes('Acme'), 'cover letter prepared');
});

test('CAPTCHA goes to needs-you without submitting', async (t) => {
  if (!browserOk) return t.skip('no browser available');
  const before = submissions.length;
  const { job, result } = await queueAndRun('?captcha=1');
  assert.equal(result.state, 'needs_you');
  assert.match(job.apply_error, /CAPTCHA/);
  assert.ok(job.screenshot.length > 1000, 'screenshot saved');
  assert.equal(submissions.length, before);
});

test('unanswerable required question goes to needs-you', async (t) => {
  if (!browserOk) return t.skip('no browser available');
  const { result } = await queueAndRun('?extra=1');
  assert.equal(result.state, 'needs_you');
  assert.match(result.error, /security clearance/i);
});

test('practice mode fills but does not submit', async (t) => {
  if (!browserOk) return t.skip('no browser available');
  svc.saveSettings({ practiceMode: true });
  const before = submissions.length;
  const { job, result } = await queueAndRun('?practice=1');
  assert.equal(result.state, 'practiced');
  assert.equal(job.apply_state, 'practiced');
  assert.equal(submissions.length, before);
  svc.saveSettings({ practiceMode: false });
});

test('tailored resume renders to a real PDF', async (t) => {
  if (!browserOk) return t.skip('no browser available');
  const pdf = await agent.resumePdf({ tailored_resume: '# Matt Renda\nmatt@example.com\n## Experience\n- Built things' }, { firstName: 'Matt', lastName: 'Renda' });
  assert.equal(pdf.name, 'Matt_Renda_Resume.pdf');
  assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
});
