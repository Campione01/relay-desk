import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { createRelayApi } from '@shared/ipc';

// Only the fixed channel table is reachable from the renderer; there is no generic invoke.
const relay = createRelayApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
});

contextBridge.exposeInMainWorld('relay', relay);
// Dropped files: Electron no longer exposes File.path; the path is only read, never opened here.
contextBridge.exposeInMainWorld('relayFiles', { pathFor: (file: File): string => webUtils.getPathForFile(file) });
