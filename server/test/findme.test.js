import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFindMe } from '../src/findme.js';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function fakeGitHub(calls = []) {
  return async (url) => {
    const u = decodeURIComponent(url.replace('https://api.github.com', ''));
    calls.push(u);
    if (u.startsWith('/search/commits?q=author-email:dana@example.com')) return json({ items: [{ author: { login: 'danadev' } }] });
    if (u.startsWith('/search/users?q=dana@example.com in:email')) return json({ items: [] });
    if (u.startsWith('/search/users?q=fullname:"Dana Smith"')) return json({ items: [{ login: 'dana-smith-art' }, { login: 'danadev' }] });
    if (u.startsWith('/search/users?q=Smith in:login')) return json({ items: [{ login: 'dsmith' }, { login: 'johnsmith' }, { login: 'danasmith99' }] });
    const user = u.match(/^\/users\/([\w-]+)$/)?.[1];
    if (user)
      return json({
        login: user,
        type: 'User',
        name: { danadev: 'Dana Smith', 'dana-smith-art': 'Dana Smith' }[user] || '',
        location: user === 'danadev' ? 'Sacramento, CA' : 'Paris',
        html_url: `https://github.com/${user}`,
        public_repos: 12,
        blog: user === 'danadev' ? 'dana.dev' : '',
      });
    if (/^\/users\/danadev\/social_accounts/.test(u)) return json([{ provider: 'linkedin', url: 'https://www.linkedin.com/in/dana-smith-123' }]);
    if (/social_accounts/.test(u)) return json([]);
    return json({}, 404);
  };
}

test('finds the developer by commit email, name, username and city; LinkedIn from their GitHub', async () => {
  const calls = [];
  const f = createFindMe({ fetchImpl: fakeGitHub(calls), log: { info() {} } });
  const r = await f.find({ name: 'Dana Smith', emails: ['dana@example.com', 'guest-1@guest.hireme.invalid'], location: 'Sacramento, CA' });
  assert.equal(r[0].login, 'danadev');
  assert.equal(r[0].strong, true);
  assert.equal(r[0].linkedin, 'https://www.linkedin.com/in/dana-smith-123');
  assert.equal(r[0].website, 'https://dana.dev');
  assert.deepEqual(r[0].why, ['Your email is on its commits', 'Same name', 'Same city']);
  assert.ok(r.some((c) => c.login === 'dsmith') && r.some((c) => c.login === 'danasmith99'), 'username guesses');
  assert.ok(!r.some((c) => c.login === 'johnsmith'));
  assert.ok(!calls.some((c) => c.includes('invalid')), 'placeholder guest emails are never searched');
  // Same person again within the hour: no new GitHub calls
  const n = calls.length;
  await f.find({ name: 'Dana Smith', emails: ['dana@example.com'], location: 'Sacramento, CA' });
  assert.equal(calls.length, n);
});

test('GitHub rate limit comes back as a friendly error', async () => {
  const f = createFindMe({ fetchImpl: async () => json({ message: 'rate limit' }, 403), log: { info() {} } });
  await assert.rejects(f.find({ name: 'Dana Smith', emails: [] }), /GitHub is busy/);
});

