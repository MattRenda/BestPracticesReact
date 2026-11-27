// Fills a database with fictional startups, roles and developers so you can try HireMe locally.
// The demo job links point at .example sites, so HireMe can't actually apply to them.
// Usage: DB_PATH=./data/demo.db node scripts/demo.js   (never point this at your real database)
// All companies use the reserved .example domain so they can't be mistaken for real ones.
import { openDb } from '../src/db.js';

const file = process.env.DB_PATH;
if (!file || !/demo/.test(file)) {
  console.error('Set DB_PATH to a demo database, e.g. DB_PATH=./data/demo.db');
  process.exit(1);
}
const db = openDb(file);

const user = (email) => {
  db.prepare("INSERT OR IGNORE INTO users (email, role) VALUES (?, 'dev')").run(email);
  return db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
};

const STARTUPS = [
  {
    name: 'Tiny Rocket',
    domain: 'tinyrocket.example',
    headcount: 6,
    stage: 'Seed',
    location: 'Remote · US',
    one_liner: 'Scheduling and reminders for small clinics',
    about: 'Two founders who ran a physical therapy clinic and got tired of no-shows. 140 clinics pay for Tiny Rocket today.',
    roles: [
      {
        title: 'Founding Full-Stack Engineer',
        skills: 'React, Node.js, TypeScript, Postgres',
        work_mode: 'remote',
        location: 'US time zones',
        salary_min: 150000,
        salary_max: 180000,
        equity: '0.75–1.25%',
        description:
          'You’ll be engineer #2, working directly with the CTO.\n\nOwn features end to end: the booking flow patients see, the calendar staff live in, and the SMS reminders that keep clinics full.\n\nWe ship small and often, talk to customers every week, and don’t do sprints for the sake of sprints.',
      },
      { title: 'Mobile Engineer (React Native)', skills: 'React Native, TypeScript, Expo', work_mode: 'remote', location: 'US', salary_min: 140000, salary_max: 165000, equity: '0.5%', description: 'Build our first patient app — check-in, forms, and reminders on iOS and Android.' },
    ],
  },
  {
    name: 'Bramble Robotics',
    domain: 'bramble.example',
    headcount: 14,
    stage: 'Series A',
    location: 'Sacramento, CA',
    one_liner: 'Weeding robots for organic farms',
    about: 'Our robots pull weeds so farms don’t spray. Running on 30 farms across the Central Valley.',
    roles: [
      { title: 'Senior Frontend Engineer', skills: 'React, TypeScript, Mapbox, WebSockets', work_mode: 'hybrid', location: 'Sacramento, CA', salary_min: 160000, salary_max: 190000, equity: '0.2%', description: 'Build the fleet dashboard growers use to plan routes, watch robots live and see what got weeded.' },
    ],
  },
  {
    name: 'Quiet Lab',
    domain: 'quietlab.example',
    headcount: 3,
    stage: 'Pre-seed',
    location: 'Remote',
    one_liner: 'Focus tools for people with noisy jobs',
    about: 'Three of us, one paying product, profitable since month four.',
    roles: [{ title: 'Product Engineer', skills: 'React, Node.js, Chrome extensions', work_mode: 'remote', location: 'Anywhere', salary_min: 120000, salary_max: 150000, equity: '1–2%', description: 'Build our Chrome extension and the web app behind it. You’ll talk to users as much as you code.' }],
  },
  {
    name: 'Ledgerleaf',
    domain: 'ledgerleaf.example',
    headcount: 22,
    stage: 'Series A',
    location: 'Remote · US',
    one_liner: 'Bookkeeping for landscapers and trades',
    about: 'Bookkeeping built for people who work outside. 4,000 small businesses use us.',
    roles: [{ title: 'Backend Engineer, Payments', skills: 'Node.js, Express, Postgres, AWS', work_mode: 'remote', location: 'US', salary_min: 155000, salary_max: 185000, equity: '0.15%', description: 'Own the services that move money: invoices, card payments, and payouts.' }],
  },
];

const DEVS = [
  { email: 'jo@dev.example', name: 'Jo Park', headline: 'Frontend engineer who likes design systems', location: 'Portland, OR', years: 6, skills: 'React, TypeScript, CSS, Storybook', work_pref: 'remote', bio: 'I build interfaces people enjoy using. Looking for a small team where I can own the whole frontend.' },
  { email: 'sam@dev.example', name: 'Sam Ortiz', headline: 'Full-stack · Node and React', location: 'Sacramento, CA', years: 9, skills: 'Node.js, React, Postgres, AWS', work_pref: 'hybrid', bio: 'Nine years shipping web apps for agencies and one startup that didn’t make it. Ready for the next one.' },
  { email: 'ari@dev.example', name: 'Ari Chen', headline: 'Mobile engineer, React Native', location: 'Remote', years: 4, skills: 'React Native, TypeScript, Expo, GraphQL', work_pref: 'remote', bio: 'Shipped three apps to the stores, one with 200k users.' },
];

for (const s of STARTUPS) {
  db.prepare(
    `INSERT OR IGNORE INTO startups (name, website, domain, headcount, stage, one_liner, about, location, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'listed', 'yc')`,
  ).run(s.name, `https://${s.domain}`, s.domain, s.headcount, s.stage, s.one_liner, s.about, s.location);
  const sid = db.prepare('SELECT id FROM startups WHERE domain = ?').get(s.domain).id;
  if (!db.prepare('SELECT 1 FROM roles WHERE startup_id = ?').get(sid))
    s.roles.forEach((r, i) =>
      db
        .prepare(
          `INSERT INTO roles (startup_id, title, description, location, work_mode, salary_min, salary_max, equity, skills, source, external_id, apply_url)
           VALUES (?,?,?,?,?,?,?,?,?,'ats',?,?)`,
        )
        .run(sid, r.title, r.description, r.location, r.work_mode, r.salary_min, r.salary_max, r.equity, r.skills, `demo:${sid}:${i}`, `https://${s.domain}/jobs/${i + 1}`),
    );
}

for (const d of DEVS) {
  const id = user(d.email);
  db.prepare(
    `INSERT OR IGNORE INTO dev_profiles (user_id, name, headline, location, years, skills, bio, work_pref, links)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(id, d.name, d.headline, d.location, d.years, d.skills, d.bio, d.work_pref);
}

console.log(`Demo data ready in ${file}. Sign in with jo@dev.example (profile already filled in) or any email for a new account.`);
