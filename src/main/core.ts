import { BrowserWindow, ipcMain } from 'electron'
import type { AppEvent, AuthPrompt } from '@shared/types'
import { randomUUID } from 'crypto'
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
  /** Ask the user to answer interactive SSH login prompts (returns null when cancelled / timed out). */
  askAuth(serverId: string, name: string, instructions: string, prompts: { prompt: string; echo: boolean }[], prefilled: (string | null)[]): Promise<string[] | null>
  /** Deliver the user's answers for a pending askAuth request. */
  answerAuth(requestId: string, answers: string[] | null): void
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

  const pendingAuth = new Map<string, { resolve: (a: string[] | null) => void; timer: NodeJS.Timeout }>()
  const askAuth: Ctx['askAuth'] = (serverId, name, instructions, prompts, prefilled) =>
    new Promise((resolve) => {
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        pendingAuth.delete(requestId)
        emit({ type: 'auth-prompt-done', requestId })
        resolve(null)
      }, 180000)
      pendingAuth.set(requestId, { resolve, timer })
      const prompt: AuthPrompt = {
        requestId,
        serverId,
        serverName: getServer(serverId)?.name ?? serverId,
        title: name || 'Additional authentication required',
        instructions,
        prompts: prompts.map((p, i) => ({ prompt: p.prompt, echo: p.echo, prefilled: prefilled[i] !== null }))
      }
      emit({ type: 'auth-prompt', prompt })
    })
  const answerAuth: Ctx['answerAuth'] = (requestId, answers) => {
    const p = pendingAuth.get(requestId)
    if (!p) return
    clearTimeout(p.timer)
    pendingAuth.delete(requestId)
    emit({ type: 'auth-prompt-done', requestId })
    p.resolve(answers)
  }
  sessions.askAuth = askAuth

  const ctx: Ctx = {
    sessions,
    tasks,
    ssh: (id) => sessions.get(id),
    emit,
    askAuth,
    answerAuth,
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
