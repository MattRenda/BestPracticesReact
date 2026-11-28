// Encrypts the API keys startups give HireMe (their Greenhouse, Lever or Ashby key) before they're stored.
// The encryption key comes from DATA_KEY, or a random one kept next to the database the first time.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function createSecrets({ dataDir, env = process.env }) {
  let key;
  if (env.DATA_KEY) key = createHash('sha256').update(env.DATA_KEY).digest();
  else {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'data.key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  }
  return {
    seal(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
    },
    open(sealed) {
      if (!sealed?.startsWith('v1:')) return '';
      try {
        const raw = Buffer.from(sealed.slice(3), 'base64');
        const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
      } catch {
        return '';
      }
    },
  };
}
