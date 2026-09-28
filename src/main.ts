import { app, BrowserWindow, ipcMain, powerMonitor, screen, shell, safeStorage, desktopCapturer, Menu } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import started from 'electron-squirrel-startup';

// This is a single-purpose timer app, not a document editor — the default
// File/Edit/View/Window menu bar Electron adds automatically has no
// use here (nothing in it applies) and doesn't match the branding of a
// small always-on-top-adjacent utility window. Removing it applies to every
// BrowserWindow the app creates (main window and the idle-alert popup).
Menu.setApplicationMenu(null);

// This app's whole job depends on timers in the renderer firing on time —
// the live clock, the mini-timer widget's updates, and (most importantly)
// the once-a-second idle check that drives the last-15-seconds warning.
// Chromium deliberately throttles timers in windows it considers
// backgrounded: minimized, hidden, or (on Windows) fully covered by other
// windows. Throttled, the idle check runs far less often than once a
// second, so the widget freezes, the amber/red warning gets skipped, and
// the idle popup appears with no warning at all — then everything catches up
// the moment the window is restored. These switches turn that off for the
// whole process; each window also opts out individually below.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// .ico gives a sharper Windows taskbar/title-bar icon than .png at small
// sizes; other platforms fall back to the PNG.
const WINDOW_ICON = path.join(__dirname, `../../assets/icon${process.platform === 'win32' ? '.ico' : '.png'}`);
const AUMID = 'com.timestaff.app';

if (process.platform === 'win32') {
  app.setAppUserModelId(AUMID);

  // setAppUserModelId alone only fixes the toast's "sent by" name/icon once
  // Windows already knows this AUMID belongs to "TimeStaff" — which normally
  // comes from a Start Menu shortcut created at install time (Squirrel does
  // this for a packaged build, but not in `npm run start` dev mode). The
  // documented dev-mode workaround is to register the AUMID's display name
  // and icon directly in the registry — same effect, no install required.
  // Best-effort: if `reg` isn't on PATH for some reason, notifications still
  // work, they just keep showing "Electron" until the app is packaged.
  const keyPath = `HKCU\\SOFTWARE\\Classes\\AppUserModelId\\${AUMID}`;
  const ignoreResult = () => {
    // Fire-and-forget — see the best-effort note above.
  };
  execFile('reg', ['add', keyPath, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'TimeStaff', '/f'], ignoreResult);
  execFile('reg', ['add', keyPath, '/v', 'IconUri', '/t', 'REG_SZ', '/d', WINDOW_ICON, '/f'], ignoreResult);
}

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

// Custom window controls — the renderer draws its own minimize/maximize/
// close buttons (see .title-bar-controls in App.tsx) instead of relying on
// Electron's titleBarOverlay, because Windows' own hover styling for that
// overlay's minimize/maximize buttons is barely visible against a light
// title bar background (only the close button's red hover is guaranteed
// visible — that one's hard-coded by the OS). Drawing the buttons
// ourselves means full control over every button's hover/active state.
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

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
let miniTimerWindow: BrowserWindow | null = null;
let closeConfirmed = false;

