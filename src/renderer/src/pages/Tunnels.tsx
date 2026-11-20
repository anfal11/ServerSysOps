import React, { useState } from 'react'
import { Cable, Copy, ExternalLink, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Callout, Card, Checkbox, Dot, EmptyState, ErrorBox, Field, Input, Loading, Modal, Page, PageHeader, Select, Table, Toggle, confirm, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { fmtBytes } from '@/lib/format'
import type { TunnelCreate, TunnelInfo } from '@shared/modules/tunnels'

const PRESETS: { id: string; label: string; port: number; name: string; web?: boolean }[] = [
  { id: 'mysql', label: 'Database · MySQL / MariaDB (3306)', port: 3306, name: 'MySQL' },
  { id: 'pg', label: 'Database · PostgreSQL (5432)', port: 5432, name: 'PostgreSQL' },
  { id: 'mongo', label: 'Database · MongoDB (27017)', port: 27017, name: 'MongoDB' },
  { id: 'web3000', label: 'Web app · port 3000', port: 3000, name: 'Web app :3000', web: true },
  { id: 'web8080', label: 'Web app · port 8080', port: 8080, name: 'Web app :8080', web: true },
  { id: 'redis', label: 'Redis (6379)', port: 6379, name: 'Redis' },
  { id: 'custom', label: 'Custom', port: 0, name: '' }
]

export default function Tunnels({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<TunnelInfo[]>('tunnels:list', serverId), [serverId], { intervalMs: 3000 })
  const [creating, setCreating] = useState(false)
  const { run } = useAction()
  const toast = useApp((s) => s.toast)

  const act = async (fn: () => Promise<unknown>, success?: string): Promise<void> => {
    await run(fn, { success })
    await reload()
  }
  const copyAddr = (t: TunnelInfo): void => {
    void navigator.clipboard.writeText(`127.0.0.1:${t.localPort}`).then(() => toast({ kind: 'success', title: `Copied 127.0.0.1:${t.localPort}` }))
  }
  const remove = async (t: TunnelInfo): Promise<void> => {
    if (!(await confirm({ title: 'Delete tunnel', message: <>Delete tunnel <b>{t.name}</b> (127.0.0.1:{t.localPort} → {t.remoteHost}:{t.remotePort})?</>, danger: true, confirmLabel: 'Delete' }))) return
    await act(() => api.global('tunnels:delete', t.id), 'Tunnel deleted')
  }

  const list = data ?? []
  const up = list.filter((t) => t.status === 'up').length

  return (
    <>
      <PageHeader
        title="Tunnels"
        subtitle={list.length ? `${up} of ${list.length} active` : undefined}
        actions={
          <>
            <Button icon={<RefreshCw size={13} />} onClick={() => reload()} title="Refresh" />
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
              New tunnel
            </Button>
          </>
        }
      />
      <Page>
        <div className="mb-4">
          <Callout>
            <b className="text-text">Access databases and internal web apps on the server without opening ports.</b> A tunnel listens on your computer (127.0.0.1:<i>local port</i>) and forwards every connection through the existing SSH session to <i>remote host:port</i> as seen from the server. Point your database client or browser at the local address. Tunnels are tied to this SSH connection: they go down when it drops and come back automatically (auto-start) on reconnect.
            <div className="text-dim mt-1">Note: reverse tunnels (exposing a port of this computer on the server, <code className="font-mono">ssh -R</code>) are not supported in this version.</div>
          </Callout>
        </div>
        {error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Loading />
        ) : list.length === 0 ? (
          <Card>
            <EmptyState icon={<Cable />} title="No tunnels yet" description="Create a tunnel to reach MySQL, PostgreSQL, Redis, a dev server or any service that only listens on the server's localhost." action={<Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>New tunnel</Button>} />
          </Card>
        ) : (
          <Card flush>
            <Table<TunnelInfo>
              rows={list}
              rowKey={(t) => t.id}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  render: (t) => (
                    <div className="flex items-center gap-2 min-w-0">
                      <Dot status={t.status === 'up' ? 'ok' : t.status === 'starting' ? 'warn' : t.status === 'error' ? 'danger' : 'muted'} />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{t.name}</div>
                        {t.error && <div className="text-[11px] text-danger-fg truncate" title={t.error}>{t.error}</div>}
                      </div>
                    </div>
                  ),
                  sortValue: (t) => t.name
                },
                {
                  key: 'route',
                  header: 'Local → remote',
                  mono: true,
                  render: (t) => (
                    <span>
                      <span className="text-text">{t.bindAll ? '0.0.0.0' : '127.0.0.1'}:{t.localPort || 'auto'}</span>
                      <span className="text-dim"> → </span>
                      <span className="text-muted">{t.remoteHost}:{t.remotePort}</span>
                    </span>
                  )
                },
                { key: 'status', header: 'Status', width: '90px', render: (t) => <Badge color={t.status === 'up' ? 'ok' : t.status === 'error' ? 'danger' : t.status === 'starting' ? 'warn' : 'muted'}>{t.status}</Badge> },
                { key: 'conn', header: 'Connections', width: '110px', align: 'right', mono: true, render: (t) => <span>{t.connections}<span className="text-dim"> / {t.totalConnections}</span></span>, sortValue: (t) => t.totalConnections },
                { key: 'traffic', header: 'Traffic in / out', width: '150px', align: 'right', mono: true, render: (t) => <span className="text-muted text-xs">{fmtBytes(t.bytesIn)} / {fmtBytes(t.bytesOut)}</span>, sortValue: (t) => t.bytesIn + t.bytesOut },
                { key: 'auto', header: 'Auto-start', width: '100px', align: 'center', render: (t) => <Toggle checked={t.autoStart} onChange={(v) => act(() => api.global('tunnels:setAutoStart', t.id, v))} /> },
                {
                  key: 'actions',
                  header: '',
                  width: '190px',
                  align: 'right',
                  render: (t) => (
                    <div className="flex items-center justify-end gap-1">
                      <Button size="xs" variant="ghost" icon={<ExternalLink size={12} />} title="Open http://127.0.0.1:port in the browser" disabled={t.status !== 'up'} onClick={() => api.openExternal(`http://127.0.0.1:${t.localPort}`)} />
                      <Button size="xs" variant="ghost" icon={<Copy size={12} />} title="Copy local address" onClick={() => copyAddr(t)} />
                      {t.status === 'up' || t.status === 'starting' ? (
                        <Button size="xs" variant="ghost" icon={<Square size={12} />} title="Stop" onClick={() => act(() => api.global('tunnels:close', t.id))} />
                      ) : (
                        <Button size="xs" variant="ghost" icon={<Play size={12} />} title="Start" onClick={() => act(() => api.global('tunnels:start', t.id), 'Tunnel started')} />
                      )}
                      <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} title="Delete" className="hover:text-danger-fg" onClick={() => remove(t)} />
                    </div>
                  )
                }
              ]}
            />
          </Card>
        )}
      </Page>
      {creating && (
        <NewTunnelModal
          serverId={serverId}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false)
            void reload()
            if (t.status === 'up') toast({ kind: 'success', title: `Tunnel ready on 127.0.0.1:${t.localPort}` })
            else toast({ kind: 'error', title: 'Tunnel could not start', detail: t.error })
          }}
        />
      )}
    </>
  )
}

