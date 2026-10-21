import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only bridge in the app, and only for the local setup/offline pages.
 *
 * It exposes three verbs — read the current address, probe, connect — and nothing that can read the
 * stored token back. The remote UI window has no preload at all.
 */
contextBridge.exposeInMainWorld('coreSetup', {
  current: (): Promise<{ serverUrl?: string }> => ipcRenderer.invoke('setup:current'),
  probe: (payload: { serverUrl: string; token: string }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('setup:probe', payload),
  connect: (payload: { serverUrl: string; token: string }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('setup:connect', payload),
  forget: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('setup:forget'),
})
