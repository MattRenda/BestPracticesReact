import { openDb } from './db.js';
import { createApp } from './app.js';
import { createServices } from './services.js';
import { createAgent } from './agent/agent.js';

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';
const LOCAL = /^(127\.0\.0\.1|localhost|::1)$/.test(HOST);

if (!LOCAL && !process.env.SPROUT_TOKEN) {
  console.error('Refusing to listen on the network without SPROUT_TOKEN. Set SPROUT_TOKEN to an access code you will enter on your phone.');
  process.exit(1);
}

const db = openDb();
const svc = createServices(db);
const agent = process.env.AGENT === 'off' ? null : createAgent(svc);
const app = createApp(db, { agent });

app.listen(PORT, HOST, () => {
  console.log(`Sprout running at http://${LOCAL ? 'localhost' : HOST}:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log('ANTHROPIC_API_KEY not set — using templates; no tailored resumes or AI answers.');
  if (!agent) console.log('Apply agent is off (AGENT=off).');
  if (svc.getSettings().practiceMode) console.log('Practice mode is on: forms are filled but not submitted. Turn it off in Settings.');
});

// Pull new jobs into the deck on a schedule.
async function scheduledRefresh() {
  const hours = Number(svc.getSettings().autoRefreshHours) || 0;
  if (hours > 0) {
    try {
      const r = await app.locals.refreshFeed();
      if (r.added) console.log(`[feed] ${r.added} new jobs in your deck`);
    } catch (e) {
      console.warn('[feed] refresh failed:', e.message);
    }
  }
  setTimeout(scheduledRefresh, Math.max(hours, 1) * 3_600_000).unref();
}
setTimeout(scheduledRefresh, 10_000).unref();

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => {
    await agent?.stop();
    process.exit(0);
  });
