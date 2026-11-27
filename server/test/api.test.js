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

let server, base, db, app;
before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO settings (key, value) VALUES ('form_ats', '[\"other\"]')").run(); // the sample roles are form-based
  app = createApp(db, { mailer, adminEmails: ['admin@hireme.test'], log: quiet, ipLimit: 1000, dataDir: mkdtempSync(path.join(tmpdir(), 'hireme-')), applierOptions: { autoStart: false, gapMs: 0 } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await app.locals.applier.stop();
  server.close();
});

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

test('swipe right applies: nothing to fill in; swipes wait for missing details and go out once they’re added', async () => {
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

  // Phone and work questions missing: the swipe is kept, nothing is asked.
  const first = (await dev.req('POST', `/deck/${small.rid}`, { liked: true })).body;
  assert.equal(first.application, null);
  assert.equal(first.waiting, 'profile');
  assert.ok((await dev.req('GET', '/saved')).body.some((r) => r.id === small.rid));

  // Filling them in sends the waiting swipe — no resume needed (HireMe builds one from the profile).
  const saved = (await dev.req('PUT', '/profile', { ...READY, experience: '' })).body;
  assert.deepEqual(saved.applyMissing, []);
  assert.deepEqual(saved.sent, ['Tiny Rocket']);
  assert.ok(!(await dev.req('GET', '/saved')).body.some((r) => r.id === small.rid));

  // From now on a right swipe applies straight away.
  const next = listedRole({ name: 'Bramble' });
  const r2 = (await dev.req('POST', `/deck/${next.rid}`, { liked: true })).body;
  assert.equal(r2.application.state, 'queued');
  const apps = (await dev.req('GET', '/applications')).body;
  assert.deepEqual(apps.map((a) => a.startup_name).sort(), ['Bramble', 'Tiny Rocket']);

  // Undo before HireMe starts cancels it, and a later profile save doesn't resend it.
  assert.equal((await dev.req('DELETE', `/deck/${next.rid}`)).status, 204);
  await dev.req('POST', `/deck/${next.rid}`, { liked: true });
  assert.equal((await dev.req('GET', '/applications')).body.filter((a) => a.role_id === next.rid).length, 1);
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
  await g.req('PUT', '/profile', { ...READY, links: { linkedin: 'linkedin.com/in/dana' } });
  // Their email from the get-to-know-you steps: a confirmation link goes out, swiping carries on
  const start = await g.req('POST', '/auth/start', { email: 'Newbie@Example.com' });
  assert.equal((await g.req('GET', '/me')).body.user.pendingEmail, 'newbie@example.com');
  assert.ok(sent.some((m) => m.to === 'newbie@example.com' && /Confirm your email/.test(m.subject)));
  const swipe = (await g.req('POST', `/deck/${role.rid}`, { liked: true })).body;
  assert.equal(swipe.waiting, 'email');
  assert.equal(swipe.application, null, 'nothing is sent before the email is confirmed');
  assert.equal((await g.req('POST', '/applications', { roleId: role.rid })).status, 403);

  // The link carries the guest, even if opened in another browser
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
  await old.req('PUT', '/profile', { ...READY, name: 'Real Name' });

  const g = client();
  await g.req('POST', '/auth/guest');
  await g.req('PUT', '/profile', { ...DEV_PROFILE, name: 'Guest Name' });
  await g.req('POST', `/deck/${role.rid}`, { liked: true });
  const start = await g.req('POST', '/auth/start', { email: 'returning@example.com' });
  assert.equal(sent.at(-1).subject, 'Your HireMe sign-in link', 'a returning person gets a sign-in email, not a confirm-your-email one');
  const v = await g.req('POST', '/auth/verify', { token: start.body.devLink.split('/signin/')[1] });
  assert.deepEqual(v.body.sent, ['Merge Labs'], 'the account already has what applications need');
  const me = (await g.req('GET', '/me')).body;
  assert.equal(me.profile.name, 'Real Name');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE is_guest = 1 AND id NOT IN (SELECT user_id FROM sessions)").get().n, 0, 'the guest account is gone');
});

