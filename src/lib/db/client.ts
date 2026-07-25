/**
 * Switchboard — SQLite connection.
 *
 * Uses Node's built-in `node:sqlite`. No native module, no build step, no
 * node-gyp, and no prebuilt-binary roulette on Windows. The tradeoff is a
 * synchronous API, which is fine: every query here is a point lookup or a
 * bounded scan against an indexed column.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { MIGRATIONS } from './schema';

let db: DatabaseSync | null = null;

/** Where the database, master key and backups live. */
export function dataDir(): string {
  const override = process.env.SWITCHBOARD_DATA_DIR;
  if (override) return override;

  // Packaged desktop builds get a real app-data directory; dev stays local.
  if (process.env.SWITCHBOARD_PACKAGED === '1') {
    const base =
      process.platform === 'win32'
        ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Application Support')
          : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
    return join(base, 'Switchboard');
  }

  return join(process.cwd(), 'data');
}

export function dbPath(): string {
  return join(dataDir(), 'switchboard.db');
}

/**
 * Returns the process-wide database handle, opening and migrating it on first
 * call. Next.js may re-evaluate modules across HMR boundaries in dev, so the
 * handle is also stashed on globalThis to avoid opening the file twice.
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  const g = globalThis as { __switchboardDb?: DatabaseSync };
  if (g.__switchboardDb) {
    db = g.__switchboardDb;
    return db;
  }

  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });

  const handle = new DatabaseSync(path);

  // WAL lets the dashboard read while the gateway writes.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');

  runMigrations(handle);

  db = handle;
  g.__switchboardDb = handle;
  return handle;
}

/**
 * Closes the handle and drops both caches, so the next `getDb()` reopens from
 * whatever `dataDir()` resolves to at that moment.
 *
 * Needed for an orderly shutdown — an open WAL handle at exit leaves `-wal` and
 * `-shm` files behind for the next process to recover — and it is what lets a
 * test point the whole data layer at a throwaway directory between cases.
 */
export function closeDb(): void {
  const g = globalThis as { __switchboardDb?: DatabaseSync };
  const handle = db ?? g.__switchboardDb;

  if (handle) {
    try {
      handle.close();
    } catch {
      // Already closed, or closed underneath us. Either way the caches go.
    }
  }

  db = null;
  delete g.__switchboardDb;
}

function runMigrations(handle: DatabaseSync): void {
  const row = handle.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  const current = row?.user_version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    handle.exec('BEGIN');
    try {
      handle.exec(migration.sql);
      // PRAGMA does not accept bound parameters; the value is a trusted int.
      handle.exec(`PRAGMA user_version = ${migration.version}`);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${String(err)}`,
      );
    }
  }
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transact<T>(fn: (handle: DatabaseSync) => T): T {
  const handle = getDb();
  handle.exec('BEGIN');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/** SQLite has no boolean type; these keep the intent readable at call sites. */
export const toInt = (value: boolean): number => (value ? 1 : 0);
export const toBool = (value: unknown): boolean => value === 1 || value === true;

/** Parses a JSON column, falling back to `fallback` on any malformed value. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function isDbInitialized(): boolean {
  return existsSync(dbPath());
}
