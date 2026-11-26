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
      role TEXT NOT NULL DEFAULT '',           -- '' (not chosen yet) | dev | founder
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
  // startups.source: 'signup' (a founder added it) | 'yc' (imported). status adds 'listed' (imported, unclaimed) and 'retired'.
  addColumns('startups', [
    ['source', "TEXT NOT NULL DEFAULT 'signup'"],
    ['yc_slug', 'TEXT'],
    ['ats', 'TEXT'],
    ['ats_slug', 'TEXT'],
    ['ats_checked_at', 'TEXT'],
  ]);
  // roles.source: 'manual' (a founder wrote it) | 'ats' (imported from the startup's job board).
  addColumns('roles', [
    ['source', "TEXT NOT NULL DEFAULT 'manual'"],
    ['external_id', 'TEXT'],
    ['apply_url', 'TEXT'],
    ['posted_at', 'TEXT'],
  ]);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS roles_external ON roles (startup_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS roles_open ON roles (status, startup_id);
    CREATE INDEX IF NOT EXISTS startups_status ON startups (status);
  `);
  return db;
}

export const MAX_HEADCOUNT = 50;
