import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '@/lib/db/client';

/**
 * Swaps in an empty database with the migrations applied.
 *
 * Call from `beforeEach` in any suite that writes rows. Each call moves
 * `SWITCHBOARD_DATA_DIR` to a fresh directory and drops the cached handle, so
 * tests cannot see each other's data and cannot depend on execution order.
 */
export function freshDb(): string {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-case-'));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  getDb();
  return dir;
}

/** Releases the handle so the temp directory can be removed on Windows. */
export function dropDb(dir?: string): void {
  closeDb();
  if (dir === undefined) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A held WAL file is not worth failing a passing test over.
  }
}

/** Row count for a table, for assertions about persistence side effects. */
export function countRows(table: string): number {
  // Table names are supplied by tests, never by input; SQLite cannot bind an
  // identifier, so interpolation is the only option here.
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
