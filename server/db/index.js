import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ROOT } from '../config.js';

const MIGRATIONS_DIR = path.join(ROOT, 'server', 'db', 'migrations');

let db = null;

/** Open (once) the durable database connection. */
export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
  db = new DatabaseSync(config.databaseFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Versioned, idempotent migrations. Never drops or resets existing tables. */
export function migrate({ quiet = false } = {}) {
  const database = getDb();
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    database.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      database.exec('COMMIT');
      count += 1;
      if (!quiet) console.log(`[migrate] applied ${file}`);
    } catch (err) {
      database.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  if (!quiet && count === 0) console.log('[migrate] database already up to date');
  return count;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/* ------------------------------------------------------------------ */
/* Small query helpers. All SQL is parameterised - never string-concat. */
/* ------------------------------------------------------------------ */

export const q = {
  all(sql, ...params) {
    return getDb().prepare(sql).all(...params);
  },
  get(sql, ...params) {
    return getDb().prepare(sql).get(...params) ?? null;
  },
  run(sql, ...params) {
    return getDb().prepare(sql).run(...params);
  },
};

/** Run a set of statements inside a transaction, rolling back on error. */
export function transaction(fn) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* rollback best-effort */
    }
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
export const iso = (d) => new Date(d).toISOString();
export const addSeconds = (date, seconds) => new Date(new Date(date).getTime() + seconds * 1000);
