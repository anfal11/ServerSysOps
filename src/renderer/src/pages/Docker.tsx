import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Box,
  Boxes,
  Container,
  Copy,
  Download,
  FileCode2,
  FileText,
  HardDrive,
  Info,
  Layers,
  ListTree,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  ContextMenu,
  EmptyState,
  ErrorBox,
  Field,
  IconButton,
  Input,
  KV,
  Loading,
  Modal,
  Page,
  PageHeader,
  Pre,
  SearchInput,
  Select,
  Stat,
  Table,
  Tabs,
  TextArea,
  Toggle,
  confirm,
  useAction,
  useAsync,
  type Column,
  type MenuItem
} from '@/components/ui'
import { useApp } from '@/store/app'
import { PackageUpdate } from '@/components/PackageUpdate'
import { cls } from '@/lib/format'
import type { DockerContainer, DockerImage, DockerNetwork, DockerVolume } from '@shared/types'
import type {
  ComposeAction,
  ComposeFile,
  ComposeProject,
  DockerContainerAction,
  DockerInfo,
  DockerNetworkDriver,
  DockerPruneOpts,
  DockerRestartPolicy,
  DockerRunSpec,
  DockerSystemDf,
  DockerTop
} from '@shared/modules/docker'

type TabId = 'containers' | 'images' | 'volumes' | 'networks' | 'compose' | 'system'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Candidate package names for the Docker engine across distros; `pkg:versions` reports which are actually installed. */
const DOCKER_PACKAGES = ['docker-ce', 'docker-ce-cli', 'docker-compose-plugin', 'docker-buildx-plugin', 'docker.io', 'docker-compose-v2', 'moby-engine']

function taskToast(title: string): void {
  useApp.getState().toast({ kind: 'info', title, detail: 'Progress is shown in the Tasks drawer.' })
}

function stateColor(state: string): 'ok' | 'warn' | 'danger' | 'info' | 'muted' {
  switch (state) {
    case 'running':
      return 'ok'
    case 'paused':
    case 'restarting':
    case 'removing':
      return 'warn'
    case 'dead':
      return 'danger'
    case 'created':
      return 'info'
    default:
      return 'muted'
  }
}

