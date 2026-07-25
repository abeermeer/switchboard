import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/**
 * Points the whole data layer at a throwaway directory for the lifetime of the
 * test file.
 *
 * This runs before any test module is imported, which matters: `dataDir()`
 * reads the environment on every call, but the master key and the SQLite handle
 * are cached in module scope on first use. If a test imported the vault before
 * this ran, it would seal against a key in the developer's real data directory
 * — and on a dev machine that means the suite could read, or overwrite, live
 * credentials.
 */
const root = mkdtempSync(join(tmpdir(), 'switchboard-test-'));

process.env.SWITCHBOARD_DATA_DIR = root;

// A fixed key keeps the vault deterministic and stops each file from paying for
// 32 bytes of entropy plus a file write it does not need. Tests that care about
// key generation delete this and exercise the real path.
delete process.env.SWITCHBOARD_MASTER_KEY;

// Nothing in the suite should reach the network. Left unset so a stray call to
// a real provider fails loudly on a bad host rather than quietly succeeding.
process.env.SWITCHBOARD_ALLOW_REMOTE = '0';

// Breaker transitions and routing failures log by design, and the suite trips
// them deliberately dozens of times. Without this the real output is buried.
// logger.test.ts sets its own level, so this does not blind the logger's tests.
process.env.SWITCHBOARD_LOG_LEVEL ??= 'silent';

beforeAll(() => {
  process.env.SWITCHBOARD_DATA_DIR = root;
});

/** jsdom defines `window`; the node-environment suites do not. */
const IS_DOM = typeof window !== 'undefined';

afterAll(async () => {
  // Only the node suites ever open a database, and importing the client from a
  // jsdom file would drag `node:sqlite` into a browser-target bundle — which
  // Vite refuses to do on Node 22.13, where it is not yet a recognised builtin.
  if (!IS_DOM) {
    const { closeDb } = await import('@/lib/db/client');
    closeDb();
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL file briefly after close; a leftover temp
    // directory is not worth failing a green suite over.
  }
});

// DOM matchers (toBeDisabled, toBeVisible, …) for the component tests. Only
// loaded where there is a DOM to match against.
if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

export const TEST_DATA_DIR = root;
