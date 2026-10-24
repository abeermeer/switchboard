import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error: plain ESM helper shipped with the CLI, no type declarations.
import { appDataDir, isInsidePackage, resolveDataDir } from '../../bin/lib/dataDir.mjs';

const HOME_VARS = ['SWITCHBOARD_DATA_DIR', 'XDG_DATA_HOME', 'APPDATA', 'HOME', 'USERPROFILE'] as const;

describe('CLI data directory', () => {
  let root: string;
  let home: string;
  const saved = Object.fromEntries(HOME_VARS.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-root-'));
    // The app-data folder is derived from the home directory, so every test
    // gets its own: a real install on the developer's machine must not leak in.
    home = mkdtempSync(join(tmpdir(), 'sb-home-'));
    // The suite pins this for every test; the CLI logic is what is under test.
    delete process.env.SWITCHBOARD_DATA_DIR;
    process.env.XDG_DATA_HOME = home;
    process.env.APPDATA = home;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    for (const name of HOME_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('defaults to the OS app-data folder, even for a clone', () => {
    // `npm install -g .` links the command to the clone, so a clone-local
    // default meant deleting the clone deleted every stored key.
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    mkdirSync(join(root, '.git'));
    expect(resolveDataDir(root)).toBe(appDataDir());
  });

  it('keeps using a database that already lives inside the package', () => {
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'switchboard.db'), '');
    expect(resolveDataDir(root)).toBe(join(root, 'data'));
    expect(isInsidePackage(root, resolveDataDir(root))).toBe(true);
  });

  it('prefers an existing app-data database over a newer one inside the clone', () => {
    // `npm start` in the clone creates <clone>/data; it must not take over.
    mkdirSync(appDataDir(), { recursive: true });
    writeFileSync(join(appDataDir(), 'switchboard.db'), '');
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'switchboard.db'), '');

    expect(resolveDataDir(root)).toBe(appDataDir());
  });

  it('honours an explicit override above everything', () => {
    process.env.SWITCHBOARD_DATA_DIR = '/srv/switchboard';
    expect(resolveDataDir(root)).toBe('/srv/switchboard');
  });

  it('does not call a sibling folder "inside"', () => {
    expect(isInsidePackage(root, `${root}-other`)).toBe(false);
    expect(isInsidePackage(root, appDataDir())).toBe(false);
  });
});
