import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.resolve('data', 'hireme.db');

export function openDb(file = DB_PATH) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL DEFAULT '',           -- dev (founder accounts were retired; see the end of openDb)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS login_tokens (
      hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dev_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      headline TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      work_pref TEXT NOT NULL DEFAULT 'any',   -- remote | hybrid | onsite | any
      years INTEGER,
      skills TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      experience TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '{}',
      salary_min INTEGER,
      visible INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS startups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      website TEXT NOT NULL,
      domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
      headcount INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      one_liner TEXT NOT NULL DEFAULT '',
      about TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      flags TEXT NOT NULL DEFAULT '',          -- reasons the admin should look twice
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
      review_note TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS startup_members (
      startup_id INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (startup_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      startup_id INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      work_mode TEXT NOT NULL DEFAULT 'remote', -- remote | hybrid | onsite
      salary_min INTEGER,
      salary_max INTEGER,
      equity TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',      -- open | closed
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A developer's swipe on a role.
    CREATE TABLE IF NOT EXISTS dev_swipes (
      dev_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      liked INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (dev_id, role_id)
    );

    -- A startup's swipe on a developer, for one of its roles.
    -- Founder swipes, matches and messages are from the earlier two-sided version; nothing writes them now.
    CREATE TABLE IF NOT EXISTS founder_swipes (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      dev_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      liked INTEGER NOT NULL,
      by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (role_id, dev_id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      dev_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      startup_id INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      closed_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (role_id, dev_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS messages_by_match ON messages (match_id, id);

    CREATE TABLE IF NOT EXISTS match_reads (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      last_emailed_at TEXT,
      PRIMARY KEY (match_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_type TEXT NOT NULL,               -- startup | dev
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (reporter_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      companies INTEGER, startups_added INTEGER, boards INTEGER,
      roles_added INTEGER, roles_updated INTEGER, roles_closed INTEGER,
      errors TEXT
    );
  `);

  // Columns added after launch. ALTER TABLE ADD COLUMN only when missing, so existing databases upgrade in place.
  const addColumns = (table, cols) => {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  // startups.source: 'signup' (added by a founder, from before HireMe was developer-only) | 'yc' (imported).
  // status: 'listed' (shown) | 'retired' (no longer hiring or over 50) | 'pending' (hidden after reports) | 'rejected' (removed by an admin).
  addColumns('startups', [
    ['source', "TEXT NOT NULL DEFAULT 'signup'"],
    ['yc_slug', 'TEXT'],
    ['ats', 'TEXT'],
    ['ats_slug', 'TEXT'],
    ['ats_checked_at', 'TEXT'],
    ['apply_email', 'TEXT'], // where applications to roles the startup posts on HireMe are emailed
  ]);
  // roles.source: 'manual' (old founder-written roles; not shown) | 'ats' (imported from the startup's job board)
  //   | 'hn' (Hacker News "Who is hiring?") | 'direct' (posted on HireMe by someone at the startup).
  addColumns('roles', [
    ['source', "TEXT NOT NULL DEFAULT 'manual'"],
    ['external_id', 'TEXT'],
    ['apply_url', 'TEXT'],
    ['posted_at', 'TEXT'],
    ['apply_email', 'TEXT'], // the startup takes applications by email (Hacker News "Who is hiring?" posts)
  ]);
  // Small key/value settings an admin can change (e.g. which form systems HireMe applies through).
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // Guests: people who started without signing up. A placeholder email until they add a real one.
  addColumns('users', [
    ['is_guest', 'INTEGER NOT NULL DEFAULT 0'],
    ['pending_email', 'TEXT'], // a guest's email, waiting for them to tap the confirmation link
  ]);
  // The guest account that asked for a sign-in link, so its answers and swipes carry over.
  addColumns('login_tokens', [['guest_id', 'INTEGER']]);
  // What HireMe needs to apply on a developer's behalf.
  addColumns('dev_profiles', [
    ['phone', "TEXT NOT NULL DEFAULT ''"],
    ['work_authorized', "TEXT NOT NULL DEFAULT ''"], // yes | no | ''
    ['needs_sponsorship', "TEXT NOT NULL DEFAULT ''"],
    ['resume_file', 'TEXT'], // stored under <data>/resumes
    ['resume_name', 'TEXT'],
    ['auto_apply', 'INTEGER NOT NULL DEFAULT 0'], // no longer used: swiping right is the consent
    ['saved_answers', "TEXT NOT NULL DEFAULT '[]'"], // [{question, answer}]
    // Answers HireMe gives to common form questions; empty means the default (see formDefaults).
    ['form_salary', "TEXT NOT NULL DEFAULT ''"],
    ['form_notice', "TEXT NOT NULL DEFAULT ''"],
    ['form_relocate', "TEXT NOT NULL DEFAULT ''"], // yes | no | ''
    ['form_onsite', "TEXT NOT NULL DEFAULT ''"], // yes | no | ''
    ['review_first', 'INTEGER NOT NULL DEFAULT 0'], // fill each form, then wait for the developer to say send
  ]);
  db.exec(`
    -- Applications HireMe submits for developers to startups that aren't on HireMe yet.
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dev_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'queued', -- queued | running | submitted | needs_you | failed | canceled | self_applied
      error TEXT NOT NULL DEFAULT '',
      missing TEXT NOT NULL DEFAULT '[]',   -- questions only the developer can answer
      answers TEXT NOT NULL DEFAULT '[]',   -- what was sent for open questions, and where it came from
      cover_note TEXT NOT NULL DEFAULT '',
      screenshot TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT,
      UNIQUE (dev_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS applications_queue ON applications (state, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS roles_external ON roles (startup_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS roles_open ON roles (status, startup_id);
    CREATE INDEX IF NOT EXISTS startups_status ON startups (status);
  `);
  // 'review': filled and waiting for the developer to say send (review_first). approved = they said send.
  addColumns('applications', [['approved', 'INTEGER NOT NULL DEFAULT 0']]);

  // One-time: retry applications that stopped to ask, now that HireMe answers most extra questions itself.
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    db.exec("UPDATE applications SET state = 'queued', error = '', missing = '[]', updated_at = datetime('now') WHERE state = 'needs_you'");
    db.exec('PRAGMA user_version = 1');
  }
  // One-time: blocked submits (CAPTCHA, no confirmation, form errors) are quiet failures now, not to-dos.
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    db.exec(`UPDATE applications SET state = 'failed', error = 'Didn’t go through: the site has a bot check or didn’t confirm it. You can apply on their site'
             WHERE state = 'needs_you' AND (error LIKE '%CAPTCHA%' OR error LIKE '%didn’t confirm%' OR error LIKE '%Submit button%' OR error LIKE '%didn’t accept%')`);
    db.exec('PRAGMA user_version = 2');
  }

  // HireMe is for developers only now: founder accounts (and accounts that never picked) become developers.
  db.exec("UPDATE users SET role = 'dev' WHERE role != 'dev'");

  return db;
}

export const MAX_HEADCOUNT = 50;
