import React, { useMemo, useState } from 'react'
import { Bell, BellOff, Check, CheckCircle, RefreshCw, Settings, Trash2 } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Callout, Card, Dot, EmptyState, ErrorBox, Page, PageHeader, ProgressBar, Select, Table, Toggle, confirm, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { cls, fmtDate, fmtPct } from '@/lib/format'
import type { AlertEvent } from '@shared/types'
import type { ServerSample } from '@shared/modules/alerts'

const KIND_COLOR: Record<AlertEvent['kind'], 'danger' | 'warn' | 'info' | 'muted' | 'accent'> = { cpu: 'warn', mem: 'warn', disk: 'danger', disconnect: 'danger', 'reboot-required': 'info', updates: 'accent' }

function timeAgo(ts: number): string {
  if (!ts) return 'no sample yet'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return fmtDate(ts)
}

export default function Alerts({ serverId }: PageProps): React.JSX.Element {
  const alerts = useApp((s) => s.alerts)
  const servers = useApp((s) => s.servers)
  const settings = useApp((s) => s.settings)
  const refreshAlerts = useApp((s) => s.refreshAlerts)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)
  const fleet = useAsync(() => api.global<ServerSample[]>('alerts:snapshot'), [], { intervalMs: 10000 })
  const [onlyUnacked, setOnlyUnacked] = useState(false)
  const [serverFilter, setServerFilter] = useState<string>('all')
  const { run, busy } = useAction()

  const rows = useMemo(
    () => alerts.filter((a) => (!onlyUnacked || !a.acknowledged) && (serverFilter === 'all' || (serverFilter === 'this' ? a.serverId === serverId : a.serverId === serverFilter))),
    [alerts, onlyUnacked, serverFilter, serverId]
  )
  const unacked = alerts.filter((a) => !a.acknowledged).length

  const ackAll = async (): Promise<void> => {
    await run(() => api.global('alerts:ack', rows.filter((a) => !a.acknowledged).map((a) => a.id)))
    await refreshAlerts()
  }
  const ackOne = async (a: AlertEvent): Promise<void> => {
    await run(() => api.global('alerts:ack', [a.id]))
    await refreshAlerts()
  }
  const clear = async (): Promise<void> => {
    if (!(await confirm({ title: 'Clear alerts', message: 'Delete all alerts for every server? This cannot be undone.', danger: true, confirmLabel: 'Clear' }))) return
    await run(() => api.global('alerts:clear'), { success: 'Alerts cleared' })
    await refreshAlerts()
  }
  const test = async (id: string): Promise<void> => {
    const s = await run(() => api.call<ServerSample>('alerts:test', id))
    if (s) {
      toast({ kind: 'info', title: `${s.serverName}: CPU ${fmtPct(s.cpuPct)} · RAM ${fmtPct(s.memPct)} · disk ${s.diskPct}% (${s.diskMount})`, detail: s.error ?? `Thresholds: CPU ${settings.alertCpuPct}% · RAM ${settings.alertMemPct}% · disk ${settings.alertDiskPct}%` })
      await fleet.reload()
      await refreshAlerts()
    }
  }

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={unacked ? `${unacked} unacknowledged` : 'all clear'}
        actions={
          <>
            <Toggle checked={settings.alertsEnabled} onChange={(v) => saveSettings({ alertsEnabled: v })} label={<span className="text-xs flex items-center gap-1">{settings.alertsEnabled ? <Bell size={11} /> : <BellOff size={11} />} Monitoring</span>} />
            <Button icon={<RefreshCw size={13} />} onClick={() => Promise.all([fleet.reload(), refreshAlerts()])} title="Refresh" />
            <Button icon={<CheckCircle size={13} />} onClick={ackAll} disabled={!rows.some((a) => !a.acknowledged)} loading={busy}>
              Acknowledge all
            </Button>
            <Button variant="danger" icon={<Trash2 size={13} />} onClick={clear} disabled={!alerts.length}>
              Clear
            </Button>
          </>
        }
      />
      <Page>
        <div className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-2 flex items-center justify-between">
          <span>Fleet · connected servers</span>
          <span className="normal-case tracking-normal font-normal">sampled every 30 s · view refreshes every 10 s</span>
        </div>
        {fleet.error ? (
          <ErrorBox error={fleet.error} onRetry={fleet.reload} />
        ) : (fleet.data ?? []).length === 0 ? (
          <Card className="mb-4">
            <EmptyState title="No connected servers" description="Connect servers to see live CPU, memory and disk usage here." />
          </Card>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 mb-5">
            {(fleet.data ?? []).map((s) => (
              <FleetCard key={s.serverId} s={s} current={s.serverId === serverId} onTest={() => test(s.serverId)} thresholds={settings} />
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 mb-2">
          <div className="text-[11px] uppercase tracking-wider text-dim font-semibold flex-1">Alert history</div>
          <Toggle checked={onlyUnacked} onChange={setOnlyUnacked} label={<span className="text-xs">Unacknowledged only</span>} />
          <Select value={serverFilter} onChange={(e) => setServerFilter(e.target.value)} className="w-44 h-7 text-xs">
            <option value="all">All servers</option>
            <option value="this">This server</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        {alerts.length === 0 ? (
          <Card>
            <EmptyState icon={<Bell />} title="No alerts" description={settings.alertsEnabled ? `You will be notified when CPU exceeds ${settings.alertCpuPct}%, memory ${settings.alertMemPct}% or a disk ${settings.alertDiskPct}%, when a server drops unexpectedly or needs a reboot.` : 'Monitoring is turned off. Enable it with the switch above.'} />
          </Card>
        ) : (
          <Card flush>
            <Table<AlertEvent>
              rows={rows}
              rowKey={(a) => a.id}
              dense
              empty="No alerts match the filter"
              columns={[
                { key: 'ts', header: 'Time', width: '150px', mono: true, render: (a) => <span className={cls(a.acknowledged ? 'text-dim' : 'text-muted')}>{fmtDate(a.ts)}</span>, sortValue: (a) => a.ts },
                { key: 'server', header: 'Server', width: '160px', render: (a) => <span className={cls('truncate block max-w-[150px]', a.acknowledged && 'text-muted')}>{a.serverName}</span>, sortValue: (a) => a.serverName },
                { key: 'kind', header: 'Kind', width: '130px', render: (a) => <Badge color={a.acknowledged ? 'muted' : KIND_COLOR[a.kind]}>{a.kind}</Badge>, sortValue: (a) => a.kind },
                { key: 'msg', header: 'Message', render: (a) => <span className={cls('text-xs', a.acknowledged ? 'text-dim' : 'text-text')}>{a.message}</span> },
                {
                  key: 'ack',
                  header: '',
                  width: '110px',
                  align: 'right',
                  render: (a) =>
                    a.acknowledged ? (
                      <span className="text-[11px] text-dim flex items-center justify-end gap-1">
                        <Check size={11} /> acknowledged
                      </span>
                    ) : (
                      <Button size="xs" variant="subtle" onClick={() => ackOne(a)}>
                        Acknowledge
                      </Button>
                    )
                }
              ]}
              initialSort={{ key: 'ts', dir: 'desc' }}
            />
          </Card>
        )}
        <div className="mt-4">
          <Callout>
            <span className="flex items-center gap-1.5">
              <Settings size={12} /> Thresholds are configured in Settings (gear icon): currently CPU {settings.alertCpuPct}% · memory {settings.alertMemPct}% · disk {settings.alertDiskPct}%. Each alert kind is raised at most once per 15 minutes per server; desktop notifications are shown when supported by your OS.
            </span>
          </Callout>
        </div>
      </Page>
    </>
  )
}

function FleetCard({ s, current, onTest, thresholds }: { s: ServerSample; current: boolean; onTest: () => void; thresholds: { alertCpuPct: number; alertMemPct: number; alertDiskPct: number } }): React.JSX.Element {
  const bar = (v: number, th: number): string => (v >= th ? 'bg-danger' : v >= th * 0.8 ? 'bg-warn' : 'bg-accent')
  return (
    <div className={cls('bg-panel border rounded-lg p-3', current ? 'border-accent/50' : 'border-border')}>
      <div className="flex items-center gap-2 mb-2">
        <Dot status={s.error ? 'danger' : s.ts ? 'ok' : 'muted'} />
        <div className="font-medium text-[13px] truncate flex-1">{s.serverName}</div>
        {s.rebootRequired && <Badge color="info">reboot</Badge>}
        <Button size="xs" variant="ghost" onClick={onTest} title="Sample now and evaluate thresholds">
          Test
        </Button>
      </div>
      {s.error ? (
        <div className="text-[11px] text-red-300 font-mono break-words">{s.error}</div>
      ) : (
        <div className="space-y-1.5">
          <Metric label="CPU" value={s.cpuPct} bar={bar(s.cpuPct, thresholds.alertCpuPct)} sub={s.nproc ? `load ${s.load1.toFixed(2)} / ${s.nproc} cores` : undefined} />
          <Metric label="RAM" value={s.memPct} bar={bar(s.memPct, thresholds.alertMemPct)} />
          <Metric label="Disk" value={s.diskPct} bar={bar(s.diskPct, thresholds.alertDiskPct)} sub={s.diskMount} />
        </div>
      )}
      <div className="text-[10px] text-dim mt-2">{timeAgo(s.ts)}</div>
    </div>
  )
}

function Metric({ label, value, bar, sub }: { label: string; value: number; bar: string; sub?: string }): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">
          {label}
          {sub && <span className="text-dim"> · {sub}</span>}
        </span>
        <span className="font-mono">{value.toFixed(0)}%</span>
      </div>
      <ProgressBar value={value} color={bar} className="mt-0.5" />
    </div>
  )
}
