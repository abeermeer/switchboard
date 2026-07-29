#!/usr/bin/env node

/**
 * Pack the tarball, install it globally into a throwaway prefix, and run the
 * command a user would actually type.
 *
 * The README claimed `npm install -g switchboard` worked for three releases and
 * it never did. Everything upstream of the install was green — typecheck, 1,033
 * tests, four build legs, a booted gateway, a tarball contents check — because
 * every one of them ran against the repository, and none of them ever installed
 * the artefact and invoked the shim. This closes that gap: it fails if the
 * package does not produce a working `switchboard` / `sb` command, if the
 * production build is missing from the tarball, or if `--version` disagrees with
 * the manifest.
 *
 * Requires a build first (`npm run build`) — `.next` ships in the tarball.
 *
 * Run: node scripts/verify-global-install.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const isWindows = process.platform === 'win32';

const problems = [];
let prefix;
let tarball;

/**
 * Runs one command line through a shell.
 *
 * A shell is unavoidable: `npm` is a shell script on POSIX and a `.cmd` on
 * Windows, and Node refuses to spawn a `.cmd` without one. The whole line goes
 * in as a single string rather than command + args, because passing an args
 * array alongside `shell: true` is deprecated (DEP0190) — the shell concatenates
 * them unescaped anyway. Quote paths at the call site; a temp directory under a
 * username with a space in it is normal on Windows.
 */
function run(line, options = {}) {
  return spawnSync(line, { cwd: root, encoding: 'utf8', shell: true, ...options });
}

try {
  if (!existsSync(join(root, '.next', 'BUILD_ID'))) {
    console.error('  FAIL  no production build — run `npm run build` first');
    process.exitCode = 1;
  } else {
    // ─── Pack ────────────────────────────────────────────────────────────────

    const packed = run(`npm pack --silent --pack-destination "${tmpdir()}"`);
    if (packed.status !== 0) {
      problems.push(`npm pack failed: ${packed.stderr.trim()}`);
    } else {
      // --silent still prints the filename, which is the whole point of it.
      const name = packed.stdout.trim().split(/\r?\n/).pop() ?? '';
      tarball = join(tmpdir(), name);
      if (!existsSync(tarball)) {
        problems.push(`npm pack reported "${name}" but no such file exists`);
      } else {
        console.log(`  ok    packed ${name}`);
      }
    }

    // ─── Install into a prefix that is not the developer's ───────────────────

    if (problems.length === 0) {
      prefix = mkdtempSync(join(tmpdir(), 'sb-install-'));
      const installed = run(`npm install -g --prefix "${prefix}" "${tarball}"`);
      if (installed.status !== 0) {
        problems.push(`global install failed: ${installed.stderr.trim().split(/\r?\n/).slice(-5).join(' / ')}`);
      } else {
        console.log('  ok    installed into a temporary global prefix');
      }
    }

    // ─── The command has to exist and report the right version ───────────────

    if (problems.length === 0) {
      // npm puts shims directly in the prefix on Windows and in prefix/bin
      // elsewhere. A missing shim here is exactly the user-visible failure:
      // "'switchboard' is not recognized as the name of a cmdlet".
      const binDir = isWindows ? prefix : join(prefix, 'bin');

      for (const command of ['switchboard', 'sb']) {
        const shim = isWindows ? join(binDir, `${command}.cmd`) : join(binDir, command);
        if (!existsSync(shim)) {
          problems.push(`no \`${command}\` command was installed (looked for ${shim})`);
          continue;
        }

        const version = run(`"${shim}" --version`, { cwd: prefix });
        const reported = version.stdout.trim();
        if (version.status !== 0) {
          problems.push(`\`${command} --version\` exited ${version.status}: ${version.stderr.trim()}`);
        } else if (reported !== manifest.version) {
          problems.push(
            `\`${command} --version\` printed "${reported}", manifest says "${manifest.version}"`,
          );
        } else {
          console.log(`  ok    \`${command} --version\` → ${reported}`);
        }
      }

      // The build is what makes the installed copy runnable at all; without it
      // `switchboard` starts, prints "No production build found", and exits.
      //
      // npm nests differently per platform: `<prefix>/node_modules/<name>` on
      // Windows, `<prefix>/lib/node_modules/<name>` everywhere else. Checking
      // only the Windows layout passed locally and failed on Ubuntu claiming the
      // tarball had no build — the build was there, the path was wrong.
      const candidates = [
        join(prefix, 'node_modules', manifest.name, '.next', 'BUILD_ID'),
        join(prefix, 'lib', 'node_modules', manifest.name, '.next', 'BUILD_ID'),
      ];
      if (!candidates.some((path) => existsSync(path))) {
        problems.push('the tarball carries no .next build — the installed command cannot start');
      } else {
        console.log('  ok    production build shipped inside the package');
      }
    }
  }
} finally {
  // Leave nothing behind: the prefix is tens of megabytes of node_modules.
  for (const path of [prefix, tarball]) {
    if (path !== undefined) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // A locked file on Windows is not worth failing the check over.
      }
    }
  }
}

for (const problem of problems) console.error(`  FAIL  ${problem}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) with the global install.`);
  process.exitCode = 1;
} else if (process.exitCode !== 1) {
  console.log('\nA global install of this package produces a working command.');
}
