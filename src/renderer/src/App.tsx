import React, { Suspense, useEffect, useState } from 'react'
import {
  Activity,
  Bell,
  Box,
  Clock,
  Database,
  FileText,
  Folder,
  Gauge,
  Globe,
  History,
  Home,
  Layers,
  ListChecks,
  Network,
  Plus,
  Settings,
  Shield,
  ShieldCheck,
  SquareTerminal,
  Terminal as TerminalIcon,
  Users as UsersIcon,
  Wifi,
  WifiOff,
  X
} from 'lucide-react'
import { useApp, type PageId } from '@/store/app'
import { NAV, PAGES } from '@/pages'
import Connections from '@/pages/Connections'
import TasksDrawer from '@/components/TasksDrawer'
import SettingsModal from '@/components/SettingsModal'
import { ConfirmHost, Toaster, Loading, Button, Spinner, Dot } from '@/components/ui'
import { cls } from '@/lib/format'

const ICONS: Record<PageId, React.ReactNode> = {
  overview: <Gauge />,
  terminal: <SquareTerminal />,
  files: <Folder />,
  docker: <Box />,
  webserver: <Globe />,
  databases: <Database />,
  runtimes: <Layers />,
  cron: <Clock />,
  processes: <Activity />,
  users: <UsersIcon />,
  firewall: <Shield />,
  security: <ShieldCheck />,
  logs: <FileText />,
  snippets: <TerminalIcon />,
  tunnels: <Network />,
  alerts: <Bell />,
  audit: <History />
}

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    init().finally(() => setReady(true))
  }, [init])
  if (!ready) return <Loading label="Starting…" />
  return (
    <div className="h-full flex flex-col bg-bg">
      <TabBar />
      <div className="flex-1 min-h-0 flex">
        <Workspace />
      </div>
      <TasksDrawer />
      <Toaster />
      <ConfirmHost />
    </div>
  )
}

