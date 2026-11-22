import React, { useMemo, useState } from 'react'
import { Download, History, RefreshCw, Trash2 } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Card, EmptyState, ErrorBox, Loading, Page, PageHeader, SearchInput, Select, Table, confirm, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { fmtDate } from '@/lib/format'
import type { AuditEntry } from '@shared/types'

export default function Audit({ serverId }: PageProps): React.JSX.Element {
  const servers = useApp((s) => s.servers)
  const { data, error, loading, reload } = useAsync(() => api.global<AuditEntry[]>('audit:list', 2000), [], { intervalMs: 15000 })
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<'this' | 'all'>('this')
  const [okFilter, setOkFilter] = useState<'all' | 'ok' | 'failed'>('all')
  const { run, busy } = useAction()

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (data ?? []).filter((e) => {
      if (scope === 'this' && e.serverId && e.serverId !== serverId) return false
      if (okFilter === 'ok' && !e.ok) return false
      if (okFilter === 'failed' && e.ok) return false
      if (!f) return true
      return e.action.toLowerCase().includes(f) || (e.detail ?? '').toLowerCase().includes(f) || (e.serverName ?? '').toLowerCase().includes(f)
    })
  }, [data, filter, scope, okFilter, serverId])

  const clear = async (): Promise<void> => {
    if (!(await confirm({ title: 'Clear activity log', message: 'Delete all recorded actions for every server? This cannot be undone.', danger: true, confirmLabel: 'Clear' }))) return
    await run(() => api.global('audit:clear'), { success: 'Activity log cleared' })
    await reload()
  }

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `centralserver-activity-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  const serverName = (e: AuditEntry): string => e.serverName ?? servers.find((s) => s.id === e.serverId)?.name ?? (e.serverId ? e.serverId.slice(0, 8) : '—')

  return (
    <>
      <PageHeader
        title="Activity log"
        subtitle={`${rows.length} of ${data?.length ?? 0} entries`}
        actions={
          <>
            <SearchInput value={filter} onChange={setFilter} placeholder="Filter actions" className="w-56" />
            <Select value={scope} onChange={(e) => setScope(e.target.value as 'this' | 'all')} className="w-36 h-7 text-xs">
              <option value="this">This server</option>
              <option value="all">All servers</option>
            </Select>
            <Select value={okFilter} onChange={(e) => setOkFilter(e.target.value as 'all' | 'ok' | 'failed')} className="w-28 h-7 text-xs">
              <option value="all">All results</option>
              <option value="ok">Succeeded</option>
              <option value="failed">Failed</option>
            </Select>
            <Button icon={<RefreshCw size={13} />} onClick={() => reload()} title="Refresh" />
            <Button icon={<Download size={13} />} onClick={exportJson} disabled={!rows.length}>
              Export JSON
            </Button>
            <Button variant="danger" icon={<Trash2 size={13} />} onClick={clear} loading={busy} disabled={!data?.length}>
              Clear
            </Button>
          </>
        }
      />
      <Page>
        {error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Loading />
        ) : !data?.length ? (
          <Card>
            <EmptyState icon={<History />} title="No activity yet" description="Every change Central Server makes on a server (installs, service restarts, firewall rules, commands you run…) is recorded here, locally on this computer." />
          </Card>
        ) : (
          <Card flush>
            <Table<AuditEntry>
              rows={rows}
              rowKey={(e) => e.id}
              dense
              empty="No entries match the filter"
              columns={[
                { key: 'ts', header: 'Time', width: '150px', mono: true, render: (e) => <span className="text-muted">{fmtDate(e.ts)}</span>, sortValue: (e) => e.ts },
                { key: 'server', header: 'Server', width: '160px', render: (e) => <span className="truncate block max-w-[150px]">{serverName(e)}</span>, sortValue: (e) => serverName(e) },
                { key: 'action', header: 'Action', width: '170px', mono: true, render: (e) => <Badge color="accent">{e.action}</Badge>, sortValue: (e) => e.action },
                { key: 'detail', header: 'Detail', render: (e) => <span className="font-mono text-xs text-muted break-all">{e.detail ?? ''}</span> },
                { key: 'ok', header: 'Result', width: '90px', align: 'right', render: (e) => (e.ok ? <Badge color="ok">ok</Badge> : <Badge color="danger">failed</Badge>), sortValue: (e) => (e.ok ? 1 : 0) }
              ]}
              initialSort={{ key: 'ts', dir: 'desc' }}
            />
          </Card>
        )}
      </Page>
    </>
  )
}