function fmtPorts(ports: string): string {
  if (!ports) return ''
  const parts = ports
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(':::') && !p.startsWith('[::]'))
  return parts.map((p) => p.replace(/^0\.0\.0\.0:/, ':')).join('  ')
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12)
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${esc})`, 'gi'))
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-warn/40 text-text rounded-sm">
        {p}
      </mark>
    ) : (
      p
    )
  )
}

function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function Toolbar({ children, right }: { children?: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-3 min-h-[28px]">
      {children}
      <div className="flex-1" />
      {right}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Docker({ serverId }: PageProps): React.JSX.Element {
  const info = useAsync(() => api.call<DockerInfo>('docker:info', serverId), [serverId])
  const [tab, setTab] = useState<TabId>('containers')
  const [runOpen, setRunOpen] = useState<string | false>(false)
  const [pullOpen, setPullOpen] = useState(false)
  const { run, busy } = useAction()
  const d = info.data
  const ready = Boolean(d?.installed && d.running)

  const install = (): void => {
    void run(async () => {
      await api.call('docker:install', serverId)
      taskToast('Installing Docker…')
    })
  }
  const service = (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'): void => {
    void run(() => api.call('docker:serviceToggle', serverId, action), { success: `Docker daemon: ${action}` }).then(() => info.reload())
  }

  return (
    <>
      <PageHeader
        title="Docker"
        subtitle={
          d?.installed ? (
            <span className="inline-flex items-center gap-1.5">
              {d.version && <Badge color="accent">v{d.version}</Badge>}
              {d.composeVersion && <Badge>compose {d.composeVersion}</Badge>}
              {d.needsSudo && <Badge color="warn">via sudo</Badge>}
              {d.rootless && <Badge color="info">rootless</Badge>}
              {/* Docker's own repo (docker-ce…) or the distro packages (docker.io / moby-engine); packages that are not installed are not shown. */}
              <PackageUpdate serverId={serverId} packages={DOCKER_PACKAGES} restart={d.hasSystemd && !d.rootless ? ['docker'] : undefined} label="Docker" className="ml-1" />
            </span>
          ) : undefined
        }
        actions={
          <>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => info.reload()} loading={info.loading && !!d} />
            <Button icon={<ArrowDownToLine size={13} />} disabled={!ready} onClick={() => setPullOpen(true)}>
              Pull
            </Button>
            <Button variant="primary" icon={<Play size={13} />} disabled={!ready} onClick={() => setRunOpen('')}>
              Run container
            </Button>
          </>
        }
      />
      <Page>
        {info.error ? (
          <ErrorBox error={info.error} onRetry={info.reload} />
        ) : !d ? (
          <Loading />
        ) : !d.installed ? (
          <Card>
            <EmptyState
              icon={<Container />}
              title="Docker is not installed"
              description="Install Docker Engine and the Compose plugin using the official convenience script (get.docker.com) or the distribution packages, enable the service and add your user to the docker group."
              action={
                <Button variant="primary" icon={<Download size={14} />} onClick={install} loading={busy}>
                  Install Docker
                </Button>
              }
            />
          </Card>
        ) : !d.running ? (
          <Card>
            <EmptyState
              icon={<Power />}
              title="Docker daemon is not running"
              description={
                <>
                  Docker {d.version ? `v${d.version} ` : ''}is installed but the daemon is not reachable
                  {d.serviceActive ? ` (systemd: ${d.serviceActive}${d.serviceEnabled ? `, ${d.serviceEnabled}` : ''})` : ''}.
                  {!d.userInGroup && !d.needsSudo ? ' Your user is not in the docker group and sudo is unavailable.' : ''}
                </>
              }
              action={
                <div className="flex gap-2">
                  <Button variant="primary" icon={<Play size={13} />} onClick={() => service('start')} loading={busy}>
                    Start daemon
                  </Button>
                  {d.hasSystemd && d.serviceEnabled !== 'enabled' && (
                    <Button onClick={() => service('enable')} loading={busy}>
                      Enable at boot
                    </Button>
                  )}
                </div>
              }
            />
          </Card>
        ) : (
          <>
            {!d.userInGroup && !d.needsSudo && !d.rootless && (
              <Callout kind="warn">
                Your user is not a member of the <code>docker</code> group; commands may fail without sudo.
              </Callout>
            )}
            <div className="flex items-center justify-between mb-4 mt-1">
              <Tabs<TabId>
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'containers', label: 'Containers', count: d.info?.containers },
                  { id: 'images', label: 'Images', count: d.info?.images },
                  { id: 'volumes', label: 'Volumes' },
                  { id: 'networks', label: 'Networks' },
                  { id: 'compose', label: 'Compose' },
                  { id: 'system', label: 'System & Prune' }
                ]}
              />
            </div>
            {tab === 'containers' && <ContainersTab serverId={serverId} needsSudo={d.needsSudo} onChanged={() => void info.reload()} />}
            {tab === 'images' && <ImagesTab serverId={serverId} onRun={(img) => setRunOpen(img)} onPull={() => setPullOpen(true)} onChanged={() => void info.reload()} />}
            {tab === 'volumes' && <VolumesTab serverId={serverId} />}
            {tab === 'networks' && <NetworksTab serverId={serverId} />}
            {tab === 'compose' && <ComposeTab serverId={serverId} composeAvailable={Boolean(d.composeVersion)} />}
            {tab === 'system' && <SystemTab serverId={serverId} info={d} onService={service} busy={busy} />}
          </>
        )}
      </Page>
      {runOpen !== false && <RunModal serverId={serverId} initialImage={runOpen} onClose={() => setRunOpen(false)} />}
      {pullOpen && <PullModal serverId={serverId} onClose={() => setPullOpen(false)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */

function ContainersTab({ serverId, needsSudo, onChanged }: { serverId: string; needsSudo: boolean; onChanged: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<DockerContainer[]>('docker:containers', serverId), [serverId], { intervalMs: 5000 })
  const [filter, setFilter] = useState('')
  const [logs, setLogs] = useState<DockerContainer | null>(null)
  const [inspect, setInspect] = useState<DockerContainer | null>(null)
  const [top, setTop] = useState<DockerContainer | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; c: DockerContainer } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const { run } = useAction()

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (data ?? []).filter((c) => !f || c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || c.id.startsWith(f) || c.state.includes(f))
  }, [data, filter])
  const running = (data ?? []).filter((c) => c.state === 'running').length

  const act = async (c: DockerContainer, action: DockerContainerAction, label: string): Promise<void> => {
    setPending(c.id)
    try {
      await run(() => api.call('docker:containerAction', serverId, c.id, action), { success: `${label}: ${c.name}` })
    } finally {
      setPending(null)
    }
    await reload()
    onChanged()
  }
  const remove = async (c: DockerContainer, force: boolean): Promise<void> => {
    if (
      !(await confirm({
        title: force ? 'Force remove container' : 'Remove container',
        message: (
          <>
            Remove <b className="font-mono">{c.name}</b>?{force && ' The container is running and will be killed first.'} Anonymous volumes are kept.
          </>
        ),
        danger: true,
        confirmLabel: 'Remove'
      }))
    )
      return
    await act(c, force ? 'removeForce' : 'remove', 'Removed')
  }
  const kill = async (c: DockerContainer): Promise<void> => {
    if (!(await confirm({ title: 'Kill container', message: <>Send SIGKILL to <b className="font-mono">{c.name}</b>? Unsaved data inside the container may be lost.</>, danger: true, confirmLabel: 'Kill' }))) return
    await act(c, 'kill', 'Killed')
  }
  const removeStopped = async (): Promise<void> => {
    const stopped = (data ?? []).filter((c) => c.state !== 'running' && c.state !== 'paused' && c.state !== 'restarting')
    if (!stopped.length) return
    if (
      !(await confirm({
        title: 'Remove stopped containers',
        message: (
          <>
            Remove {stopped.length} stopped container{stopped.length > 1 ? 's' : ''}?
            <Pre className="mt-2" maxH="max-h-40">
              {stopped.map((c) => c.name).join('\n')}
            </Pre>
          </>
        ),
        danger: true,
        confirmLabel: `Remove ${stopped.length}`
      }))
    )
      return
    await run(async () => {
      for (const c of stopped) await api.call('docker:containerAction', serverId, c.id, 'remove')
    }, { success: `Removed ${stopped.length} container${stopped.length > 1 ? 's' : ''}` })
    await reload()
    onChanged()
  }
  const shell = (c: DockerContainer): void => {
    useApp.getState().openTerminal(serverId, `${needsSudo ? 'sudo ' : ''}docker exec -it ${c.id} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`)
  }

  const columns: Column<DockerContainer>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (c) => c.name,
      render: (c) => (
        <div className="min-w-0">
          <div className="font-medium truncate max-w-[260px]" title={c.name}>
            {c.name}
          </div>
          <div className="text-dim text-[11px] font-mono">{shortId(c.id)}</div>
        </div>
      )
    },
    { key: 'image', header: 'Image', sortValue: (c) => c.image, render: (c) => <span className="font-mono text-xs truncate block max-w-[260px]" title={c.image}>{c.image}</span> },
    { key: 'state', header: 'State', width: '90px', sortValue: (c) => c.state, render: (c) => <Badge color={stateColor(c.state)}>{c.state}</Badge> },
    { key: 'status', header: 'Status', sortValue: (c) => c.status, render: (c) => <span className="text-muted text-xs whitespace-nowrap">{c.status}</span> },
    { key: 'ports', header: 'Ports', render: (c) => <span className="font-mono text-[11px] text-muted whitespace-pre-wrap">{fmtPorts(c.ports)}</span> },
    {
      key: 'res',
      header: 'CPU / Mem',
      width: '150px',
      sortValue: (c) => c.cpuPct ?? -1,
      render: (c) =>
        c.state === 'running' && c.cpuPct !== undefined ? (
          <div className="text-xs whitespace-nowrap">
            <span className={cls(c.cpuPct > 80 && 'text-warn-fg')}>{c.cpuPct.toFixed(1)}%</span>
            <span className="text-dim"> · </span>
            <span className="text-muted">{(c.memUsage ?? '').split('/')[0].trim()}</span>
            {c.memPct !== undefined && <span className="text-dim"> ({c.memPct.toFixed(0)}%)</span>}
          </div>
        ) : (
          <span className="text-dim">—</span>
        )
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '190px',
      render: (c) => {
        const isRunning = c.state === 'running' || c.state === 'paused' || c.state === 'restarting'
        const b = pending === c.id
        return (
          <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
            {isRunning ? (
              <IconButton title="Stop" size="xs" icon={<Square size={12} />} loading={b} onClick={() => act(c, 'stop', 'Stopped')} />
            ) : (
              <IconButton title="Start" size="xs" icon={<Play size={12} />} loading={b} onClick={() => act(c, 'start', 'Started')} />
            )}
            <IconButton title="Restart" size="xs" icon={<RotateCw size={12} />} disabled={b} onClick={() => act(c, 'restart', 'Restarted')} />
            <IconButton title="Logs" size="xs" icon={<FileText size={12} />} onClick={() => setLogs(c)} />
            <IconButton title="Shell" size="xs" icon={<Terminal size={12} />} disabled={c.state !== 'running'} onClick={() => shell(c)} />
            <IconButton title="More" size="xs" icon={<MoreHorizontal size={12} />} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, c })} />
          </div>
        )
      }
    }
  ]

  const menuItems = (c: DockerContainer): MenuItem[] => {
    const isRunning = c.state === 'running'
    return [
      c.state === 'paused' ? { label: 'Unpause', icon: <Play />, onClick: () => act(c, 'unpause', 'Unpaused') } : { label: 'Pause', icon: <Pause />, disabled: !isRunning, onClick: () => act(c, 'pause', 'Paused') },
      { label: 'Kill', icon: <Zap />, disabled: !isRunning && c.state !== 'paused', onClick: () => kill(c) },
      { separator: true, label: '' },
      { label: 'Inspect', icon: <Info />, onClick: () => setInspect(c) },
      { label: 'Processes (top)', icon: <ListTree />, disabled: !isRunning, onClick: () => setTop(c) },
      { label: 'Follow logs in Tasks', icon: <FileText />, onClick: () => void run(async () => { await api.call('docker:logsFollow', serverId, c.id); taskToast(`Following logs of ${c.name}`) }) },
      { label: 'Copy ID', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(c.id) },
      { separator: true, label: '' },
      { label: isRunning || c.state === 'paused' ? 'Force remove' : 'Remove', icon: <Trash2 />, danger: true, onClick: () => remove(c, isRunning || c.state === 'paused') }
    ]
  }

  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">
              {running} of {data?.length ?? 0} running
            </span>
            <Button size="sm" icon={<Trash2 size={12} />} disabled={!(data ?? []).some((c) => c.state !== 'running' && c.state !== 'paused')} onClick={removeStopped}>
              Remove stopped
            </Button>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by name, image, id or state" className="w-72" />
      </Toolbar>
      {error && !data ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          {error ? (
            <div className="p-2">
              <ErrorBox error={error} onRetry={reload} />
            </div>
          ) : null}
          <Table
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            dense
            initialSort={{ key: 'name', dir: 'asc' }}
            onRowContextMenu={(c, e) => setMenu({ x: e.clientX, y: e.clientY, c })}
            empty={
              data?.length ? (
                'No containers match the filter'
              ) : (
                <EmptyState icon={<Box />} title="No containers" description="Run a container from an image or bring up a Compose project." />
              )
            }
          />
        </Card>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.c)} onClose={() => setMenu(null)} />}
      {logs && <LogsModal serverId={serverId} container={logs} onClose={() => setLogs(null)} />}
      {inspect && <JsonModal title={`Inspect: ${inspect.name}`} load={() => api.call<unknown>('docker:inspect', serverId, inspect.id)} onClose={() => setInspect(null)} />}
      {top && <TopModal serverId={serverId} container={top} onClose={() => setTop(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Logs modal                                                          */
/* ------------------------------------------------------------------ */

const TAILS = [100, 500, 2000]

function LogsModal({ serverId, container, onClose }: { serverId: string; container: DockerContainer; onClose: () => void }): React.JSX.Element {
  const [tail, setTail] = useState(500)
  const [timestamps, setTimestamps] = useState(false)
  const [auto, setAuto] = useState(true)
  const [search, setSearch] = useState('')
  const [onlyMatches, setOnlyMatches] = useState(false)
  const [stick, setStick] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)
  const { data, error, loading, reload } = useAsync(() => api.call<string>('docker:logs', serverId, container.id, { tail, timestamps }), [serverId, container.id, tail, timestamps], { intervalMs: auto ? 3000 : undefined })
  const { run } = useAction()

  useEffect(() => {
    if (stick && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [data, stick])

  const lines = useMemo(() => {
    const all = (data ?? '').replace(/\r\n?/g, '\n').split('\n')
    if (all.length && all[all.length - 1] === '') all.pop()
    return all
  }, [data])
  const q = search.trim()
  const matchCount = useMemo(() => (q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())).length : 0), [lines, q])
  const shown = q && onlyMatches ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : lines

  return (
    <Modal
      open
      onClose={onClose}
      title={`Logs: ${container.name}`}
      badge={<Badge color={stateColor(container.state)}>{container.state}</Badge>}
      width="max-w-5xl"
      footer={
        <>
          <span className="text-xs text-dim mr-auto">
            {lines.length} lines{q ? ` · ${matchCount} match${matchCount === 1 ? '' : 'es'}` : ''}
            {loading ? ' · refreshing…' : ''}
          </span>
          <Button icon={<Copy size={12} />} onClick={() => void run(() => navigator.clipboard.writeText(data ?? ''), { success: 'Copied to clipboard' })}>
            Copy
          </Button>
          <Button icon={<Download size={12} />} onClick={() => downloadText(`${container.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, data ?? '')}>
            Download
          </Button>
          <Button
            icon={<FileText size={12} />}
            onClick={() =>
              void run(async () => {
                await api.call('docker:logsFollow', serverId, container.id)
                taskToast(`Following logs of ${container.name}`)
              })
            }
          >
            Follow in Tasks
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <Field label="Tail" className="w-28">
          <Select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            {TAILS.map((t) => (
              <option key={t} value={t}>
                {t} lines
              </option>
            ))}
          </Select>
        </Field>
        <div className="relative w-64 self-end">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search in logs" className="pl-7" />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-text">
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-4 self-end h-8">
          <Checkbox checked={onlyMatches} onChange={setOnlyMatches} label="Only matches" disabled={!q} />
          <Toggle checked={timestamps} onChange={setTimestamps} label="Timestamps" />
          <Toggle checked={auto} onChange={setAuto} label="Auto-refresh (3s)" />
          <Toggle checked={stick} onChange={setStick} label="Stick to bottom" />
          <IconButton title="Refresh now" icon={<RefreshCw size={13} />} onClick={() => reload()} />
        </div>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : (
        <pre ref={preRef} className="bg-bg-2 border border-border rounded-md p-3 text-xs font-mono overflow-auto whitespace-pre-wrap break-words h-[60vh] leading-[1.45]">
          {shown.length === 0 && data !== undefined ? <span className="text-dim">{q ? 'No matching lines' : 'No log output'}</span> : null}
          {shown.map((l, i) => (
            <div key={i} className={cls(q && l.toLowerCase().includes(q.toLowerCase()) && 'bg-warn/10')}>
              {highlight(l, q)}
            </div>
          ))}
        </pre>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* JSON (inspect) modal + top modal                                    */
/* ------------------------------------------------------------------ */

function JsonModal({ title, load, onClose }: { title: string; load: () => Promise<unknown>; onClose: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(load, [])
  const text = useMemo(() => (data === undefined ? '' : JSON.stringify(data, null, 2)), [data])
  const { run } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="max-w-4xl"
      footer={
        <>
          <Button icon={<Copy size={12} />} disabled={!text} onClick={() => void run(() => navigator.clipboard.writeText(text), { success: 'Copied' })}>
            Copy JSON
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} onRetry={reload} /> : loading ? <Loading /> : <Pre maxH="max-h-[70vh]">{text}</Pre>}
    </Modal>
  )
}

