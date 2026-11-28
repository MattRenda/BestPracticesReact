import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createSecrets } from '../src/secrets.js';
import { createAtsApi } from '../src/apply/ats-api.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROFILE = {
  name: 'Dana Dev',
  email: 'dana@example.com',
  phone: '555-010-1234',
  experience: 'Senior Engineer — Lumen Labs (2021 – present)',
  links: { linkedin: 'https://www.linkedin.com/in/dana', github: 'https://github.com/dana' },
};
const RESUME = { name: 'Dana_Dev_Resume.pdf', buffer: Buffer.from('%PDF-1.4 fake') };

test('API keys are sealed at rest and only open with the same data key', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hm-'));
  const a = createSecrets({ dataDir: dir, env: {} });
  const sealed = a.seal('gh_live_123');
  assert.ok(sealed.startsWith('v1:') && !sealed.includes('gh_live_123'));
  assert.equal(createSecrets({ dataDir: dir, env: {} }).open(sealed), 'gh_live_123', 'same key file');
  assert.equal(createSecrets({ dataDir: dir, env: { DATA_KEY: 'other' } }).open(sealed), '', 'wrong key');
});

test('Greenhouse: Job Board API with Basic auth, the job’s questions answered, required unknowns come back', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('?questions=true'))
      return json({
        questions: [
          { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
          { label: 'Resume/CV', required: true, fields: [{ name: 'resume', type: 'input_file' }, { name: 'resume_text', type: 'textarea' }] },
          { label: 'LinkedIn Profile', required: false, fields: [{ name: 'question_111', type: 'input_text' }] },
          { label: 'Are you authorized to work in the US?', required: true, fields: [{ name: 'question_222', type: 'multi_value_single_select', values: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] }] },
        ],
      });
    return json({}, 200);
  };
  const api = createAtsApi({ fetchImpl });
  const answer = (q) => ({ 'LinkedIn Profile': PROFILE.links.linkedin, 'Are you authorized to work in the US?': 'Yes' })[q] || '';
  const r = await api.submit({ system: 'greenhouse', key: 'KEY', board: 'lumen', externalId: 'greenhouse:4001', profile: PROFILE, resume: RESUME, note: 'Hi there', answer });
  assert.equal(r.state, 'submitted', JSON.stringify(r));
  const post = calls.find((c) => c.init.method === 'POST');
  assert.equal(post.url, 'https://boards-api.greenhouse.io/v1/boards/lumen/jobs/4001');
  assert.equal(post.init.headers.authorization, `Basic ${Buffer.from('KEY:').toString('base64')}`);
  const f = post.init.body;
  assert.equal(f.get('first_name'), 'Dana');
  assert.equal(f.get('last_name'), 'Dev');
  assert.equal(f.get('question_111'), PROFILE.links.linkedin);
  assert.equal(f.get('question_222'), '1');
  assert.equal(f.get('cover_letter_text'), 'Hi there');
  assert.equal(f.get('resume').name, 'Dana_Dev_Resume.pdf');

  const r2 = await api.submit({ system: 'greenhouse', key: 'KEY', board: 'lumen', externalId: 'greenhouse:4001', profile: PROFILE, resume: RESUME, note: '', answer: () => '' });
  assert.equal(r2.state, 'needs_you');
  assert.deepEqual(r2.missing, ['Are you authorized to work in the US?']);
});

test('Lever: Postings API key in the URL, links as urls[…], 429 waits for later, revoked key is flagged', async () => {
  let status = 200;
  let last;
  const api = createAtsApi({ fetchImpl: async (url, init) => ((last = { url: String(url), init }), json(status === 200 ? { ok: true, applicationId: 'a1' } : { ok: false, error: 'nope' }, status)) });
  const go = () => api.submit({ system: 'lever', key: 'LK', board: 'lumen', externalId: 'lever:abc-123', profile: PROFILE, resume: RESUME, note: 'Note', answer: () => '' });
  assert.equal((await go()).state, 'submitted');
  assert.equal(last.url, 'https://api.lever.co/v0/postings/lumen/abc-123?key=LK');
  assert.equal(last.init.body.get('urls[LinkedIn]'), PROFILE.links.linkedin);
  assert.equal(last.init.body.get('org'), 'Lumen Labs');
  assert.equal(last.init.body.get('source'), 'HireMe');
  status = 429;
  assert.equal((await go()).retryLater, true);
  status = 401;
  const bad = await go();
  assert.equal(bad.state, 'failed');
  assert.equal(bad.keyRejected, true);
});