function TabBar(): React.JSX.Element {
  const { tabs, activeTab, setActiveTab, closeTab, servers, connections, tasks, toggleTasks, alerts } = useApp()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const running = tasks.filter((t) => t.status === 'running').length
  const unack = alerts.filter((a) => !a.acknowledged).length
  return (
    <div className="h-10 bg-bg-2 border-b border-border flex items-stretch shrink-0 drag">
      <div className="flex items-stretch no-drag overflow-x-auto">
        <button onClick={() => setActiveTab('home')} className={cls('px-3 flex items-center gap-2 border-r border-border text-muted hover:text-text', activeTab === 'home' && 'bg-bg text-text')} title="Servers">
          <Home size={15} />
        </button>
        {tabs
          .filter((t) => t !== 'home')
          .map((id) => {
            const s = servers.find((x) => x.id === id)
            const st = connections[id]?.status ?? 'disconnected'
            return (
              <div
                key={id}
                onClick={() => setActiveTab(id)}
                onAuxClick={(e) => e.button === 1 && closeTab(id)}
                className={cls('group px-3 flex items-center gap-2 border-r border-border cursor-default min-w-[140px] max-w-[220px]', activeTab === id ? 'bg-bg text-text' : 'text-muted hover:text-text hover:bg-panel')}
              >
                <Dot status={st === 'connected' ? 'ok' : st === 'connecting' || st === 'reconnecting' ? 'warn' : st === 'error' ? 'danger' : 'muted'} />
                <span className="truncate text-xs font-medium flex-1">{s?.name ?? 'Server'}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(id)
                  }}
                  className="opacity-0 group-hover:opacity-100 text-dim hover:text-text"
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
        <button onClick={() => setActiveTab('home')} className="px-2.5 flex items-center text-dim hover:text-text" title="Add server">
          <Plus size={15} />
        </button>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1 px-2 no-drag">
        <Button variant="ghost" size="sm" onClick={() => toggleTasks()} icon={running ? <Spinner size={13} /> : <ListChecks size={14} />}>
          Tasks{running ? ` (${running})` : ''}
        </Button>
        {unack > 0 && (
          <span className="text-[10px] bg-warn/20 text-amber-300 border border-warn/40 rounded px-1.5 h-5 flex items-center" title="Unacknowledged alerts">
            {unack} alert{unack > 1 ? 's' : ''}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} icon={<Settings size={14} />} title="Settings" />
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

function Workspace(): React.JSX.Element {
  const activeTab = useApp((s) => s.activeTab)
  if (activeTab === 'home') return <Connections />
  return <ServerView serverId={activeTab} key={activeTab} />
}

function ServerView({ serverId }: { serverId: string }): React.JSX.Element {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId))
  const conn = useApp((s) => s.connections[serverId])
  const page = useApp((s) => s.page[serverId] ?? 'overview')
  const setPage = useApp((s) => s.setPage)
  const connect = useApp((s) => s.connect)
  const disconnect = useApp((s) => s.disconnect)
  const status = conn?.status ?? 'disconnected'
  const PageComp = PAGES[page]
  const groups: { key: string; label?: string }[] = [{ key: 'main' }, { key: 'services', label: 'Services' }, { key: 'system', label: 'System' }, { key: 'extra', label: 'Tools' }]

  return (
    <>
      <aside className="w-[200px] shrink-0 bg-bg-2 border-r border-border flex flex-col">
        <div className="px-4 pt-4 pb-3 border-b border-border">
          <div className="flex items-center gap-2 font-semibold text-[13px] truncate">
            <Dot status={status === 'connected' ? 'ok' : status === 'connecting' || status === 'reconnecting' ? 'warn' : status === 'error' ? 'danger' : 'muted'} />
            <span className="truncate">{server?.name ?? 'Server'}</span>
          </div>
          <div className="text-[11px] text-muted font-mono truncate mt-1">
            {server?.username}@{server?.host}
            {server && server.port !== 22 ? `:${server.port}` : ''}
          </div>
          <div className="text-[11px] text-dim truncate">{conn?.os?.prettyName ?? (status === 'connecting' ? 'Connecting…' : status === 'reconnecting' ? 'Reconnecting…' : status === 'error' ? 'Connection error' : 'Disconnected')}</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {groups.map((g) => (
            <div key={g.key} className="mb-1">
              {g.label && <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-dim font-semibold">{g.label}</div>}
              {NAV.filter((n) => n.group === g.key).map((n) => (
                <button
                  key={n.id}
                  onClick={() => setPage(serverId, n.id)}
                  className={cls('w-full flex items-center gap-2.5 px-4 h-8 text-[13px] text-left [&>svg]:w-4 [&>svg]:h-4 transition-colors', page === n.id ? 'bg-panel-2 text-text font-medium' : 'text-muted hover:text-text hover:bg-panel')}
                >
                  {ICONS[n.id]}
                  {n.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-border">
          {status === 'connected' ? (
            <Button variant="ghost" size="sm" className="w-full justify-start" icon={<WifiOff size={14} />} onClick={() => disconnect(serverId)}>
              Disconnect
            </Button>
          ) : (
            <Button variant="primary" size="sm" className="w-full" loading={status === 'connecting' || status === 'reconnecting'} icon={<Wifi size={14} />} onClick={() => connect(serverId)}>
              Connect
            </Button>
          )}
        </div>
      </aside>
      <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg">
        {status === 'connected' ? (
          <Suspense fallback={<Loading />}>
            <PageComp serverId={serverId} />
          </Suspense>
        ) : (
          <Disconnected serverId={serverId} />
        )}
      </main>
    </>
  )
}

function Disconnected({ serverId }: { serverId: string }): React.JSX.Element {
  const conn = useApp((s) => s.connections[serverId])
  const connect = useApp((s) => s.connect)
  const server = useApp((s) => s.servers.find((x) => x.id === serverId))
  const status = conn?.status ?? 'disconnected'
  const hk = conn?.hostKey
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-lg w-full bg-panel border border-border rounded-lg p-6 text-center">
        {status === 'connecting' || status === 'reconnecting' ? (
          <>
            <Spinner size={24} className="mx-auto mb-3" />
            <div className="font-medium">{status === 'connecting' ? 'Connecting' : 'Reconnecting'} to {server?.host}…</div>
            {conn?.error && <div className="text-muted text-xs mt-1">{conn.error}</div>}
          </>
        ) : conn?.errorCode === 'HOST_KEY_CHANGED' ? (
          <>
            <div className="text-danger font-semibold mb-2">Server identity changed</div>
            <div className="text-xs text-muted leading-relaxed text-left">
              The host key of <b className="text-text">{server?.host}</b> does not match the one saved on this computer. This happens after a server is reinstalled, but it can also mean someone is intercepting the connection.
              <div className="mt-3 font-mono bg-bg-2 border border-border rounded p-2 break-all">
                <div>
                  <span className="text-dim">saved:</span> {hk?.previous}
                </div>
                <div>
                  <span className="text-dim">now:</span> {hk?.fingerprint}
                </div>
              </div>
            </div>
            <div className="flex justify-center gap-2 mt-4">
              <Button variant="danger" onClick={() => connect(serverId, { trustNewHostKey: true })}>
                Trust new key and connect
              </Button>
            </div>
          </>
        ) : (
          <>
            <WifiOff size={28} className="mx-auto text-dim mb-3" />
            <div className="font-medium">{status === 'error' ? 'Connection failed' : 'Not connected'}</div>
            {conn?.error && <div className="text-red-300 text-xs mt-2 font-mono whitespace-pre-wrap">{conn.error}</div>}
            <div className="mt-4">
              <Button variant="primary" icon={<Wifi size={14} />} onClick={() => connect(serverId)}>
                Connect
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
