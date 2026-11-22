import { create } from 'zustand'
import type { AlertEvent, AppSettings, AuthPrompt, ConnectionState, ServerProfile, TaskInfo } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from '@/lib/api'
import { applyTheme } from '@/lib/themes'

export type PageId =
  | 'overview'
  | 'terminal'
  | 'files'
  | 'docker'
  | 'webserver'
  | 'databases'
  | 'runtimes'
  | 'cron'
  | 'processes'
  | 'users'
  | 'firewall'
  | 'twofactor'
  | 'security'
  | 'logs'
  | 'snippets'
  | 'tunnels'
  | 'alerts'
  | 'audit'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'warn'
  title: string
  detail?: string
}

interface AppState {
  servers: ServerProfile[]
  connections: Record<string, ConnectionState>
  /** Open server tabs (server ids). 'home' is the connection manager. */
  tabs: string[]
  activeTab: string
  page: Record<string, PageId>
  tasks: TaskInfo[]
  tasksOpen: boolean
  alerts: AlertEvent[]
  settings: AppSettings
  toasts: Toast[]
  appVersion: string
  update: { status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error'; version?: string; percent?: number; error?: string }
  /** Commands queued for the Terminal page (consumed when it mounts / is visible). */
  pendingTerminal: Record<string, string[]>
  /** Interactive SSH login prompts waiting for the user (2FA codes etc.). */
  authPrompts: AuthPrompt[]

  init(): Promise<void>
  refreshServers(): Promise<void>
  openTab(serverId: string): void
  closeTab(serverId: string): void
  setActiveTab(id: string): void
  setPage(serverId: string, page: PageId): void
  connect(serverId: string, opts?: { trustNewHostKey?: boolean }): Promise<void>
  disconnect(serverId: string): Promise<void>
  toggleTasks(open?: boolean): void
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: number): void
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  refreshAlerts(): Promise<void>
  /** Switch to the Terminal page of a server and (optionally) run a command in a new shell tab. */
  openTerminal(serverId: string, command?: string): void
  takePendingTerminal(serverId: string): string[]
}

let toastSeq = 1

