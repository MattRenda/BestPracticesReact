// End-to-end: HireMe applies for a developer to a local Greenhouse-style form in a real headless browser.
// Skips when no browser is available (set CHROME_PATH, or run `npx playwright install chromium`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { FACTUAL } from '../src/apply/ai.js';
import { profileResume } from '../src/apply/resume.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { CHROME_PATH: process.env.CHROME_PATH || (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : '') }; // no ANTHROPIC_API_KEY: templates only

let site, siteBase, server, base, app, db, applier;
const submissions = [];
let browserOk = true;

before(async () => {
  const s = express();
  s.use(express.json());
  s.get('/job', (_req, res) => res.sendFile(path.join(here, 'fixtures/apply.html')));
  s.get('/recaptcha/api2/anchor', (_req, res) => res.send('<div>I am not a robot</div>'));
  s.post('/submit', (req, res) => (submissions.push(req.body), res.json({ ok: true })));
  s.get('/thanks', (_req, res) => res.send('<h1>Thank you for applying!</h1>'));
  site = s.listen(0);
  await new Promise((r) => site.once('listening', r));
  siteBase = `http://127.0.0.1:${site.address().port}`;

  db = openDb(':memory:');
  app = createApp(db, {
    mailer: { configured: false, send: async () => {} },
    log: { info() {}, warn() {}, error() {} },
    ipLimit: 1000,
    dataDir: mkdtempSync(path.join(tmpdir(), 'hireme-')),
    applierOptions: { env, autoStart: false, gapMs: 0 },
  });
  applier = app.locals.applier;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;

  // An imported (listed) startup whose application form is the local mock
  const sid = db.prepare("INSERT INTO startups (name, website, domain, headcount, source, status) VALUES ('Acme', 'https://acme.example', 'acme.example', 8, 'yc', 'listed')").run().lastInsertRowid;
  for (const q of ['', '?captcha=1', '?extra=1'])
    db.prepare("INSERT INTO roles (startup_id, source, external_id, title, description, apply_url, skills) VALUES (?, 'ats', ?, 'Senior React Engineer', 'React and Node at Acme.', ?, 'React')").run(sid, `ashby:${q || 'main'}`, `${siteBase}/job${q}`);

  try {
    await applier.testRun(`${siteBase}/thanks`, { company: 'x', title: 'y' });
  } catch {
    browserOk = false;
  }
});
after(async () => {
  await applier?.stop();
  server?.close();
  site?.close();
});

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: res.status === 204 ? null : type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return {
    req,
    async signIn(email) {
      const r = await req('POST', '/auth/start', { email, intent: 'dev' });
      await req('POST', '/auth/verify', { token: r.body.devLink.split('/signin/')[1] });
    },
  };
}

const PROFILE = {
  name: 'Matt Renda', headline: 'Senior full-stack engineer', skills: 'React, Node.js', location: 'Sacramento, CA', years: 10,
  experience: 'Senior Software Engineer — CA DMV (2022 – present)\n• Rebuilt legacy apps in React', links: { linkedin: 'https://linkedin.com/in/matt' },
};
const roleId = (q) => db.prepare('SELECT id FROM roles WHERE external_id = ?').get(`ashby:${q}`).id;

