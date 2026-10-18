import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { htmlToText, matchesFilters, parseBoard } from '../src/feed.js';

delete process.env.ANTHROPIC_API_KEY;

const FIXTURES = {
  'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true': {
    jobs: [
      { id: 11, title: 'Senior React Engineer', location: { name: 'Remote - US' }, content: '&lt;p&gt;Build things&amp;amp;more&lt;/p&gt;', first_published: new Date().toISOString() },
      { id: 12, title: 'Sales Manager', location: { name: 'NYC' }, content: '' },
      { id: 13, title: 'Engineering Manager', location: { name: 'Remote' }, content: '' },
    ],
  },
  'https://api.lever.co/v0/postings/globex?mode=json': [
    { id: 'a', text: 'Full Stack Engineer', hostedUrl: 'https://jobs.lever.co/globex/a', applyUrl: 'https://jobs.lever.co/globex/a/apply', categories: { location: 'Sacramento, CA' }, descriptionPlain: 'Node and React', createdAt: Date.now() },
  ],
  'https://api.ashbyhq.com/posting-api/job-board/initech': {
    jobs: [{ id: 'z', title: 'Frontend Engineer', location: 'Austin, TX', isRemote: false, jobUrl: 'https://jobs.ashbyhq.com/initech/z', descriptionPlain: 'TS' }],
  },
};

const fakeFetch = async (url) =>
  FIXTURES[url]
    ? { ok: true, status: 200, json: async () => FIXTURES[url] }
    : { ok: false, status: 404, json: async () => ({}) };

let server, base, svc;
before(async () => {
  const app = createApp(openDb(':memory:'), { fetchImpl: fakeFetch });
  svc = app.locals.svc;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const req = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('parseBoard handles common links', () => {
  assert.deepEqual(parseBoard('https://boards.greenhouse.io/acme'), { ats: 'greenhouse', slug: 'acme' });
  assert.deepEqual(parseBoard('job-boards.greenhouse.io/acme/jobs/123'), { ats: 'greenhouse', slug: 'acme' });
  assert.deepEqual(parseBoard('https://boards.greenhouse.io/embed/job_board?for=acme'), { ats: 'greenhouse', slug: 'acme' });
  assert.deepEqual(parseBoard('https://jobs.lever.co/globex/abc'), { ats: 'lever', slug: 'globex' });
  assert.deepEqual(parseBoard('jobs.ashbyhq.com/initech'), { ats: 'ashby', slug: 'initech' });
  assert.equal(parseBoard('https://example.com/careers'), null);
});

test('htmlToText unescapes greenhouse content', () => {
  assert.equal(htmlToText('&lt;p&gt;Build things&amp;amp;more&lt;/p&gt;'), 'Build things&more');
});

test('filters: keywords, exclude, locations with remote', () => {
  const s = { keywords: 'engineer', exclude: 'manager', locations: 'sacramento', remoteOk: true };
  assert.ok(matchesFilters({ title: 'Senior React Engineer', location: 'Remote - US' }, s));
  assert.ok(!matchesFilters({ title: 'Engineering Manager', location: 'Remote' }, s));
  assert.ok(!matchesFilters({ title: 'Frontend Engineer', location: 'Austin, TX' }, s));
});

test('refresh → deck → swipe → apply queue → result', async () => {
  for (const url of ['boards.greenhouse.io/acme', 'jobs.lever.co/globex', 'jobs.ashbyhq.com/initech', 'jobs.lever.co/missing'])
    assert.equal((await req('POST', '/sources', { url })).status, 201);
  assert.equal((await req('POST', '/sources', { url: 'example.com' })).status, 400);
  await req('PUT', '/settings', { keywords: 'engineer', exclude: 'manager', locations: 'sacramento, austin', remoteOk: true });

  const r = await req('POST', '/feed/refresh');
  assert.equal(r.body.added, 3);
  assert.ok(r.body.report.find((x) => x.source === 'lever:missing').error);
  assert.equal((await req('POST', '/feed/refresh')).body.added, 0, 'no duplicates on second refresh');

  const deck = (await req('GET', '/deck')).body;
  assert.equal(deck.length, 3);
  const [first, second, third] = deck;

  await req('PUT', '/settings', { askQuestions: true });
  await req('POST', `/jobs/${first.id}/swipe`, { direction: 'right' });
  assert.equal(svc.getJob(first.id).apply_state, 'questions');
  const qs = (await req('GET', `/jobs/${first.id}/questions`)).body.questions;
  assert.ok(qs.some((q) => q.id === 'auth'), 'asks for missing work authorization');
  const released = await req('PUT', `/jobs/${first.id}/context`, { answers: { auth: 'Yes', sponsor: 'no' }, done: true });
  assert.equal(released.body.apply_state, 'pending');
  assert.equal((await req('GET', '/profile')).body.workAuthorized, 'yes', 'answer saved to profile');

  await req('POST', `/jobs/${second.id}/swipe`, { direction: 'left' });
  await req('POST', `/jobs/${third.id}/swipe`, { direction: 'right' });
  const undone = await req('POST', `/jobs/${third.id}/swipe`, { direction: 'undo' });
  assert.equal(undone.body.status, 'new');

  let stats = (await req('GET', '/stats')).body;
  assert.equal(stats.deck, 1);
  assert.equal(stats.applying, 1);

  const claimed = svc.claimNext();
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.apply_state, 'running');
  assert.equal(svc.claimNext(), null);
  const prepared = await svc.prepare(claimed);
  assert.ok(prepared.cover_letter.length > 50, 'cover letter generated before applying');

  const done = svc.recordResult(prepared, { state: 'done', fieldsFilled: 12 });
  assert.equal(done.status, 'applied');
  assert.ok(done.applied_at);

  // approval mode: right swipe waits in review until approved
  await req('PUT', '/settings', { askQuestions: false, requireApproval: true });
  await req('POST', `/jobs/${third.id}/swipe`, { direction: 'right' });
  assert.equal(svc.getJob(third.id).apply_state, 'review');
  assert.equal(svc.claimNext(), null);
  await req('POST', `/jobs/${third.id}/approve`);
  const c2 = svc.claimNext();
  assert.equal(c2.id, third.id);
  svc.recordResult(c2, { state: 'needs_you', error: 'CAPTCHA on page' });
  stats = (await req('GET', '/stats')).body;
  assert.equal(stats.needsYou, 1);
  const retried = await req('POST', `/jobs/${c2.id}/retry`);
  assert.equal(retried.body.apply_state, 'pending');
});
