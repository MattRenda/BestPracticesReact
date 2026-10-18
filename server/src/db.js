import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.resolve('data', 'sprout.db');

export function openDb(file = DB_PATH) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;

    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO profile (id, data) VALUES (1, '{}');

    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      company TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL DEFAULT '',
      posted_at TEXT,
      apply_state TEXT NOT NULL DEFAULT '',
      apply_error TEXT NOT NULL DEFAULT '',
      apply_started_at TEXT,
      context TEXT NOT NULL DEFAULT '{}',
      tailored_resume TEXT NOT NULL DEFAULT '',
      screenshot TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      cover_letter TEXT NOT NULL DEFAULT '',
      applied_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ats TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      last_fetched_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      UNIQUE (ats, slug)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL DEFAULT '{}'
    );
    INSERT OR IGNORE INTO settings (id, data) VALUES (1, '{}');

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// new = in the swipe deck; queued = approved (right swipe), waiting to be applied.
// apply_state: '' | review (waiting for your approval) | pending | running | done | needs_you | failed
export const JOB_STATUSES = ['new', 'queued', 'applied', 'interviewing', 'offer', 'rejected', 'skipped'];
