import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The running version, read from the manifest rather than written here.
 *
 * A literal in the source drifts on the very next release and then lies: the
 * status endpoint reported `0.1.0` from a v0.4.0 install for three releases,
 * which is worse than reporting nothing when someone is trying to work out
 * whether an upgrade actually took.
 *
 * `process.cwd()` is the package root in every way the server is started — the
 * CLI spawns `next start` with `cwd: root`, `npm start` runs from the checkout,
 * and the desktop shell sets the same. Read once at module load; the file cannot
 * change under a running process.
 */
function readVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const value = (parsed as { version: unknown }).version;
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    // Nothing readable. Fall through to the sentinel rather than guessing a
    // number — an obviously wrong version is easier to diagnose than a
    // plausible one.
  }
  return '0.0.0';
}

export const VERSION: string = readVersion();
