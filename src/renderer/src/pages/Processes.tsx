import React, { useEffect, useMemo, useState } from 'react'
import { Activity, FileCode, Info, Network, Pause, Play, Power, RefreshCw, RotateCw, ScrollText, Shield, Skull, Square, XOctagon } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { cls, fmtBytes } from '@/lib/format'
import { Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorBox, IconButton, KV, Loading, MenuButton, Modal, Page, PageHeader, Pre, SearchInput, Table, Tabs, Toggle, confirm, useAction, useAsync, type Column } from '@/components/ui'
import type { ListeningPort, ProcessInfo, ServiceInfo } from '@shared/types'
import type { ProcDetail, ProcListResult, ProcSignal, SvcAction, SvcListResult, SvcStatusResult } from '@shared/modules/processes'

type TabId = 'processes' | 'services' | 'ports'

/** Parse "3h 56m" / "2d 4h" / "12m 3s" / "45s" back into seconds for sorting. */
function elapsedSeconds(s: string): number {
  let total = 0
  for (const m of s.matchAll(/(\d+)([dhms])/g)) {
    const n = Number(m[1])
    total += m[2] === 'd' ? n * 86400 : m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n
  }
  return total
}

export default function Processes({ serverId }: PageProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('processes')
  const [summary, setSummary] = useState<{ total: number; load: [number, number, number] } | null>(null)
  return (
    <>
      <PageHeader title="Processes and services" subtitle={summary ? `${summary.total} processes, load ${summary.load.map((l) => l.toFixed(2)).join(' ')}` : undefined} />
      <Page>
        <div className="flex items-center justify-between mb-4">
          <Tabs<TabId> tabs={[{ id: 'processes', label: 'Processes' }, { id: 'services', label: 'Services' }, { id: 'ports', label: 'Listening ports' }]} value={tab} onChange={setTab} />
        </div>
        <div className={tab === 'processes' ? '' : 'hidden'}>
          <ProcessesTab serverId={serverId} active={tab === 'processes'} onSummary={setSummary} />
        </div>
        {tab === 'services' && <ServicesTab serverId={serverId} />}
        {tab === 'ports' && <PortsTab serverId={serverId} />}
      </Page>
    </>
  )
}

/* ================================================================== */
/* Processes                                                            */
/* ================================================================== */