function TopModal({ serverId, container, onClose }: { serverId: string; container: DockerContainer; onClose: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<DockerTop>('docker:top', serverId, container.id), [container.id], { intervalMs: 3000 })
  return (
    <Modal open onClose={onClose} title={`Processes: ${container.name}`} width="max-w-4xl" footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table
            dense
            columns={(data?.titles ?? []).map((t, i) => ({ key: String(i), header: t, mono: true, render: (row: string[]) => <span className="whitespace-nowrap">{row[i]}</span> }))}
            rows={data?.processes ?? []}
            rowKey={(r) => r.join('|')}
          />
        </Card>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Run container modal                                                 */
/* ------------------------------------------------------------------ */

interface PortRow {
  host: string
  container: string
  proto: 'tcp' | 'udp'
}
interface EnvRow {
  k: string
  v: string
}
interface VolRow {
  host: string
  container: string
  ro: boolean
}

function RowList<T>({ rows, onChange, render, add, addLabel }: { rows: T[]; onChange: (r: T[]) => void; render: (row: T, set: (patch: Partial<T>) => void) => React.ReactNode; add: () => T; addLabel: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          {render(r, (patch) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x))))}
          <IconButton title="Remove" size="xs" icon={<X size={12} />} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="xs" variant="subtle" icon={<Plus size={11} />} onClick={() => onChange([...rows, add()])} className="self-start">
        {addLabel}
      </Button>
    </div>
  )
}