ipcMain.on('app:ready-to-close', () => {
  closeConfirmed = true;
  mainWindow?.close();
});

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
    backgroundColor: '#f2f6fb',
    // The default native title bar is dark and unstylable from CSS —
    // 'hidden' removes it and lets the renderer draw its own title strip
    // (see ".title-bar" in App.tsx), including its own minimize/maximize/
    // close buttons wired to the IPC handlers above, instead of Windows'
    // titleBarOverlay buttons (whose minimize/maximize hover state Windows
    // renders too faintly to see against a light background). macOS
    // ignores this and always draws its own traffic-light buttons in
    // 'hidden' mode regardless, which is the platform's own convention.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
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

  // The maximize/restore button's icon needs to reflect the window's
  // actual state, which can change from things other than that button
  // itself (double-clicking the title bar, dragging to the screen edge,
  // Windows' snap layouts) — pushed to the renderer whenever it changes
  // rather than only updated optimistically on click.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false));

  // A hidden idle-alert window still counts toward getAllWindows(), which
  // would otherwise stop the app from quitting when the main window closes
  // — close it explicitly alongside the main window.
  mainWindow.on('closed', () => {
    idleAlertWindow?.close();
    miniTimerWindow?.close();
    closeScreenshotToast();
    mainWindow = null;
  });

  // Closing the main window is this app's only "I'm done" signal (there's
  // no tray icon to keep it running headless) — so it has to actually stop
  // whatever timer is running first, and that's an async API call that
  // only the renderer can make (it owns the authenticated axios instance).
  // The first 'close' is intercepted and deferred until the renderer
  // confirms the stop request finished (see the module-level
  // 'app:ready-to-close' handler below); a short fallback timeout covers a
  // renderer that never responds (crashed, stuck) so the window can't get
  // stuck refusing to close.
  closeConfirmed = false;
  mainWindow.on('close', (event) => {
    if (closeConfirmed) return;
    event.preventDefault();
    mainWindow?.webContents.send('app:before-close');
    setTimeout(() => {
      if (closeConfirmed) return;
      closeConfirmed = true;
      mainWindow?.close();
    }, 3000);
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
      backgroundThrottling: false,
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

// --- Screenshot toast: the "screenshot captured" popup ---------------------
// Drawn as our own small always-on-top window instead of a native OS
// notification, because an OS toast is always placed by the OS (bottom right
// on Windows) and an app can't move it — and the user can choose where this
// appears (see Settings in the app). Never takes focus, so it can't steal
// typing from whatever is being worked on — but it does take clicks, for its
// dismiss (X) button.

type ScreenshotAlertPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'left-center'
  | 'center'
  | 'right-center'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

// The card is 364x76 (a Windows 11 toast's size); the rest is transparent
// breathing room so its shadow isn't clipped, which also doubles as the gap
// from the screen edge.
const TOAST_WIDTH = 396;
const TOAST_HEIGHT = 108;
const TOAST_VISIBLE_MS = 5000;

let screenshotToastWindow: BrowserWindow | null = null;
let screenshotToastTimer: ReturnType<typeof setTimeout> | null = null;

function toastBounds(position: ScreenshotAlertPosition): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea;
  const left = wa.x;
  const right = wa.x + wa.width - TOAST_WIDTH;
  const top = wa.y;
  const bottom = wa.y + wa.height - TOAST_HEIGHT;
  const centerX = Math.round(wa.x + (wa.width - TOAST_WIDTH) / 2);
  const centerY = Math.round(wa.y + (wa.height - TOAST_HEIGHT) / 2);
  switch (position) {
    case 'top-left':
      return { x: left, y: top };
    case 'top-center':
      return { x: centerX, y: top };
    case 'top-right':
      return { x: right, y: top };
    case 'left-center':
      return { x: left, y: centerY };
    case 'center':
      return { x: centerX, y: centerY };
    case 'right-center':
      return { x: right, y: centerY };
    case 'bottom-left':
      return { x: left, y: bottom };
    case 'bottom-center':
      return { x: centerX, y: bottom };
    case 'bottom-right':
    default:
      return { x: right, y: bottom };
  }
}

function closeScreenshotToast() {
  if (screenshotToastTimer) clearTimeout(screenshotToastTimer);
  screenshotToastTimer = null;
  if (screenshotToastWindow && !screenshotToastWindow.isDestroyed()) screenshotToastWindow.close();
  screenshotToastWindow = null;
}

ipcMain.on('screenshot-toast:dismiss', () => closeScreenshotToast());

ipcMain.handle('notify-screenshot-captured', (_event, position: ScreenshotAlertPosition) => {
  // A new screenshot while the last popup is still up replaces it (and
  // restarts the timer) rather than stacking a second window on top.
  closeScreenshotToast();

  const { x, y } = toastBounds(position);
  const win = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    x,
    y,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  screenshotToastWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL(rendererUrl('screenshot-toast'));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.showInactive();
    screenshotToastTimer = setTimeout(closeScreenshotToast, TOAST_VISIBLE_MS);
  });
  win.on('closed', () => {
    if (screenshotToastWindow === win) screenshotToastWindow = null;
  });
});

// --- Mini timer: a small always-on-top overlay showing whatever task is
// currently tracked, so you don't need the main window open/focused to see
// it — modeled on a VM guest's floating "you're inside a VM" toolbar. Like
// the idle-alert window, this one has no logic of its own: the main
// window's renderer decides what it shows and reacts to its buttons; this
// just displays data and reports clicks back.

