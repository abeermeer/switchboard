'use strict';

/**
 * electron-builder configuration.
 *
 * Icons live at electron/assets/ and are generated from the product mark by
 * `npm run icons` (scripts/make-icons.mjs) rather than checked in as opaque
 * binaries, so they cannot drift from the sidebar glyph they are drawn from.
 * Regenerate after changing the accent tokens in globals.css.
 */
module.exports = {
  appId: 'com.abeermeer.switchboard',
  productName: 'Switchboard',
  copyright: `Copyright © ${new Date().getFullYear()} Abeer Meer`,
  directories: {
    output: 'release',
    buildResources: 'electron/assets',
  },
  files: [
    'electron/**/*',
    '.next/**/*',
    'public/**/*',
    'package.json',
    'next.config.ts',
    // Next's production server and the app's runtime dependencies must ship;
    // dev tooling must not.
    'node_modules/**/*',
    '!node_modules/.cache',
    '!node_modules/electron/**',
    '!node_modules/electron-builder/**',
    '!node_modules/typescript/**',
    '!node_modules/@types/**',
    '!**/*.map',
    '!**/*.ts',
    '!**/*.tsx',
  ],
  extraMetadata: {
    main: 'electron/main.cjs',
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'electron/assets/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Switchboard',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: 'electron/assets/icon.icns',
    category: 'public.app-category.developer-tools',
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'electron/assets/icon.png',
    category: 'Development',
  },
};
