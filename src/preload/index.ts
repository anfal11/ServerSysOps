import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent } from '@shared/types'

export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  code?: string
}

const api = {
  /** Invoke a service handler. First arg after channel is the server id ('' for global). */
  invoke: <T = unknown>(channel: string, serverId: string, ...args: unknown[]): Promise<IpcResult<T>> =>
    ipcRenderer.invoke(channel, serverId, ...args) as Promise<IpcResult<T>>,
  appInfo: () => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string; userData: string; electron: string }>,
  openExternal: (url: string) => ipcRenderer.send('app:openExternal', url),
  showItem: (p: string) => ipcRenderer.send('app:showItem', p),
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.send('window:control', action),
  onEvent: (cb: (e: AppEvent) => void): (() => void) => {
    const listener = (_: unknown, e: AppEvent): void => cb(e)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
