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
