#!/usr/bin/env node

/**
 * Renders the Switchboard mark into the icon files electron-builder expects.
 *
 * The mark is the same patch-panel jack the dashboard sidebar draws (four
 * terminals, one copper patch cable curving between them) — the metaphor the
 * product is named after. Kept as code rather than checked-in binaries so the
 * icon cannot drift from the UI, and so a colour change is a one-line edit.
 *
 * Requires `sharp`, which is already present as a transitive dependency of the
 * build toolchain. Run: node scripts/make-icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'electron', 'assets');

// Token values lifted from src/app/globals.css so the icon matches the product.
const BG = '#121417';
const ACCENT = '#f0912f';
const ACCENT_SOFT = '#2a1c0d';
const ACCENT_LINE = '#4d3418';

/**
 * @param {number} size
 * @param {{ padded?: boolean }} [opts] macOS expects transparent padding around
 *   the glyph; Windows and Linux want it edge to edge.
 */
function markSvg(size, opts = {}) {
  const padded = opts.padded === true;
  // macOS icons sit in a ~10% safe-area margin so the rounded square is not
  // clipped by the system's own mask.
  const inset = padded ? size * 0.1 : 0;
  const box = size - inset * 2;
  const radius = box * 0.225;
  const stroke = Math.max(1, box * 0.012);

  // The 22-unit coordinate space matches the SVG in Sidebar.tsx exactly.
  const u = box / 22;
  const px = (n) => (inset + n * u).toFixed(3);
  const dotR = (1.75 * u).toFixed(3);

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}"
        fill="${BG}"/>
  <rect x="${(inset + u).toFixed(3)}" y="${(inset + u).toFixed(3)}"
        width="${(box - u * 2).toFixed(3)}" height="${(box - u * 2).toFixed(3)}"
        rx="${(radius * 0.85).toFixed(3)}"
        fill="${ACCENT_SOFT}" stroke="${ACCENT_LINE}" stroke-width="${stroke}"/>
  <circle cx="${px(7.5)}" cy="${px(7.5)}" r="${dotR}" fill="${ACCENT}"/>
  <circle cx="${px(14.5)}" cy="${px(7.5)}" r="${dotR}" fill="${ACCENT}" opacity="0.35"/>
  <circle cx="${px(7.5)}" cy="${px(14.5)}" r="${dotR}" fill="${ACCENT}" opacity="0.35"/>
  <circle cx="${px(14.5)}" cy="${px(14.5)}" r="${dotR}" fill="${ACCENT}"/>
  <path d="M${px(7.5)} ${px(7.5)} C${px(7.5)} ${px(11)} ${px(14.5)} ${px(11)} ${px(14.5)} ${px(14.5)}"
        stroke="${ACCENT}" stroke-width="${(1.5 * u).toFixed(3)}"
        stroke-linecap="round" fill="none"/>
</svg>`,
    'utf8',
  );
}

/** A tray icon is ~16px, where the inner detail turns to mush. Simplify it. */
function traySvg(size) {
  const u = size / 22;
  const px = (n) => (n * u).toFixed(3);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${px(6.5)}" cy="${px(6.5)}" r="${(2.6 * u).toFixed(3)}" fill="${ACCENT}"/>
  <circle cx="${px(15.5)}" cy="${px(15.5)}" r="${(2.6 * u).toFixed(3)}" fill="${ACCENT}"/>
  <path d="M${px(6.5)} ${px(6.5)} C${px(6.5)} ${px(11)} ${px(15.5)} ${px(11)} ${px(15.5)} ${px(15.5)}"
        stroke="${ACCENT}" stroke-width="${(2.2 * u).toFixed(3)}"
        stroke-linecap="round" fill="none"/>
</svg>`,
    'utf8',
  );
}

async function main() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('sharp is required to generate icons. Install it with: npm i -D sharp');
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  // Linux + the electron-builder default source.
  await sharp(markSvg(1024)).png().toFile(join(outDir, 'icon.png'));

  // Windows .ico. electron-builder wants at least 256px; bundling the smaller
  // sizes keeps it crisp in the taskbar and Explorer's small-icon views.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(
    icoSizes.map((size) => sharp(markSvg(size)).png().toBuffer()),
  );
  writeFileSync(join(outDir, 'icon.ico'), buildIco(icoSizes, icoBuffers));

  // macOS .icns, built by hand so this does not need macOS-only tooling.
  const icnsSpec = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const icnsEntries = await Promise.all(
    icnsSpec.map(async ([type, size]) => ({
      type,
      data: await sharp(markSvg(size, { padded: true })).png().toBuffer(),
    })),
  );
  writeFileSync(join(outDir, 'icon.icns'), buildIcns(icnsEntries));

  // Tray, at 1x and 2x for HiDPI.
  await sharp(traySvg(32)).png().toFile(join(outDir, 'tray-icon.png'));
  await sharp(traySvg(64)).png().toFile(join(outDir, 'tray-icon@2x.png'));

  console.log(`Wrote icons to ${outDir}`);
}

/** ICO container: a 6-byte header, then one 16-byte directory entry per image. */
function buildIco(sizes, buffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  const directory = Buffer.alloc(16 * sizes.length);
  let offset = header.length + directory.length;

  sizes.forEach((size, index) => {
    const at = index * 16;
    // 256 is encoded as 0 — the field is a single byte.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(buffers[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += buffers[index].length;
  });

  return Buffer.concat([header, directory, ...buffers]);
}

/** ICNS container: an 8-byte file header wrapping 8-byte-headed PNG chunks. */
function buildIcns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);

  return Buffer.concat([header, body]);
}

await main();
