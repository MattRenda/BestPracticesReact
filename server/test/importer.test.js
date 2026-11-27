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
// Hacker News "Who is hiring?": one thread, a few posts (only two qualify)
const HN_SEARCH = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=12';
pages[HN_SEARCH] = { hits: [{ objectID: '9000', title: 'Ask HN: Who is hiring? (November 2026)' }, { objectID: '8999', title: 'Ask HN: Who wants to be hired? (November 2026)' }] };
pages['https://hn.algolia.com/api/v1/items/9000'] = {
  children: [
    { id: 9101, created_at: '2026-11-02T16:00:00Z', text: 'Tiny Rocket (YC W25) | Senior Backend Engineer | Remote (US) | <a href="https:&#x2F;&#x2F;tinyrocket.example">https://tinyrocket.example</a><p>We build scheduling for clinics in Node.js and Postgres.<p>Email jobs [at] tinyrocket [dot] example with your resume.' },
    { id: 9102, created_at: '2026-11-02T17:00:00Z', text: 'Lumen Labs | Full-stack Engineer (React, Python) | San Francisco, CA | ONSITE<p>We&#x27;re a team of 8 building tools for labs.<p>Apply: hiring@lumenlabs.example' },
    { id: 9103, text: 'MegaCorp | Software Engineer | NYC<p>We have 400 employees. Email jobs@megacorp.example' },
    { id: 9104, text: 'NoMail Inc | Backend Engineer | Remote<p>A team of 5. Apply at <a href="https://jobs.ashbyhq.com/nomail">our board</a>' },
    { id: 9105, text: 'Acme | Sales Lead | Remote<p>A team of 4. sales-lead@acme.example' },
    { id: 9106, text: 'Mystery Co | Backend Engineer | Remote<p>Email me: dev@mystery.example' },
  ],
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
  assert.deepEqual(startups.map((s) => s.name), ['Lumen Labs', 'Quiet Lab', 'Sphere', 'Tiny Rocket'], 'listed even without a job board; never BigCo or Staffwise');
  assert.equal(stats.startups_added, 4);

  // Hacker News: only engineering posts that take email applications, at startups confirmed at 50 or fewer
  const hn = db.prepare("SELECT r.title, r.apply_email, r.apply_url, r.work_mode, s.name, s.headcount, s.source FROM roles r JOIN startups s ON s.id = r.startup_id WHERE r.source = 'hn' ORDER BY s.name").all();
  assert.deepEqual(
    hn.map((r) => [r.name, r.title, r.apply_email, r.headcount]),
    [
      ['Lumen Labs', 'Full-stack Engineer (React, Python)', 'hiring@lumenlabs.example', 8],
      ['Tiny Rocket', 'Senior Backend Engineer', 'jobs@tinyrocket.example', 6],
    ],
    'size from the post or from YC; never MegaCorp (400), NoMail (no email), Acme (sales) or Mystery (size unknown)',
  );
  assert.equal(hn[1].source, 'yc', 'joined to the YC startup it already knows');
  assert.equal(hn[1].apply_url, 'https://news.ycombinator.com/item?id=9101');
  assert.equal(hn[1].work_mode, 'remote');
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
  assert.equal(again.roles_updated, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM roles WHERE source = 'ats'").get().n, 2);
  assert.equal(db.prepare("SELECT title FROM roles WHERE external_id = 'greenhouse:7'").get().title, 'Staff Software Engineer');
});

test('developers see imported roles, ranked by shared skills; a yes starts an application', async () => {
  const dev = client();
  await dev.signIn('dev@example.com', 'dev');
  await dev.req('PUT', '/profile', { name: 'Dee Example', headline: 'Engineer', skills: 'React, Node.js' });
  // By default only roles HireMe can send by itself: the email ones
  let deck = (await dev.req('GET', '/deck')).body;
  assert.deepEqual(deck.map((c) => c.title).sort(), ['Full-stack Engineer (React, Python)', 'Senior Backend Engineer']);

  // An admin switches Ashby forms on
  const admin = client();
  await admin.signIn('admin@hireme.test', 'dev');
  const methods = (await admin.req('GET', '/admin/apply-methods')).body;
  assert.deepEqual(methods.map((m) => [m.id, m.openRoles]).slice(0, 2), [['email', 2], ['ashby', 1]]);
  await admin.req('POST', '/admin/apply-methods', { enabled: ['ashby'] });
  deck = (await dev.req('GET', '/deck')).body;
  const tr = deck.find((c) => c.title === 'Founding Engineer');
  assert.ok(tr.apply_url.includes('ashbyhq.com'));
  assert.deepEqual(tr.sharedSkills.sort(), ['node.js', 'react']);
  assert.ok(!deck.some((c) => c.startup.name === 'Quiet Lab'), 'Greenhouse still off');

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