function ProcessesTab({ serverId, active, onSummary }: { serverId: string; active: boolean; onSummary: (s: { total: number; load: [number, number, number] }) => void }): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [hideKernel, setHideKernel] = useState(true)
  const [auto, setAuto] = useState(true)
  const [detailPid, setDetailPid] = useState<number | null>(null)
  const list = useAsync(() => api.call<ProcListResult>('proc:list', serverId, { hideKernel }), [serverId, hideKernel], { intervalMs: auto && active ? 3000 : undefined })
  const { run, busy } = useAction()
  useEffect(() => {
    if (list.data) onSummary({ total: list.data.total, load: list.data.load })
  }, [list.data, onSummary])

  const rows = useMemo(() => {
    const all = list.data?.processes ?? []
    const f = filter.trim().toLowerCase()
    if (!f) return all
    return all.filter((p) => p.command.toLowerCase().includes(f) || p.args.toLowerCase().includes(f) || p.user.toLowerCase().includes(f) || String(p.pid) === f)
  }, [list.data, filter])

  const signal = async (p: ProcessInfo, sig: ProcSignal): Promise<void> => {
    if (sig === 'KILL' || sig === 'TERM') {
      const ok = await confirm({
        title: sig === 'KILL' ? 'Kill process' : 'Terminate process',
        message: (
          <>
            Send <b>SIG{sig}</b> to PID <b>{p.pid}</b> (<code className="font-mono">{p.command}</code>, user {p.user})?
            {sig === 'KILL' && <div className="text-amber-300 mt-2">SIGKILL cannot be caught: the process ends immediately without cleanup.</div>}
          </>
        ),
        danger: true,
        confirmLabel: sig === 'KILL' ? 'Kill' : 'Terminate'
      })
      if (!ok) return
    }
    await run(() => api.call('proc:signal', serverId, p.pid, sig), { success: `SIG${sig} sent to ${p.pid}` })
    await list.reload()
  }

  const columns: Column<ProcessInfo>[] = [
    { key: 'pid', header: 'PID', width: '80px', mono: true, sortValue: (p) => p.pid, render: (p) => p.pid },
    { key: 'user', header: 'User', width: '120px', sortValue: (p) => p.user, render: (p) => <span className="truncate block max-w-[120px]" title={p.user}>{p.user}</span> },
    { key: 'cpu', header: 'CPU%', width: '80px', align: 'right', mono: true, sortValue: (p) => p.cpu, render: (p) => <span className={cls(p.cpu >= 50 && 'text-amber-300')}>{p.cpu.toFixed(1)}</span> },
    { key: 'mem', header: 'MEM%', width: '80px', align: 'right', mono: true, sortValue: (p) => p.mem, render: (p) => p.mem.toFixed(1) },
    { key: 'rss', header: 'RSS', width: '90px', align: 'right', mono: true, sortValue: (p) => p.rss, render: (p) => fmtBytes(p.rss) },
    { key: 'elapsed', header: 'Uptime', width: '90px', mono: true, sortValue: (p) => elapsedSeconds(p.elapsed), render: (p) => <span className="text-muted">{p.elapsed}</span> },
    {
      key: 'command',
      header: 'Command',
      sortValue: (p) => p.command,
      render: (p) => (
        <div className="min-w-0 max-w-[640px] truncate font-mono text-xs" title={`${p.command} ${p.args}`.trim()}>
          <span className={cls('font-semibold', p.stat.startsWith('T') && 'text-amber-300', p.stat.startsWith('Z') && 'text-red-300')}>{p.command}</span>
          {p.args && <span className="text-dim"> {p.args}</span>}
          {p.stat.startsWith('T') && <Badge color="warn" className="ml-2">stopped</Badge>}
          {p.stat.startsWith('Z') && <Badge color="danger" className="ml-2">zombie</Badge>}
        </div>
      )
    },
    {
      key: 'actions',
      header: '',
      width: '130px',
      align: 'right',
      render: (p) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton size="xs" title="Details" icon={<Info size={13} />} onClick={() => setDetailPid(p.pid)} />
          {p.stat.startsWith('T') ? (
            <IconButton size="xs" title="Resume (SIGCONT)" icon={<Play size={13} />} disabled={busy} onClick={() => void signal(p, 'CONT')} />
          ) : (
            <IconButton size="xs" title="Pause (SIGSTOP)" icon={<Pause size={13} />} disabled={busy} onClick={() => void signal(p, 'STOP')} />
          )}
          <IconButton size="xs" title="Terminate (SIGTERM)" icon={<Square size={13} />} disabled={busy || p.pid === 1} onClick={() => void signal(p, 'TERM')} />
          <IconButton size="xs" title="Kill (SIGKILL)" icon={<Skull size={13} />} className="hover:text-red-300" disabled={busy || p.pid === 1} onClick={() => void signal(p, 'KILL')} />
        </div>
      )
    }
  ]

  return (
    <>
      <div className="flex items-center gap-4 mb-3">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by command, user or PID" className="w-72" />
        <Checkbox checked={hideKernel} onChange={setHideKernel} label="Hide kernel threads" />
        <Checkbox checked={auto} onChange={setAuto} label="Auto refresh (3 s)" />
        <div className="flex-1" />
        {list.data && <span className="text-dim text-xs">{rows.length} shown</span>}
        <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void list.reload()} />
      </div>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table<ProcessInfo> columns={columns} rows={rows} rowKey={(p) => String(p.pid)} dense initialSort={{ key: 'cpu', dir: 'desc' }} onRowClick={(p, e) => e.detail === 2 && setDetailPid(p.pid)} empty="No matching processes" />
        </Card>
      )}
      {detailPid !== null && <ProcessDetailModal serverId={serverId} pid={detailPid} onClose={() => setDetailPid(null)} onSignal={(sig) => { const p = rows.find((x) => x.pid === detailPid); if (p) void signal(p, sig) }} />}
    </>
  )
}