function RunModal({ serverId, initialImage, onClose }: { serverId: string; initialImage: string; onClose: () => void }): React.JSX.Element {
  const [image, setImage] = useState(initialImage)
  const [name, setName] = useState('')
  const [pull, setPull] = useState(!initialImage)
  const [restart, setRestart] = useState<DockerRestartPolicy>('unless-stopped')
  const [network, setNetwork] = useState('')
  const [command, setCommand] = useState('')
  const [extraArgs, setExtraArgs] = useState('')
  const [ports, setPorts] = useState<PortRow[]>([])
  const [env, setEnv] = useState<EnvRow[]>([])
  const [vols, setVols] = useState<VolRow[]>([])
  const { run, busy } = useAction()
  const networks = useAsync(() => api.call<DockerNetwork[]>('docker:networks', serverId), [serverId])

  const valid = image.trim().length > 0 && ports.every((p) => !p.host || !p.container || (Number(p.host) > 0 && Number(p.container) > 0))
  const submit = async (): Promise<void> => {
    const spec: DockerRunSpec = {
      image: image.trim(),
      name: name.trim() || undefined,
      ports: ports.filter((p) => p.host && p.container).map((p) => ({ host: Number(p.host), container: Number(p.container), proto: p.proto })),
      env: env.filter((e) => e.k.trim()).map((e) => ({ k: e.k.trim(), v: e.v })),
      volumes: vols.filter((v) => v.host.trim() && v.container.trim()).map((v) => ({ host: v.host.trim(), container: v.container.trim(), ro: v.ro })),
      restart,
      network: network.trim() || undefined,
      command: command.trim() || undefined,
      detach: true,
      pull,
      extraArgs: extraArgs.trim() || undefined
    }
    const id = await run(() => api.call<string>('docker:run', serverId, spec))
    if (id) {
      taskToast(`Starting ${spec.name ?? spec.image}…`)
      onClose()
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Run container"
      width="max-w-2xl"
      footer={
        <>
          <Checkbox checked={pull} onChange={setPull} label="Pull image first" className="mr-auto" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Play size={13} />} disabled={!valid} loading={busy} onClick={submit}>
            Run
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-4">
        <Field label="Image" className="col-span-4">
          <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" mono autoFocus />
        </Field>
        <Field label="Name" className="col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" mono />
        </Field>
        <Field label="Restart policy" className="col-span-2">
          <Select value={restart} onChange={(e) => setRestart(e.target.value as DockerRestartPolicy)}>
            <option value="no">no</option>
            <option value="always">always</option>
            <option value="unless-stopped">unless-stopped</option>
            <option value="on-failure">on-failure</option>
          </Select>
        </Field>
        <Field label="Network" className="col-span-2">
          <Input value={network} onChange={(e) => setNetwork(e.target.value)} placeholder="bridge (default)" mono list="sm-docker-networks" />
          <datalist id="sm-docker-networks">{(networks.data ?? []).map((n) => <option key={n.id} value={n.name} />)}</datalist>
        </Field>
        <Field label="Command (optional)" className="col-span-2">
          <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="overrides CMD" mono />
        </Field>
        <Field label="Ports" className="col-span-6" hint="host port → container port">
          <RowList<PortRow>
            rows={ports}
            onChange={setPorts}
            add={() => ({ host: '', container: '', proto: 'tcp' })}
            addLabel="Add port"
            render={(p, set) => (
              <>
                <Input type="number" value={p.host} onChange={(e) => set({ host: e.target.value })} placeholder="8080" mono className="w-28" />
                <span className="text-dim">→</span>
                <Input type="number" value={p.container} onChange={(e) => set({ container: e.target.value })} placeholder="80" mono className="w-28" />
                <div className="w-24">
                  <Select value={p.proto} onChange={(e) => set({ proto: e.target.value as 'tcp' | 'udp' })}>
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                  </Select>
                </div>
              </>
            )}
          />
        </Field>
        <Field label="Environment" className="col-span-6">
          <RowList<EnvRow>
            rows={env}
            onChange={setEnv}
            add={() => ({ k: '', v: '' })}
            addLabel="Add variable"
            render={(e, set) => (
              <>
                <Input value={e.k} onChange={(ev) => set({ k: ev.target.value })} placeholder="KEY" mono className="w-48" />
                <span className="text-dim">=</span>
                <Input value={e.v} onChange={(ev) => set({ v: ev.target.value })} placeholder="value" mono className="flex-1" />
              </>
            )}
          />
        </Field>
        <Field label="Volumes" className="col-span-6" hint="host path (absolute) or named volume → container path">
          <RowList<VolRow>
            rows={vols}
            onChange={setVols}
            add={() => ({ host: '', container: '', ro: false })}
            addLabel="Add volume"
            render={(v, set) => (
              <>
                <Input value={v.host} onChange={(e) => set({ host: e.target.value })} placeholder="/srv/data or myvolume" mono className="flex-1" />
                <span className="text-dim">→</span>
                <Input value={v.container} onChange={(e) => set({ container: e.target.value })} placeholder="/data" mono className="flex-1" />
                <Checkbox checked={v.ro} onChange={(ro) => set({ ro })} label="ro" />
              </>
            )}
          />
        </Field>
        <Field label="Extra arguments" className="col-span-6" hint="Passed to docker run before the image, e.g. --memory 512m --cpus 1 --hostname web">
          <Input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} mono placeholder="optional" />
        </Field>
      </div>
    </Modal>
  )
}