test('Ashby: form definition from jobPosting.info, field submissions and the resume as a file part', async () => {
  const calls = [];
  const api = createAtsApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/jobPosting.info'))
        return json({
          success: true,
          results: {
            applicationFormDefinition: {
              sections: [
                {
                  fields: [
                    { isRequired: true, field: { path: '_systemfield_name', type: 'String', title: 'Name' } },
                    { isRequired: true, field: { path: '_systemfield_email', type: 'Email', title: 'Email' } },
                    { isRequired: true, field: { path: '_systemfield_resume', type: 'File', title: 'Resume' } },
                    { isRequired: false, field: { path: 'abc', type: 'SocialLink', title: 'LinkedIn' } },
                    { isRequired: true, field: { path: 'def', type: 'ValueSelect', title: 'Need sponsorship?', selectableValues: [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }] } },
                  ],
                },
              ],
            },
          },
        });
      return json({ success: true, results: { applicationId: 'x' } });
    },
  });
  const r = await api.submit({ system: 'ashby', key: 'AK', board: 'lumen', externalId: 'ashby:post-1', profile: PROFILE, resume: RESUME, note: '', answer: (q) => (q === 'Need sponsorship?' ? 'No' : '') });
  assert.equal(r.state, 'submitted', JSON.stringify(r));
  const post = calls.find((c) => c.url.endsWith('/applicationForm.submit'));
  const form = post.init.body;
  assert.equal(form.get('jobPostingId'), 'post-1');
  const subs = JSON.parse(form.get('applicationForm')).fieldSubmissions;
  assert.deepEqual(subs, [
    { path: '_systemfield_name', value: 'Dana Dev' },
    { path: '_systemfield_email', value: 'dana@example.com' },
    { path: '_systemfield_resume', value: 'resume_1' },
    { path: 'abc', value: PROFILE.links.linkedin },
    { path: 'def', value: 'n' },
  ]);
  assert.equal(form.get('resume_1').name, 'Dana_Dev_Resume.pdf');
});

// ---------- end to end: a startup connects Greenhouse, a developer swipes, it lands in Greenhouse ----------

let server, base, db, app;
const posted = [];
before(async () => {
  db = openDb(':memory:');
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://boards-api.greenhouse.io/v1/boards/sprocket/jobs?content=true'))
      return json({ jobs: [{ id: 7001, title: 'Founding Engineer', content: '&lt;p&gt;Build our React and Node.js app.&lt;/p&gt;', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/sprocket/jobs/7001', updated_at: '2026-11-01T00:00:00Z' }] });
    if (u === 'https://boards-api.greenhouse.io/v1/boards/sprocket/jobs') return json({ jobs: [] });
    if (u.includes('/jobs/7001?questions=true')) return json({ questions: [{ label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] }] });
    if (u === 'https://boards-api.greenhouse.io/v1/boards/sprocket/jobs/7001' && init.method === 'POST') {
      posted.push(init);
      return json({ success: true });
    }
    if (u.includes('/boards/nope/')) return json({}, 404);
    return json({}, 404);
  };
  app = createApp(db, { mailer: { configured: false, send: async () => {} }, log: { info() {}, warn() {}, error() {} }, ipLimit: 1000, fetchImpl, dataDir: mkdtempSync(path.join(tmpdir(), 'hm-')), applierOptions: { autoStart: false, gapMs: 0 } });
  db.prepare("INSERT INTO settings (key, value) VALUES ('form_ats', '[]')").run(); // form systems off: only the connection makes these roles sendable
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await app.locals.applier.stop();
  server.close();
});

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    req,
    async signIn(email, intent) {
      const r = await req('POST', '/auth/start', { email, intent });
      await req('POST', '/auth/verify', { token: r.body.devLink.split('/signin/')[1] });
    },
  };
}

test('a startup connects Greenhouse; its roles come in, a right swipe goes through the API, the key never leaves the server', async () => {
  const f = client();
  await f.signIn('ana@sprocket.example', 'hiring');
  await f.req('POST', '/hiring/startup', { name: 'Sprocket', website: 'sprocket.example', headcount: 6 });
  assert.match((await f.req('PUT', '/hiring/ats', { system: 'greenhouse', board: 'nope', key: 'GHKEY12345' })).body.error, /no Greenhouse job board/);
  const h = (await f.req('PUT', '/hiring/ats', { system: 'greenhouse', board: 'https://job-boards.greenhouse.io/sprocket', key: 'GHKEY12345' })).body;
  assert.deepEqual({ ...h.ats, connected_at: undefined }, { system: 'greenhouse', board: 'sprocket', connected_at: undefined, error: '' });
  assert.ok(!JSON.stringify(h).includes('GHKEY12345'), 'key never sent back');
  const stored = db.prepare("SELECT ats_api_key FROM startups WHERE domain = 'sprocket.example'").get().ats_api_key;
  assert.ok(stored.startsWith('v1:') && !stored.includes('GHKEY12345'), 'sealed at rest');
  assert.equal(h.imported, 1, 'board roles imported right away');

  const dev = client();
  await dev.signIn('swiper@example.com');
  await dev.req('PUT', '/profile', { name: 'Dana Dev', headline: 'Engineer', skills: 'React, Node.js', location: 'Sacramento, CA', work_pref: 'remote', years: 8, phone: '555', work_authorized: 'yes', needs_sponsorship: 'no', experience: 'Engineer at X, 2018 - Present' });
  const card = (await dev.req('GET', '/deck')).body.find((c) => c.title === 'Founding Engineer');
  assert.ok(card, 'in the deck even with form systems off');
  await dev.req('POST', `/deck/${card.id}`, { liked: true });
  await app.locals.applier.tick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].headers.authorization, `Basic ${Buffer.from('GHKEY12345:').toString('base64')}`);
  assert.equal(posted[0].body.get('email'), 'swiper@example.com');
  const a = db.prepare('SELECT state FROM applications WHERE role_id = ?').get(card.id);
  assert.equal(a.state, 'submitted');

  // Disconnect: the role falls back to normal treatment (form systems are off here, so it leaves the deck)
  await f.req('DELETE', '/hiring/ats');
  const other = client();
  await other.signIn('other@example.com');
  await other.req('PUT', '/profile', { name: 'Ola Other', headline: 'Engineer', skills: 'React', location: 'Austin, TX', work_pref: 'remote', years: 3 });
  assert.ok(!(await other.req('GET', '/deck')).body.some?.((c) => c.id === card.id));
});