function ProcessDetailModal({ serverId, pid, onClose, onSignal }: { serverId: string; pid: number; onClose: () => void; onSignal: (s: ProcSignal) => void }): React.JSX.Element {
  const d = useAsync(() => api.call<ProcDetail>('proc:detail', serverId, pid), [serverId, pid], { intervalMs: 5000 })
  const x = d.data
  const io = x?.io ?? {}
  return (
    <Modal
      open
      onClose={onClose}
      title={<span>Process {pid}{x?.status.Name ? <span className="text-muted font-normal"> · {x.status.Name}</span> : null}</span>}
      badge={x?.status.State ? <Badge color={x.status.State.startsWith('R') ? 'ok' : x.status.State.startsWith('T') ? 'warn' : x.status.State.startsWith('Z') ? 'danger' : 'muted'}>{x.status.State}</Badge> : undefined}
      width="max-w-3xl"
      footer={
        <>
          <Button size="sm" icon={<Square size={12} />} onClick={() => onSignal('TERM')} disabled={pid === 1}>
            Terminate
          </Button>
          <Button size="sm" variant="danger" icon={<Skull size={12} />} onClick={() => onSignal('KILL')} disabled={pid === 1}>
            Kill
          </Button>
          <div className="flex-1" />
          <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => void d.reload()} />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {d.error ? (
        <ErrorBox error={d.error} onRetry={d.reload} />
      ) : !x ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <KV
            rows={[
              ['Command line', <code className="font-mono text-xs break-all">{x.cmdline || '—'}</code>],
              ['Executable', <code className="font-mono text-xs">{x.exe || '—'}</code>],
              ['Working dir', <code className="font-mono text-xs">{x.cwd || '—'}</code>],
              ['Parent PID', x.status.PPid ?? '—'],
              ['UID / GID', `${(x.status.Uid ?? '—').split(/\s+/)[0]} / ${(x.status.Gid ?? '—').split(/\s+/)[0]}`],
              ['Threads', x.threads ?? '—'],
              ['Nice', x.nice ?? '—'],
              ['Started', x.started ?? '—'],
              ['Memory (RSS)', x.status.VmRSS ?? '—'],
              ['Swap', x.status.VmSwap ?? '—'],
              ['Virtual size', x.status.VmSize ?? '—'],
              ['Open files', x.openFiles],
              ['I/O read / written', `${fmtBytes(io.read_bytes ?? io.rchar)} / ${fmtBytes(io.write_bytes ?? io.wchar)}`],
              ['systemd unit', x.unit ? <code className="font-mono text-xs">{x.unit}</code> : '—'],
              ['cgroup', <code className="font-mono text-[11px] text-muted break-all">{x.cgroup || '—'}</code>]
            ]}
          />
          {x.limits.length > 0 && (
            <div>
              <div className="text-xs text-muted font-medium mb-1.5">Limits</div>
              <Pre maxH="max-h-32">{x.limits.join('\n')}</Pre>
            </div>
          )}
          <div>
            <div className="text-xs text-muted font-medium mb-1.5">Children ({x.children.length})</div>
            {x.children.length === 0 ? (
              <div className="text-dim text-xs">No child processes</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {x.children.map((c) => (
                  <Badge key={c.pid} className="font-mono">
                    {c.pid} {c.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ================================================================== */
/* Services                                                             */
/* ================================================================== */

type SvcFilter = 'all' | 'running' | 'failed' | 'enabled'

function activeColor(s: ServiceInfo): 'ok' | 'warn' | 'danger' | 'muted' | 'info' {
  if (s.active === 'active') return s.sub === 'running' ? 'ok' : 'info'
  if (s.active === 'failed') return 'danger'
  if (s.active === 'activating' || s.active === 'deactivating' || s.active === 'reloading') return 'warn'
  return 'muted'
}

function enabledColor(e: string): 'ok' | 'warn' | 'danger' | 'muted' | 'info' {
  if (e === 'enabled' || e === 'enabled-runtime') return 'ok'
  if (e === 'masked') return 'danger'
  if (e === 'static' || e === 'indirect' || e === 'generated' || e === 'transient') return 'info'
  if (e === 'disabled') return 'muted'
  return 'muted'
}

function ServicesTab({ serverId }: { serverId: string }): React.JSX.Element {
  const list = useAsync(() => api.call<SvcListResult>('svc:list', serverId), [serverId], { intervalMs: 15000 })
  const [filter, setFilter] = useState('')
  const [chip, setChip] = useState<SvcFilter>('all')
  const [statusFor, setStatusFor] = useState<string | null>(null)
  const [unitFor, setUnitFor] = useState<string | null>(null)
  const { run, busy } = useAction()

  const services = list.data?.services ?? []
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return services.filter((s) => {
      if (chip === 'running' && !(s.active === 'active' && s.sub === 'running')) return false
      if (chip === 'failed' && s.active !== 'failed') return false
      if (chip === 'enabled' && !s.enabled.startsWith('enabled')) return false
      if (f && !s.name.toLowerCase().includes(f) && !s.description.toLowerCase().includes(f)) return false
      return true
    })
  }, [services, filter, chip])
  const counts = useMemo(
    () => ({
      all: services.length,
      running: services.filter((s) => s.active === 'active' && s.sub === 'running').length,
      failed: services.filter((s) => s.active === 'failed').length,
      enabled: services.filter((s) => s.enabled.startsWith('enabled')).length
    }),
    [services]
  )

  const action = async (s: ServiceInfo, a: SvcAction): Promise<void> => {
    if (a === 'stop' || a === 'mask' || a === 'disable') {
      const critical = /^(ssh|sshd|systemd-|dbus|network|NetworkManager|systemd-networkd|systemd-resolved)/.test(s.name)
      const ok = await confirm({
        title: `${a[0].toUpperCase()}${a.slice(1)} ${s.name}`,
        message: (
          <>
            {a === 'stop' && <>Stop <b>{s.name}</b> now? Clients using it will be disconnected.</>}
            {a === 'disable' && <>Disable <b>{s.name}</b>? It will no longer start at boot (it keeps running until stopped).</>}
            {a === 'mask' && <>Mask <b>{s.name}</b>? It can no longer be started by anything until unmasked.</>}
            {critical && <div className="text-amber-300 mt-2">This looks like a critical system service. Stopping SSH or networking can lock you out of the server.</div>}
          </>
        ),
        danger: true,
        confirmLabel: a[0].toUpperCase() + a.slice(1),
        typeToConfirm: critical ? s.name.replace(/\.service$/, '') : undefined
      })
      if (!ok) return
    }
    await run(() => api.call('svc:action', serverId, s.name, a), { success: `${s.name}: ${a} done` })
    await list.reload()
  }

  const columns: Column<ServiceInfo>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (s) => s.name,
      render: (s) => (
        <button className="font-mono text-xs text-left hover:text-accent truncate max-w-[280px] block" title={s.name} onClick={() => setStatusFor(s.name)}>
          {s.name.replace(/\.service$/, '')}
        </button>
      )
    },
    { key: 'description', header: 'Description', sortValue: (s) => s.description, render: (s) => <span className="text-muted text-xs truncate block max-w-[380px]" title={s.description}>{s.description || '—'}</span> },
    { key: 'load', header: 'Load', width: '90px', sortValue: (s) => s.load, render: (s) => <span className={cls('text-xs', s.load === 'not-found' || s.load === 'error' ? 'text-amber-300' : 'text-muted')}>{s.load}</span> },
    {
      key: 'active',
      header: 'Active',
      width: '150px',
      sortValue: (s) => `${s.active} ${s.sub}`,
      render: (s) => (
        <Badge color={activeColor(s)}>
          {s.active}
          {s.sub && s.sub !== s.active ? ` (${s.sub})` : ''}
        </Badge>
      )
    },
    { key: 'enabled', header: 'Enabled', width: '110px', sortValue: (s) => s.enabled, render: (s) => (s.enabled ? <Badge color={enabledColor(s.enabled)}>{s.enabled}</Badge> : <span className="text-dim text-xs">—</span>) },
    {
      key: 'actions',
      header: '',
      width: '190px',
      align: 'right',
      render: (s) => {
        const running = s.active === 'active'
        const systemd = list.data?.systemd ?? true
        return (
          <div className="flex items-center justify-end gap-0.5">
            {running ? (
              <IconButton size="xs" title="Stop" icon={<Square size={13} />} disabled={busy} onClick={() => void action(s, 'stop')} />
            ) : (
              <IconButton size="xs" title="Start" icon={<Play size={13} />} disabled={busy || s.enabled === 'masked'} onClick={() => void action(s, 'start')} />
            )}
            <IconButton size="xs" title="Restart" icon={<RotateCw size={13} />} disabled={busy || s.enabled === 'masked'} onClick={() => void action(s, 'restart')} />
            <IconButton size="xs" title="Status & logs" icon={<ScrollText size={13} />} onClick={() => setStatusFor(s.name)} />
            <MenuButton
              label=""
              size="xs"
              variant="ghost"
              items={[
                { label: 'Reload configuration', icon: <RefreshCw />, onClick: () => void action(s, 'reload'), disabled: !running },
                { separator: true, label: '' },
                { label: 'Enable at boot', icon: <Power />, onClick: () => void action(s, 'enable'), disabled: !systemd || s.enabled.startsWith('enabled') || s.enabled === 'masked' || s.enabled === 'static' },
                { label: 'Disable at boot', icon: <Power />, onClick: () => void action(s, 'disable'), disabled: !systemd || !s.enabled.startsWith('enabled') },
                { separator: true, label: '' },
                { label: 'Unit file', icon: <FileCode />, onClick: () => setUnitFor(s.name) },
                { separator: true, label: '' },
                s.enabled === 'masked'
                  ? { label: 'Unmask', icon: <Shield />, onClick: () => void action(s, 'unmask'), disabled: !systemd }
                  : { label: 'Mask', icon: <XOctagon />, danger: true, onClick: () => void action(s, 'mask'), disabled: !systemd }
              ]}
            />
          </div>
        )
      }
    }
  ]

  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter services" className="w-64" />
        <Tabs<SvcFilter>
          value={chip}
          onChange={setChip}
          tabs={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'running', label: 'Running', count: counts.running },
            { id: 'failed', label: <span className={cls(counts.failed > 0 && 'text-red-300')}>Failed</span>, count: counts.failed },
            { id: 'enabled', label: 'Enabled', count: counts.enabled }
          ]}
        />
        <div className="flex-1" />
        <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void list.reload()} />
      </div>
      {list.data && !list.data.systemd && (
        <div className="mb-3">
          <Callout kind="warn">
            <b>systemd is not available on this server.</b> Showing <code>service --status-all</code>; only start, stop, restart and reload are supported, and enabled state is unknown.
          </Callout>
        </div>
      )}
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table<ServiceInfo> columns={columns} rows={rows} rowKey={(s) => s.name} dense initialSort={{ key: 'name', dir: 'asc' }} empty={services.length === 0 ? 'No services found' : 'No services match the filter'} />
        </Card>
      )}
      {statusFor && <ServiceStatusModal serverId={serverId} unit={statusFor} onClose={() => setStatusFor(null)} onAction={(a) => { const s = services.find((x) => x.name === statusFor); if (s) void action(s, a) }} />}
      {unitFor && <UnitFileModal serverId={serverId} unit={unitFor} onClose={() => setUnitFor(null)} />}
    </>
  )
}

