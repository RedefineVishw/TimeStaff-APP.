// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

interface IdleAlertShowData {
  idleSeconds: number;
  projectName: string;
  taskName: string;
}

interface IdleAlertResponse {
  action: 'stop' | 'resume';
  wasWorking: 'no' | 'yes';
}

interface MiniTimerData {
  taskName: string;
  projectName: string;
  elapsedSeconds: number;
  status: 'running' | 'paused' | 'idle-warning' | 'idle-critical';
}

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

type MiniTimerAction = 'pause' | 'resume' | 'dismiss';

// Deliberately tiny surface: only what the renderer actually needs from the
// main process, not general IPC/Node access. Shared by both the main window
// and the separate idle-alert window (they use different parts of it).
contextBridge.exposeInMainWorld('timeStaff', {
  // macOS always draws its own traffic-light window buttons even with
  // titleBarStyle: 'hidden' — the renderer uses this to skip rendering its
  // own custom minimize/maximize/close there instead of drawing a second,
  // conflicting set (see TitleBar in App.tsx). A plain value, not an IPC
  // call, since it never changes for the life of the process.
  platform: process.platform,
  getIdleSeconds: (): Promise<number> => ipcRenderer.invoke('get-idle-seconds'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  captureScreenshot: (): Promise<Uint8Array> => ipcRenderer.invoke('capture-screenshot'),
  // Shows the small "screenshot captured" popup window at the given screen
  // position (see the screenshot toast section of main.ts).
  notifyScreenshotCaptured: (position: ScreenshotAlertPosition): Promise<void> =>
    ipcRenderer.invoke('notify-screenshot-captured', position),
  // The screenshot popup's own dismiss (X) button — closes it immediately
  // instead of waiting out the few seconds it stays up.
  screenshotToast: {
    dismiss: () => ipcRenderer.send('screenshot-toast:dismiss'),
  },
  auth: {
    getRefreshToken: (): Promise<string | null> => ipcRenderer.invoke('auth:get-refresh-token'),
    setRefreshToken: (token: string): Promise<boolean> => ipcRenderer.invoke('auth:set-refresh-token', token),
    clearRefreshToken: (): Promise<void> => ipcRenderer.invoke('auth:clear-refresh-token'),
  },
  // Custom title bar controls (see main.ts) — this app draws its own
  // minimize/maximize/close buttons instead of relying on Electron's
  // titleBarOverlay, whose native hover styling for minimize/maximize is
  // barely visible against a light title bar.
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChanged: (callback: (isMaximized: boolean) => void) => {
      const listener = (_event: unknown, isMaximized: boolean) => callback(isMaximized);
      ipcRenderer.on('window:maximized-changed', listener);
      return () => ipcRenderer.removeListener('window:maximized-changed', listener);
    },
  },
  // The floating always-on-top mini timer widget (see main.ts). Same
  // "dumb popup, real logic in the main window" split as idleAlert below —
  // this just shows/hides/updates it and reports back which button (if
  // any) was clicked in it.
  miniTimer: {
    show: (data: MiniTimerData) => ipcRenderer.send('mini-timer:show', data),
    update: (data: MiniTimerData) => ipcRenderer.send('mini-timer:update', data),
    hide: () => ipcRenderer.send('mini-timer:hide'),
    // Called by the mini-timer window itself when a button is clicked.
    respondAction: (action: MiniTimerAction) => ipcRenderer.send('mini-timer:action', action),
    // Mini-timer window listens for this to know what to display.
    onData: (callback: (data: MiniTimerData) => void) => {
      const listener = (_event: unknown, data: MiniTimerData) => callback(data);
      ipcRenderer.on('mini-timer:data', listener);
      return () => ipcRenderer.removeListener('mini-timer:data', listener);
    },
    // Main window listens for this to know a pause/resume click to act on
    // ("dismiss" is handled entirely in main.ts — it never reaches here).
    onAction: (callback: (action: MiniTimerAction) => void) => {
      const listener = (_event: unknown, action: MiniTimerAction) => callback(action);
      ipcRenderer.on('mini-timer:action', listener);
      return () => ipcRenderer.removeListener('mini-timer:action', listener);
    },
  },
  // Fired when the user closes the main window — the renderer stops
  // whatever timer is running (an async API call only it can make) and
  // then confirms so main.ts can let the close actually proceed.
  onBeforeClose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('app:before-close', listener);
    return () => ipcRenderer.removeListener('app:before-close', listener);
  },
  confirmReadyToClose: () => ipcRenderer.send('app:ready-to-close'),
  idleAlert: {
    // Called by the main window when idle crosses the threshold — asks
    // main to pop the separate always-on-top window.
    show: (data: IdleAlertShowData) => ipcRenderer.send('idle-alert:show', data),
    // Called by the main window on abandon-timeout auto-resolve, to close
    // the popup if the user never responded.
    hide: () => ipcRenderer.send('idle-alert:hide'),
    // Called by the idle-alert window itself when the user clicks a button.
    respond: (response: IdleAlertResponse) => ipcRenderer.send('idle-alert:respond', response),
    // Main window listens for this to know a decision to act on.
    onResponse: (callback: (response: IdleAlertResponse) => void) => {
      const listener = (_event: unknown, response: IdleAlertResponse) => callback(response);
      ipcRenderer.on('idle-alert:response', listener);
      return () => ipcRenderer.removeListener('idle-alert:response', listener);
    },
    // Idle-alert window listens for this to know what to display.
    onData: (callback: (data: IdleAlertShowData) => void) => {
      const listener = (_event: unknown, data: IdleAlertShowData) => callback(data);
      ipcRenderer.on('idle-alert:data', listener);
      return () => ipcRenderer.removeListener('idle-alert:data', listener);
    },
  },
});