function PullModal({ serverId, onClose }: { serverId: string; onClose: () => void }): React.JSX.Element {
  const [image, setImage] = useState('')
  const { run, busy } = useAction()
  const submit = async (): Promise<void> => {
    const id = await run(() => api.call<string>('docker:pull', serverId, image.trim()))
    if (id) {
      taskToast(`Pulling ${image.trim()}…`)
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Pull image"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<ArrowDownToLine size={13} />} disabled={!image.trim()} loading={busy} onClick={submit}>
            Pull
          </Button>
        </>
      }
    >
      <Field label="Image" hint="repository[:tag] or repository@digest, e.g. postgres:16-alpine, ghcr.io/org/app:latest">
        <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:latest" mono autoFocus onKeyDown={(e) => e.key === 'Enter' && image.trim() && void submit()} />
      </Field>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

function ImagesTab({ serverId, onRun, onPull, onChanged }: { serverId: string; onRun: (image: string) => void; onPull: () => void; onChanged: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<DockerImage[]>('docker:images', serverId), [serverId])
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; i: DockerImage } | null>(null)
  const [inspect, setInspect] = useState<DockerImage | null>(null)
  const [history, setHistory] = useState<DockerImage | null>(null)
  const { run, busy } = useAction()

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (data ?? []).filter((i) => !f || i.repository.toLowerCase().includes(f) || i.tag.toLowerCase().includes(f) || i.id.includes(f))
  }, [data, filter])
  const ref = (i: DockerImage): string => (i.dangling ? i.id : `${i.repository}:${i.tag}`)

  const remove = async (i: DockerImage, force: boolean): Promise<void> => {
    if (!(await confirm({ title: force ? 'Force remove image' : 'Remove image', message: <>Remove image <b className="font-mono">{ref(i)}</b> ({i.size})?{force && ' Containers using it keep running but lose the tag reference.'}</>, danger: true, confirmLabel: 'Remove' }))) return
    await run(() => api.call('docker:removeImage', serverId, ref(i), force), { success: `Removed ${ref(i)}` })
    await reload()
    onChanged()
  }
  const prune = async (all: boolean): Promise<void> => {
    if (
      !(await confirm({
        title: all ? 'Prune all unused images' : 'Prune dangling images',
        message: all ? 'Remove every image not used by at least one container. Pulling them again later may take a while.' : 'Remove untagged (dangling) image layers.',
        danger: true,
        confirmLabel: 'Prune'
      }))
    )
      return
    const r = await run(() => api.call<string>('docker:pruneImages', serverId, all))
    if (r !== undefined) useApp.getState().toast({ kind: 'success', title: 'Images pruned', detail: r || undefined })
    await reload()
    onChanged()
  }

  const columns: Column<DockerImage>[] = [
    {
      key: 'repo',
      header: 'Repository',
      sortValue: (i) => i.repository,
      render: (i) => (
        <span className="font-mono text-xs">
          {i.dangling ? <span className="text-dim">&lt;none&gt;</span> : i.repository}
          {i.dangling && (
            <Badge color="warn" className="ml-2">
              dangling
            </Badge>
          )}
        </span>
      )
    },
    { key: 'tag', header: 'Tag', sortValue: (i) => i.tag, render: (i) => <span className="font-mono text-xs">{i.tag === '<none>' ? <span className="text-dim">—</span> : i.tag}</span> },
    { key: 'id', header: 'Image ID', width: '120px', render: (i) => <span className="font-mono text-xs text-muted">{shortId(i.id)}</span> },
    { key: 'size', header: 'Size', width: '100px', align: 'right', sortValue: (i) => parseSize(i.size), render: (i) => <span className="text-xs whitespace-nowrap">{i.size}</span> },
    { key: 'created', header: 'Created', sortValue: (i) => i.created, render: (i) => <span className="text-xs text-muted whitespace-nowrap">{i.created.replace(/ \+\d{4} \w+$/, '')}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '110px',
      render: (i) => (
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          <IconButton title="Run container from this image" size="xs" icon={<Play size={12} />} disabled={i.dangling} onClick={() => onRun(ref(i))} />
          <IconButton title="Remove" size="xs" icon={<Trash2 size={12} />} onClick={() => remove(i, false)} />
          <IconButton title="More" size="xs" icon={<MoreHorizontal size={12} />} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, i })} />
        </div>
      )
    }
  ]

  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">{data?.length ?? 0} images</span>
            <Button icon={<ArrowDownToLine size={12} />} onClick={onPull}>
              Pull
            </Button>
            <Button icon={<Trash2 size={12} />} loading={busy} onClick={() => prune(false)}>
              Prune dangling
            </Button>
            <Button icon={<Trash2 size={12} />} loading={busy} onClick={() => prune(true)}>
              Prune unused
            </Button>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter images" className="w-72" />
      </Toolbar>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table columns={columns} rows={rows} rowKey={(i) => i.id + i.repository + i.tag} dense initialSort={{ key: 'repo', dir: 'asc' }} onRowContextMenu={(i, e) => setMenu({ x: e.clientX, y: e.clientY, i })} empty={data?.length ? 'No images match the filter' : <EmptyState icon={<Layers />} title="No images" description="Pull an image to get started." />} />
        </Card>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Run container', icon: <Play />, disabled: menu.i.dangling, onClick: () => onRun(ref(menu.i)) },
            { label: 'Inspect', icon: <Info />, onClick: () => setInspect(menu.i) },
            { label: 'History (layers)', icon: <Layers />, onClick: () => setHistory(menu.i) },
            { label: 'Copy ID', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(menu.i.id) },
            { separator: true, label: '' },
            { label: 'Remove', icon: <Trash2 />, danger: true, onClick: () => remove(menu.i, false) },
            { label: 'Force remove', icon: <Trash2 />, danger: true, onClick: () => remove(menu.i, true) }
          ]}
        />
      )}
      {inspect && <JsonModal title={`Inspect: ${ref(inspect)}`} load={() => api.call<unknown>('docker:inspect', serverId, inspect.id)} onClose={() => setInspect(null)} />}
      {history && <JsonModal title={`History: ${ref(history)}`} load={() => api.call<unknown>('docker:imageHistory', serverId, history.id)} onClose={() => setHistory(null)} />}
    </>
  )
}

function parseSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const u = m[2].toUpperCase()
  const mult = u.startsWith('K') ? 1e3 : u.startsWith('M') ? 1e6 : u.startsWith('G') ? 1e9 : u.startsWith('T') ? 1e12 : 1
  return n * mult
}

/* ------------------------------------------------------------------ */
/* Volumes                                                             */
/* ------------------------------------------------------------------ */

function VolumesTab({ serverId }: { serverId: string }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<DockerVolume[]>('docker:volumes', serverId), [serverId])
  const [filter, setFilter] = useState('')
  const [create, setCreate] = useState(false)
  const [inspect, setInspect] = useState<DockerVolume | null>(null)
  const { run, busy } = useAction()
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (data ?? []).filter((v) => !f || v.name.toLowerCase().includes(f) || v.driver.includes(f))
  }, [data, filter])

  const remove = async (v: DockerVolume): Promise<void> => {
    if (!(await confirm({ title: 'Remove volume', message: <>Permanently delete volume <b className="font-mono">{v.name}</b>{v.size ? ` (${v.size})` : ''} and all data in it? This cannot be undone.</>, danger: true, confirmLabel: 'Delete volume', typeToConfirm: v.name.length > 20 ? undefined : v.name }))) return
    await run(() => api.call('docker:removeVolume', serverId, v.name, false), { success: `Removed ${v.name}` })
    await reload()
  }
  const prune = async (): Promise<void> => {
    if (!(await confirm({ title: 'Prune volumes', message: 'Remove unused anonymous volumes (docker volume prune). Named volumes are not touched on Docker 23+.', danger: true, confirmLabel: 'Prune' }))) return
    const r = await run(() => api.call<string>('docker:pruneVolumes', serverId))
    if (r !== undefined) useApp.getState().toast({ kind: 'success', title: 'Volumes pruned', detail: r || undefined })
    await reload()
  }

  const columns: Column<DockerVolume>[] = [
    { key: 'name', header: 'Name', sortValue: (v) => v.name, render: (v) => <span className="font-mono text-xs break-all">{v.name}</span> },
    { key: 'driver', header: 'Driver', width: '90px', sortValue: (v) => v.driver, render: (v) => <Badge>{v.driver}</Badge> },
    { key: 'mp', header: 'Mountpoint', render: (v) => <span className="font-mono text-[11px] text-muted break-all">{v.mountpoint}</span> },
    { key: 'size', header: 'Size', width: '90px', align: 'right', sortValue: (v) => parseSize(v.size ?? ''), render: (v) => <span className="text-xs">{v.size ?? <span className="text-dim">—</span>}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '80px',
      render: (v) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton title="Inspect" size="xs" icon={<Info size={12} />} onClick={() => setInspect(v)} />
          <IconButton title="Remove" size="xs" icon={<Trash2 size={12} />} onClick={() => remove(v)} />
        </div>
      )
    }
  ]

  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">{data?.length ?? 0} volumes</span>
            <Button icon={<Plus size={12} />} onClick={() => setCreate(true)}>
              Create volume
            </Button>
            <Button icon={<Trash2 size={12} />} loading={busy} onClick={prune}>
              Prune
            </Button>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter volumes" className="w-72" />
      </Toolbar>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table columns={columns} rows={rows} rowKey={(v) => v.name} dense initialSort={{ key: 'name', dir: 'asc' }} empty={data?.length ? 'No volumes match the filter' : <EmptyState icon={<HardDrive />} title="No volumes" />} />
        </Card>
      )}
      {create && <CreateVolumeModal serverId={serverId} onClose={() => setCreate(false)} onCreated={() => void reload()} />}
      {inspect && <JsonModal title={`Volume: ${inspect.name}`} load={() => api.call<unknown>('docker:inspect', serverId, inspect.name)} onClose={() => setInspect(null)} />}
    </>
  )
}