test('LinkedIn from the developer’s own website; private addresses are never fetched', async () => {
  const { linkedinIn, privateAddress, fetchPublicPage } = await import('../src/safe-fetch.js');
  assert.equal(linkedinIn('<a href="https://linkedin.com/in/dana-smith-1a2b/">LinkedIn</a>'), 'https://www.linkedin.com/in/dana-smith-1a2b');
  assert.equal(linkedinIn('<a href="https://www.linkedin.com/company/acme">'), '');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1'])
    assert.ok(privateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '140.82.112.3', '2606:4700::1111']) assert.ok(!privateAddress(ip), ip);
  let fetched = 0;
  const fetchImpl = async () => (fetched++, new Response('<a href="https://linkedin.com/in/x-y-z">', { headers: { 'content-type': 'text/html' } }));
  assert.equal(await fetchPublicPage('http://127.0.0.1/', { fetchImpl }), '');
  assert.equal(await fetchPublicPage('http://localhost:3000/', { fetchImpl }), '');
  assert.equal(await fetchPublicPage('file:///etc/passwd', { fetchImpl }), '');
  assert.equal(fetched, 0);
  // A public site that redirects to a private address stops there
  let hop = 0;
  const redirecting = async () => (hop++ ? new Response('secret') : new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
  assert.equal(await fetchPublicPage('https://dana.dev', { fetchImpl: redirecting, resolve: async (u) => { if (u.hostname.startsWith('169.')) throw new Error('private'); } }), '');
  assert.equal(hop, 1);

  const f = createFindMe({ fetchImpl: fakeGitHub(), log: { info() {} }, pageFetch: async (u) => (u === 'https://dana.dev' ? '<a href="https://www.linkedin.com/in/dana-from-site">' : '') });
  assert.equal(await f.linkedinFromSite('https://dana.dev'), 'https://www.linkedin.com/in/dana-from-site');
  assert.equal(await f.linkedinFromSite('https://github.com/dana'), '');
});

test('LinkedIn profiles from web search results (not LinkedIn): name and city decide, the developer picks', async () => {
  const queries = [];
  const fetchImpl = async (url, opts) => {
    queries.push(decodeURIComponent(new URL(url).searchParams.get('q')));
    assert.equal(opts.headers['x-subscription-token'], 'k');
    return json({
      web: {
        results: [
          { title: 'Dana Smith - Senior Software Engineer - Lumen Labs | LinkedIn', url: 'https://www.linkedin.com/in/dana-smith-1a2b', description: '<strong>Dana Smith</strong>. Senior Software Engineer. Location: Sacramento · 500+ connections' },
          { title: 'Dana Smith - Nurse - Mercy | LinkedIn', url: 'https://www.linkedin.com/in/danasmithrn', description: 'Location: Boston' },
          { title: 'Dana Smith - Senior Software Engineer | LinkedIn', url: 'https://linkedin.com/in/dana-smith-1a2b?trk=x', description: 'dup' },
          { title: 'Lumen Labs | LinkedIn', url: 'https://www.linkedin.com/company/lumen', description: 'company page' },
          { title: 'John Doe - Engineer | LinkedIn', url: 'https://www.linkedin.com/in/jdoe', description: 'Location: Ohio' },
        ],
      },
    });
  };
  const f = createFindMe({ fetchImpl, braveKey: 'k', log: { info() {} } });
  const r = await f.searchLinkedin({ name: 'Dana Smith', location: 'Sacramento, CA' });
  assert.equal(queries[0], 'site:linkedin.com/in "Dana Smith" Sacramento');
  assert.deepEqual(
    r.map((c) => [c.url, c.strong, c.why.join(', ')]),
    [
      ['https://www.linkedin.com/in/dana-smith-1a2b', true, 'Same name, Same city'],
      ['https://www.linkedin.com/in/danasmithrn', false, 'Same name'],
    ],
  );
  assert.equal(r[0].headline, 'Senior Software Engineer · Lumen Labs');
  assert.equal(r[0].location, 'Sacramento');
  assert.equal(await createFindMe({ fetchImpl, braveKey: '', log: { info() {} } }).searchLinkedin({ name: 'Dana Smith' }), null, 'off without a key');
});

test('LinkedIn search stops when the monthly budget is used up', async () => {
  let calls = 0;
  let budget = 1;
  const fetchImpl = async () => (calls++, json({ web: { results: [] } }));
  const f = createFindMe({ fetchImpl, braveKey: 'k', log: { info() {} }, spendSearch: () => budget-- > 0 });
  assert.deepEqual(await f.searchLinkedin({ name: 'Dana Smith', location: 'Sacramento, CA' }), []);
  assert.equal(calls, 1, 'the second (no-city) search was skipped');
  await f.searchLinkedin({ name: 'Dana Smith' });
  assert.equal(calls, 1);
});
