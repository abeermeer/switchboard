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

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import net from 'node:net';
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

      // `--version` proves the shim exists, not that the server can run. The
      // installed copy has no dev dependencies (no TypeScript, no Tailwind),
      // which is exactly the environment a broken runtime import shows up in.
      if (problems.length === 0) await bootInstalled(binDir);
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

/** A port nothing is listening on, so the check never collides with a dev server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function bootInstalled(binDir) {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'sb-install-data-'));
  const shim = isWindows ? join(binDir, 'switchboard.cmd') : join(binDir, 'switchboard');
  const child = spawn(`"${shim}" start --port ${port}`, {
    shell: true,
    detached: !isWindows,
    stdio: 'ignore',
    env: { ...process.env, SWITCHBOARD_DATA_DIR: data, SWITCHBOARD_LOG_LEVEL: 'warn' },
  });

  let status = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && status !== 200) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = await fetch(`http://127.0.0.1:${port}/api/system/status`)
      .then((res) => res.status)
      .catch(() => 0);
  }

  if (isWindows) spawnSync(`taskkill /pid ${child.pid} /t /f`, { shell: true });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  try {
    rmSync(data, { recursive: true, force: true });
  } catch {
    // A held WAL file on Windows is not worth failing the check over.
  }

  if (status === 200) console.log(`  ok    the installed command started a gateway that answers on :${port}`);
  else problems.push(`\`switchboard start\` from the installed package never answered (last status ${status})`);
}

for (const problem of problems) console.error(`  FAIL  ${problem}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) with the global install.`);
  process.exitCode = 1;
} else if (process.exitCode !== 1) {
  console.log('\nA global install of this package produces a working command.');
}