test('helpers: factual questions are never drafted; resume comes from the profile', () => {
  for (const q of ['Are you legally authorized to work in the US?', 'Will you require visa sponsorship?', 'What are your salary expectations?', 'When can you start?', 'Can you work onsite in SF 3 days a week?', 'Gender'])
    assert.ok(FACTUAL.test(q), q);
  for (const q of ['Why do you want to work at Acme?', 'Tell us about a project you are proud of']) assert.ok(!FACTUAL.test(q), q);
  const md = profileResume({ ...PROFILE, phone: '916-555-0100', bio: 'I ship.' }, 'matt@example.com');
  assert.match(md, /^# Matt Renda\nmatt@example.com \| 916-555-0100 \| Sacramento, CA/);
  assert.match(md, /### Senior Software Engineer — CA DMV/);
  assert.match(md, /- Rebuilt legacy apps in React/);
});

test('a yes without application details asks for them instead of applying', async () => {
  const dev = client();
  await dev.signIn('early@example.com');
  await dev.req('PUT', '/profile', PROFILE);
  const r = (await dev.req('POST', `/deck/${roleId('main')}`, { liked: true })).body;
  assert.equal(r.application, null);
  assert.deepEqual(r.applySetup.missing.sort(), ['needs_sponsorship', 'phone', 'work_authorized']);
  assert.equal(r.applySetup.consented, false);
  assert.equal((await dev.req('POST', '/applications', { roleId: roleId('main'), consent: true })).status, 400, 'still missing details');
});

test('HireMe fills, uploads, answers and submits the form for the developer', async (t) => {
  if (!browserOk) return t.skip('no browser available');
  const dev = client();
  await dev.signIn('matt@example.com');
  await dev.req('PUT', '/profile', { ...PROFILE, phone: '916-555-0100', work_authorized: 'yes', needs_sponsorship: 'no' });
  // Upload a resume PDF
  const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(200));
  assert.equal((await dev.req('POST', '/profile/resume', { name: 'Matt Renda Resume.pdf', data: pdf.toString('base64') })).status, 200);
  assert.equal((await dev.req('POST', '/profile/resume', { name: 'x.pdf', data: Buffer.from('not a pdf').toString('base64') })).status, 400);

  // First yes: consent, then it queues
  const swipe = (await dev.req('POST', `/deck/${roleId('main')}`, { liked: true })).body;
  assert.deepEqual(swipe.applySetup.missing, []);
  const queued = (await dev.req('POST', '/applications', { roleId: roleId('main'), consent: true })).body;
  assert.equal(queued.state, 'queued');
  await applier.tick();

  const list = (await dev.req('GET', '/applications')).body;
  const a = list.find((x) => x.role_id === roleId('main'));
  assert.equal(a.state, 'submitted', `${a.state}: ${a.error}`);
  const s = submissions.at(-1);
  assert.equal(s.first_name, 'Matt');
  assert.equal(s.last_name, 'Renda');
  assert.equal(s.email, 'matt@example.com');
  assert.equal(s.phone, '916-555-0100');
  assert.equal(s['urls[LinkedIn]'], 'https://linkedin.com/in/matt');
  assert.equal(s.auth, '1');
  assert.equal(s.sponsor, 'no');
  assert.equal(s.gender, "I don't wish to answer");
  assert.match(s.why, /Acme/, 'open question drafted (template without an API key)');
  assert.equal(s.consent, 'on');
  assert.equal(s.resume.name, 'Matt Renda Resume.pdf');
  assert.ok(a.answers.some((x) => /why/i.test(x.question) && x.source === 'drafted'), 'what was sent is recorded');
  assert.match(a.cover_note, /Acme/);
  assert.equal((await dev.req('GET', `/applications/${a.id}/screenshot`)).status, 200);

  // Later yeses apply right away
  const r2 = (await dev.req('POST', `/deck/${roleId('?captcha=1')}`, { liked: true })).body;
  assert.equal(r2.application.state, 'queued');
});

test('CAPTCHA and unanswerable questions come back to the developer; answers are saved and reused', async (t) => {
  if (!browserOk) return t.skip('no browser available');
  const dev = client();
  await dev.signIn('matt@example.com');
  const before = submissions.length;
  await applier.tick(); // the CAPTCHA one queued in the last test
  let list = (await dev.req('GET', '/applications')).body;
  const cap = list.find((x) => x.role_id === roleId('?captcha=1'));
  assert.equal(cap.state, 'needs_you');
  assert.match(cap.error, /CAPTCHA/);
  assert.equal(submissions.length, before, 'nothing submitted');
  assert.equal((await dev.req('GET', '/me')).body.counts.needsYou, 1);
  assert.equal((await dev.req('POST', `/applications/${cap.id}/self`)).status, 204);

  // A required question HireMe can't answer
  await dev.req('POST', `/deck/${roleId('?extra=1')}`, { liked: true });
  await applier.tick();
  list = (await dev.req('GET', '/applications')).body;
  const ex = list.find((x) => x.role_id === roleId('?extra=1'));
  assert.equal(ex.state, 'needs_you');
  assert.deepEqual(ex.missing, ['What is your security clearance level?']);

  const again = (await dev.req('POST', `/applications/${ex.id}/answers`, { answers: [{ question: ex.missing[0], answer: 'None' }] })).body;
  assert.equal(again.state, 'queued');
  await applier.tick();
  list = (await dev.req('GET', '/applications')).body;
  assert.equal(list.find((x) => x.id === ex.id).state, 'submitted');
  assert.equal(submissions.at(-1).clearance, 'None');
  const profile = (await dev.req('GET', '/profile')).body;
  assert.equal(profile.saved_answers[0].answer, 'None', 'saved for next time');
});
