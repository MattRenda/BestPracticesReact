import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { looksLikeAgency, siteDomain } from '../src/rules.js';

const sent = [];
const mailer = { configured: false, sent, send: async (m) => void sent.push(m) };
const quiet = { info() {}, warn() {}, error() {} };

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  const app = createApp(db, { mailer, adminEmails: ['admin@hireme.test'], log: quiet, ipLimit: 1000, dataDir: mkdtempSync(path.join(tmpdir(), 'hireme-')), applierOptions: { autoStart: false } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

/** A browser-ish client with its own cookie. */
function client() {
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return {
    req,
    async signIn(email, intent) {
      const r = await req('POST', '/auth/start', { email, intent });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const token = r.body.devLink.split('/signin/')[1];
      const v = await req('POST', '/auth/verify', { token });
      assert.equal(v.status, 200);
      return (await req('GET', '/me')).body;
    },
  };
}

const DEV_PROFILE = { name: 'Dana Dev', headline: 'Full-stack engineer', skills: 'React, Node.js, TypeScript', location: 'Sacramento, CA', work_pref: 'remote', years: 8 };
const READY = { ...DEV_PROFILE, phone: '555-010-1234', work_authorized: 'yes', needs_sponsorship: 'no', experience: 'Engineer at Example Co, 2018 - Present' };

let seq = 0;
/** An imported startup with one open role, the way the importer stores them. */
function listedRole({ name = `Startup ${++seq}`, headcount = 12, status = 'listed', title = 'Software Engineer', skills = 'React, Node.js', applyUrl = 'https://jobs.example/apply' } = {}) {
  const domain = `${name.toLowerCase().replace(/\W+/g, '')}${seq}.example`;
  const sid = Number(
    db.prepare("INSERT INTO startups (name, website, domain, headcount, status, source) VALUES (?, ?, ?, ?, ?, 'yc')").run(name, `https://${domain}`, domain, headcount, status).lastInsertRowid,
  );
  const rid = Number(
    db
      .prepare("INSERT INTO roles (startup_id, title, skills, work_mode, status, source, apply_url, external_id) VALUES (?, ?, ?, 'remote', 'open', 'ats', ?, ?)")
      .run(sid, title, skills, applyUrl, `ashby:${sid}`).lastInsertRowid,
  );
  return { sid, rid };
}

test('rules: domains and agencies', () => {
  assert.equal(siteDomain('https://www.Acme.io/about'), 'acme.io');
  assert.equal(siteDomain('not a url'), '');
  assert.ok(looksLikeAgency('Tech staffing for startups'));
  assert.ok(!looksLikeAgency('Scheduling for small clinics'));
});

test('sign-in: magic link, session, CSRF guard; every account is a developer', async () => {
  const c = client();
  assert.equal((await c.req('POST', '/auth/start', { email: 'nope' })).status, 400);
  const me = await c.signIn('Dana@Example.com', 'founder'); // old clients may still send a founder intent
  assert.equal(me.user.email, 'dana@example.com');
  assert.equal(me.user.role, 'dev');
  assert.ok(sent.some((m) => m.to === 'dana@example.com' && /sign-in link/.test(m.subject)));

  // Links are single-use
  const r = await c.req('POST', '/auth/start', { email: 'dana@example.com' });
  const token = r.body.devLink.split('/signin/')[1];
  assert.equal((await c.req('POST', '/auth/verify', { token })).status, 200);
  assert.equal((await c.req('POST', '/auth/verify', { token })).status, 400);

  // A cross-site form post (not JSON) is refused
  const form = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 415);
  const evil = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);

  // The founder side is gone
  for (const [m, path] of [['GET', '/startup'], ['GET', '/matches'], ['GET', '/deck/devs'], ['POST', '/me/role']])
    assert.equal((await c.req(m, path, {})).status, 404, `${m} ${path}`);
});

