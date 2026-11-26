import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { checkStartup, emailMatchesDomain, siteDomain } from '../src/rules.js';

const sent = [];
const mailer = { configured: false, sent, send: async (m) => void sent.push(m) };
const quiet = { info() {}, warn() {}, error() {} };

let server, base;
before(async () => {
  const app = createApp(openDb(':memory:'), { mailer, adminEmails: ['admin@hireme.test'], log: quiet, ipLimit: 1000, dataDir: mkdtempSync(path.join(tmpdir(), 'hireme-')), applierOptions: { autoStart: false } });
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
const STARTUP = { name: 'Tiny Rocket', website: 'https://www.tinyrocket.io', headcount: 6, stage: 'Seed', one_liner: 'Scheduling for small clinics', confirmNotAgency: true };

test('rules: domains and startup checks', () => {
  assert.equal(siteDomain('https://www.Acme.io/about'), 'acme.io');
  assert.equal(siteDomain('not a url'), '');
  assert.ok(emailMatchesDomain('a@eng.acme.io', 'acme.io'));
  assert.ok(!emailMatchesDomain('a@notacme.io', 'acme.io'));
  assert.match(checkStartup({ ...STARTUP }, 'me@gmail.com').errors[0], /work email/);
  assert.match(checkStartup({ ...STARTUP }, 'me@other.com').errors[0], /has to match/);
  assert.match(checkStartup({ ...STARTUP, headcount: 51 }, 'me@tinyrocket.io').errors[0], /50 or fewer/);
  assert.match(checkStartup({ ...STARTUP, confirmNotAgency: false }, 'me@tinyrocket.io').errors[0], /not recruiting/);
  assert.deepEqual(checkStartup({ ...STARTUP }, 'me@tinyrocket.io').errors, []);
  assert.ok(checkStartup({ ...STARTUP, one_liner: 'Tech staffing for startups' }, 'me@tinyrocket.io').flags.length);
});

test('sign-in: magic link, session, CSRF guard', async () => {
  const c = client();
  assert.equal((await c.req('POST', '/auth/start', { email: 'nope' })).status, 400);
  assert.equal((await c.req('POST', '/auth/start', { email: 'f@gmail.com', intent: 'founder' })).status, 400, 'founders need a work email');
  const me = await c.signIn('Dana@Example.com', 'dev');
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
});

test('full flow: verify startup, swipe both ways, match, chat', async () => {
  const admin = client();
  await admin.signIn('admin@hireme.test', 'dev');
  const dev = client();
  await dev.signIn('dev1@example.com', 'dev');
  const founder = client();
  await founder.signIn('ana@tinyrocket.io', 'founder');

  // Deck needs a finished profile
  assert.equal((await dev.req('GET', '/deck')).status, 409);
  const prof = await dev.req('PUT', '/profile', { ...DEV_PROFILE, links: { github: 'github.com/dana', linkedin: 'javascript:alert(1)' } });
  assert.equal(prof.body.complete, true);
  assert.equal(prof.body.links.github, 'https://github.com/dana');
  assert.equal(prof.body.links.linkedin, '', 'unsafe links are dropped');
  const devId = (await dev.req('GET', '/me')).body.user.id;

  // Founder signs up the startup; it starts pending
  assert.equal((await founder.req('POST', '/startup', { ...STARTUP, website: 'othercompany.com' })).status, 400);
  const created = await founder.req('POST', '/startup', STARTUP);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, 'pending');
  assert.ok(sent.some((m) => m.to === 'admin@hireme.test' && /Tiny Rocket/.test(m.subject)));
  const role = (await founder.req('POST', '/roles', { title: 'Founding Engineer', skills: 'React, Node.js, Postgres', work_mode: 'remote', salary_min: 140000, salary_max: 170000 })).body;

  // Pending: hidden from devs, and founders can't browse devs yet
  assert.equal((await dev.req('GET', '/deck')).body.length, 0);
  const blocked = await founder.req('GET', `/deck/devs?role=${role.id}`);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.pending, true);

  // Only admins approve
  assert.equal((await dev.req('POST', `/admin/startups/${created.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await admin.req('GET', '/me')).body.counts.pendingStartups, 1);
  assert.equal((await admin.req('POST', `/admin/startups/${created.body.id}`, { status: 'approved' })).status, 200);
  assert.ok(sent.some((m) => m.to === 'ana@tinyrocket.io' && /live on HireMe/.test(m.subject)));

  // Dev sees the role, ranked with shared skills
  const deck = (await dev.req('GET', '/deck')).body;
  assert.equal(deck.length, 1);
  assert.equal(deck[0].startup.headcount, 6);
  assert.deepEqual(deck[0].sharedSkills.sort(), ['node.js', 'react']);

  // Dev likes with a note — no match yet; founder sees the interest first
  let r = await dev.req('POST', `/deck/${role.id}`, { liked: true, note: 'Built two scheduling apps — would love to chat!' });
  assert.equal(r.body.matched, false);
  assert.equal((await founder.req('GET', '/me')).body.counts.interested, 1);
  const devDeck = (await founder.req('GET', `/deck/devs?role=${role.id}`)).body;
  assert.equal(devDeck[0].id, devId);
  assert.equal(devDeck[0].likedRole, true);
  assert.match(devDeck[0].note, /scheduling/);
  assert.equal(devDeck[0].email, undefined, 'emails stay private');

  // Undo works before a match
  assert.equal((await dev.req('DELETE', `/deck/${role.id}`)).status, 204);
  assert.equal((await dev.req('GET', '/deck')).body.length, 1);
  await dev.req('POST', `/deck/${role.id}`, { liked: true, note: 'Built two scheduling apps — would love to chat!' });

  // Founder likes back → match, note becomes the first message, both sides emailed
  r = await founder.req('POST', `/deck/devs/${devId}`, { role: role.id, liked: true });
  assert.equal(r.body.matched, true);
  const matchId = r.body.matchId;
  assert.ok(sent.some((m) => m.to === 'dev1@example.com' && /matched with Tiny Rocket/.test(m.subject)));
  assert.ok(sent.some((m) => m.to === 'ana@tinyrocket.io' && /New match/.test(m.subject)));
  assert.equal((await dev.req('DELETE', `/deck/${role.id}`)).status, 409, 'no undo after matching');

  // Chat
  assert.equal((await founder.req('GET', '/me')).body.counts.unread, 1);
  const thread = (await founder.req('GET', `/matches/${matchId}`)).body;
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].side, 'dev');
  assert.equal(thread.dev.name, 'Dana Dev');
  await founder.req('POST', `/matches/${matchId}/read`, { lastId: thread.messages[0].id });
  assert.equal((await founder.req('GET', '/me')).body.counts.unread, 0);
  assert.equal((await founder.req('POST', `/matches/${matchId}/messages`, { body: 'Hi Dana! Free Thursday?' })).status, 201);
  assert.equal((await dev.req('GET', '/me')).body.counts.unread, 1);
  const list = (await dev.req('GET', '/matches')).body;
  assert.equal(list[0].startup_name, 'Tiny Rocket');
  assert.equal(list[0].last_body, 'Hi Dana! Free Thursday?');

  // A teammate on the same domain can join; their messages don't count as unread for each other
  const mate = client();
  const mateMe = await mate.signIn('ben@tinyrocket.io', 'founder');
  assert.equal(mateMe.joinable.name, 'Tiny Rocket');
  assert.equal((await mate.req('POST', '/startup/join', { id: created.body.id })).status, 201);
  assert.equal((await mate.req('GET', '/matches')).body.length, 1);

  // Outsiders can't read the match
  const stranger = client();
  await stranger.signIn('dev2@example.com', 'dev');
  assert.equal((await stranger.req('GET', `/matches/${matchId}`)).status, 404);
  const outsider = client();
  await outsider.signIn('cto@otherco.dev', 'founder');
  assert.equal((await outsider.req('POST', '/startup/join', { id: created.body.id })).status, 403);

  // Growing past 50 is refused
  assert.equal((await founder.req('PUT', '/startup', { headcount: 75 })).status, 400);

  // Closing ends the conversation
  await dev.req('POST', `/matches/${matchId}/close`);
  assert.equal((await founder.req('POST', `/matches/${matchId}/messages`, { body: 'hello?' })).status, 409);
});

test('founder-first like shows as interest to the developer', async () => {
  const admin = client();
  await admin.signIn('admin@hireme.test');
  const founder = client();
  await founder.signIn('kim@quietlab.co', 'founder');
  const s = (await founder.req('POST', '/startup', { ...STARTUP, name: 'Quiet Lab', website: 'quietlab.co', headcount: 3 })).body;
  await admin.req('POST', `/admin/startups/${s.id}`, { status: 'approved' });
  const role = (await founder.req('POST', '/roles', { title: 'Frontend Engineer', skills: 'React' })).body;

  const dev = client();
  await dev.signIn('dev3@example.com', 'dev');
  await dev.req('PUT', '/profile', { ...DEV_PROFILE, name: 'Lee' });
  const devId = (await dev.req('GET', '/me')).body.user.id;

  const r = await founder.req('POST', `/deck/devs/${devId}`, { role: role.id, liked: true });
  assert.equal(r.body.matched, false);
  const deck = (await dev.req('GET', '/deck')).body;
  const card = deck.find((d) => d.id === role.id);
  assert.equal(card.interested, true);
  assert.equal(deck[0].id, role.id, 'interested roles come first');
  assert.equal((await dev.req('POST', `/deck/${role.id}`, { liked: true })).body.matched, true);
});

test('reports: three recruiter reports hide a startup until reviewed', async () => {
  const admin = client();
  await admin.signIn('admin@hireme.test');
  const founder = client();
  await founder.signIn('sam@sneakyhire.com', 'founder');
  const s = (await founder.req('POST', '/startup', { ...STARTUP, name: 'Sneaky', website: 'sneakyhire.com' })).body;
  await admin.req('POST', `/admin/startups/${s.id}`, { status: 'approved' });
  await founder.req('POST', '/roles', { title: 'Engineer', skills: 'React' });

  for (let i = 0; i < 3; i++) {
    const d = client();
    await d.signIn(`reporter${i}@example.com`, 'dev');
    await d.req('PUT', '/profile', DEV_PROFILE);
    assert.ok((await d.req('GET', '/deck')).body.some((x) => x.startup.id === s.id));
    assert.equal((await d.req('POST', '/reports', { type: 'startup', id: s.id, reason: 'recruiter' })).status, 201);
    // The reporter stops seeing them right away
    assert.ok(!(await d.req('GET', '/deck')).body.some((x) => x.startup.id === s.id));
  }
  const q = (await admin.req('GET', '/admin/queue')).body;
  const row = q.startups.find((x) => x.id === s.id);
  assert.equal(row.status, 'pending');
  assert.match(row.flags, /Hidden after reports/);
  assert.equal(q.reports.filter((x) => x.target_id === s.id).length, 3);
});

test('accounts: role is fixed once set up, and accounts can be deleted', async () => {
  const dev = client();
  await dev.signIn('switcher@example.com', 'dev');
  await dev.req('PUT', '/profile', DEV_PROFILE);
  assert.equal((await dev.req('POST', '/me/role', { role: 'founder' })).status, 409);
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