function ServiceStatusModal({ serverId, unit, onClose, onAction }: { serverId: string; unit: string; onClose: () => void; onAction: (a: SvcAction) => void }): React.JSX.Element {
  const [follow, setFollow] = useState(false)
  const [lines, setLines] = useState(100)
  const st = useAsync(() => api.call<SvcStatusResult>('svc:status', serverId, unit, lines), [serverId, unit, lines], { intervalMs: follow ? 2000 : undefined })
  const x = st.data
  return (
    <Modal
      open
      onClose={onClose}
      title={<span className="font-mono text-[13px]">{unit}</span>}
      badge={x ? <Badge color={x.activeState === 'active' ? 'ok' : x.activeState === 'failed' ? 'danger' : 'muted'}>{x.activeState}</Badge> : undefined}
      width="max-w-4xl"
      footer={
        <>
          <Button size="sm" icon={<Play size={12} />} onClick={() => onAction('start')} disabled={x?.activeState === 'active'}>
            Start
          </Button>
          <Button size="sm" icon={<Square size={12} />} onClick={() => onAction('stop')} disabled={x?.activeState !== 'active'}>
            Stop
          </Button>
          <Button size="sm" icon={<RotateCw size={12} />} onClick={() => onAction('restart')}>
            Restart
          </Button>
          <div className="flex-1" />
          <Toggle checked={follow} onChange={setFollow} label="Follow" />
          <Button size="sm" variant="ghost" onClick={() => setLines((n) => (n >= 1000 ? 100 : n * 10))} title="Toggle number of log lines">
            {lines} lines
          </Button>
          <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void st.reload()} loading={st.loading && !follow}>
            Refresh
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {st.error ? (
        <ErrorBox error={st.error} onRetry={st.reload} />
      ) : !x ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          <div>
            <div className="text-xs text-muted font-medium mb-1.5">systemctl status</div>
            <Pre maxH="max-h-56">{x.status || '(no output)'}</Pre>
          </div>
          <div>
            <div className="text-xs text-muted font-medium mb-1.5 flex items-center gap-2">
              Journal (last {lines} lines)
              {follow && <span className="inline-flex items-center gap-1 text-ok text-[11px]"><Activity size={11} /> live</span>}
            </div>
            <LogPre text={x.logs || '(no log entries)'} follow={follow} />
          </div>
        </div>
      )}
    </Modal>
  )
}

