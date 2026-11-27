// Passwordless sign-in: we email a one-time link, and opening it starts a 30-day session.
// Signing in proves the person controls that inbox. No passwords.
import { createHash, randomBytes } from 'node:crypto';
import { isEmail } from './rules.js';
import { createGoogleVerifier } from './google.js';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const COOKIE = 'hm_session';
const SESSION_DAYS = 30;
const LINK_MINUTES = 20;

export function createAuth(db, { mailer, publicUrl, adminEmails = [], production = false, log = console, ipLimit = 12, googleClientId = '', fetchImpl = fetch, claimGuest = () => ({ sent: [] }) }) {
  const verifyGoogle = createGoogleVerifier({ clientId: googleClientId, fetchImpl });
  const admins = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const hits = new Map();

  /** Simple in-memory rate limit: at most `max` calls per key per window. */
  function limited(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return list.length > max;
  }

  const cookies = (req) =>
    Object.fromEntries(
      String(req.get('cookie') || '')
        .split(';')
        .map((c) => c.trim().split('='))
        .filter(([k, v]) => k && v)
        .map(([k, v]) => [k, decodeURIComponent(v)]),
    );

  const secure = (req) => (publicUrl ? publicUrl.startsWith('https:') : req.secure);
  const baseUrl = (req) => publicUrl || `${req.protocol}://${req.get('host')}`;

  function setSession(req, res, userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO sessions (hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).run(sha(token), userId);
    res.append(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`,
    );
  }

  /**
   * Creates the account if needed (every account is a developer account) and starts a session.
   * If a guest account is signing in, its profile and swipes become this account's: a new email
   * turns the guest into a real account; an existing one absorbs it (see claimGuest in app.js).
   */
  function signIn(req, res, email, guestId) {
    const guest = guestId ? db.prepare('SELECT * FROM users WHERE id = ? AND is_guest = 1').get(guestId) : null;
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (guest && !user) {
      db.prepare('UPDATE users SET email = ?, is_guest = 0 WHERE id = ?').run(email, guest.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(guest.id);
    } else if (!user) {
      db.prepare("INSERT INTO users (email, role) VALUES (?, 'dev')").run(email);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }
    const claimed = guest ? claimGuest(guest.id, user.id) : { sent: [] };
    setSession(req, res, user.id);
    return { user, ...claimed };
  }

  const guestOf = (req) => (req.user?.isGuest ? req.user.id : null);

  const isAdmin = (user) => !!user && admins.has(user.email.toLowerCase());

  /** Attaches req.user (or null). Also guards against cross-site form posts. */
  function middleware(req, res, next) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // Browsers can't send application/json cross-site without a CORS preflight, which we never allow.
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
      const origin = req.get('origin');
      let sameSite = true;
      try {
        sameSite = !origin || new URL(origin).host === new URL(baseUrl(req)).host;
      } catch {
        sameSite = false;
      }
      if (!sameSite) return res.status(403).json({ error: 'Cross-site request blocked' });
    }
    req.user = null;
    const token = cookies(req)[COOKIE];
    if (token) {
      const row = db
        .prepare("SELECT u.*, s.hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > datetime('now')")
        .get(sha(token));
      if (row) {
        req.user = { id: row.id, email: row.is_guest ? '' : row.email, role: row.role, isAdmin: !row.is_guest && isAdmin(row), isGuest: !!row.is_guest, pendingEmail: row.is_guest ? row.pending_email || '' : '' };
        if (!row.last_seen_at || Date.now() - new Date(`${row.last_seen_at}Z`).getTime() > 60_000)
          db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(row.id);
      }
    }
    next();
  }

  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in first' }));
  const requireRole = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    if (req.user.role !== role) return res.status(403).json({ error: 'This is for developer accounts' });
    next();
  };
  const requireAdmin = (req, res, next) => (req.user?.isAdmin ? next() : res.status(403).json({ error: 'Admins only' }));

  function routes(app) {
    // "Get started" without signing up: a guest account with a session, so answers and swipes are kept.
    app.post('/api/auth/guest', (req, res) => {
      if (req.user) return res.json({ ok: true, existing: true });
      if (limited(`guest:${req.ip}`, 30, 3_600_000)) return res.status(429).json({ error: 'Too many new visitors from your network. Try again later.' });
      const email = `guest-${randomBytes(9).toString('hex')}@guest.hireme.invalid`;
      const id = Number(db.prepare("INSERT INTO users (email, role, is_guest) VALUES (?, 'dev', 1)").run(email).lastInsertRowid);
      setSession(req, res, id);
      res.status(201).json({ ok: true });
    });

    app.post('/api/auth/start', async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
      if (limited(`ip:${req.ip}`, ipLimit, 15 * 60_000) || limited(`email:${email}`, 4, 15 * 60_000))
        return res.status(429).json({ error: 'Too many sign-in emails. Wait a few minutes and try again.' });
      if (!mailer.configured && production) return res.status(503).json({ error: 'Email isn’t set up on this server yet (SMTP_URL).' });

      const token = randomBytes(32).toString('base64url');
      db.prepare("DELETE FROM login_tokens WHERE expires_at < datetime('now')").run();
      const existing = db.prepare('SELECT 1 FROM users WHERE email = ? AND is_guest = 0').get(email);
      // A guest confirming their email gets a day: their applications wait on this link.
      const minutes = guestOf(req) ? 24 * 60 : LINK_MINUTES;
      db.prepare(`INSERT INTO login_tokens (hash, email, intent, guest_id, expires_at) VALUES (?, ?, '', ?, datetime('now', '+${minutes} minutes'))`).run(
        sha(token),
        email,
        guestOf(req),
      );
      if (guestOf(req)) db.prepare('UPDATE users SET pending_email = ? WHERE id = ?').run(email, guestOf(req));
      const link = `${baseUrl(req)}/#/signin/${token}`;
      try {
        await mailer.send({
          to: email,
          subject: guestOf(req) && !existing ? 'Confirm your email to start applying' : 'Your HireMe sign-in link',
          text: guestOf(req) && existing
            ? `Tap this link to sign back in to HireMe. Your profile is right where you left it, and anything you swiped on just now comes with you:\n\n${link}\n\nIt works once and expires in 24 hours. If this wasn’t you, ignore this email.`
            : guestOf(req)
            ? `Tap this link to confirm your email. HireMe then sends the applications for the jobs you swipe right on, with this email as your contact:\n\n${link}\n\nIt works once and expires in 24 hours. If this wasn’t you, ignore this email and nothing will be sent.`
            : `Open this link to sign in to HireMe:\n\n${link}\n\nIt works once and expires in ${LINK_MINUTES} minutes. If you didn’t ask for it, ignore this email.`,
        });
      } catch (e) {
        log.error?.('sign-in email failed:', e.message);
        return res.status(502).json({ error: 'Couldn’t send the email. Try again in a minute.' });
      }
      res.json({ sent: true, ...(mailer.configured ? {} : { devLink: link }) });
    });

    app.post('/api/auth/verify', (req, res) => {
      const token = String(req.body?.token || '');
      const row = db.prepare("SELECT * FROM login_tokens WHERE hash = ? AND expires_at > datetime('now')").get(sha(token));
      if (!row) return res.status(400).json({ error: 'That sign-in link has expired or was already used. Request a new one.' });
      db.prepare('DELETE FROM login_tokens WHERE hash = ?').run(row.hash);
      // The guest is remembered on the link itself, so it works even if opened in another browser.
      const r = signIn(req, res, row.email, row.guest_id || guestOf(req));
      res.json({ ok: true, sent: r.sent });
    });

    // "Sign in with Google": the browser sends Google's signed ID token; Google has verified the email.
    app.post('/api/auth/google', async (req, res) => {
      if (limited(`gip:${req.ip}`, 30, 15 * 60_000)) return res.status(429).json({ error: 'Too many sign-in attempts. Wait a few minutes.' });
      let g;
      try {
        g = await verifyGoogle(req.body?.credential);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const r = signIn(req, res, g.email, guestOf(req));
      res.json({ ok: true, sent: r.sent });
    });

    app.post('/api/auth/logout', (req, res) => {
      const token = cookies(req)[COOKIE];
      if (token) db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha(token));
      res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.status(204).end();
    });
  }

  return { middleware, routes, requireUser, requireRole, requireAdmin, isAdmin, baseUrl, limited };
}