test('only roles HireMe can send by itself are in the deck; email ones go out as an application email', async () => {
  const sid = Number(db.prepare("INSERT INTO startups (name, website, domain, headcount, status, source) VALUES ('Mailbox Co', 'https://mailbox.example', 'mailbox.example', 9, 'listed', 'hn')").run().lastInsertRowid);
  const rid = Number(
    db
      .prepare("INSERT INTO roles (startup_id, title, skills, work_mode, status, source, apply_url, apply_email, external_id) VALUES (?, 'Backend Engineer', 'Node.js', 'remote', 'open', 'hn', 'https://news.ycombinator.com/item?id=1', 'jobs@mailbox.example', 'hn:1')")
      .run(sid).lastInsertRowid,
  );
  const ashby = listedRole({ name: 'Formful' });
  db.prepare("UPDATE startups SET ats = 'ashby' WHERE id = ?").run(ashby.sid);

  const dev = client();
  await dev.signIn('mailer@example.com');
  await dev.req('PUT', '/profile', { ...READY, links: { github: 'https://github.com/dana' } });
  const data = readFileSync(new URL('./fixtures/resume.pdf', import.meta.url)).toString('base64');
  await dev.req('POST', '/profile/resume', { name: 'Dana Resume.pdf', data });
  const ids = (await dev.req('GET', '/deck')).body.map((c) => c.id);
  assert.ok(ids.includes(rid), 'email roles are always in');
  assert.ok(!ids.includes(ashby.rid), 'Ashby forms are off here (only "other" is on in this test)');

  // Earlier tests left form applications to a made-up site in the queue; this test is only about email
  db.prepare("UPDATE applications SET state = 'canceled' WHERE state = 'queued'").run();
  const swipe = (await dev.req('POST', `/deck/${rid}`, { liked: true })).body;
  assert.equal(swipe.application.state, 'queued');
  await app.locals.applier.tick();
  const a = (await dev.req('GET', '/applications')).body.find((x) => x.role_id === rid);
  assert.equal(a.state, 'submitted', a.error);
  assert.deepEqual(a.answers[0], { question: 'Sent by email to', answer: 'jobs@mailbox.example', source: 'email' });
  const m = sent.find((x) => x.to === 'jobs@mailbox.example');
  assert.equal(m.cc, 'mailer@example.com');
  assert.equal(m.replyTo, 'mailer@example.com');
  assert.equal(m.fromName, 'Dana Dev via HireMe');
  assert.equal(m.subject, 'Application: Backend Engineer — Dana Dev');
  assert.deepEqual(m.attachments.map((x) => x.filename), ['Dana Resume.pdf']);
  assert.ok(m.attachments[0].content.length > 1000, 'the actual PDF');
  assert.match(m.text, /^Hi Mailbox Co team,/);
  assert.match(m.text, /GitHub: https:\/\/github\.com\/dana/);
});

