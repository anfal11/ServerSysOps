import { BrowserWindow, ipcMain } from 'electron'
import type { AppEvent } from '@shared/types'
import { SessionManager } from './ssh/SessionManager'
import { TaskManager } from './tasks/TaskManager'
import type { SshClient } from './ssh/SshClient'
import { addAudit } from './store/settings'
import { getServer } from './store/servers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (serverId: string, ...args: any[]) => Promise<unknown> | unknown

export interface Ctx {
  sessions: SessionManager
  tasks: TaskManager
  /** Connected SshClient for a server (throws when not connected). */
  ssh(serverId: string): SshClient
  /** Register an IPC handler. First renderer argument is always the server id (may be '' for global handlers). */
  handle(channel: string, handler: Handler): void
  /** Broadcast an event to all renderer windows. */
  emit(event: AppEvent): void
  /** Record an entry in the local audit log. */
  audit(serverId: string | undefined, action: string, detail?: string, ok?: boolean): void
}

export function createContext(): Ctx {
  const sessions = new SessionManager()
  const tasks = new TaskManager()
  const registered = new Set<string>()

  const emit = (event: AppEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('app:event', event)
    }
  }

  sessions.on('state', (state) => emit({ type: 'connection', state }))
  tasks.on('update', (task) => emit({ type: 'task', task }))

  const ctx: Ctx = {
    sessions,
    tasks,
    ssh: (id) => sessions.get(id),
    emit,
    audit: (serverId, action, detail, ok = true) => {
      const name = serverId ? getServer(serverId)?.name : undefined
      addAudit({ serverId, serverName: name, action, detail, ok })
    },
    handle: (channel, handler) => {
      if (registered.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`)
      registered.add(channel)
      ipcMain.handle(channel, async (_e, serverId: string, ...args: unknown[]) => {
        try {
          return { ok: true, data: await handler(serverId, ...args) }
        } catch (e) {
          const err = e as Error & { code?: string }
          return { ok: false, error: err?.message ?? String(e), code: err?.code }
        }
      })
    }
  }
  return ctx
}