// The visible bar's own size — the actual BrowserWindow is bigger than
// this (see MINI_TIMER_GLOW_MARGIN below), with transparent space around
// the bar so its idle-warning glow has somewhere to render into instead of
// being clipped at the window's edge.
const MINI_TIMER_WIDTH = 440;
const MINI_TIMER_HEIGHT = 36;
// 25px covers the bigger of the two glows (the last-3-seconds red one) —
// the milder amber warning glow reaches less far but fits fine within this.
const MINI_TIMER_GLOW_MARGIN = 25;
const MINI_TIMER_WINDOW_WIDTH = MINI_TIMER_WIDTH + MINI_TIMER_GLOW_MARGIN * 2;
const MINI_TIMER_WINDOW_HEIGHT = MINI_TIMER_HEIGHT + MINI_TIMER_GLOW_MARGIN * 2;
const MINI_TIMER_POSITION_FILE = () => path.join(app.getPath('userData'), 'mini-timer-position.json');

async function loadMiniTimerPosition(): Promise<{ x: number; y: number } | null> {
  try {
    const raw = await fs.readFile(MINI_TIMER_POSITION_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed;
  } catch {
    // No saved position yet, or it's corrupt — fall through to the default.
  }
  return null;
}

function saveMiniTimerPosition(x: number, y: number) {
  // Fire-and-forget — losing one position save isn't worth surfacing, the
  // widget just falls back to the default spot next launch.
  fs.writeFile(MINI_TIMER_POSITION_FILE(), JSON.stringify({ x, y })).catch(() => {
    // See the comment above — losing a position save is fine.
  });
}

function defaultMiniTimerPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay();
  // Centers the visible *bar*, not the (larger, invisible) window around
  // it — subtracting the glow margin so the extra transparent space is
  // evenly split on both sides rather than skewing the bar off-center.
  return {
    x: Math.round(workArea.x + (workArea.width - MINI_TIMER_WIDTH) / 2 - MINI_TIMER_GLOW_MARGIN),
    y: workArea.y + 16 - MINI_TIMER_GLOW_MARGIN,
  };
}

async function createMiniTimerWindow() {
  const position = (await loadMiniTimerPosition()) ?? defaultMiniTimerPosition();
  miniTimerWindow = new BrowserWindow({
    width: MINI_TIMER_WINDOW_WIDTH,
    height: MINI_TIMER_WINDOW_HEIGHT,
    x: position.x,
    y: position.y,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  // 'screen-saver' is the same level the idle alert uses — high enough to
  // stay visible over a full-screen app, which is the whole point of a
  // widget meant to be glanceable while you're working in something else.
  miniTimerWindow.setAlwaysOnTop(true, 'screen-saver');
  miniTimerWindow.loadURL(rendererUrl('mini-timer'));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  miniTimerWindow.on('moved', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!miniTimerWindow) return;
      const [x, y] = miniTimerWindow.getPosition();
      saveMiniTimerPosition(x, y);
    }, 400);
  });
  miniTimerWindow.on('closed', () => {
    miniTimerWindow = null;
  });
}

interface MiniTimerData {
  taskName: string;
  projectName: string;
  elapsedSeconds: number;
  status: 'running' | 'paused' | 'idle-warning' | 'idle-critical';
}

ipcMain.on('mini-timer:show', async (_event, data: MiniTimerData) => {
  if (!miniTimerWindow || miniTimerWindow.isDestroyed()) {
    await createMiniTimerWindow();
  }
  const win = miniTimerWindow!;
  const show = () => {
    win.webContents.send('mini-timer:data', data);
    win.showInactive(); // doesn't steal focus from whatever app you're actually working in
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', show);
  } else {
    show();
  }
});

// Ticks/status changes while it's already showing — no window
// creation/positioning work needed, just fresh data.
ipcMain.on('mini-timer:update', (_event, data: MiniTimerData) => {
  miniTimerWindow?.webContents.send('mini-timer:data', data);
});

ipcMain.on('mini-timer:hide', () => {
  miniTimerWindow?.hide();
});

// The widget's own buttons have no logic of their own either — forwarded
// to the main window's renderer (where the real pause/resume/API logic
// lives) exactly like idle-alert:respond above. "dismiss" (the X) is the
// one action this process can fully handle itself, since it's purely a
// visibility change with no timer-state consequence.
ipcMain.on('mini-timer:action', (_event, action: 'pause' | 'resume' | 'dismiss') => {
  if (action === 'dismiss') {
    miniTimerWindow?.hide();
    return;
  }
  mainWindow?.webContents.send('mini-timer:action', action);
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