function CreateVolumeModal({ serverId, onClose, onCreated }: { serverId: string; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [driver, setDriver] = useState('local')
  const { run, busy } = useAction()
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)
  const submit = async (): Promise<void> => {
    const r = await run(() => api.call('docker:createVolume', serverId, name, driver || undefined), { success: `Volume ${name} created` })
    if (r !== undefined) {
      onCreated()
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Create volume"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Field label="Name" className="col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="app-data" mono autoFocus />
        </Field>
        <Field label="Driver">
          <Input value={driver} onChange={(e) => setDriver(e.target.value)} mono />
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Networks                                                            */
/* ------------------------------------------------------------------ */

const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none'])

function NetworksTab({ serverId }: { serverId: string }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<DockerNetwork[]>('docker:networks', serverId), [serverId])
  const [create, setCreate] = useState(false)
  const [inspect, setInspect] = useState<DockerNetwork | null>(null)
  const { run, busy } = useAction()

  const remove = async (n: DockerNetwork): Promise<void> => {
    if (!(await confirm({ title: 'Remove network', message: <>Remove network <b className="font-mono">{n.name}</b>? Fails if containers are still attached.</>, danger: true, confirmLabel: 'Remove' }))) return
    await run(() => api.call('docker:removeNetwork', serverId, n.id), { success: `Removed ${n.name}` })
    await reload()
  }
  const prune = async (): Promise<void> => {
    if (!(await confirm({ title: 'Prune networks', message: 'Remove all networks not used by at least one container.', danger: true, confirmLabel: 'Prune' }))) return
    const r = await run(() => api.call<string>('docker:pruneNetworks', serverId))
    if (r !== undefined) useApp.getState().toast({ kind: 'success', title: 'Networks pruned', detail: r || undefined })
    await reload()
  }

  const columns: Column<DockerNetwork>[] = [
    { key: 'name', header: 'Name', sortValue: (n) => n.name, render: (n) => <span className="font-mono text-xs">{n.name}</span> },
    { key: 'id', header: 'ID', width: '120px', render: (n) => <span className="font-mono text-xs text-muted">{shortId(n.id)}</span> },
    { key: 'driver', header: 'Driver', width: '100px', sortValue: (n) => n.driver, render: (n) => <Badge>{n.driver}</Badge> },
    { key: 'scope', header: 'Scope', width: '90px', render: (n) => <span className="text-xs text-muted">{n.scope}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '80px',
      render: (n) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton title="Inspect" size="xs" icon={<Info size={12} />} onClick={() => setInspect(n)} />
          <IconButton title={BUILTIN_NETWORKS.has(n.name) ? 'Built-in network' : 'Remove'} size="xs" icon={<Trash2 size={12} />} disabled={BUILTIN_NETWORKS.has(n.name)} onClick={() => remove(n)} />
        </div>
      )
    }
  ]

  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">{data?.length ?? 0} networks</span>
            <Button icon={<Plus size={12} />} onClick={() => setCreate(true)}>
              Create network
            </Button>
            <Button icon={<Trash2 size={12} />} loading={busy} onClick={prune}>
              Prune
            </Button>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} />
          </>
        }
      />
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table columns={columns} rows={data ?? []} rowKey={(n) => n.id} dense initialSort={{ key: 'name', dir: 'asc' }} empty={<EmptyState icon={<Network />} title="No networks" />} />
        </Card>
      )}
      {create && <CreateNetworkModal serverId={serverId} onClose={() => setCreate(false)} onCreated={() => void reload()} />}
      {inspect && <JsonModal title={`Network: ${inspect.name}`} load={() => api.call<unknown>('docker:networkInspect', serverId, inspect.id)} onClose={() => setInspect(null)} />}
    </>
  )
}

