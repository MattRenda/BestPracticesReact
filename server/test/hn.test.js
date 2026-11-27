import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEmail, parseHiringPost, teamSizeFrom } from '../src/hn.js';

test('emails, including the spelled-out kind', () => {
  assert.equal(findEmail('Reach out: jobs [at] acme [dot] io'), 'jobs@acme.io');
  assert.equal(findEmail('email hiring (at) foo (dot) co (dot) uk'), 'hiring@foo.co.uk');
  assert.equal(findEmail('Send to ana at acme dot dev please'), 'ana@acme.dev');
  assert.equal(findEmail('privacy@acme.io or careers@acme.io'), 'careers@acme.io', 'skips addresses that aren’t for applying');
  assert.equal(findEmail('Apply on our site'), '');
});

test('HN text: hex entities and bare <p> paragraphs', async () => {
  const { hnText } = await import('../src/hn.js');
  assert.equal(hnText('We&#x27;re hiring<p>Email jobs&#x2F;careers'), "We're hiring\n\nEmail jobs/careers");
});

test('team size only when the post says it', () => {
  assert.equal(teamSizeFrom("We're a team of 12 in SF"), 12);
  assert.equal(teamSizeFrom('a 6-person team'), 6);
  assert.equal(teamSizeFrom('We are 9 people'), 9);
  assert.equal(teamSizeFrom('15 employees, profitable'), 15);
  assert.equal(teamSizeFrom('8 engineers so far'), null, 'engineers alone don’t bound the team');
  assert.equal(teamSizeFrom('small but mighty'), null);
});

test('posts: engineering roles that take email applications, nothing else', () => {
  const p = parseHiringPost('Lumen Labs (YC S24) | Senior Software Engineer | Remote (US) | <a href="https://lumen.example">lumen.example</a><p>Team of 7.<p>Email jobs@lumen.example');
  assert.equal(p.company, 'Lumen Labs');
  assert.equal(p.yc, true);
  assert.equal(p.title, 'Senior Software Engineer');
  assert.equal(p.workMode, 'remote');
  assert.equal(p.website, 'https://lumen.example');
  assert.equal(p.teamSize, 7);
  assert.equal(parseHiringPost('Lumen | Account Executive | NYC<p>sales@lumen.example'), null, 'not engineering');
  assert.equal(parseHiringPost('Lumen | Backend Engineer | NYC<p>Apply via our site, please do not email.<p>jobs@lumen.example'), null);
  assert.equal(parseHiringPost('TalentBridge | Software Engineer | Remote<p>We recruit for our client, a fintech. jobs@tb.example'), null, 'recruiters');
});

test('early-stage signals count as small', async () => {
  const { earlyStageFrom } = await import('../src/hn.js');
  assert.equal(earlyStageFrom('We just closed a $3M seed round'), 'Seed');
  assert.equal(earlyStageFrom('pre-seed, two founders'), 'Pre-seed');
  assert.equal(earlyStageFrom('Hiring our founding engineer'), 'Founding team');
  assert.equal(earlyStageFrom('We are a Series C company, 400 people'), null);
  assert.equal(earlyStageFrom('Grow from seed to scale with our platform'), null);
});
