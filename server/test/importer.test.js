import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { extractSkills, findBoardLinks, htmlToText, isDevRole } from '../src/importer.js';

// A fake internet: the YC company list, a few company websites and their job boards.
const YC = 'https://yc-oss.github.io/api/companies/hiring.json';
let companies, boards;
function resetWorld() {
  companies = [
    { name: 'Tiny Rocket', slug: 'tiny-rocket', website: 'https://tinyrocket.example', team_size: 6, batch: 'Winter 2025', status: 'Active', isHiring: true, one_liner: 'Scheduling for clinics', long_description: 'We help clinics.', all_locations: 'San Francisco, CA, USA' },
    { name: 'Quiet Lab', slug: 'quiet-lab', website: 'quietlab.example', team_size: 3, batch: 'Summer 2024', status: 'Active', isHiring: true, one_liner: 'Focus tools' },
    { name: 'Sphere', slug: 'sphere', website: 'https://getsphere.example', team_size: 7, status: 'Active', isHiring: true, one_liner: 'Tax' },
    { name: 'BigCo', slug: 'bigco', website: 'https://bigco.example', team_size: 120, status: 'Active', isHiring: true, one_liner: 'Huge' },
    { name: 'Staffwise', slug: 'staffwise', website: 'https://staffwise.example', team_size: 5, status: 'Active', isHiring: true, one_liner: 'Tech staffing for startups' },
  ];
  boards = {
    'https://api.ashbyhq.com/posting-api/job-board/tinyrocket?includeCompensation=true': {
      jobs: [
        {
          id: 'a1', title: 'Founding Engineer', location: 'San Francisco', isRemote: true, workplaceType: 'Remote', isListed: true,
          descriptionPlain: 'Build our React and Node.js app with Postgres.', applyUrl: 'https://jobs.ashbyhq.com/tinyrocket/a1/application', publishedAt: '2026-11-01T00:00:00Z',
          compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150000, maxValue: 180000 }, { compensationType: 'EquityPercentage', interval: 'NONE' }] },
        },
        { id: 'a2', title: 'Account Executive', location: 'SF', isListed: true, descriptionPlain: 'Sell', applyUrl: 'x' },
        { id: 'a3', title: 'Backend Engineer', location: 'SF', isListed: false, descriptionPlain: 'Hidden', applyUrl: 'x' },
      ],
    },
    'https://boards-api.greenhouse.io/v1/boards/quiet-lab/jobs?content=true': {
      jobs: [{ id: 7, title: 'Senior Software Engineer', location: { name: 'Remote - US' }, absolute_url: 'https://job-boards.greenhouse.io/quiet-lab/jobs/7', content: '&lt;p&gt;At Quiet Lab you&amp;#39;ll use TypeScript &amp;amp; Go.&lt;/p&gt;' }],
    },
    // A different company that happens to be called "sphere" on Lever — must not be matched.
    'https://api.lever.co/v0/postings/sphere?mode=json': [{ id: 'l1', text: 'Software Engineer', categories: { location: 'Paris' }, descriptionPlain: 'Join Orbital Paris SAS.', hostedUrl: 'https://jobs.lever.co/sphere/l1' }],
  };
}
const pages = {
  'https://tinyrocket.example/': '<a href="https://jobs.ashbyhq.com/tinyrocket">Careers</a>',
  'https://quietlab.example/robots.txt': 'User-agent: *\nDisallow: /careers',
  'https://quietlab.example/careers': '<a href="https://jobs.lever.co/wrong-board">should not be read</a>',
};
const requested = [];
async function fakeFetch(url) {
  requested.push(url);
  const body = url === YC ? companies : boards[url] ?? pages[url];
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

const mailer = { configured: false, send: async () => {} };
const quiet = { info() {}, warn() {}, error() {} };
let server, base, app;
before(async () => {
  resetWorld();
  app = createApp(openDb(':memory:'), { mailer, adminEmails: ['admin@hireme.test'], log: quiet, ipLimit: 1000, dataDir: mkdtempSync(path.join(tmpdir(), 'hireme-')), applierOptions: { autoStart: false }, fetchImpl: fakeFetch });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

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
      await req('POST', '/auth/verify', { token: r.body.devLink.split('/signin/')[1] });
      return (await req('GET', '/me')).body;
    },
  };
}

test('boards shared by several companies (VC portfolio, recruiters) are recognized', async () => {
  const { looksShared } = await import('../src/importer.js');
  const shared = [
    { title: 'Staff Full Stack Engineer - Pay-i', description: 'About Pay-i. We are…' },
    { title: 'Founding Engineer - Frontend - Oodle (Bangalore, India)', description: 'About Oodle AI…' },
  ];
  const own = [
    { title: 'Software Engineer - Backend', description: 'About Tiny Rocket. About the role.' },
    { title: 'Senior Engineer - Remote', description: 'About us.' },
  ];
  assert.equal(looksShared(shared, 'Spur'), true);
  assert.equal(looksShared(own, 'Tiny Rocket'), false);
});

test('helpers: dev-role filter, skills, board links, html', () => {
  assert.ok(isDevRole('Founding Engineer'));
  assert.ok(isDevRole('Senior iOS Developer'));
  assert.ok(!isDevRole('Account Executive'));
  assert.ok(!isDevRole('Solutions Engineer'));
  assert.ok(!isDevRole('Product Designer'));
  assert.deepEqual(extractSkills('We use React, Node.js and Postgres. Not Javascriptish. Go is great.').sort(), ['Go', 'Node.js', 'Postgres', 'React']);
  assert.deepEqual(extractSkills('Join our Google team'), [], '"Go" inside another word is not a skill');
  assert.deepEqual(findBoardLinks('<a href="https://boards.greenhouse.io/embed/job_board?for=acme">x</a> <a href="//jobs.lever.co/globex/123">y</a>'), [
    { ats: 'greenhouse', slug: 'acme' },
    { ats: 'lever', slug: 'globex' },
  ]);
  assert.equal(htmlToText('&lt;ul&gt;&lt;li&gt;A &amp;amp; B&lt;/li&gt;&lt;/ul&gt;'), '• A & B');
});