function CreateNetworkModal({ serverId, onClose, onCreated }: { serverId: string; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [driver, setDriver] = useState<DockerNetworkDriver>('bridge')
  const [subnet, setSubnet] = useState('')
  const { run, busy } = useAction()
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && (!subnet.trim() || /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$|^[0-9a-fA-F:]+\/\d{1,3}$/.test(subnet.trim()))
  const submit = async (): Promise<void> => {
    const r = await run(() => api.call('docker:createNetwork', serverId, { name, driver, subnet: subnet.trim() || undefined }), { success: `Network ${name} created` })
    if (r !== undefined) {
      onCreated()
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Create network"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="backend" mono autoFocus />
        </Field>
        <Field label="Driver">
          <Select value={driver} onChange={(e) => setDriver(e.target.value as DockerNetworkDriver)}>
            <option value="bridge">bridge</option>
            <option value="overlay">overlay (swarm)</option>
            <option value="macvlan">macvlan</option>
          </Select>
        </Field>
        <Field label="Subnet (optional)" className="col-span-2" hint="CIDR notation, e.g. 172.30.0.0/16">
          <Input value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="auto" mono />
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

const COMPOSE_TEMPLATE = `services:
  app:
    image: nginx:alpine
    container_name: app
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
`

function composeStatusColor(status: string): 'ok' | 'warn' | 'muted' | 'danger' {
  const s = status.toLowerCase()
  if (s.startsWith('running') && !s.includes('exited')) return 'ok'
  if (s.includes('running')) return 'warn'
  if (s.includes('exited') || s.includes('dead')) return 'muted'
  if (s.includes('unhealthy')) return 'danger'
  return 'muted'
}

function ComposeTab({ serverId, composeAvailable }: { serverId: string; composeAvailable: boolean }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<ComposeProject[]>('docker:compose:projects', serverId), [serverId])
  const [edit, setEdit] = useState<ComposeProject | null>(null)
  const [create, setCreate] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const { run } = useAction()

  const action = async (p: ComposeProject, a: ComposeAction): Promise<void> => {
    if (!p.dir) {
      useApp.getState().toast({ kind: 'error', title: 'Unknown project directory', detail: 'The project has no working directory label; manage it from the Terminal.' })
      return
    }
    if (a === 'down' && !(await confirm({ title: 'Compose down', message: <>Stop and remove the containers and networks of <b className="font-mono">{p.name}</b>? Named volumes are kept.</>, danger: true, confirmLabel: 'Down' }))) return
    setPending(p.name)
    const id = await run(() => api.call<string>('docker:compose:action', serverId, p.dir, a))
    setPending(null)
    if (id) taskToast(`compose ${a}: ${p.name}`)
    window.setTimeout(() => void reload(), 2500)
  }

  const columns: Column<ComposeProject>[] = [
    { key: 'name', header: 'Project', sortValue: (p) => p.name, render: (p) => <span className="font-medium">{p.name}</span> },
    { key: 'status', header: 'Status', width: '160px', render: (p) => <Badge color={composeStatusColor(p.status)}>{p.status || 'unknown'}</Badge> },
    {
      key: 'dir',
      header: 'Directory / files',
      render: (p) => (
        <div className="min-w-0">
          <div className="font-mono text-xs truncate" title={p.dir}>
            {p.dir || <span className="text-dim">unknown</span>}
          </div>
          {p.configFiles.length > 0 && <div className="text-dim text-[11px] font-mono truncate">{p.configFiles.map((f) => f.split('/').pop()).join(', ')}</div>}
        </div>
      )
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '300px',
      render: (p) => {
        const b = pending === p.name
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button size="xs" icon={<Play size={11} />} loading={b} disabled={!p.dir} onClick={() => action(p, 'up')}>
              Up
            </Button>
            <Button size="xs" icon={<Square size={11} />} disabled={b || !p.dir} onClick={() => action(p, 'down')}>
              Down
            </Button>
            <Button size="xs" icon={<RotateCw size={11} />} disabled={b || !p.dir} onClick={() => action(p, 'restart')}>
              Restart
            </Button>
            <Button size="xs" icon={<ArrowDownToLine size={11} />} disabled={b || !p.dir} onClick={() => action(p, 'pull')}>
              Pull
            </Button>
            <IconButton title="Logs (last 300 lines, in Tasks)" size="xs" icon={<FileText size={12} />} disabled={!p.dir} onClick={() => action(p, 'logs')} />
            <IconButton title="Edit compose file" size="xs" icon={<FileCode2 size={12} />} disabled={!p.dir} onClick={() => setEdit(p)} />
          </div>
        )
      }
    }
  ]

  return (
    <>
      {!composeAvailable && (
        <Callout kind="warn">
          Docker Compose was not detected (neither the <code>docker compose</code> plugin nor <code>docker-compose</code>). Install the <code>docker-compose-plugin</code> package to manage projects.
        </Callout>
      )}
      <Toolbar
        right={
          <>
            <Button icon={<Plus size={12} />} onClick={() => setCreate(true)}>
              New project
            </Button>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} />
          </>
        }
      >
        <span className="text-xs text-muted">{data?.length ?? 0} projects</span>
      </Toolbar>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table columns={columns} rows={data ?? []} rowKey={(p) => p.name} dense initialSort={{ key: 'name', dir: 'asc' }} empty={<EmptyState icon={<Boxes />} title="No Compose projects" description="Projects appear here once they have been brought up with docker compose. Create a new one to get started." />} />
        </Card>
      )}
      {edit && <ComposeEditModal serverId={serverId} project={edit} onClose={() => setEdit(null)} onUp={() => void action(edit, 'up')} />}
      {create && <ComposeCreateModal serverId={serverId} onClose={() => setCreate(false)} onCreated={() => void reload()} />}
    </>
  )
}

function ComposeEditModal({ serverId, project, onClose, onUp }: { serverId: string; project: ComposeProject; onClose: () => void; onUp: () => void }): React.JSX.Element {
  const file = useAsync(() => api.call<ComposeFile>('docker:compose:readFile', serverId, project.dir), [project.dir])
  const [text, setText] = useState<string | null>(null)
  const { run, busy } = useAction()
  const value = text ?? file.data?.content ?? ''
  const dirty = text !== null && text !== file.data?.content

  const save = async (andUp: boolean): Promise<void> => {
    const r = await run(() => api.call<string>('docker:compose:writeFile', serverId, project.dir, value), { success: 'Compose file saved (previous copy kept as .bak)' })
    if (r === undefined) return
    setText(null)
    await file.reload()
    if (andUp) {
      onUp()
      onClose()
    }
  }
  const close = useCallback(async () => {
    if (dirty && !(await confirm({ title: 'Discard changes?', message: 'The compose file has unsaved changes.', danger: true, confirmLabel: 'Discard' }))) return
    onClose()
  }, [dirty, onClose])

  return (
    <Modal
      open
      onClose={() => void close()}
      title={`Edit: ${file.data?.path ?? project.dir}`}
      badge={dirty ? <Badge color="warn">modified</Badge> : undefined}
      width="max-w-4xl"
      footer={
        <>
          <Button onClick={() => void close()}>Cancel</Button>
          <Button disabled={!dirty} loading={busy} onClick={() => save(false)}>
            Save
          </Button>
          <Button variant="primary" icon={<Play size={12} />} disabled={!file.data} loading={busy} onClick={() => save(true)}>
            Save & Up
          </Button>
        </>
      }
    >
      {file.error ? (
        <ErrorBox error={file.error} onRetry={file.reload} />
      ) : file.loading && !file.data ? (
        <Loading />
      ) : (
        <TextArea mono value={value} onChange={(e) => setText(e.target.value)} rows={26} spellCheck={false} className="h-[65vh] text-xs leading-[1.45]" />
      )}
    </Modal>
  )
}

