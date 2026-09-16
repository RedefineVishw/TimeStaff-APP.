import { app, BrowserWindow, ipcMain, powerMonitor, screen, shell, safeStorage, desktopCapturer } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import started from 'electron-squirrel-startup';

// .ico gives a sharper Windows taskbar/title-bar icon than .png at small
// sizes; other platforms fall back to the PNG.
const WINDOW_ICON = path.join(__dirname, `../../assets/icon${process.platform === 'win32' ? '.ico' : '.png'}`);

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Idle detection lives here in the main process because it needs a real
// Electron API (powerMonitor), not something the renderer can call directly
// — exposed to the renderer via preload's contextBridge instead of IPC
// permissions being handed out wholesale.
ipcMain.handle('get-idle-seconds', () => powerMonitor.getSystemIdleTime());
ipcMain.handle('open-external', (_event, url: string) => shell.openExternal(url));

// The desktop app's session is independent of the web app's — it stores its
// own refresh token here, encrypted at rest via Electron's built-in
// safeStorage (OS keychain-backed on Windows/macOS, libsecret on Linux), in
// a small file under the per-user app data directory. No extra native
// dependency (e.g. keytar) needed for this.
const REFRESH_TOKEN_FILE = () => path.join(app.getPath('userData'), 'refresh-token.enc');

ipcMain.handle('auth:get-refresh-token', async () => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = await fs.readFile(REFRESH_TOKEN_FILE());
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
});

ipcMain.handle('auth:set-refresh-token', async (_event, token: string) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const encrypted = safeStorage.encryptString(token);
  await fs.writeFile(REFRESH_TOKEN_FILE(), encrypted);
  return true;
});

ipcMain.handle('auth:clear-refresh-token', async () => {
  try {
    await fs.unlink(REFRESH_TOKEN_FILE());
  } catch {
    // Already gone — fine.
  }
});

// The actual pixel capture needs real OS access (main process only) — the
// renderer can't touch the screen directly even with Node integration off.
// Everything else (upload, retry/backoff on failure, the notification) is
// handled in the renderer, reusing the same authenticated axios instance
// and its token-refresh logic rather than duplicating auth in main.
//
// Uses Electron's own desktopCapturer (Chromium's native screen-capture
// API) rather than a third-party package — an earlier attempt with
// `screenshot-desktop` relied on dynamically compiling a C# helper via the
// legacy .NET Framework `csc.exe` at runtime, which failed in this
// environment (likely blocked by endpoint security software, a common
// false-positive trigger for "compile-then-run" tools). desktopCapturer
// needs no external process and no compilation step.
ipcMain.handle('capture-screenshot', async () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    // Request the thumbnail at full display resolution — the default is a
    // small preview-sized thumbnail, not a usable screenshot.
    thumbnailSize: primaryDisplay.size,
  });
  const primarySource = sources.find((s) => s.display_id === String(primaryDisplay.id)) ?? sources[0];
  if (!primarySource) {
    throw new Error('No screen source available to capture');
  }
  return new Uint8Array(primarySource.thumbnail.toPNG());
});

let mainWindow: BrowserWindow | null = null;
let idleAlertWindow: BrowserWindow | null = null;

function rendererUrl(hash: string): string {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return `${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${hash}`;
  }
  return `file://${path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)}#${hash}`;
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 760,
    minHeight: 520,
    title: 'TimeStaff',
    icon: WINDOW_ICON,
    backgroundColor: '#f5f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // A hidden idle-alert window still counts toward getAllWindows(), which
  // would otherwise stop the app from quitting when the main window closes
  // — close it explicitly alongside the main window.
  mainWindow.on('closed', () => {
    idleAlertWindow?.close();
    mainWindow = null;
  });
};

// A genuinely separate, always-on-top OS-level window for the idle alert —
// not an overlay inside the main window. The whole point of this alert is
// to catch the user's attention when they come back to their computer,
// which could easily be with some *other* application focused; an overlay
// baked into the main BrowserWindow would be invisible whenever that window
// isn't the foreground app. This window loads the same renderer bundle as
// the main window (Electron Forge only defines one renderer target), routed
// to a different component via a URL hash the renderer checks on boot.
function createIdleAlertWindow() {
  idleAlertWindow = new BrowserWindow({
    width: 380,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  idleAlertWindow.setAlwaysOnTop(true, 'screen-saver');
  idleAlertWindow.loadURL(rendererUrl('idle-alert'));
  idleAlertWindow.on('closed', () => {
    idleAlertWindow = null;
  });
}

interface IdleAlertShowData {
  idleSeconds: number;
  projectName: string;
  taskName: string;
}

ipcMain.on('idle-alert:show', (_event, data: IdleAlertShowData) => {
  if (!idleAlertWindow || idleAlertWindow.isDestroyed()) {
    createIdleAlertWindow();
  }
  const win = idleAlertWindow!;
  const show = () => {
    win.webContents.send('idle-alert:data', data);
    win.center();
    win.show();
    win.focus();
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', show);
  } else {
    show();
  }
});

ipcMain.on('idle-alert:hide', () => {
  idleAlertWindow?.hide();
});

// The popup window has no logic of its own — it just displays data and
// reports the user's choice back here, which forwards it to the main
// window's renderer (where the real timer state, API client, and
// token-refresh logic live) to actually act on.
ipcMain.on('idle-alert:respond', (_event, response: { action: 'stop' | 'resume'; wasWorking: 'no' | 'yes' }) => {
  mainWindow?.webContents.send('idle-alert:response', response);
  idleAlertWindow?.hide();
});

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
