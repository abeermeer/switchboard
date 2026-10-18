import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error: plain ESM helper shipped with the CLI, no type declarations.
import { appDataDir, isInsidePackage, resolveDataDir } from '../../bin/lib/dataDir.mjs';

describe('CLI data directory', () => {
  let root: string;
  const saved = process.env.SWITCHBOARD_DATA_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-root-'));
    // The suite pins this for every test; the CLI logic is what is under test.
    delete process.env.SWITCHBOARD_DATA_DIR;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = saved;
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

  it('honours an explicit override above everything', () => {
    process.env.SWITCHBOARD_DATA_DIR = '/srv/switchboard';
    expect(resolveDataDir(root)).toBe('/srv/switchboard');
  });

  it('does not call a sibling folder "inside"', () => {
    expect(isInsidePackage(root, `${root}-other`)).toBe(false);
    expect(isInsidePackage(root, appDataDir())).toBe(false);
  });
});