function ComposeCreateModal({ serverId, onClose, onCreated }: { serverId: string; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [dir, setDir] = useState('/opt/compose/myapp')
  const [content, setContent] = useState(COMPOSE_TEMPLATE)
  const [up, setUp] = useState(true)
  const { run, busy } = useAction()
  const valid = dir.startsWith('/') && content.trim().length > 0
  const submit = async (): Promise<void> => {
    const path = await run(() => api.call<string>('docker:compose:create', serverId, dir.trim(), content), { success: 'Project created' })
    if (path === undefined) return
    if (up) {
      const id = await run(() => api.call<string>('docker:compose:action', serverId, dir.trim(), 'up'))
      if (id) taskToast(`compose up: ${dir.trim()}`)
    }
    onCreated()
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="New Compose project"
      width="max-w-3xl"
      footer={
        <>
          <Checkbox checked={up} onChange={setUp} label="Run docker compose up after creating" className="mr-auto" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <Field label="Project directory" hint="Absolute path; it is created if missing and compose.yaml is written inside it.">
        <Input value={dir} onChange={(e) => setDir(e.target.value)} mono autoFocus />
      </Field>
      <Field label="compose.yaml" className="mt-4">
        <TextArea mono value={content} onChange={(e) => setContent(e.target.value)} rows={18} spellCheck={false} className="text-xs leading-[1.45]" />
      </Field>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* System & prune                                                      */
/* ------------------------------------------------------------------ */

function SystemTab({ serverId, info, onService, busy }: { serverId: string; info: DockerInfo; onService: (a: 'start' | 'stop' | 'restart' | 'enable' | 'disable') => void; busy: boolean }): React.JSX.Element {
  const df = useAsync(() => api.call<DockerSystemDf>('docker:systemDf', serverId), [serverId])
  const [opts, setOpts] = useState<DockerPruneOpts>({ containers: true, images: true, volumes: false, networks: true, buildCache: true, allImages: false })
  const { run, busy: pruning } = useAction()
  const set = <K extends keyof DockerPruneOpts>(k: K, v: boolean): void => setOpts((o) => ({ ...o, [k]: v }))
  const anySelected = opts.containers || opts.images || opts.volumes || opts.networks || opts.buildCache

  const prune = async (): Promise<void> => {
    const items = [
      opts.containers && 'all stopped containers',
      opts.images && (opts.allImages ? 'ALL images not used by a container' : 'dangling images'),
      opts.volumes && 'unused anonymous volumes (data is lost)',
      opts.networks && 'unused networks',
      opts.buildCache && 'build cache'
    ].filter(Boolean) as string[]
    if (
      !(await confirm({
        title: 'Prune Docker resources',
        message: (
          <>
            This will permanently remove:
            <ul className="list-disc ml-5 mt-2 space-y-0.5">
              {items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </>
        ),
        danger: true,
        confirmLabel: 'Prune',
        typeToConfirm: opts.volumes || opts.allImages ? 'prune' : undefined
      }))
    )
      return
    const id = await run(() => api.call<string>('docker:prune', serverId, opts))
    if (id) taskToast('Pruning Docker resources…')
    window.setTimeout(() => void df.reload(), 4000)
  }

  const row = (type: string): DockerSystemDf['rows'][number] | undefined => df.data?.rows.find((r) => r.type.toLowerCase().startsWith(type))
  const card = (label: string, type: string): React.JSX.Element => {
    const r = row(type)
    return <Stat label={label} value={r ? r.size || '0B' : '—'} sub={r ? `${r.totalCount} total · ${r.active} active · reclaimable ${r.reclaimable || '0B'}` : undefined} />
  }
  const i = info.info

  return (
    <>
      <Toolbar right={<IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => df.reload()} loading={df.loading && !!df.data} />}>
        <span className="text-xs text-muted">Disk usage</span>
      </Toolbar>
      {df.error ? (
        <ErrorBox error={df.error} onRetry={df.reload} />
      ) : (
        <div className="grid grid-cols-4 gap-3 mb-4">
          {card('Images', 'images')}
          {card('Containers', 'containers')}
          {card('Volumes', 'local volumes')}
          {card('Build cache', 'build cache')}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Card title="Prune" actions={<Button variant="danger" size="sm" icon={<Trash2 size={12} />} disabled={!anySelected} loading={pruning} onClick={prune}>Prune</Button>}>
          <div className="flex flex-col gap-2.5 text-[13px]">
            <Checkbox checked={opts.containers} onChange={(v) => set('containers', v)} label="Stopped containers" />
            <Checkbox checked={opts.images} onChange={(v) => set('images', v)} label="Unused images" />
            <div className="ml-6">
              <Checkbox checked={opts.allImages} onChange={(v) => set('allImages', v)} disabled={!opts.images} label={<span>All unused images, not only dangling (<code>-a</code>)</span>} />
            </div>
            <Checkbox checked={opts.networks} onChange={(v) => set('networks', v)} label="Unused networks" />
            <Checkbox checked={opts.buildCache} onChange={(v) => set('buildCache', v)} label="Build cache" />
            <Checkbox checked={opts.volumes} onChange={(v) => set('volumes', v)} label={<span className="text-warn-fg">Unused anonymous volumes (data loss)</span>} />
            <div className="text-[11px] text-dim mt-1">Runs the matching <code>docker … prune -f</code> commands as a task and reports the reclaimed space.</div>
          </div>
        </Card>
        <Card title="Daemon">
          <KV
            rows={[
              ['Server version', i?.serverVersion || info.version || '—'],
              ['Compose', info.composeVersion ?? <span className="text-dim">not installed</span>],
              ['Storage driver', i?.storageDriver || '—'],
              ['Cgroup version', i?.cgroupVersion ? `v${i.cgroupVersion}` : '—'],
              ['Containers', i ? `${i.containers} (${i.running} running, ${i.paused} paused, ${i.stopped} stopped)` : '—'],
              ['Images', i ? String(i.images) : '—'],
              ['Access', info.needsSudo ? 'via sudo' : info.rootless ? 'rootless' : info.userInGroup ? 'docker group' : 'direct'],
              ...(info.hasSystemd ? ([['Service', <span key="svc" className="inline-flex gap-1.5"><Badge color={info.serviceActive === 'active' ? 'ok' : 'muted'}>{info.serviceActive ?? 'unknown'}</Badge><Badge color={info.serviceEnabled === 'enabled' ? 'ok' : 'muted'}>{info.serviceEnabled ?? 'unknown'}</Badge></span>]] as [React.ReactNode, React.ReactNode][]) : [])
            ]}
          />
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <Button size="xs" icon={<RotateCw size={11} />} loading={busy} onClick={() => void confirm({ title: 'Restart Docker daemon', message: 'Containers without a live-restore policy will be restarted.', danger: true, confirmLabel: 'Restart' }).then((ok) => ok && onService('restart'))}>
              Restart daemon
            </Button>
            <Button size="xs" icon={<Power size={11} />} loading={busy} onClick={() => void confirm({ title: 'Stop Docker daemon', message: 'All running containers will be stopped.', danger: true, confirmLabel: 'Stop' }).then((ok) => ok && onService('stop'))}>
              Stop daemon
            </Button>
            {info.hasSystemd && (info.serviceEnabled === 'enabled' ? (
              <Button size="xs" loading={busy} onClick={() => onService('disable')}>
                Disable at boot
              </Button>
            ) : (
              <Button size="xs" loading={busy} onClick={() => onService('enable')}>
                Enable at boot
              </Button>
            ))}
          </div>
        </Card>
      </div>
      {df.data?.verbose && df.data.verbose.volumes.length > 0 && (
        <Card title="Largest volumes" className="mt-3" flush>
          <Table
            dense
            columns={[
              { key: 'name', header: 'Volume', render: (v: { name: string; size: string; links: number }) => <span className="font-mono text-xs">{v.name}</span> },
              { key: 'links', header: 'Used by', width: '90px', align: 'right', render: (v) => <span className="text-xs">{v.links}</span> },
              { key: 'size', header: 'Size', width: '100px', align: 'right', render: (v) => <span className="text-xs">{v.size}</span> }
            ]}
            rows={[...df.data.verbose.volumes].sort((a, b) => parseSize(b.size) - parseSize(a.size)).slice(0, 15)}
            rowKey={(v) => v.name}
          />
        </Card>
      )}
    </>
  )
}
