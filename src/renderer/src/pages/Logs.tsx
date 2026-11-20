import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Eraser, FileArchive, FileText, Folder, Pause, Play, RefreshCw, ShieldAlert } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorBox, Input, Loading, Select, Stat, Table, Tabs, Toggle, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { cls, fmtBytes, fmtDate } from '@/lib/format'
import type { AuthEvent, AuthSummary, JournalQuery, JournalResult, JournalUnits, LogEntry, LogFile } from '@shared/modules/logs'

type Tab = 'journal' | 'files' | 'kernel' | 'auth'

const PRIO_LABEL = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']
const PRIO_COLOR: Record<number, 'danger' | 'warn' | 'info' | 'muted'> = { 0: 'danger', 1: 'danger', 2: 'danger', 3: 'danger', 4: 'warn', 5: 'info', 6: 'muted', 7: 'muted' }
const SINCE_PRESETS: { id: string; label: string; since?: string; boot?: string }[] = [
  { id: '15m', label: 'Last 15 min', since: '15 min ago' },
  { id: '1h', label: 'Last hour', since: '1 hour ago' },
  { id: '24h', label: 'Last 24 h', since: '24 hours ago' },
  { id: '7d', label: 'Last 7 days', since: '7 days ago' },
  { id: 'boot', label: 'Current boot', boot: '0' },
  { id: 'all', label: 'Any time' }
]

