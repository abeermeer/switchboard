import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Where a CLI-launched gateway should keep its database and master key.
 *
 * This has to be decided by the launcher rather than left to `process.cwd()`.
 * The CLI spawns the server with `cwd` set to the package directory, so a
 * global install would otherwise write `data/` inside `node_modules/switchboard`
 * — and `npm update -g` deletes that directory, taking the database and every
 * sealed provider credential with it.
 *
 * Mirrors `dataDir()` in src/lib/db/client.ts so both agree on the location.
 */
export function appDataDir() {
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  return join(base, 'Switchboard');
}

/** A repo checkout keeps its data local, which is what a developer expects. */
export function isRepoCheckout(root) {
  return existsSync(join(root, '.git')) || existsSync(join(root, 'tsconfig.json'));
}

/**
 * Resolves the data directory for a CLI launch, honouring an explicit
 * override first.
 */
export function resolveDataDir(root) {
  if (process.env.SWITCHBOARD_DATA_DIR) return process.env.SWITCHBOARD_DATA_DIR;
  if (isRepoCheckout(root)) return join(root, 'data');
  return appDataDir();
}
