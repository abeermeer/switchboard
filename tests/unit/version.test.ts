import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { VERSION } from '@/lib/version';

/**
 * `/api/system/status` reported a hardcoded `0.1.0` from a v0.4.0 install, which
 * is the single worst thing that field can do: someone diagnosing whether an
 * upgrade took reads it and concludes the old version is still running.
 *
 * A literal in the source cannot be kept in sync by review, so this asserts the
 * exported value against the manifest instead.
 */
describe('VERSION', () => {
  const manifest: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

  it('matches the version in package.json', () => {
    expect(manifest).toMatchObject({ version: expect.any(String) });
    const { version } = manifest as { version: string };

    expect(VERSION).toBe(version);
  });

  it('is a real semver-looking string, not the unreadable-manifest sentinel', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).not.toBe('0.0.0');
  });
});
