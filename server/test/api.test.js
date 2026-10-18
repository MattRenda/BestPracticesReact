import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { bestSavedAnswer, profileAnswer } from '../src/match.js';

delete process.env.ANTHROPIC_API_KEY;
let server, base;

before(async () => {
  server = createApp(openDb(':memory:')).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const req = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('profile round-trips and merges', async () => {
  await req('PUT', '/profile', { firstName: 'Matt', email: 'm@example.com' });
  const { body } = await req('PUT', '/profile', { lastName: 'R', requireSponsorship: 'no', workAuthorized: 'yes' });
  assert.equal(body.firstName, 'Matt');
  assert.equal(body.lastName, 'R');
});

test('jobs: create, upsert by url, status change sets applied_at', async () => {
  const a = await req('POST', '/jobs', { url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'Engineer' });
  assert.equal(a.status, 201);
  const b = await req('POST', '/jobs', { url: 'https://boards.greenhouse.io/acme/jobs/1', location: 'Remote' });
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.location, 'Remote');
  const c = await req('PATCH', `/jobs/${a.body.id}`, { status: 'applied' });
  assert.ok(c.body.applied_at);
  assert.equal((await req('PATCH', `/jobs/${a.body.id}`, { status: 'nope' })).status, 400);
  const detail = await req('GET', `/jobs/${a.body.id}`);
  assert.ok(detail.body.events.some((e) => e.kind === 'status'));
});

test('stats count applied jobs', async () => {
  const stats = await req('GET', '/stats');
  assert.ok(stats.body.byStatus.applied >= 1);
  assert.equal(stats.body.practiceMode, true, 'practice mode is on by default');
});

test('auth token is enforced when set', async () => {
  const s = createApp(openDb(':memory:'), { token: 'secret' }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const u = `http://127.0.0.1:${s.address().port}/api`;
  assert.equal((await fetch(u + '/profile')).status, 401);
  assert.equal((await fetch(u + '/profile', { headers: { authorization: 'Bearer secret' } })).status, 200);
  assert.equal((await fetch(u + '/health')).status, 200);
  s.close();
});

test('answer: profile rule, then saved answer, then template', async () => {
  const s = await req('POST', '/answer', { question: 'Will you now or in the future require visa sponsorship?' });
  assert.deepEqual([s.body.answer, s.body.source], ['No', 'profile']);
  await req('POST', '/answers', { question: 'Why do you want to work here?', answer: 'Because of the mission.' });
  const saved = await req('POST', '/answer', { question: 'Why do you want to work at our company?' });
  assert.equal(saved.body.source, 'saved');
  const gen = await req('POST', '/answer', { question: 'Describe a hard bug you fixed', generate: false });
  assert.equal(gen.body.source, 'none');
});

test('cover letter template uses job and profile', async () => {
  const job = await req('POST', '/jobs', { company: 'Globex', title: 'Frontend Dev' });
  const { body } = await req('POST', `/jobs/${job.body.id}/cover-letter`);
  assert.match(body.cover_letter, /Globex/);
  assert.match(body.cover_letter, /Matt R/);
});

test('matching helpers', () => {
  assert.equal(profileAnswer('Are you legally authorized to work in the United States?', { workAuthorized: 'yes' }), 'Yes');
  assert.equal(bestSavedAnswer('favorite color', [{ question: 'Why this role?', answer: 'x' }]), null);
});
