#!/usr/bin/env node

/**
 * Check that the npm name in package.json is actually ours to publish.
 *
 * This exists because it was not. The README told people to run
 * `npm install -g switchboard` for three releases; `switchboard` on npm is an
 * unrelated 2022 event-listener library with no `bin` field, so the install
 * succeeded, produced no command, and the failure looked like a bug in our CLI.
 * Nothing in the pipeline could catch it, because the pipeline never looked at
 * the registry.
 *
 * Passes when the name is unregistered (ours to take) or when the registered
 * package points back at this repository. Fails when someone else holds it.
 *
 * Run: node scripts/verify-package-name.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** git+https://github.com/a/b.git and git://github.com/a/b both reduce to github.com/a/b. */
function normalise(url) {
  return String(url)
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/**
 * Returns the exit code rather than calling `process.exit`. Exiting while a
 * fetch socket is still open trips a libuv assertion on Windows
 * (`!(handle->flags & UV_HANDLE_CLOSING)`), which replaced the intended exit 1
 * with a crash and exit 127 — the failure was still printed, but a wrapper
 * checking the code saw the wrong reason.
 */
async function main() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const name = manifest.name;
  const ours = normalise(manifest.repository?.url ?? '');

  if (ours.length === 0) {
    console.error('  FAIL  package.json has no repository.url to compare against');
    return 1;
  }

  let response;
  try {
    response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    // A network failure is not a naming problem. Say so and pass rather than
    // blocking a commit on registry availability.
    console.log(`  skip  registry unreachable (${err instanceof Error ? err.message : err})`);
    return 0;
  }

  if (response.status === 404) {
    await response.body?.cancel();
    console.log(`  ok    "${name}" is unregistered — ours to publish`);
    return 0;
  }

  if (!response.ok) {
    await response.body?.cancel();
    console.log(`  skip  registry returned ${response.status}`);
    return 0;
  }

  const packument = await response.json();
  const latest = packument['dist-tags']?.latest;
  const theirs = normalise(
    packument.versions?.[latest]?.repository?.url ?? packument.repository?.url ?? '',
  );

  if (theirs === ours) {
    console.log(`  ok    "${name}" is published from this repository (latest ${latest})`);
    return 0;
  }

  console.error(`  FAIL  npm name "${name}" belongs to someone else.`);
  console.error(`        registry latest: ${latest} — ${theirs || '(no repository field)'}`);
  console.error(`        this repo:       ${ours}`);
  console.error('');
  console.error('  Installing it gives users that package, not this one. Pick a name that is');
  console.error('  free or scoped, and update every install instruction with it.');
  return 1;
}

process.exitCode = await main();
