import { existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
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
 * Mirrors `dataDir()` in src/lib/db/client.ts and electron/main.cjs so all
 * three agree on the location.
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

/**
 * Resolves the data directory for a CLI launch, honouring an explicit
 * override first.
 *
 * A repo checkout used to keep its data in `<checkout>/data`. The documented
 * install, `npm install -g .`, links the global command to the checkout, so
 * the README's promise that data lives in the OS app-data folder was false:
 * deleting the clone, or a `git clean -xdf`, destroyed the master key and every
 * stored credential with it. New installs now always use the app-data folder.
 * A database inside the package is still used when the app-data folder has
 * none, so an upgrade never looks like data loss, and `isInsidePackage` lets
 * the CLI warn about it. Moving it then cannot overwrite anything.
 */
export function resolveDataDir(root) {
  if (process.env.SWITCHBOARD_DATA_DIR) return process.env.SWITCHBOARD_DATA_DIR;
  // The app-data folder wins whenever it already holds a database. `npm start`
  // and `npm run dev` keep their own ./data in the clone, and preferring any
  // database found there flipped `switchboard` onto that empty one: every key
  // looked lost, and following the "move it" advice would have overwritten the
  // real database and master key.
  const shared = appDataDir();
  if (existsSync(join(shared, 'switchboard.db'))) return shared;
  const legacy = join(root, 'data');
  if (existsSync(join(legacy, 'switchboard.db'))) return legacy;
  return shared;
}

/** True when `dir` sits inside the installed package or clone. */
export function isInsidePackage(root, dir) {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
