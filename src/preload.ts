// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// Deliberately tiny surface: only the two things the renderer actually
// needs from the main process, not general IPC/Node access.
contextBridge.exposeInMainWorld('timeStaff', {
  getIdleSeconds: (): Promise<number> => ipcRenderer.invoke('get-idle-seconds'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
});