function LogPre({ text, follow }: { text: string; follow: boolean }): React.JSX.Element {
  const ref = React.useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text, follow])
  return (
    <pre ref={ref} className="bg-bg-2 border border-border rounded-md p-3 text-xs font-mono overflow-auto whitespace-pre-wrap break-words max-h-[40vh]">
      {text}
    </pre>
  )
}

function UnitFileModal({ serverId, unit, onClose }: { serverId: string; unit: string; onClose: () => void }): React.JSX.Element {
  const f = useAsync(() => api.call<string>('svc:unitFile', serverId, unit), [serverId, unit])
  return (
    <Modal open onClose={onClose} title={<span className="font-mono text-[13px]">{unit}</span>} badge={<Badge>unit file</Badge>} width="max-w-3xl" footer={<Button onClick={onClose}>Close</Button>}>
      {f.error ? <ErrorBox error={f.error} onRetry={f.reload} /> : f.data === undefined ? <Loading /> : <Pre maxH="max-h-[65vh]">{f.data || '(empty)'}</Pre>}
    </Modal>
  )
}

/* ================================================================== */
/* Listening ports                                                      */
/* ================================================================== */

function PortsTab({ serverId }: { serverId: string }): React.JSX.Element {
  const list = useAsync(() => api.call<ListeningPort[]>('ports:list', serverId), [serverId], { intervalMs: 10000 })
  const [filter, setFilter] = useState('')
  const { run, busy } = useAction()
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const all = list.data ?? []
    if (!f) return all
    return all.filter((p) => String(p.port) === f || p.process.toLowerCase().includes(f) || p.address.toLowerCase().includes(f) || (p.user ?? '').toLowerCase().includes(f) || p.proto.includes(f))
  }, [list.data, filter])

  const kill = async (p: ListeningPort): Promise<void> => {
    if (!p.pid) return
    const ok = await confirm({
      title: 'Terminate process',
      message: (
        <>
          Send SIGTERM to <b>{p.process || 'process'}</b> (PID {p.pid}) listening on <code className="font-mono">{p.address}:{p.port}</code>?
        </>
      ),
      danger: true,
      confirmLabel: 'Terminate'
    })
    if (!ok) return
    await run(() => api.call('proc:signal', serverId, p.pid, 'TERM'), { success: `SIGTERM sent to ${p.pid}` })
    await list.reload()
  }

  const columns: Column<ListeningPort>[] = [
    { key: 'proto', header: 'Proto', width: '70px', sortValue: (p) => p.proto, render: (p) => <Badge color={p.proto.startsWith('tcp') ? 'accent' : 'info'}>{p.proto}</Badge> },
    { key: 'address', header: 'Address', width: '200px', mono: true, sortValue: (p) => p.address, render: (p) => <span className={cls(p.address === '0.0.0.0' || p.address === '[::]' || p.address === '*' ? 'text-amber-300' : 'text-muted')} title={p.address === '0.0.0.0' || p.address === '[::]' || p.address === '*' ? 'Listening on all interfaces' : undefined}>{p.address}</span> },
    { key: 'port', header: 'Port', width: '80px', mono: true, align: 'right', sortValue: (p) => p.port, render: (p) => <span className="font-semibold">{p.port}</span> },
    { key: 'process', header: 'Process', sortValue: (p) => p.process, render: (p) => <span className="font-mono text-xs">{p.process || <span className="text-dim">unknown (needs root)</span>}</span> },
    { key: 'pid', header: 'PID', width: '80px', mono: true, sortValue: (p) => p.pid ?? 0, render: (p) => p.pid ?? '—' },
    { key: 'user', header: 'User', width: '110px', sortValue: (p) => p.user ?? '', render: (p) => p.user ?? '—' },
    {
      key: 'actions',
      header: '',
      width: '60px',
      align: 'right',
      render: (p) => (p.pid ? <IconButton size="xs" title="Terminate process (SIGTERM)" icon={<Square size={13} />} disabled={busy || p.pid === 1} onClick={() => void kill(p)} /> : null)
    }
  ]

  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by port, process, address" className="w-64" />
        <div className="flex-1" />
        {list.data && <span className="text-dim text-xs">{rows.length} sockets</span>}
        <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void list.reload()} />
      </div>
      <div className="mb-3">
        <Callout>
          <span className="inline-flex items-center gap-2">
            <Network size={13} /> These are sockets accepting connections. To allow or deny traffic to a port, open the{' '}
            <button className="text-accent hover:underline" onClick={() => useApp.getState().setPage(serverId, 'firewall')}>
              Firewall page
            </button>
            .
          </span>
        </Callout>
      </div>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState icon={<Network />} title="No listening sockets" description="Nothing is listening, or ss/netstat is not installed on this server." />
        </Card>
      ) : (
        <Card flush>
          <Table<ListeningPort> columns={columns} rows={rows} rowKey={(p) => `${p.proto}|${p.address}|${p.port}|${p.pid ?? ''}`} dense initialSort={{ key: 'port', dir: 'asc' }} empty="No sockets match the filter" />
        </Card>
      )}
    </>
  )
}
