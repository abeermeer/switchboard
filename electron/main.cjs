'use strict';

const { app, BrowserWindow, Menu, Tray, shell, ipcMain, clipboard, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const IS_DEV = process.env.SWITCHBOARD_DEV === '1';
const DEFAULT_PORT = 7272;

/** @type {import('electron').BrowserWindow | null} */
let win = null;
/** @type {import('electron').Tray | null} */
let tray = null;
/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
let port = DEFAULT_PORT;
let quitting = false;

// Only one instance may own the port and the database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win !== null) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function isPortFree(candidate) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(candidate, '127.0.0.1');
  });
}

async function findPort(start) {
  for (let candidate = start; candidate < start + 40; candidate += 1) {
    if (await isPortFree(candidate)) return candidate;
  }
  return start;
}

function waitForServer(target, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(target, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Gateway did not start on port ${target}`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function startServer() {
  if (IS_DEV) {
    // The dev server is already running under `npm run dev`; attaching avoids
    // two processes fighting over the port and the SQLite file.
    port = DEFAULT_PORT;
    await waitForServer(port);
    return;
  }

  port = await findPort(DEFAULT_PORT);

  const root = path.join(__dirname, '..');
  server = spawn(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      // Packaged builds must write to a real app-data directory, matching
      // dataDir() in src/lib/db/client.ts.
      SWITCHBOARD_PACKAGED: '1',
      SWITCHBOARD_DATA_DIR: app.getPath('userData'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (chunk) => process.stdout.write(`[gateway] ${chunk}`));
  server.stderr?.on('data', (chunk) => process.stderr.write(`[gateway] ${chunk}`));
  server.on('exit', (code) => {
    if (!quitting && code !== 0) {
      console.error(`[switchboard] gateway exited with code ${code}`);
    }
  });

  await waitForServer(port);
}

function stopServer() {
  if (server === null) return;
  const child = server;
  server = null;

  if (process.platform === 'win32' && child.pid !== undefined) {
    // Next spawns workers; killing only the parent leaves them holding the port.
    spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0b0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win?.show());
  void win.loadURL(`http://127.0.0.1:${port}/dashboard`);

  // Anything that is not our own gateway opens in the user's real browser
  // rather than inside a chromeless app window.
  const isInternal = (url) => url.startsWith(`http://127.0.0.1:${port}`) || url.startsWith(`http://localhost:${port}`);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.on('close', (event) => {
    // Closing the window hides to the tray; the gateway keeps serving.
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (win === null) createWindow();
  else {
    win.show();
    win.focus();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));
  // electron-builder falls back to a default icon when the asset is absent, so
  // an empty image here is a cosmetic issue rather than a crash.
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Switchboard');

  const rebuild = () => {
    const loginItem = app.getLoginItemSettings();
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Switchboard — port ${port}`, enabled: false },
        { type: 'separator' },
        { label: 'Open dashboard', click: showWindow },
        {
          label: 'Copy endpoint URL',
          click: () => clipboard.writeText(`http://127.0.0.1:${port}/v1`),
        },
        { type: 'separator' },
        {
          label: 'Start at login',
          type: 'checkbox',
          checked: loginItem.openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked });
            rebuild();
          },
        },
        {
          label: 'Restart gateway',
          click: async () => {
            stopServer();
            await startServer();
            win?.reload();
          },
        },
        { type: 'separator' },
        {
          label: 'Quit Switchboard',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };

  rebuild();
  tray.on('click', showWindow);
}

function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }],
      },
      // Without an Edit menu, copy and paste do not work on macOS.
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          ...(IS_DEV ? [{ role: 'toggleDevTools' }] : []),
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        role: 'help',
        submenu: [
          {
            label: 'Documentation',
            click: () => void shell.openExternal('https://github.com/abeermeer/switchboard'),
          },
        ],
      },
    ]),
  );
}

ipcMain.handle('sb:endpoint', () => `http://127.0.0.1:${port}/v1`);
ipcMain.handle('sb:open-external', (_event, url) => shell.openExternal(String(url)));
ipcMain.handle('sb:restart', async () => {
  stopServer();
  await startServer();
  win?.reload();
  return true;
});

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error('[switchboard] could not start the gateway:', err);
  }

  createWindow();
  createTray();
  createMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  // The tray keeps the app alive on every platform; quitting is explicit.
});
