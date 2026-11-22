import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Box, ChevronDown, ChevronRight, Copy, Database, ExternalLink, Globe, Pause, Play, Radar, RefreshCw, ScrollText, Server } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { cls, fmtBytes, fmtDate } from '@/lib/format'
import { Badge, Button, Callout, Card, EmptyState, ErrorBox, IconButton, Loading, Page, PageHeader, SearchInput, Select, Stat, Table, Tabs, Toggle, confirm, useAction, useAsync, type Column } from '@/components/ui'
import type {
  TrafficConnections,
  TrafficContainer,
  TrafficContainerConn,
  TrafficContainers,
  TrafficDatabases,
  TrafficDbClient,
  TrafficDbEngineInfo,
  TrafficListener,
  TrafficRemote,
  TrafficWebIp,
  TrafficWebLog,
  TrafficWebLogs,
  TrafficWebSummary,
  TrafficWindow
} from '@shared/modules/traffic'

type TabId = 'connections' | 'web' | 'containers' | 'databases'

const WINDOWS: { id: TrafficWindow; label: string }[] = [
  { id: '15m', label: '15 min' },
  { id: '1h', label: '1 hour' },
  { id: '6h', label: '6 hours' },
  { id: '24h', label: '24 hours' },
  { id: 'all', label: 'Whole file' }
]

const ENGINE_LABEL: Record<string, string> = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mongo: 'MongoDB', redis: 'Redis' }

/* ------------------------------------------------------------------ */
/* Shared helpers                                                       */
/* ------------------------------------------------------------------ */

function Mono({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }): React.JSX.Element {
  return (
    <span className={cls('font-mono text-xs', className)} title={title}>
      {children}
    </span>
  )
}

function Toolbar({ children, right }: { children?: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 mb-3 min-h-[28px] flex-wrap">
      {children}
      <div className="flex-1" />
      {right}
    </div>
  )
}

function taskToast(title: string): void {
  useApp.getState().toast({ kind: 'info', title, detail: 'Live output is shown in the Tasks drawer.' })
}

function isPrivate(ip: string): boolean {
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip)) return true
  const l = ip.toLowerCase()
  return l === '::1' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd')
}

/** Reverse-DNS results survive refreshes and page switches (per IP, null = no name). */
const rdnsCache = new Map<string, string | null>()

/** Resolve names for the given IPs on the server (getent hosts) when enabled; results come from a shared cache. */
function useRdns(serverId: string, ips: string[], enabled: boolean): Map<string, string | null> {
  const [, bump] = useState(0)
  const pending = useRef(new Set<string>())
  useEffect(() => {
    if (!enabled) return
    const missing = ips.filter((ip) => !rdnsCache.has(ip) && !pending.current.has(ip)).slice(0, 50)
    if (missing.length === 0) return
    for (const ip of missing) pending.current.add(ip)
    let alive = true
    api
      .call<Record<string, string | null>>('traffic:rdns', serverId, missing)
      .then((r) => {
        for (const [ip, host] of Object.entries(r)) rdnsCache.set(ip, host)
      })
      .catch(() => {
        for (const ip of missing) rdnsCache.set(ip, null)
      })
      .finally(() => {
        for (const ip of missing) pending.current.delete(ip)
        if (alive) bump((n) => n + 1)
      })
    return () => {
      alive = false
    }
  }, [serverId, enabled, ips.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  return rdnsCache
}

/** Block / Whois / Copy for one IP. */
function IpActions({ serverId, ip, size = 'xs' }: { serverId: string; ip: string; size?: 'xs' | 'sm' }): React.JSX.Element {
  const { run, busy } = useAction()
  const block = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Block IP address',
      message: (
        <>
          Add a firewall rule that denies all incoming traffic from <b className="font-mono">{ip}</b>?
          {isPrivate(ip) && <div className="text-warn-fg mt-2">This is a private address: it may be your own network, a proxy or a container gateway. Blocking it can cut off legitimate traffic (or your own session).</div>}
          <div className="text-dim mt-2">The rule is added through the Firewall module with the comment "Traffic page"; remove it there when no longer needed.</div>
        </>
      ),
      danger: true,
      confirmLabel: 'Block',
      typeToConfirm: isPrivate(ip) ? ip : undefined
    })
    if (!ok) return
    await run(() => api.call('fw:blockIp', serverId, { ip, comment: 'Traffic page' }), { success: `Blocked ${ip}` })
  }
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      <IconButton size={size} title="Block this IP in the firewall" icon={<Ban size={13} />} className="hover:text-danger-fg" disabled={busy} onClick={() => void block()} />
      <IconButton size={size} title="Whois / geolocation (ipinfo.io)" icon={<ExternalLink size={13} />} onClick={() => api.openExternal(`https://ipinfo.io/${encodeURIComponent(ip)}`)} />
      <IconButton size={size} title="Copy IP" icon={<Copy size={13} />} onClick={() => void run(() => navigator.clipboard.writeText(ip), { success: `Copied ${ip}` })} />
    </div>
  )
}