function fmtTs(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString(undefined, { hour12: false })}`
}

export default function Logs({ serverId }: PageProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('journal')
  const hasSystemd = useApp((s) => s.connections[serverId]?.os?.hasSystemd ?? true)
  useEffect(() => {
    if (!hasSystemd && tab === 'journal') setTab('files')
  }, [hasSystemd, tab])
  return (
    <>
      <div className="flex items-center justify-between px-6 h-14 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-[15px] font-semibold">Logs</h1>
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'journal', label: 'Journal' },
              { id: 'files', label: 'Files' },
              { id: 'kernel', label: 'Kernel' },
              { id: 'auth', label: 'Auth' }
            ]}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col px-6 pb-6">
        {tab === 'journal' && <JournalTab serverId={serverId} hasSystemd={hasSystemd} />}
        {tab === 'files' && <FilesTab serverId={serverId} />}
        {tab === 'kernel' && <KernelTab serverId={serverId} />}
        {tab === 'auth' && <AuthTab serverId={serverId} />}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

function JournalTab({ serverId, hasSystemd }: { serverId: string; hasSystemd: boolean }): React.JSX.Element {
  const [unit, setUnit] = useState('')
  const [priority, setPriority] = useState('')
  const [preset, setPreset] = useState('1h')
  const [grep, setGrep] = useState('')
  const [grepApplied, setGrepApplied] = useState('')
  const [lines, setLines] = useState(500)
  const [follow, setFollow] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()
  const listRef = useRef<HTMLDivElement>(null)
  const units = useAsync(() => api.call<JournalUnits>('logs:units', serverId), [serverId], { enabled: hasSystemd })

  const baseQuery = useCallback((): JournalQuery => {
    const p = SINCE_PRESETS.find((x) => x.id === preset)
    return { unit: unit.trim() || undefined, priority: priority === '' ? undefined : Number(priority), since: p?.since, boot: p?.boot, grep: grepApplied || undefined, lines }
  }, [unit, priority, preset, grepApplied, lines])

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const r = await api.call<JournalResult>('logs:journal', serverId, baseQuery())
      setEntries(r.entries)
      setCursor(r.nextCursor)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [serverId, baseQuery])

  useEffect(() => {
    if (hasSystemd) void load()
  }, [load, hasSystemd])

  // Follow mode: poll for entries after the last cursor.
  useEffect(() => {
    if (!follow || !hasSystemd) return
    let busy = false
    const t = window.setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const q = baseQuery()
        const r = await api.call<JournalResult>('logs:journal', serverId, { ...q, since: undefined, boot: undefined, cursorAfter: cursor, lines: 500 })
        if (r.entries.length) {
          setEntries((cur) => [...cur, ...r.entries].slice(-5000))
          setCursor(r.nextCursor)
        }
      } catch {
        /* keep polling */
      } finally {
        busy = false
      }
    }, 2000)
    return () => window.clearInterval(t)
  }, [follow, cursor, baseQuery, serverId, hasSystemd])

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [entries, autoScroll])

  if (!hasSystemd) return <Callout kind="warn">This server does not run systemd-journald. Use the Files tab to read plain log files in /var/log.</Callout>

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Input list="sm-units" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="All units (type to filter, e.g. nginx, sshd, kernel)" className="w-64 h-7 text-xs" mono />
        <datalist id="sm-units">
          <option value="kernel" />
          {(units.data?.units ?? []).map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-36 h-7 text-xs">
          <option value="">Any priority</option>
          {PRIO_LABEL.map((l, i) => (
            <option key={l} value={i}>
              {i} · {l} and above
            </option>
          ))}
        </Select>
        <Select value={preset} onChange={(e) => setPreset(e.target.value)} className="w-36 h-7 text-xs">
          {SINCE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setGrepApplied(grep.trim())
          }}
          className="flex items-center gap-1"
        >
          <Input value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="Search text (Enter)" className="w-48 h-7 text-xs" />
        </form>
        <Select value={lines} onChange={(e) => setLines(Number(e.target.value))} className="w-28 h-7 text-xs">
          {[100, 250, 500, 1000, 2000, 5000].map((n) => (
            <option key={n} value={n}>
              {n} lines
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        <Toggle checked={follow} onChange={setFollow} label={<span className="text-xs flex items-center gap-1">{follow ? <Pause size={11} /> : <Play size={11} />} Follow</span>} />
        <Toggle checked={autoScroll} onChange={setAutoScroll} label={<span className="text-xs">Auto-scroll</span>} />
        <Button size="xs" icon={<Eraser size={11} />} onClick={() => setEntries([])} title="Clear the view (keeps the cursor for follow mode)">
          Clear
        </Button>
        <Button size="xs" icon={<RefreshCw size={11} />} onClick={load} loading={loading}>
          Refresh
        </Button>
      </div>
      {error && (
        <div className="mb-3">
          <ErrorBox error={error} onRetry={load} />
        </div>
      )}
      <div ref={listRef} className="flex-1 min-h-0 overflow-auto bg-bg-2 border border-border rounded-md font-mono text-xs">
        {loading && entries.length === 0 ? (
          <Loading />
        ) : entries.length === 0 ? (
          <EmptyState icon={<FileText />} title="No entries" description="Nothing matches the current filters. Widen the time range or clear the unit / text filter." />
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {entries.map((e, i) => (
                <tr key={e.cursor || i} className={cls('border-b border-border/40 hover:bg-panel-2/60 align-top', e.priority <= 3 && 'bg-danger/5', e.priority === 4 && 'bg-warn/5')}>
                  <td className="px-2 py-0.5 text-dim whitespace-nowrap w-[120px]">{fmtTs(e.ts)}</td>
                  <td className="px-1 py-0.5 w-[70px]">
                    <Badge color={PRIO_COLOR[e.priority] ?? 'muted'} className="h-4 text-[10px]">
                      {PRIO_LABEL[e.priority] ?? e.priority}
                    </Badge>
                  </td>
                  <td className="px-2 py-0.5 text-accent whitespace-nowrap max-w-[180px] truncate" title={e.unit}>
                    {e.unit}
                    {e.pid ? <span className="text-dim">[{e.pid}]</span> : null}
                  </td>
                  <td className="px-2 py-0.5 whitespace-pre-wrap break-words text-text">{e.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="text-[11px] text-dim mt-1.5 flex items-center gap-3">
        <span>{entries.length} entries</span>
        {follow && (
          <span className="flex items-center gap-1 text-green-300">
            <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" /> following (polls every 2 s)
          </span>
        )}
        {units.data?.boots.length ? <span>{units.data.boots.length} boots recorded</span> : null}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

function FilesTab({ serverId }: { serverId: string }): React.JSX.Element {
  const files = useAsync(() => api.call<LogFile[]>('logs:files', serverId), [serverId])
  const [selected, setSelected] = useState<string>('')
  const [custom, setCustom] = useState('')
  const [lines, setLines] = useState(500)
  const [grep, setGrep] = useState('')
  const [grepApplied, setGrepApplied] = useState('')
  const [auto, setAuto] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState('')
  const preRef = useRef<HTMLPreElement>(null)
  const { run, busy } = useAction()
  const toast = useApp((s) => s.toast)

  const content = useAsync(() => (selected ? api.call<string>('logs:tail', serverId, { path: selected, lines, grep: grepApplied || undefined }) : Promise.resolve('')), [serverId, selected, lines, grepApplied], { intervalMs: auto ? 5000 : undefined, enabled: !!selected })

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [content.data])

  const tree = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const groups = new Map<string, LogFile[]>()
    for (const file of files.data ?? []) {
      if (f && !file.path.toLowerCase().includes(f)) continue
      groups.set(file.dir, [...(groups.get(file.dir) ?? []), file])
    }
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [files.data, filter])

  const download = (): void => {
    if (!selected) return
    void run(() => api.call<string | null>('logs:download', serverId, selected).then((p) => p && toast({ kind: 'success', title: 'Downloaded', detail: p })))
  }

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[300px_1fr] gap-4">
      <Card flush className="min-h-0 flex flex-col">
        <div className="p-2 border-b border-border flex items-center gap-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter /var/log" className="h-7 text-xs" />
          <Button size="xs" icon={<RefreshCw size={11} />} onClick={() => files.reload()} loading={files.loading} title="Refresh list" />
        </div>
        <div className="flex-1 min-h-0 overflow-auto py-1">
          {files.error ? (
            <div className="p-2">
              <ErrorBox error={files.error} onRetry={files.reload} />
            </div>
          ) : files.loading && !files.data ? (
            <Loading />
          ) : (
            tree.map(([dir, list]) => {
              const key = dir || '.'
              const open = !collapsed[key]
              return (
                <div key={key}>
                  <button onClick={() => setCollapsed((c) => ({ ...c, [key]: open }))} className="w-full flex items-center gap-1.5 px-2 h-6 text-xs text-muted hover:text-text">
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Folder size={12} />
                    <span className="font-mono truncate">/var/log{dir ? `/${dir}` : ''}</span>
                    <span className="ml-auto text-dim">{list.length}</span>
                  </button>
                  {open &&
                    list.map((f) => (
                      <button
                        key={f.path}
                        disabled={f.binary}
                        onClick={() => {
                          setSelected(f.path)
                          setCustom(f.path)
                        }}
                        title={f.binary ? 'Binary file — download it instead' : `${f.path} · ${fmtBytes(f.size)} · ${fmtDate(f.mtime)}`}
                        className={cls('w-full flex items-center gap-1.5 pl-7 pr-2 h-6 text-xs font-mono text-left disabled:opacity-40', selected === f.path ? 'bg-accent/15 text-text' : 'hover:bg-panel-2 text-muted hover:text-text')}
                      >
                        {f.compressed ? <FileArchive size={11} className="shrink-0" /> : <FileText size={11} className="shrink-0" />}
                        <span className="truncate flex-1">{f.name}</span>
                        {f.binary && <Badge className="h-4 text-[9px]">bin</Badge>}
                        <span className="text-dim text-[10px] shrink-0">{fmtBytes(f.size, 0)}</span>
                      </button>
                    ))}
                </div>
              )
            })
          )}
        </div>
      </Card>
      <div className="min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (custom.trim().startsWith('/')) setSelected(custom.trim())
            }}
            className="flex items-center gap-1 flex-1 min-w-[240px]"
          >
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="/var/log/syslog or any absolute path (Enter)" className="h-7 text-xs" mono />
          </form>
          <Select value={lines} onChange={(e) => setLines(Number(e.target.value))} className="w-28 h-7 text-xs">
            {[100, 250, 500, 1000, 2000, 5000, 10000].map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </Select>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setGrepApplied(grep.trim())
            }}
          >
            <Input value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="grep (Enter)" className="w-40 h-7 text-xs" />
          </form>
          <Toggle checked={auto} onChange={setAuto} label={<span className="text-xs">Auto-refresh</span>} />
          <Button size="xs" icon={<RefreshCw size={11} />} onClick={() => content.reload()} disabled={!selected} loading={content.loading && !!selected} />
          <Button size="xs" icon={<Download size={11} />} onClick={download} disabled={!selected} loading={busy}>
            Download
          </Button>
        </div>
        {!selected ? (
          <Card className="flex-1">
            <EmptyState icon={<FileText />} title="Select a log file" description="Pick a file on the left or type an absolute path. Compressed (.gz/.xz/.zst) files are decompressed on the fly." />
          </Card>
        ) : content.error ? (
          <ErrorBox error={content.error} onRetry={content.reload} />
        ) : (
          <pre ref={preRef} className="flex-1 min-h-0 overflow-auto bg-bg-2 border border-border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-words">
            {content.loading && content.data === undefined ? 'Loading…' : content.data || '(empty)'}
          </pre>
        )}
        {selected && (
          <div className="text-[11px] text-dim mt-1.5 font-mono truncate">
            {selected} · last {lines} lines{grepApplied ? ` matching "${grepApplied}"` : ''}
            {auto ? ' · refreshing every 5 s' : ''}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Kernel                                                              */
/* ------------------------------------------------------------------ */

function KernelTab({ serverId }: { serverId: string }): React.JSX.Element {
  const [lines, setLines] = useState(500)
  const [filter, setFilter] = useState('')
  const { data, error, loading, reload } = useAsync(() => api.call<string>('logs:dmesg', serverId, lines), [serverId, lines])
  const preRef = useRef<HTMLPreElement>(null)
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const all = (data ?? '').split('\n')
    return f ? all.filter((l) => l.toLowerCase().includes(f)) : all
  }, [data, filter])
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [shown])
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter (e.g. error, usb, oom, segfault)" className="w-72 h-7 text-xs" />
        <Select value={lines} onChange={(e) => setLines(Number(e.target.value))} className="w-28 h-7 text-xs">
          {[200, 500, 1000, 2000, 5000].map((n) => (
            <option key={n} value={n}>
              {n} lines
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        <span className="text-[11px] text-dim">{shown.length} lines</span>
        <Button size="xs" icon={<RefreshCw size={11} />} onClick={reload} loading={loading}>
          Refresh
        </Button>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : (
        <pre ref={preRef} className="flex-1 min-h-0 overflow-auto bg-bg-2 border border-border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-words">
          {loading && !data ? 'Loading…' : shown.map((l, i) => <div key={i} className={cls(/error|fail|oom|segfault|panic|bug/i.test(l) && 'text-red-300', /warn/i.test(l) && 'text-amber-300')}>{l}</div>)}
        </pre>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

const KIND_COLOR: Record<AuthEvent['kind'], 'ok' | 'danger' | 'warn' | 'muted' | 'accent'> = { accepted: 'ok', failed: 'danger', invalid: 'warn', disconnect: 'muted', sudo: 'accent' }

function AuthTab({ serverId }: { serverId: string }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<AuthSummary>('logs:auth', serverId, { lines: 1500 }), [serverId], { intervalMs: 30000 })
  const [kinds, setKinds] = useState<Record<AuthEvent['kind'], boolean>>({ accepted: true, failed: true, invalid: true, disconnect: false, sudo: true })
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (data?.events ?? []).filter((e) => kinds[e.kind] && (!f || (e.user ?? '').toLowerCase().includes(f) || (e.ip ?? '').includes(f) || e.msg.toLowerCase().includes(f)))
  }, [data, kinds, filter])
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading && !data) return <Loading />
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      <div className="grid grid-cols-[1fr_1fr_2fr] gap-3">
        <Stat label="Accepted logins (24 h)" value={data?.accepted24h ?? 0} sub={data?.source === 'journal' ? 'from journald' : data?.source === 'file' ? 'from /var/log/auth.log' : 'no auth log found'} />
        <Stat label="Failed / invalid attempts (24 h)" value={data?.failed24h ?? 0} color={(data?.failed24h ?? 0) > 100 ? 'bg-danger' : 'bg-accent'} sub={(data?.failed24h ?? 0) > 100 ? 'Heavy brute-forcing — use keys only and fail2ban' : 'Normal background noise on public servers'} />
        <Card title="Top attacking IPs (24 h)" bodyClass="py-2 px-4">
          {data?.topIps.length ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
              {data.topIps.map((t) => (
                <div key={t.ip} className="flex items-center justify-between gap-2">
                  <span className="truncate">{t.ip}</span>
                  <span className="text-red-300">{t.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted">No failed logins in the last 24 hours.</div>
          )}
          {!!data?.topIps.length && (
            <div className="text-[11px] text-dim mt-2 flex items-center gap-1">
              <ShieldAlert size={11} /> Ban repeat offenders automatically: Security audit → Fail2ban → Fix, or Overview → Quick actions.
            </div>
          )}
        </Card>
      </div>
      <div className="flex items-center gap-3">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by user, IP or text" className="w-64 h-7 text-xs" />
        {(Object.keys(kinds) as AuthEvent['kind'][]).map((k) => (
          <Checkbox key={k} checked={kinds[k]} onChange={(v) => setKinds((c) => ({ ...c, [k]: v }))} label={<span className="text-xs capitalize">{k}</span>} />
        ))}
        <div className="flex-1" />
        <span className="text-[11px] text-dim">{rows.length} events</span>
        <Button size="xs" icon={<RefreshCw size={11} />} onClick={reload} loading={loading}>
          Refresh
        </Button>
      </div>
      <Card flush className="flex-1 min-h-0 overflow-auto">
        <Table<AuthEvent>
          rows={rows}
          rowKey={(e, ) => `${e.ts}-${e.kind}-${e.ip ?? ''}-${e.user ?? ''}-${e.msg.length}`}
          dense
          empty="No matching events"
          columns={[
            { key: 'ts', header: 'Time', width: '140px', mono: true, render: (e) => <span className="text-muted">{fmtTs(e.ts)}</span> },
            { key: 'kind', header: 'Event', width: '100px', render: (e) => <Badge color={KIND_COLOR[e.kind]}>{e.kind}</Badge> },
            { key: 'user', header: 'User', width: '140px', mono: true, render: (e) => e.user ?? '' },
            { key: 'ip', header: 'From', width: '160px', mono: true, render: (e) => e.ip ?? '' },
            { key: 'method', header: 'Method', width: '90px', render: (e) => <span className="text-muted text-xs">{e.method ?? ''}</span> },
            { key: 'msg', header: 'Message', render: (e) => <span className="font-mono text-xs text-muted break-all">{e.msg}</span> }
          ]}
        />
      </Card>
    </div>
  )
}