function NewTunnelModal({ serverId, onClose, onCreated }: { serverId: string; onClose: () => void; onCreated: (t: TunnelInfo) => void }): React.JSX.Element {
  const [preset, setPreset] = useState('mysql')
  const [f, setF] = useState<TunnelCreate & { name: string }>({ name: 'MySQL', localPort: 3306, remoteHost: '127.0.0.1', remotePort: 3306, bindAll: false, autoStart: true })
  const { run, busy } = useAction()
  const applyPreset = (id: string): void => {
    setPreset(id)
    const p = PRESETS.find((x) => x.id === id)
    if (!p || p.id === 'custom') return
    setF((cur) => ({ ...cur, name: p.name, remotePort: p.port, localPort: p.port }))
  }
  const valid = f.remoteHost.trim() && Number(f.remotePort) >= 1 && Number(f.remotePort) <= 65535 && Number(f.localPort) >= 0 && Number(f.localPort) <= 65535
  const create = async (): Promise<void> => {
    const t = await run(() => api.call<TunnelInfo>('tunnels:create', serverId, { ...f, name: f.name.trim() || undefined, localPort: Number(f.localPort), remotePort: Number(f.remotePort), remoteHost: f.remoteHost.trim() }))
    if (t) onCreated(t)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="New tunnel"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={create}>
            Create & start
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Preset" className="col-span-2">
          <Select value={preset} onChange={(e) => applyPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" className="col-span-2">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Production DB" />
        </Field>
        <Field label="Remote host (as seen from the server)" hint="127.0.0.1 for a service on the server itself, or another host in its private network.">
          <Input value={f.remoteHost} onChange={(e) => setF({ ...f, remoteHost: e.target.value })} mono />
        </Field>
        <Field label="Remote port">
          <Input type="number" min={1} max={65535} value={f.remotePort} onChange={(e) => setF({ ...f, remotePort: Number(e.target.value) })} mono />
        </Field>
        <Field label="Local port" hint="0 = pick a free port automatically">
          <Input type="number" min={0} max={65535} value={f.localPort} onChange={(e) => setF({ ...f, localPort: Number(e.target.value) })} mono />
        </Field>
        <div className="flex flex-col gap-3 pt-6">
          <Checkbox checked={!!f.autoStart} onChange={(v) => setF({ ...f, autoStart: v })} label="Start automatically when the server connects" />
          <Checkbox checked={!!f.bindAll} onChange={(v) => setF({ ...f, bindAll: v })} label={<span>Listen on all interfaces <span className="text-dim">(0.0.0.0 — other devices on your LAN can use it)</span></span>} />
        </div>
      </div>
      {f.bindAll && (
        <div className="mt-4">
          <Callout kind="warn">Binding to 0.0.0.0 exposes the remote service to everyone on your local network without authentication of their own. Keep 127.0.0.1 unless you need this.</Callout>
        </div>
      )}
    </Modal>
  )
}