function IpCell({ ip, you, host, expanded }: { ip: string; you?: boolean; host?: string | null; expanded?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {expanded !== undefined && <span className="text-dim shrink-0">{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Mono className="font-semibold">{ip}</Mono>
          {you && <Badge color="accent">you</Badge>}
          {isPrivate(ip) && <Badge>private</Badge>}
        </div>
        {host && <div className="text-dim text-[11px] truncate max-w-[260px]" title={host}>{host}</div>}
      </div>
    </div>
  )
}

function StatusBuckets({ s }: { s: { s2xx: number; s3xx: number; s4xx: number; s5xx: number } }): React.JSX.Element {
  const total = s.s2xx + s.s3xx + s.s4xx + s.s5xx || 1
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono" title={`2xx ${s.s2xx} · 3xx ${s.s3xx} · 4xx ${s.s4xx} · 5xx ${s.s5xx}`}>
      <div className="flex h-1.5 w-24 rounded overflow-hidden bg-border">
        <div className="bg-ok" style={{ width: `${(s.s2xx / total) * 100}%` }} />
        <div className="bg-info" style={{ width: `${(s.s3xx / total) * 100}%` }} />
        <div className="bg-warn" style={{ width: `${(s.s4xx / total) * 100}%` }} />
        <div className="bg-danger" style={{ width: `${(s.s5xx / total) * 100}%` }} />
      </div>
      {s.s4xx > 0 && <span className="text-warn-fg">{s.s4xx} 4xx</span>}
      {s.s5xx > 0 && <span className="text-danger-fg">{s.s5xx} 5xx</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function Traffic({ serverId }: PageProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('connections')
  const [subtitle, setSubtitle] = useState<string | undefined>()
  return (
    <>
      <PageHeader title="Traffic" subtitle={subtitle} />
      <Page>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'connections', label: 'Connections' },
              { id: 'web', label: 'Web server' },
              { id: 'containers', label: 'Containers' },
              { id: 'databases', label: 'Databases' }
            ]}
          />
        </div>
        <div className={tab === 'connections' ? '' : 'hidden'}>
          <ConnectionsTab serverId={serverId} active={tab === 'connections'} onSummary={setSubtitle} />
        </div>
        {tab === 'web' && <WebTab serverId={serverId} />}
        {tab === 'containers' && <ContainersTab serverId={serverId} />}
        {tab === 'databases' && <DatabasesTab serverId={serverId} />}
      </Page>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 1. Live connections                                                  */
/* ------------------------------------------------------------------ */

function ConnectionsTab({ serverId, active, onSummary }: { serverId: string; active: boolean; onSummary: (s: string | undefined) => void }): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const [resolve, setResolve] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const conns = useAsync(() => api.call<TrafficConnections>('traffic:connections', serverId), [serverId], { intervalMs: !paused && active ? 5000 : undefined, cacheKey: `traffic:conns:${serverId}` })
  const d = conns.data

  useEffect(() => {
    onSummary(d ? `${d.totals.inbound} inbound · ${d.totals.outbound} outbound · ${d.totals.uniqueIps} remote IPs` : undefined)
  }, [d, onSummary])

  const rows = useMemo(() => {
    const all = d?.remotes ?? []
    const f = filter.trim().toLowerCase()
    if (!f) return all
    return all.filter((r) => r.ip.toLowerCase().includes(f) || r.ports.some((p) => String(p.port) === f || p.service.toLowerCase().includes(f)) || (rdnsCache.get(r.ip) ?? '').toLowerCase().includes(f))
  }, [d, filter])
  const names = useRdns(serverId, rows.map((r) => r.ip), resolve)

  const columns: Column<TrafficRemote>[] = [
    {
      key: 'ip',
      header: 'Remote IP',
      width: '300px',
      sortValue: (r) => r.ip,
      render: (r) => <IpCell ip={r.ip} you={r.you} host={resolve ? names.get(r.ip) : undefined} expanded={expanded === r.ip} />
    },
    { key: 'connections', header: 'Conns', width: '80px', align: 'right', mono: true, sortValue: (r) => r.connections, render: (r) => <span className="font-semibold">{r.connections}</span> },
    {
      key: 'dir',
      header: 'Direction',
      width: '110px',
      sortValue: (r) => r.inbound - r.outbound,
      render: (r) => (
        <span className="text-xs">
          {r.inbound > 0 && <span className="text-text">{r.inbound} in</span>}
          {r.inbound > 0 && r.outbound > 0 && <span className="text-dim"> · </span>}
          {r.outbound > 0 && <span className="text-muted">{r.outbound} out</span>}
        </span>
      )
    },
    {
      key: 'ports',
      header: 'Ports / services',
      sortValue: (r) => r.ports[0]?.port ?? 0,
      render: (r) => {
        const open = expanded === r.ip
        const shown = open ? r.ports : r.ports.slice(0, 4)
        return (
          <div className={cls('flex gap-1.5', open ? 'flex-col items-start py-1' : 'flex-wrap items-center')}>
            {shown.map((p) => (
              <span key={`${p.inbound}|${p.proto}|${p.port}`} className={cls('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-mono', p.inbound ? 'bg-panel-2 border-border text-text' : 'border-border/60 text-muted')} title={p.inbound ? `Inbound to local port ${p.port}/${p.proto}` : `Outbound to remote port ${p.port}/${p.proto}`}>
                {!p.inbound && <span className="text-dim">→</span>}
                {p.port}
                {p.proto === 'udp' && <span className="text-dim">/udp</span>}
                {p.service && <span className="text-muted">{p.service}</span>}
                {(open || p.count > 1) && <span className="text-dim">×{p.count}</span>}
              </span>
            ))}
            {!open && r.ports.length > shown.length && <span className="text-dim text-[11px]">+{r.ports.length - shown.length} more</span>}
          </div>
        )
      }
    },
    { key: 'actions', header: '', width: '110px', align: 'right', render: (r) => <IpActions serverId={serverId} ip={r.ip} /> }
  ]

  const listenerColumns: Column<TrafficListener>[] = [
    { key: 'port', header: 'Port', width: '90px', mono: true, sortValue: (l) => l.port, render: (l) => <span className="font-semibold">{l.port}<span className="text-dim">/{l.proto}</span></span> },
    {
      key: 'service',
      header: 'Service',
      sortValue: (l) => l.service,
      render: (l) =>
        l.service ? (
          <span className="inline-flex items-center gap-1.5">
            {l.kind === 'docker' && <Box size={12} className="text-muted" />}
            <Mono>{l.service}</Mono>
            {l.pid && <span className="text-dim text-[11px]">pid {l.pid}</span>}
          </span>
        ) : (
          <span className="text-dim text-xs">{d?.noProcessNames ? 'unknown (needs root)' : 'unknown'}</span>
        )
    },
    { key: 'address', header: 'Bound to', width: '160px', mono: true, sortValue: (l) => l.address, render: (l) => <span className="text-muted">{l.address}</span> },
    { key: 'connections', header: 'Conns', width: '80px', align: 'right', mono: true, sortValue: (l) => l.connections, render: (l) => (l.connections ? <span className="font-semibold">{l.connections}</span> : <span className="text-dim">0</span>) }
  ]

  return (
    <>
      <Toolbar
        right={
          <>
            {d && <span className="text-dim text-xs">{rows.length} of {d.remotes.length} IPs</span>}
            <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void conns.reload()} loading={conns.loading && !!d} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by IP, port, service or host name" className="w-80" />
        <Toggle checked={!paused} onChange={(v) => setPaused(!v)} label={<span className="inline-flex items-center gap-1">{paused ? <Pause size={11} /> : <Play size={11} />} Auto refresh (5 s)</span>} />
        <Toggle checked={resolve} onChange={setResolve} label="Resolve names" />
      </Toolbar>
      {conns.error ? (
        <ErrorBox error={conns.error} onRetry={conns.reload} />
      ) : !d ? (
        <Loading label="Reading sockets…" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Established TCP" value={d.totals.established} />
            <Stat label="Inbound" value={d.totals.inbound} sub="to a listening port" />
            <Stat label="Outbound" value={d.totals.outbound} sub="opened by this server" />
            <Stat label="UDP flows" value={d.totals.udp} />
            <Stat label="Remote IPs" value={d.totals.uniqueIps} sub={d.yourIp ? `you: ${d.yourIp}` : undefined} />
          </div>
          {d.hints.map((h) => (
            <Callout key={h} kind="warn">
              {h}
            </Callout>
          ))}
          {d.remotes.length === 0 ? (
            <Card>
              <EmptyState icon={<Radar />} title="No remote connections" description="Nothing besides loopback is connected right now, or ss is not available on this server." />
            </Card>
          ) : (
            <Card flush title="Remote addresses" actions={<span className="text-dim text-xs">Click a row for the full per-port breakdown</span>}>
              <Table<TrafficRemote> columns={columns} rows={rows} rowKey={(r) => r.ip} dense initialSort={{ key: 'connections', dir: 'desc' }} onRowClick={(r) => setExpanded((cur) => (cur === r.ip ? null : r.ip))} selected={(r) => r.ip === expanded} empty="No addresses match the filter" />
            </Card>
          )}
          <Card flush title="Listening ports" actions={<span className="text-dim text-xs">{d.listeners.length} sockets · {d.docker ? 'Docker port mapping included' : 'no Docker'}</span>}>
            <Table<TrafficListener> columns={listenerColumns} rows={d.listeners} rowKey={(l) => `${l.proto}|${l.port}`} dense initialSort={{ key: 'connections', dir: 'desc' }} empty="No listening sockets" />
          </Card>
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Web server access logs                                            */
/* ------------------------------------------------------------------ */

function MinuteBars({ points }: { points: { t: number; count: number }[] }): React.JSX.Element {
  const w = 600
  const h = 56
  const max = Math.max(1, ...points.map((p) => p.count))
  const bw = w / Math.max(1, points.length)
  const [hover, setHover] = useState<number | null>(null)
  const hp = hover !== null ? points[hover] : undefined
  return (
    <div className="bg-panel border border-border rounded-lg px-4 py-3">
      <div className="flex items-center justify-between text-xs text-muted mb-1">
        <span>Requests per minute (last 60 minutes of the window)</span>
        <span className="text-text font-medium">{hp ? `${new Date(hp.t).toLocaleTimeString()} · ${hp.count} req` : `peak ${max}/min`}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-14" onMouseLeave={() => setHover(null)}>
        {points.map((p, i) => {
          const bh = (p.count / max) * (h - 2)
          return <rect key={p.t} x={i * bw + 0.5} y={h - bh} width={Math.max(0.5, bw - 1)} height={bh} fill="var(--color-accent)" fillOpacity={hover === i ? 1 : 0.65} onMouseEnter={() => setHover(i)} />
        })}
        <line x1={0} y1={h - 0.5} x2={w} y2={h - 0.5} stroke="var(--color-border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

function WebTab({ serverId }: { serverId: string }): React.JSX.Element {
  const logs = useAsync(() => api.call<TrafficWebLogs>('traffic:webLogs', serverId), [serverId], { cacheKey: `traffic:weblogs:${serverId}` })
  const [path, setPath] = useState<string>('')
  const [win, setWin] = useState<TrafficWindow>('1h')
  const [resolve, setResolve] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const { run, busy } = useAction()
  const setPage = useApp((s) => s.setPage)

  const available = logs.data?.logs ?? []
  useEffect(() => {
    if (available.length && !available.some((l) => l.path === path)) setPath(available[0].path)
  }, [available, path])
  const current: TrafficWebLog | undefined = available.find((l) => l.path === path)

  const summary = useAsync(() => api.call<TrafficWebSummary>('traffic:webSummary', serverId, { path, window: win, limit: 100 }), [serverId, path, win], { enabled: !!path, cacheKey: `traffic:websum:${serverId}:${path}:${win}` })
  const s = summary.data

  const rows = useMemo(() => {
    const all = s?.topIps ?? []
    const f = filter.trim().toLowerCase()
    if (!f) return all
    return all.filter((r) => r.ip.toLowerCase().includes(f) || r.userAgent.toLowerCase().includes(f) || r.topPaths.some((p) => p.path.toLowerCase().includes(f)) || (rdnsCache.get(r.ip) ?? '').toLowerCase().includes(f))
  }, [s, filter])
  const names = useRdns(serverId, rows.map((r) => r.ip), resolve)

  const follow = async (): Promise<void> => {
    if (!path) return
    await run(async () => {
      await api.call('traffic:webTail', serverId, { path })
      taskToast(`Following ${path}`)
    })
  }

  const columns: Column<TrafficWebIp>[] = [
    { key: 'ip', header: 'Client IP', width: '300px', sortValue: (r) => r.ip, render: (r) => <IpCell ip={r.ip} host={resolve ? names.get(r.ip) : undefined} expanded={expanded === r.ip} /> },
    { key: 'requests', header: 'Requests', width: '90px', align: 'right', mono: true, sortValue: (r) => r.requests, render: (r) => <span className="font-semibold">{r.requests}</span> },
    { key: 'bytes', header: 'Bytes', width: '90px', align: 'right', mono: true, sortValue: (r) => r.bytes, render: (r) => fmtBytes(r.bytes) },
    { key: 'status', header: 'Status', width: '190px', sortValue: (r) => r.statuses.s5xx * 1000 + r.statuses.s4xx, render: (r) => <StatusBuckets s={r.statuses} /> },
    { key: 'last', header: 'Last seen', width: '150px', sortValue: (r) => r.lastSeen, render: (r) => <span className="text-muted text-xs whitespace-nowrap">{fmtDate(r.lastSeen)}</span> },
    {
      key: 'detail',
      header: 'Top paths / user agent',
      sortValue: (r) => r.topPaths[0]?.path ?? '',
      render: (r) => {
        const open = expanded === r.ip
        if (!open)
          return (
            <div className="min-w-0 max-w-[520px] truncate text-xs" title={`${r.topPaths.map((p) => `${p.count}× ${p.path}`).join('\n')}\n\n${r.userAgent}`}>
              <Mono className="text-text">{r.topPaths[0]?.path ?? '—'}</Mono>
              {r.topPaths.length > 1 && <span className="text-dim"> +{r.topPaths.length - 1}</span>}
              {r.userAgent && <span className="text-dim"> · {r.userAgent}</span>}
            </div>
          )
        return (
          <div className="py-1 space-y-1 text-xs">
            {r.topPaths.map((p) => (
              <div key={p.path} className="flex items-center gap-2">
                <span className="text-muted font-mono w-12 text-right shrink-0">{p.count}×</span>
                <Mono className="break-all">{p.path}</Mono>
              </div>
            ))}
            <div className="text-dim break-all pt-1">UA: {r.userAgent || '—'}</div>
          </div>
        )
      }
    },
    { key: 'actions', header: '', width: '110px', align: 'right', render: (r) => <IpActions serverId={serverId} ip={r.ip} /> }
  ]

  if (logs.error) return <ErrorBox error={logs.error} onRetry={logs.reload} />
  if (!logs.data) return <Loading label="Looking for access logs…" />

  const noServer = logs.data.servers.length === 0
  if (noServer || available.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <EmptyState
            icon={<Globe />}
            title={noServer ? 'No web server found' : 'No access log found'}
            description={
              noServer ? (
                <>
                  Neither nginx, Apache nor Caddy is installed on this server. Install one on the{' '}
                  <button className="text-accent hover:underline" onClick={() => setPage(serverId, 'webserver')}>
                    Web server page
                  </button>
                  .
                </>
              ) : (
                <>
                  {logs.data.servers.join(', ')} {logs.data.servers.length > 1 ? 'are' : 'is'} installed, but no access log exists under /var/log or in the configuration. Logging may be disabled (<Mono>access_log off</Mono>) or the server has not served a request yet.
                </>
              )
            }
            action={
              <Button icon={<RefreshCw size={13} />} onClick={() => void logs.reload()}>
                Look again
              </Button>
            }
          />
        </Card>
        {logs.data.caddyNoAccessLog && <CaddyHint />}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Toolbar
        right={
          <>
            <Button size="sm" icon={<ScrollText size={12} />} onClick={() => void follow()} disabled={!path} loading={busy}>
              Follow live
            </Button>
            <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void summary.reload()} loading={summary.loading && !!s} />
          </>
        }
      >
        <div className="w-[420px] max-w-full">
          <Select value={path} onChange={(e) => setPath(e.target.value)} className="h-7 text-xs font-mono">
            {available.map((l) => (
              <option key={l.path} value={l.path}>
                {l.server} · {l.path} ({fmtBytes(l.sizeBytes)})
              </option>
            ))}
          </Select>
        </div>
        <Tabs<TrafficWindow> value={win} onChange={setWin} tabs={WINDOWS} />
        <Toggle checked={resolve} onChange={setResolve} label="Resolve names" />
      </Toolbar>
      {current && (
        <div className="flex items-center gap-2 text-xs text-dim -mt-2">
          <Badge color="accent">{current.server}</Badge>
          <Badge>{current.format === 'caddy-json' ? 'JSON' : 'combined'}</Badge>
          <span>modified {fmtDate(current.mtime)}</span>
          {s && (
            <span>
              · {s.linesScanned.toLocaleString()} lines scanned{s.truncated ? ' (last 200,000 only)' : ''}
              {s.unparsed > 0 ? ` · ${s.unparsed} unparsed` : ''}
              {s.from && s.to ? ` · ${fmtDate(s.from)} → ${fmtDate(s.to)}` : ''}
            </span>
          )}
        </div>
      )}
      {logs.data.caddyNoAccessLog && current?.server !== 'caddy' && <CaddyHint />}
      {summary.error ? (
        <ErrorBox error={summary.error} onRetry={summary.reload} />
      ) : !s ? (
        <Loading label="Aggregating the log on the server…" />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Requests" value={s.total.toLocaleString()} sub={win === 'all' ? 'whole file (capped)' : `last ${WINDOWS.find((w) => w.id === win)?.label}`} />
            <Stat label="Unique IPs" value={s.uniqueIps.toLocaleString()} />
            <Stat label="Bytes sent" value={fmtBytes(s.bytes)} />
            <Stat label="4xx" value={s.statuses.s4xx.toLocaleString()} sub={s.total ? `${((s.statuses.s4xx / s.total) * 100).toFixed(1)} %` : undefined} bar={s.total ? (s.statuses.s4xx / s.total) * 100 : 0} color="bg-warn" />
            <Stat label="5xx" value={s.statuses.s5xx.toLocaleString()} sub={s.total ? `${((s.statuses.s5xx / s.total) * 100).toFixed(1)} %` : undefined} bar={s.total ? (s.statuses.s5xx / s.total) * 100 : 0} color="bg-danger" />
          </div>
          <MinuteBars points={s.perMinute} />
          {s.total === 0 ? (
            <Card>
              <EmptyState icon={<Globe />} title="No requests in this window" description={s.unparsed > 0 ? `${s.unparsed} lines could not be parsed: the log may use a custom format.` : 'Try a longer window.'} />
            </Card>
          ) : (
            <Card
              flush
              title={`Top ${rows.length} client IPs`}
              actions={
                <>
                  <SearchInput value={filter} onChange={setFilter} placeholder="Filter IP, path or user agent" className="w-64" />
                  <span className="text-dim text-xs">Click a row for paths and user agent</span>
                </>
              }
            >
              <Table<TrafficWebIp> columns={columns} rows={rows} rowKey={(r) => r.ip} dense initialSort={{ key: 'requests', dir: 'desc' }} onRowClick={(r) => setExpanded((cur) => (cur === r.ip ? null : r.ip))} selected={(r) => r.ip === expanded} empty="No IPs match the filter" />
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function CaddyHint(): React.JSX.Element {
  return (
    <Callout>
      <b>Caddy writes no access log.</b> Add a <Mono>log</Mono> directive to the site block in <Mono>/etc/caddy/Caddyfile</Mono> and reload Caddy:
      <pre className="mt-1.5 font-mono text-[11px] text-text whitespace-pre">{`example.com {
    log {
        output file /var/log/caddy/access.log
    }
    # …
}`}</pre>
    </Callout>
  )
}

/* ------------------------------------------------------------------ */
/* 3. Containers                                                        */
/* ------------------------------------------------------------------ */

function ContainersTab({ serverId }: { serverId: string }): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const [resolve, setResolve] = useState(false)
  const [filter, setFilter] = useState('')
  const list = useAsync(() => api.call<TrafficContainers>('traffic:containers', serverId), [serverId], { intervalMs: paused ? undefined : 5000, cacheKey: `traffic:containers:${serverId}` })
  const d = list.data
  const setPage = useApp((s) => s.setPage)

  const containers = useMemo(() => {
    const all = d?.containers ?? []
    const f = filter.trim().toLowerCase()
    if (!f) return all
    return all.filter((c) => c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || c.connections.some((x) => x.ip.includes(f) || x.ports.some((p) => String(p) === f)))
  }, [d, filter])
  const allIps = useMemo(() => [...new Set(containers.flatMap((c) => c.connections.map((x) => x.ip)))], [containers])
  const names = useRdns(serverId, allIps, resolve)

  const total = d?.containers.reduce((n, c) => n + c.connections.reduce((m, x) => m + x.count, 0), 0) ?? 0

  return (
    <>
      <Toolbar
        right={
          <>
            {d && <span className="text-dim text-xs">{d.containers.length} running · {total} connections</span>}
            <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void list.reload()} loading={list.loading && !!d} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by container, image, IP or port" className="w-80" />
        <Toggle checked={!paused} onChange={(v) => setPaused(!v)} label={<span className="inline-flex items-center gap-1">{paused ? <Pause size={11} /> : <Play size={11} />} Auto refresh (5 s)</span>} />
        <Toggle checked={resolve} onChange={setResolve} label="Resolve names" />
      </Toolbar>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : !d ? (
        <Loading label="Inspecting containers…" />
      ) : !d.docker ? (
        <Card>
          <EmptyState
            icon={<Box />}
            title="Docker is not installed"
            description={
              <>
                Container traffic is read with <Mono>nsenter</Mono> inside each container's network namespace. Install Docker on the{' '}
                <button className="text-accent hover:underline" onClick={() => setPage(serverId, 'docker')}>
                  Docker page
                </button>
                .
              </>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {d.hint && <Callout kind="warn">{d.hint}</Callout>}
          {d.containers.length === 0 ? (
            <Card>
              <EmptyState icon={<Box />} title="No running containers" />
            </Card>
          ) : containers.length === 0 ? (
            <Card>
              <EmptyState icon={<Box />} title="No container matches the filter" />
            </Card>
          ) : (
            containers.map((c) => <ContainerCard key={c.id} serverId={serverId} c={c} names={resolve ? names : undefined} />)
          )}
        </div>
      )}
    </>
  )
}

function ContainerCard({ serverId, c, names }: { serverId: string; c: TrafficContainer; names?: Map<string, string | null> }): React.JSX.Element {
  const total = c.connections.reduce((n, x) => n + x.count, 0)
  const columns: Column<TrafficContainerConn>[] = [
    { key: 'ip', header: 'Remote IP', width: '300px', sortValue: (r) => r.ip, render: (r) => <IpCell ip={r.ip} host={names?.get(r.ip)} /> },
    { key: 'count', header: 'Conns', width: '80px', align: 'right', mono: true, sortValue: (r) => r.count, render: (r) => <span className="font-semibold">{r.count}</span> },
    {
      key: 'ports',
      header: 'Container ports',
      sortValue: (r) => r.ports[0] ?? 0,
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.ports.map((p) => (
            <Badge key={p} className="font-mono">
              {p}
            </Badge>
          ))}
        </div>
      )
    },
    { key: 'actions', header: '', width: '110px', align: 'right', render: (r) => <IpActions serverId={serverId} ip={r.ip} /> }
  ]
  return (
    <Card
      flush
      title={
        <span className="inline-flex items-center gap-2">
          <Box size={14} className="text-muted" />
          <Mono className="text-[13px]">{c.name}</Mono>
          <Badge>{c.image}</Badge>
          {c.networkMode && c.networkMode !== 'default' && c.networkMode !== 'bridge' && <Badge color="info">{c.networkMode}</Badge>}
        </span>
      }
      actions={
        <span className="text-dim text-xs">
          {c.ports ? <Mono className="text-dim">{c.ports}</Mono> : 'no published ports'} · {total} connection{total === 1 ? '' : 's'}
        </span>
      }
    >
      {c.skipped ? (
        <div className="px-4 py-3 text-xs text-muted">{c.skipped}</div>
      ) : c.error ? (
        <div className="px-4 py-3 text-xs text-warn-fg font-mono break-all">{c.error}</div>
      ) : (
        <Table<TrafficContainerConn> columns={columns} rows={c.connections} rowKey={(r) => r.ip} dense initialSort={{ key: 'count', dir: 'desc' }} empty="No established connections inside this container" />
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 4. Databases                                                         */
/* ------------------------------------------------------------------ */

function DatabasesTab({ serverId }: { serverId: string }): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const [resolve, setResolve] = useState(false)
  const list = useAsync(() => api.call<TrafficDatabases>('traffic:databases', serverId), [serverId], { intervalMs: paused ? undefined : 10000, cacheKey: `traffic:dbs:${serverId}` })
  const d = list.data
  const setPage = useApp((s) => s.setPage)
  const allIps = useMemo(() => [...new Set((d?.engines ?? []).flatMap((e) => e.clients.map((c) => c.ip)))], [d])
  const names = useRdns(serverId, allIps, resolve)
  const missingCreds = (d?.engines ?? []).some((e) => e.where === 'host' && !e.credentials && e.hint && /credentials|authentication/i.test(e.hint))

  return (
    <>
      <Toolbar
        right={
          <>
            {d && <span className="text-dim text-xs">{d.engines.length} engine{d.engines.length === 1 ? '' : 's'}</span>}
            <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void list.reload()} loading={list.loading && !!d} />
          </>
        }
      >
        <Toggle checked={!paused} onChange={(v) => setPaused(!v)} label={<span className="inline-flex items-center gap-1">{paused ? <Pause size={11} /> : <Play size={11} />} Auto refresh (10 s)</span>} />
        <Toggle checked={resolve} onChange={setResolve} label="Resolve names" />
      </Toolbar>
      {list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : !d ? (
        <Loading label="Looking for database listeners…" />
      ) : (
        <div className="space-y-4">
          {missingCreds && (
            <Callout>
              Some engines refused the login, so only socket-level clients are shown for them. Store admin credentials on the{' '}
              <button className="text-accent hover:underline" onClick={() => setPage(serverId, 'databases')}>
                Databases page
              </button>{' '}
              to see users, databases and the engine's own client list.
            </Callout>
          )}
          {d.engines.length === 0 ? (
            <Card>
              <EmptyState icon={<Database />} title="No database found" description={d.hint} />
            </Card>
          ) : (
            d.engines.map((e) => <EngineCard key={`${e.where}|${e.engine}|${e.container ?? ''}|${e.port}`} serverId={serverId} e={e} names={resolve ? names : undefined} />)
          )}
        </div>
      )}
    </>
  )
}

function EngineCard({ serverId, e, names }: { serverId: string; e: TrafficDbEngineInfo; names?: Map<string, string | null> }): React.JSX.Element {
  const [showDetail, setShowDetail] = useState(false)
  const total = e.clients.reduce((n, c) => n + c.connections, 0)
  const columns: Column<TrafficDbClient>[] = [
    { key: 'ip', header: 'Client IP', width: '300px', sortValue: (c) => c.ip, render: (c) => <IpCell ip={c.ip} host={names?.get(c.ip)} /> },
    { key: 'connections', header: 'Conns', width: '80px', align: 'right', mono: true, sortValue: (c) => c.connections, render: (c) => <span className="font-semibold">{c.connections}</span> },
    {
      key: 'users',
      header: 'Users',
      width: '200px',
      sortValue: (c) => (c.users ?? []).join(','),
      render: (c) => (c.users?.length ? <div className="flex flex-wrap gap-1">{c.users.map((u) => <Badge key={u} color="info" className="font-mono">{u}</Badge>)}</div> : <span className="text-dim text-xs">—</span>)
    },
    {
      key: 'dbs',
      header: 'Databases',
      sortValue: (c) => (c.dbs ?? []).join(','),
      render: (c) => (c.dbs?.length ? <div className="flex flex-wrap gap-1">{c.dbs.map((db) => <Badge key={db} className="font-mono">{db}</Badge>)}</div> : <span className="text-dim text-xs">—</span>)
    },
    { key: 'actions', header: '', width: '110px', align: 'right', render: (c) => <IpActions serverId={serverId} ip={c.ip} /> }
  ]
  const detail = e.detail ?? []
  const cols = e.detailColumns ?? []
  return (
    <Card
      flush
      title={
        <span className="inline-flex items-center gap-2">
          <Database size={14} className="text-muted" />
          {ENGINE_LABEL[e.engine] ?? e.engine}
          <Badge color={e.where === 'docker' ? 'info' : 'accent'}>{e.where === 'docker' ? <span className="inline-flex items-center gap-1"><Box size={10} /> {e.container}</span> : <span className="inline-flex items-center gap-1"><Server size={10} /> host</span>}</Badge>
          {e.port > 0 && <Mono className="text-muted">:{e.port}</Mono>}
          <span className="text-dim text-xs font-normal">{e.label}</span>
        </span>
      }
      actions={
        <>
          <span className="text-dim text-xs">
            {e.clients.length} client IP{e.clients.length === 1 ? '' : 's'} · {total} connection{total === 1 ? '' : 's'}
          </span>
          {detail.length > 0 && (
            <Button size="xs" variant={showDetail ? 'subtle' : 'ghost'} onClick={() => setShowDetail((v) => !v)}>
              {showDetail ? 'Hide' : 'Show'} engine view ({detail.length})
            </Button>
          )}
        </>
      }
    >
      {e.hint && <div className={cls('px-4 py-2 text-xs border-b border-border', /refused|needs|not installed|failed/i.test(e.hint) ? 'text-warn-fg' : 'text-muted')}>{e.hint}</div>}
      <Table<TrafficDbClient> columns={columns} rows={e.clients} rowKey={(c) => c.ip} dense initialSort={{ key: 'connections', dir: 'desc' }} empty="No remote clients connected (local socket connections are not listed)" />
      {showDetail && detail.length > 0 && (
        <div className="border-t border-border overflow-auto max-h-80">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-panel-2/60 text-muted text-left">
              <tr>
                {cols.map((c) => (
                  <th key={c} className="px-3 py-1.5 font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.map((row, i) => (
                <tr key={i} className="border-t border-border/60">
                  {row.map((v, j) => (
                    <td key={j} className="px-3 py-1 font-mono whitespace-nowrap max-w-[320px] truncate" title={v}>
                      {v || <span className="text-dim">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