test('import: small YC startups and their developer roles, nothing else', async () => {
  const stats = await app.locals.importer.start();
  assert.deepEqual(stats.errors, []);
  const db = app.locals.db;
  const startups = db.prepare('SELECT name, status, headcount, stage, ats, ats_slug FROM startups ORDER BY name').all();
  assert.deepEqual(startups.map((s) => s.name), ['Quiet Lab', 'Sphere', 'Tiny Rocket'], 'listed even without a job board; never BigCo or Staffwise');
  assert.equal(stats.startups_added, 3);
  const byName = Object.fromEntries(startups.map((s) => [s.name, s]));
  assert.equal(byName['Tiny Rocket'].ats, 'ashby', 'found from the link on its homepage');
  assert.equal(byName['Tiny Rocket'].stage, 'YC W25');
  assert.equal(byName['Quiet Lab'].ats, 'greenhouse', 'found by name guess, confirmed by the post mentioning Quiet Lab');
  assert.ok(!byName.BigCo, 'over 50 people');
  assert.ok(!byName.Staffwise, 'staffing agency');
  assert.ok(!requested.includes('https://quietlab.example/careers'), 'robots.txt disallowed /careers');
  assert.equal(byName.Sphere.ats, 'none', 'a same-named board that never mentions the company is not trusted');

  const roles = db.prepare("SELECT title, work_mode, salary_min, salary_max, equity, skills, apply_url, status FROM roles WHERE source = 'ats' ORDER BY title").all();
  assert.deepEqual(roles.map((r) => r.title), ['Founding Engineer', 'Senior Software Engineer']);
  const fe = roles[0];
  assert.equal(fe.work_mode, 'remote');
  assert.equal(fe.salary_min, 150000);
  assert.equal(fe.equity, 'Offers');
  assert.match(fe.skills, /React/);
  assert.equal(roles[1].work_mode, 'remote');
  assert.match(roles[1].skills, /TypeScript/);

  // Running again updates the same roles instead of duplicating them
  boards['https://boards-api.greenhouse.io/v1/boards/quiet-lab/jobs?content=true'].jobs[0].title = 'Staff Software Engineer';
  const again = await app.locals.importer.start();
  assert.deepEqual(again.errors, []);
  assert.equal(again.roles_added, 0);
  assert.equal(again.roles_updated, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roles WHERE source = 'ats'").get().n, 2);
  assert.equal(db.prepare("SELECT title FROM roles WHERE external_id = 'greenhouse:7'").get().title, 'Staff Software Engineer');
});

test('developers see imported roles, ranked by shared skills; a yes starts an application', async () => {
  const dev = client();
  await dev.signIn('dev@example.com', 'dev');
  await dev.req('PUT', '/profile', { name: 'Dee Example', headline: 'Engineer', skills: 'React, Node.js' });
  const deck = (await dev.req('GET', '/deck')).body;
  const tr = deck.find((c) => c.startup.name === 'Tiny Rocket');
  assert.ok(tr.apply_url.includes('ashbyhq.com'));
  assert.deepEqual(tr.sharedSkills.sort(), ['node.js', 'react']);
  assert.equal(deck[0].startup.name, 'Tiny Rocket', 'more shared skills ranks first');

  const r = (await dev.req('POST', `/deck/${tr.id}`, { liked: true })).body;
  assert.ok(r.apply_url.includes('/application'));
  assert.equal(r.waiting, 'profile', 'kept until the phone and work questions are filled in');
  const saved = (await dev.req('GET', '/saved')).body;
  assert.equal(saved[0].startup_name, 'Tiny Rocket');
});

test('re-import: removed posts close, startups that grow past 50 are retired', async () => {
  const db = app.locals.db;
  boards['https://api.ashbyhq.com/posting-api/job-board/tinyrocket?includeCompensation=true'].jobs.shift(); // Founding Engineer filled
  companies.find((c) => c.name === 'Quiet Lab').team_size = 60;
  const stats = await app.locals.importer.start();
  assert.deepEqual(stats.errors, []);
  assert.ok(stats.roles_closed >= 1);
  assert.equal(db.prepare("SELECT status FROM roles WHERE title = 'Founding Engineer'").get().status, 'closed', 'claimed startups still sync from their board');
  assert.equal(db.prepare("SELECT status FROM startups WHERE name = 'Quiet Lab'").get().status, 'retired');
  assert.equal(db.prepare("SELECT status FROM roles WHERE external_id = 'greenhouse:7'").get().status, 'closed');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM import_runs WHERE finished_at IS NOT NULL").get().n, 3);
});

test('admin can see import history and start a run', async () => {
  const admin = client();
  await admin.signIn('admin@hireme.test', 'dev');
  const info = (await admin.req('GET', '/admin/import')).body;
  assert.equal(info.runs.length, 3);
  assert.equal(info.running, false);
  assert.equal((await admin.req('POST', '/admin/import')).status, 202);
  const dev = client();
  await dev.signIn('nope@example.com', 'dev');
  assert.equal((await dev.req('POST', '/admin/import')).status, 403);
  await app.locals.importer.start(); // let it finish before the server closes
});
