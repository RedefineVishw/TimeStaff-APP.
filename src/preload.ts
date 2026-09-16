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

// Deliberately tiny surface: only what the renderer actually needs from the
// main process, not general IPC/Node access. Shared by both the main window
// and the separate idle-alert window (they use different parts of it).
contextBridge.exposeInMainWorld('timeStaff', {
  getIdleSeconds: (): Promise<number> => ipcRenderer.invoke('get-idle-seconds'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  captureScreenshot: (): Promise<Uint8Array> => ipcRenderer.invoke('capture-screenshot'),
  auth: {
    getRefreshToken: (): Promise<string | null> => ipcRenderer.invoke('auth:get-refresh-token'),
    setRefreshToken: (token: string): Promise<boolean> => ipcRenderer.invoke('auth:set-refresh-token', token),
    clearRefreshToken: (): Promise<void> => ipcRenderer.invoke('auth:clear-refresh-token'),
  },
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
