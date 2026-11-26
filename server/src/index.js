import { openDb } from './db.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

const db = openDb();
const app = createApp(db);

// Housekeeping: drop expired sign-in links and sessions once an hour.
setInterval(() => {
  db.prepare("DELETE FROM login_tokens WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}, 3_600_000).unref();

app.listen(PORT, HOST, () => {
  console.log(`HireMe running at ${process.env.PUBLIC_URL || `http://localhost:${PORT}`}`);
  if (!app.locals.mailer.configured)
    console.log(
      process.env.NODE_ENV === 'production'
        ? 'SMTP_URL not set — nobody can sign in until it is.'
        : 'SMTP_URL not set — sign-in links are shown on screen and printed here instead of emailed.',
    );
  if (!process.env.ADMIN_EMAILS) console.log('ADMIN_EMAILS not set — nobody can approve startups yet.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
