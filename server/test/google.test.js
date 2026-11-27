import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

// A stand-in for Google: our own RSA key, published at Google's certs URL through a fake fetch.
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const fakeFetch = async (url) =>
  url === 'https://www.googleapis.com/oauth2/v3/certs'
    ? { ok: true, status: 200, json: async () => ({ keys: [jwk] }) }
    : { ok: false, status: 404, json: async () => ({}) };

function idToken(claims = {}, { kid = 'k1', key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '123', email: 'dana@gmail.com', email_verified: true, iat: now, exp: now + 3600, ...claims }),
  ).toString('base64url');
  const sig = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

let server, base;
before(async () => {
  const app = createApp(openDb(':memory:'), {
    mailer: { configured: false, send: async () => {} },
    log: { info() {}, warn() {}, error() {} },
    dataDir: mkdtempSync(path.join(tmpdir(), 'hireme-')),
    applierOptions: { autoStart: false },
    googleClientId: CLIENT_ID,
    fetchImpl: fakeFetch,
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function google(credential, intent) {
  const res = await fetch(`${base}/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential, intent }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const body = await res.json();
  const me = cookie ? await (await fetch(`${base}/me`, { headers: { cookie } })).json() : null;
  return { status: res.status, body, me };
}

test('config exposes the public client ID', async () => {
  assert.equal((await (await fetch(`${base}/config`)).json()).googleClientId, CLIENT_ID);
});

test('a valid Google token signs in and creates the account', async () => {
  const r = await google(idToken(), 'dev');
  assert.equal(r.status, 200);
  assert.equal(r.me.user.email, 'dana@gmail.com');
  assert.equal(r.me.user.role, 'dev');
  // Signing in again later keeps the same account and role
  const again = await google(idToken({ email: 'Dana@Gmail.com' }), 'founder');
  assert.equal(again.me.user.id, r.me.user.id);
  assert.equal(again.me.user.role, 'dev');
});

test('tokens that are forged, for another app, expired or unverified are refused', async () => {
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const good = idToken({ email: 'x@example.com' });
  const [h, , s] = good.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'admin@example.com', email_verified: true, exp: 9e9 })).toString('base64url')}.${s}`;
  for (const [token, why] of [
    [idToken({}, { key: otherKey }), 'signed by someone else'],
    [tampered, 'payload changed after signing'],
    [idToken({ aud: 'someone-elses-app' }), 'wrong audience'],
    [idToken({ iss: 'https://evil.example' }), 'wrong issuer'],
    [idToken({ exp: Math.floor(Date.now() / 1000) - 3600 }), 'expired'],
    [idToken({ email_verified: false }), 'email not verified'],
    [idToken({}, { kid: 'unknown' }), 'unknown key'],
    ['not-a-jwt', 'garbage'],
  ]) {
    const r = await google(token, 'dev');
    assert.equal(r.status, 400, why);
    assert.equal(r.me, null, `no session: ${why}`);
  }
});

test('any Google account signs in as a developer (there are no founder accounts)', async () => {
  const r = await google(idToken({ email: 'ana@tinyrocket.example', hd: 'tinyrocket.example' }), 'founder');
  assert.equal(r.status, 200);
  assert.equal(r.me.user.role, 'dev');
});