export const useApp = create<AppState>((set, get) => ({
  servers: [],
  connections: {},
  tabs: ['home'],
  activeTab: 'home',
  page: {},
  tasks: [],
  tasksOpen: false,
  alerts: [],
  settings: DEFAULT_SETTINGS,
  toasts: [],
  appVersion: '',
  update: { status: 'idle' },
  pendingTerminal: {},
  authPrompts: [],

  async init() {
    const [servers, states, tasks, settings, info, alerts] = await Promise.all([
      api.global<ServerProfile[]>('servers:list'),
      api.global<ConnectionState[]>('servers:states'),
      api.global<TaskInfo[]>('tasks:list'),
      api.global<AppSettings>('settings:get'),
      window.api.appInfo(),
      api.global<AlertEvent[]>('alerts:list').catch(() => [] as AlertEvent[])
    ])
    const connections: Record<string, ConnectionState> = {}
    for (const s of states) connections[s.serverId] = s
    set({ servers, connections, tasks, settings, appVersion: info.version, alerts })
    applyTheme(settings.theme)
    api.onEvent((e) => {
      if (e.type === 'connection') {
        set((st) => ({ connections: { ...st.connections, [e.state.serverId]: e.state } }))
        if (e.state.status === 'error' && e.state.error) {
          const name = get().servers.find((s) => s.id === e.state.serverId)?.name ?? 'Server'
          get().toast({ kind: 'error', title: `${name}: connection failed`, detail: e.state.error })
        }
      } else if (e.type === 'task') {
        set((st) => {
          const idx = st.tasks.findIndex((t) => t.id === e.task.id)
          const tasks = idx >= 0 ? st.tasks.map((t) => (t.id === e.task.id ? e.task : t)) : [e.task, ...st.tasks]
          return { tasks }
        })
        if (e.task.status === 'failed') get().toast({ kind: 'error', title: `Task failed: ${e.task.title}`, detail: e.task.error })
        else if (e.task.status === 'done') get().toast({ kind: 'success', title: `Done: ${e.task.title}` })
      } else if (e.type === 'auth-prompt') {
        set((st) => ({ authPrompts: [...st.authPrompts.filter((p) => p.requestId !== e.prompt.requestId), e.prompt] }))
      } else if (e.type === 'auth-prompt-done') {
        set((st) => ({ authPrompts: st.authPrompts.filter((p) => p.requestId !== e.requestId) }))
      } else if (e.type === 'update') {
        const info = (e.info ?? {}) as { version?: string; percent?: number }
        const prev = get().update
        if (e.status === 'available') {
          set({ update: { status: 'available', version: info.version } })
          if (prev.version !== info.version) get().toast({ kind: 'info', title: `Version ${info.version} is available`, detail: 'Click "Update" in the top bar to download and install it.' })
        } else if (e.status === 'downloading') set({ update: { status: 'downloading', version: prev.version, percent: Math.round(info.percent ?? 0) } })
        else if (e.status === 'downloaded') set({ update: { status: 'downloaded', version: prev.version } })
        else if (e.status === 'error') set({ update: { status: 'error', version: prev.version, error: String(e.info ?? 'Update failed') } })
        else if (e.status === 'none') set({ update: { status: 'none' } })
        else if (e.status === 'checking') set({ update: { ...prev, status: prev.status === 'idle' || prev.status === 'none' ? 'checking' : prev.status } })
      } else if (e.type === 'alert') {
        set((st) => ({ alerts: [e.alert, ...st.alerts].slice(0, 500) }))
        get().toast({ kind: 'warn', title: `${e.alert.serverName}: ${e.alert.message}` })
      }
    })
  },

  async refreshServers() {
    set({ servers: await api.global<ServerProfile[]>('servers:list') })
  },

  openTab(serverId) {
    set((st) => ({ tabs: st.tabs.includes(serverId) ? st.tabs : [...st.tabs, serverId], activeTab: serverId }))
  },
  closeTab(serverId) {
    set((st) => {
      const tabs = st.tabs.filter((t) => t !== serverId)
      const activeTab = st.activeTab === serverId ? tabs[tabs.length - 1] ?? 'home' : st.activeTab
      return { tabs, activeTab }
    })
  },
  setActiveTab(id) {
    set({ activeTab: id })
  },
  setPage(serverId, page) {
    set((st) => ({ page: { ...st.page, [serverId]: page } }))
  },

  async connect(serverId, opts) {
    get().openTab(serverId)
    set((st) => ({ connections: { ...st.connections, [serverId]: { serverId, status: 'connecting' } } }))
    try {
      await api.call('servers:connect', serverId, opts)
    } catch {
      /* state event carries the error */
    }
  },
  async disconnect(serverId) {
    await api.call('servers:disconnect', serverId)
  },

  toggleTasks(open) {
    set((st) => ({ tasksOpen: open ?? !st.tasksOpen }))
  },
  toast(t) {
    const id = toastSeq++
    set((st) => ({ toasts: [...st.toasts, { ...t, id }] }))
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 9000 : 4500)
  },
  dismissToast(id) {
    set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
  },
  async saveSettings(patch) {
    const settings = await api.global<AppSettings>('settings:set', patch)
    set({ settings })
    applyTheme(settings.theme)
  },
  async refreshAlerts() {
    set({ alerts: await api.global<AlertEvent[]>('alerts:list') })
  },
  openTerminal(serverId, command) {
    set((st) => ({
      page: { ...st.page, [serverId]: 'terminal' },
      activeTab: serverId,
      pendingTerminal: command ? { ...st.pendingTerminal, [serverId]: [...(st.pendingTerminal[serverId] ?? []), command] } : st.pendingTerminal
    }))
  },
  takePendingTerminal(serverId) {
    const list = get().pendingTerminal[serverId] ?? []
    if (list.length) set((st) => ({ pendingTerminal: { ...st.pendingTerminal, [serverId]: [] } }))
    return list
  }
}))

/** Convenience hook: is a server connected. */
export function useConnected(serverId: string): boolean {
  return useApp((s) => s.connections[serverId]?.status === 'connected')
}
