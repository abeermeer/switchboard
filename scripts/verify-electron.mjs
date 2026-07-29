#!/usr/bin/env node

/**
 * Fast structural check on the desktop packaging.
 *
 * A real `electron-builder` run takes minutes and downloads a platform
 * toolchain, so it lives in its own workflow. This is the cheap half: it catches
 * the class of bug that actually happened — the builder config referencing
 * `electron/assets/icon.ico` while that directory did not exist, so every
 * installer silently shipped the stock Electron logo — plus a syntax error in
 * the main or preload script, which would only surface when a user launched the
 * app.
 *
 * Run: node scripts/verify-electron.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function ok(message) {
  notes.push(message);
}

// ─── The builder config has to load and name its entry point ─────────────────

const configPath = join(root, 'electron', 'builder.config.cjs');
let config;
try {
  config = require(configPath);
  ok('builder config loads');
} catch (err) {
  fail(`builder config does not load: ${err instanceof Error ? err.message : String(err)}`);
}

if (config !== undefined) {
  if (typeof config.appId !== 'string' || config.appId.length === 0) {
    fail('builder config has no appId');
  }
  if (config.extraMetadata?.main === undefined) {
    // Without this, electron-builder ships the package's own `main`, which is
    // the Next app rather than the desktop shell.
    fail('builder config does not set extraMetadata.main');
  } else if (!existsSync(join(root, config.extraMetadata.main))) {
    fail(`extraMetadata.main points at a missing file: ${config.extraMetadata.main}`);
  } else {
    ok(`entry point exists: ${config.extraMetadata.main}`);
  }
}

// ─── Every icon the config references must exist, and be the right format ────

/** Magic bytes, so a renamed-but-wrong file is caught rather than trusted. */
const SIGNATURES = {
  '.png': [0x89, 0x50, 0x4e, 0x47],
  '.ico': [0x00, 0x00, 0x01, 0x00],
  '.icns': [0x69, 0x63, 0x6e, 0x73], // 'icns'
};

/** Reads the width and height out of a PNG's IHDR chunk. */
function pngDimensions(buffer) {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * @param {string} label
 * @param {string | undefined} relative
 * @param {number} [minPixels] Smallest acceptable edge. A 32px tray glyph is
 *   legitimately a few hundred bytes, so file size is the wrong signal —
 *   dimensions are the thing that actually has to be right.
 */
function checkIcon(label, relative, minPixels = 256) {
  if (relative === undefined) return;

  const path = join(root, relative);
  if (!existsSync(path)) {
    fail(`${label} icon is missing: ${relative} — run \`npm run icons\``);
    return;
  }

  const bytes = readFileSync(path);
  if (bytes.length === 0) {
    fail(`${label} icon is empty: ${relative}`);
    return;
  }

  const extension = relative.slice(relative.lastIndexOf('.'));
  const expected = SIGNATURES[extension];
  if (expected !== undefined) {
    const head = [...bytes.subarray(0, expected.length)];
    if (!expected.every((byte, index) => head[index] === byte)) {
      fail(`${label} icon is not a valid ${extension} file: ${relative}`);
      return;
    }
  }

  if (extension === '.png') {
    const dimensions = pngDimensions(bytes);
    if (dimensions === null) {
      fail(`${label} icon has no readable PNG header: ${relative}`);
      return;
    }
    if (dimensions.width < minPixels || dimensions.height < minPixels) {
      // electron-builder rejects an app icon under 256px outright.
      fail(
        `${label} icon is ${dimensions.width}x${dimensions.height}; needs at least ${minPixels}px: ${relative}`,
      );
      return;
    }
    ok(`${label} icon valid at ${dimensions.width}x${dimensions.height}`);
    return;
  }

  ok(`${label} icon present and valid (${(statSync(path).size / 1024).toFixed(1)} kB)`);
}

if (config !== undefined) {
  checkIcon('windows', config.win?.icon);
  checkIcon('macOS', config.mac?.icon);
  checkIcon('linux', config.linux?.icon);
}

// The tray icon is loaded at runtime rather than by the builder, so the config
// never mentions it — and a missing one degrades silently to a blank tray slot.
// 32px is the tray's native size; anything larger is downscaled by the OS.
checkIcon('tray', 'electron/assets/tray-icon.png', 32);
checkIcon('tray @2x', 'electron/assets/tray-icon@2x.png', 64);

// ─── The scripts have to parse ───────────────────────────────────────────────

for (const script of ['electron/main.cjs', 'electron/preload.cjs']) {
  const path = join(root, script);
  if (!existsSync(path)) {
    fail(`${script} is missing`);
    continue;
  }
  try {
    // Compile without running: `electron` is not resolvable outside Electron's
    // own runtime, so requiring it here would fail for the wrong reason.
    new (require('node:vm').Script)(readFileSync(path, 'utf8'), { filename: path });
    ok(`${script} parses`);
  } catch (err) {
    fail(`${script} has a syntax error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── The preload must not widen the renderer's reach ─────────────────────────

const preload = existsSync(join(root, 'electron/preload.cjs'))
  ? readFileSync(join(root, 'electron/preload.cjs'), 'utf8')
  : '';

if (preload.length > 0) {
  if (!preload.includes('contextBridge')) {
    fail('preload does not use contextBridge — the renderer would get raw Node access');
  } else {
    ok('preload exposes its API through contextBridge');
  }
  if (/exposeInMainWorld\([^,]+,\s*ipcRenderer\s*\)/.test(preload)) {
    fail('preload exposes ipcRenderer wholesale, which defeats the sandbox');
  }
}

// ─── main.cjs must keep the hardening flags on ───────────────────────────────

const main = existsSync(join(root, 'electron/main.cjs'))
  ? readFileSync(join(root, 'electron/main.cjs'), 'utf8')
  : '';

if (main.length > 0) {
  const required = [
    ['contextIsolation: true', 'contextIsolation must stay on'],
    ['nodeIntegration: false', 'nodeIntegration must stay off'],
    ['sandbox: true', 'the renderer sandbox must stay on'],
  ];
  for (const [needle, message] of required) {
    if (!main.includes(needle)) fail(`${message} (looked for \`${needle}\` in main.cjs)`);
  }
  if (required.every(([needle]) => main.includes(needle))) {
    ok('renderer hardening flags are set');
  }

  // A window that can navigate anywhere is a browser with Node privileges next
  // to it; the handler is what keeps external links in the real browser.
  if (!main.includes('setWindowOpenHandler')) {
    fail('main.cjs does not guard window.open — external URLs could load in-app');
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

for (const note of notes) console.log(`  ok    ${note}`);
for (const problem of problems) console.error(`  FAIL  ${problem}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} desktop packaging problem(s).`);
  process.exit(1);
}

console.log(`\nDesktop packaging looks sound (${notes.length} checks).`);
