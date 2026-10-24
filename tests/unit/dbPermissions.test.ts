import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dbPath } from '@/lib/db/client';
import { dropDb, freshDb } from '../helpers/db';

// POSIX mode bits do not exist on Windows; the user's ACL protects the file there.
describe.skipIf(process.platform === 'win32')('database file permissions', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
  });

  afterEach(() => {
    dropDb(dir);
  });

  it('is readable by its owner only, like master.key', () => {
    // Every logged prompt lives in here; created under a default umask it was 0644.
    expect(statSync(dbPath()).mode & 0o777).toBe(0o600);
  });

  it('keeps the WAL file private too', () => {
    expect(statSync(join(dir, 'switchboard.db-wal')).mode & 0o777).toBe(0o600);
  });
});