test('startups list their own roles: work email at their domain, 50 or fewer, developer titles; applications are emailed to them', async () => {
  const anon = client();
  assert.equal((await anon.req('GET', '/hiring')).status, 401);

  // A personal email can't list a company
  const gmail = client();
  await gmail.signIn('founder@gmail.com', 'hiring');
  assert.equal((await gmail.req('GET', '/hiring')).body.workEmail, false);
  assert.equal((await gmail.req('POST', '/hiring/startup', { name: 'Nope', website: 'nope.example', headcount: 5 })).status, 403);

  const f = client();
  await f.signIn('ana@sprocket.example', 'hiring');
  const h0 = (await f.req('GET', '/hiring')).body;
  assert.equal(h0.suggestedWebsite, 'https://sprocket.example');
  assert.equal(h0.startup, null);
  assert.match((await f.req('POST', '/hiring/startup', { name: 'Sprocket', website: 'other.example', headcount: 5 })).body.error, /has to be at other\.example/);
  assert.match((await f.req('POST', '/hiring/startup', { name: 'Sprocket', website: 'sprocket.example', headcount: 120 })).body.error, /50 people or fewer/);
  assert.match((await f.req('POST', '/hiring/startup', { name: 'Sprocket Staffing', website: 'sprocket.example', headcount: 5 })).body.error, /not recruiters/);
  const h1 = await f.req('POST', '/hiring/startup', { name: 'Sprocket', website: 'https://sprocket.example', headcount: 7, location: 'Remote', one_liner: 'Bike parts, but software' });
  assert.equal(h1.status, 201, JSON.stringify(h1.body));
  assert.equal(h1.body.startup.status, 'live');
  assert.equal(h1.body.startup.apply_email, 'ana@sprocket.example');
  assert.ok(sent.some((m) => m.to === 'admin@hireme.test' && /New startup on HireMe: Sprocket/.test(m.subject)), 'admins hear about it');

  // Developer roles only, with a real description
  assert.match((await f.req('POST', '/hiring/roles', { title: 'Account Executive', description: 'x'.repeat(50) })).body.error, /developer roles/);
  assert.match((await f.req('POST', '/hiring/roles', { title: 'Software Engineer', description: 'short' })).body.error, /description/);
  // Applications go to an address at the company
  assert.equal((await f.req('PUT', '/hiring/startup', { apply_email: 'ana@gmail.com' })).status, 400);
  await f.req('PUT', '/hiring/startup', { apply_email: 'jobs@sprocket.example' });
  const h2 = (
    await f.req('POST', '/hiring/roles', {
      title: 'Founding Engineer',
      description: 'Build our React and Node.js app end to end, from the database to the UI. Small team, lots of ownership.',
      work_mode: 'remote',
      salary_min: 140000,
      salary_max: 180000,
      equity: '0.5–1%',
    })
  ).body;
  assert.equal(h2.roles.length, 1);
  const roleId = h2.roles[0].id;
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  assert.equal(role.source, 'direct');
  assert.equal(role.apply_email, 'jobs@sprocket.example');
  assert.match(role.skills, /React/);

  // A coworker at the same domain joins the same company; HireMe-listed companies (e.g. from YC) can be claimed too
  const co = client();
  await co.signIn('ben@sprocket.example', 'hiring');
  assert.equal((await co.req('GET', '/hiring')).body.existing.name, 'Sprocket');
  assert.equal((await co.req('POST', '/hiring/startup', { website: 'sprocket.example' })).body.startup.id, h1.body.startup.id);

  // Developers see it and a right swipe emails the startup
  const dev = client();
  await dev.signIn('swiper@example.com');
  await dev.req('PUT', '/profile', READY);
  const card = (await dev.req('GET', '/deck')).body.find((c) => c.id === roleId);
  assert.ok(card, 'in the deck right away');
  assert.equal(card.apply_url, '');
  db.prepare("UPDATE applications SET state = 'canceled' WHERE state = 'queued'").run();
  await dev.req('POST', `/deck/${roleId}`, { liked: true });
  await app.locals.applier.tick();
  const m = sent.find((x) => x.to === 'jobs@sprocket.example');
  assert.ok(m, 'emailed');
  assert.match(m.text, /role on HireMe\./);
  if (process.env.SHOW_MAIL) console.log(m.text);
  assert.equal(m.text.match(/^Hi /gm).length, 1, 'one greeting');
  assert.equal(m.text.match(/^Thanks,/gm).length, 1, 'one sign-off');
  assert.equal((await f.req('GET', '/hiring')).body.roles[0].applications, 1);

  // Closing a role takes it out of the deck
  await f.req('PUT', `/hiring/roles/${roleId}`, { status: 'closed' });
  assert.ok(!(await dev.req('GET', '/deck')).body.some((c) => c.id === roleId));
  // Another startup's member can't touch it
  assert.equal((await gmail.req('PUT', `/hiring/roles/${roleId}`, { status: 'open' })).status, 404);
});

test('roles in another language stay out of the deck', async () => {
  const dev = client();
  await dev.signIn('lang@example.com');
  await dev.req('PUT', '/profile', READY);
  const ja = listedRole({ name: 'Tokyo AI' });
  db.prepare('UPDATE roles SET description = ? WHERE id = ?').run('私たちは小売業界向けのAIプラットフォームを開発しています。東京オフィスでエンジニアを募集しています。', ja.rid);
  const en = listedRole({ name: 'Plain English' });
  db.prepare('UPDATE roles SET description = ? WHERE id = ?').run('We are building tools for small teams. You will work with our founders on the product.', en.rid);
  const ids = (await dev.req('GET', '/deck')).body.map((c) => c.id);
  assert.ok(!ids.includes(ja.rid), 'Japanese posting hidden');
  assert.ok(ids.includes(en.rid));
  assert.equal(db.prepare('SELECT lang FROM roles WHERE id = ?').get(ja.rid).lang, 'ja');
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