test('swipe right applies: setup first, then HireMe queues the application', async () => {
  const small = listedRole({ name: 'Tiny Rocket', headcount: 6 });
  const big = listedRole({ name: 'Too Big', headcount: 51 });
  const hidden = listedRole({ name: 'Hidden Co', status: 'pending' });
  const noForm = listedRole({ name: 'No Form', applyUrl: null });

  const dev = client();
  await dev.signIn('swiper@example.com');
  assert.equal((await dev.req('GET', '/deck')).status, 409, 'profile first');
  await dev.req('PUT', '/profile', DEV_PROFILE);
  const deck = (await dev.req('GET', '/deck')).body;
  const ids = deck.map((c) => c.id);
  assert.ok(ids.includes(small.rid));
  for (const r of [big, hidden, noForm]) assert.ok(!ids.includes(r.rid), 'only open roles with a form at listed startups of 50 or fewer');
  assert.deepEqual(deck.find((c) => c.id === small.rid).sharedSkills, ['react', 'node.js']);

  // Not set up to apply yet: the swipe is saved and HireMe asks for what's missing.
  const first = (await dev.req('POST', `/deck/${small.rid}`, { liked: true })).body;
  assert.equal(first.application, null);
  assert.deepEqual(first.applySetup, { missing: ['phone', 'work_authorized', 'needs_sponsorship', 'resume'], consented: false });
  assert.ok((await dev.req('GET', '/saved')).body.some((r) => r.id === small.rid));

  await dev.req('PUT', '/profile', READY);
  const app = await dev.req('POST', '/applications', { roleId: small.rid, consent: true });
  assert.equal(app.status, 201);
  assert.equal(app.body.state, 'queued');
  assert.ok(!(await dev.req('GET', '/saved')).body.some((r) => r.id === small.rid));

  // Once set up, a right swipe applies straight away.
  const next = listedRole({ name: 'Bramble' });
  const r2 = (await dev.req('POST', `/deck/${next.rid}`, { liked: true })).body;
  assert.equal(r2.application.state, 'queued');
  const apps = (await dev.req('GET', '/applications')).body;
  assert.deepEqual(apps.map((a) => a.startup_name).sort(), ['Bramble', 'Tiny Rocket']);

  // Undo before HireMe starts cancels the application; left swipes just skip.
  assert.equal((await dev.req('DELETE', `/deck/${next.rid}`)).status, 204);
  assert.ok(!(await dev.req('GET', '/applications')).body.some((a) => a.role_id === next.rid));
  const left = listedRole();
  assert.equal((await dev.req('POST', `/deck/${left.rid}`, { liked: false })).body.application, null);
  assert.ok(!(await dev.req('GET', '/deck')).body.some((c) => c.id === left.rid));
  assert.equal((await dev.req('POST', `/deck/${big.rid}`, { liked: true })).status, 404);
});

test('reports: three recruiter reports hide a company until an admin looks', async () => {
  const admin = client();
  await admin.signIn('admin@hireme.test');
  const s = listedRole({ name: 'Sneaky Hire' });
  for (let i = 0; i < 3; i++) {
    const d = client();
    await d.signIn(`reporter${i}@example.com`);
    await d.req('PUT', '/profile', DEV_PROFILE);
    assert.ok((await d.req('GET', '/deck')).body.some((x) => x.id === s.rid));
    assert.equal((await d.req('POST', '/reports', { type: 'startup', id: s.sid, reason: 'recruiter' })).status, 201);
    // The reporter stops seeing them right away
    assert.ok(!(await d.req('GET', '/deck')).body.some((x) => x.id === s.rid));
  }
  const q = (await admin.req('GET', '/admin/queue')).body;
  assert.equal(q.hidden.find((x) => x.id === s.sid).status, 'pending');
  assert.equal(q.reports.filter((x) => x.target_id === s.sid).length, 3);
  assert.equal((await client().req('GET', '/admin/queue')).status, 403);

  // Admin puts it back: reports are resolved and it's listed again.
  assert.equal((await admin.req('POST', `/admin/startups/${s.sid}`, { status: 'listed' })).body.status, 'listed');
  assert.equal((await admin.req('GET', '/admin/queue')).body.reports.filter((x) => x.target_id === s.sid).length, 0);
});

test('guests: start without signing up, swipe, then add an email and the applications go out', async () => {
  const role = listedRole({ name: 'Guest Rocket' });
  const g = client();
  assert.equal((await g.req('POST', '/auth/guest')).status, 201);
  let me = (await g.req('GET', '/me')).body;
  assert.equal(me.user.isGuest, true);
  assert.equal(me.user.email, '', 'the placeholder email never shows');
  assert.equal(me.profileComplete, false);

  // Answers from the get-to-know-you steps, plus what forms need
  await g.req('PUT', '/profile', { ...READY, links: { linkedin: 'linkedin.com/in/dana' }, auto_apply: true });
  const swipe = (await g.req('POST', `/deck/${role.rid}`, { liked: true })).body;
  assert.equal(swipe.needsAccount, true);
  assert.equal(swipe.application, null, 'nothing is sent without a real email');
  assert.equal((await g.req('POST', '/applications', { roleId: role.rid, consent: true })).status, 403);

  // The sign-in link carries the guest, even if opened in another browser
  const start = await g.req('POST', '/auth/start', { email: 'Newbie@Example.com' });
  const token = start.body.devLink.split('/signin/')[1];
  const other = client();
  const v = await other.req('POST', '/auth/verify', { token });
  assert.deepEqual(v.body.sent, ['Guest Rocket']);
  me = (await other.req('GET', '/me')).body;
  assert.equal(me.user.email, 'newbie@example.com');
  assert.equal(me.user.isGuest, false);
  assert.equal(me.profile.name, 'Dana Dev');
  assert.equal(me.profile.links.linkedin, 'https://linkedin.com/in/dana');
  assert.equal((await other.req('GET', '/applications')).body[0].startup_name, 'Guest Rocket');
});

test('guests who sign in to an existing account keep that account’s profile and bring their swipes', async () => {
  const role = listedRole({ name: 'Merge Labs' });
  const old = client();
  await old.signIn('returning@example.com');
  await old.req('PUT', '/profile', { ...READY, name: 'Real Name', auto_apply: true });

  const g = client();
  await g.req('POST', '/auth/guest');
  await g.req('PUT', '/profile', { ...DEV_PROFILE, name: 'Guest Name' });
  await g.req('POST', `/deck/${role.rid}`, { liked: true });
  const start = await g.req('POST', '/auth/start', { email: 'returning@example.com' });
  const v = await g.req('POST', '/auth/verify', { token: start.body.devLink.split('/signin/')[1] });
  assert.deepEqual(v.body.sent, ['Merge Labs'], 'the account had already agreed to Apply for me');
  const me = (await g.req('GET', '/me')).body;
  assert.equal(me.profile.name, 'Real Name');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE is_guest = 1 AND id NOT IN (SELECT user_id FROM sessions)").get().n, 0, 'the guest account is gone');
});

test('accounts can be deleted', async () => {
  const dev = client();
  await dev.signIn('leaver@example.com');
  await dev.req('PUT', '/profile', DEV_PROFILE);
  assert.equal((await dev.req('DELETE', '/me')).status, 204);
  assert.equal((await dev.req('GET', '/me')).body.user, null);
});

test('setup can start from a resume: upload fills in suggestions, nothing saved until the developer saves', async () => {
  const dev = client();
  await dev.signIn('resume-first@example.com', 'dev');
  const data = readFileSync(new URL('./fixtures/resume.pdf', import.meta.url)).toString('base64');
  const up = await dev.req('POST', '/profile/resume', { name: 'Jordan Resume.pdf', data, parse: true });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.parsed.name, 'Jordan Example');
  assert.equal(up.body.parsed.location, 'Portland, OR');
  assert.match(up.body.parsed.headline, /^Backend Engineer/);
  assert.match(up.body.parsed.skills, /Go, Python/);
  assert.equal(up.body.parsed.links.github, 'https://github.com/jordan-example');
  assert.equal(up.body.unreadable, false);
  // The resume is stored, but the profile is still empty and incomplete.
  const me = (await dev.req('GET', '/me')).body;
  assert.equal(me.profileComplete, false);
  const p = (await dev.req('GET', '/profile')).body;
  assert.equal(p.has_resume, true);
  assert.equal(p.name, '');
  // Without parse, uploads just store the file.
  const plain = await dev.req('POST', '/profile/resume', { name: 'r.pdf', data });
  assert.equal(plain.body.parsed, undefined);
});

test('smtp settings parse, with the password kept separately', async () => {
  const { smtpOptions } = await import('../src/mail.js');
  assert.deepEqual(smtpOptions('smtps://me%40gmail.com@smtp.gmail.com:465', 'app-pass'), {
    host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'me@gmail.com', pass: 'app-pass' },
  });
  assert.equal(smtpOptions('smtp://u:p@mail.example:587').auth.pass, 'p');
});
