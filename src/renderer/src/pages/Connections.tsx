import React, { useMemo, useState } from 'react'
import { Download, FolderKey, KeyRound, MoreHorizontal, Pencil, Plus, Server, Trash2, Upload, Wifi, Copy } from 'lucide-react'
import { useApp } from '@/store/app'
import { Badge, Button, Callout, Checkbox, ContextMenu, Dot, EmptyState, Field, Input, Modal, SearchInput, Select, confirm, useAction } from '@/components/ui'
import { api } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import type { ServerProfile, ServerProfileInput, OsInfo } from '@shared/types'

export default function Connections(): React.JSX.Element {
  const { servers, connections, connect, refreshServers, openTab } = useApp()
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<ServerProfile | null | 'new'>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; s: ServerProfile } | null>(null)
  const { run } = useAction()

  const filtered = useMemo(() => {
    const f = filter.toLowerCase()
    return servers.filter((s) => !f || s.name.toLowerCase().includes(f) || s.host.includes(f) || (s.group ?? '').toLowerCase().includes(f))
  }, [servers, filter])
  const groups = useMemo(() => {
    const m = new Map<string, ServerProfile[]>()
    for (const s of filtered) {
      const g = s.group?.trim() || ''
      m.set(g, [...(m.get(g) ?? []), s])
    }
    return [...m.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [filtered])

  const remove = async (s: ServerProfile): Promise<void> => {
    if (!(await confirm({ title: 'Remove server', message: <>Remove <b>{s.name}</b> from this app? The server itself is not touched.</>, danger: true, confirmLabel: 'Remove' }))) return
    await run(() => api.call('servers:delete', s.id))
    useApp.getState().closeTab(s.id)
    await refreshServers()
  }
  const duplicate = async (s: ServerProfile): Promise<void> => {
    const { id: _id, createdAt: _c, lastConnectedAt: _l, ...rest } = s
    await run(() => api.global('servers:save', { ...rest, name: s.name + ' (copy)' }))
    await refreshServers()
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between px-6 h-14 shrink-0">
        <h1 className="text-[15px] font-semibold flex items-center gap-2">
          <Server size={16} /> Servers
        </h1>
        <div className="flex items-center gap-2">
          <SearchInput value={filter} onChange={setFilter} placeholder="Search servers" className="w-56" />
          <Button icon={<Upload size={13} />} onClick={() => run(() => api.global<number>('servers:import').then(async (n) => { if (n) await refreshServers() }), { success: 'Imported' })} title="Import servers.json (no passwords)">
            Import
          </Button>
          <Button icon={<Download size={13} />} onClick={() => run(() => api.global('servers:export'))} title="Export profiles without secrets">
            Export
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
            Add server
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-6 pb-6">
        {servers.length === 0 ? (
          <div className="bg-panel border border-border rounded-lg">
            <EmptyState
              icon={<Server />}
              title="No servers yet"
              description="Add a Linux server reachable over SSH. Nothing is installed on the server: every feature works through plain SSH commands, so it runs on Ubuntu, Debian, RHEL, Rocky, Alma, Fedora, openSUSE, Alpine and Arch."
              action={
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
                  Add your first server
                </Button>
              }
            />
          </div>
        ) : (
          groups.map(([group, list]) => (
            <div key={group} className="mb-6">
              {group && <div className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-2">{group}</div>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {list.map((s) => {
                  const st = connections[s.id]?.status ?? 'disconnected'
                  const os = connections[s.id]?.os
                  return (
                    <div
                      key={s.id}
                      onDoubleClick={() => (st === 'connected' ? openTab(s.id) : connect(s.id))}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, s })
                      }}
                      className="bg-panel border border-border rounded-lg p-4 hover:border-border-2 transition-colors group"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0" style={{ background: (s.color ?? '#3b82f6') + '26', color: s.color ?? '#3b82f6' }}>
                          <Server size={18} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Dot status={st === 'connected' ? 'ok' : st === 'connecting' || st === 'reconnecting' ? 'warn' : st === 'error' ? 'danger' : 'muted'} />
                            <div className="font-semibold truncate">{s.name}</div>
                          </div>
                          <div className="text-xs text-muted font-mono truncate mt-0.5">
                            {s.username}@{s.host}
                            {s.port !== 22 ? `:${s.port}` : ''}
                          </div>
                          <div className="text-[11px] text-dim truncate mt-0.5">{os?.prettyName ?? (s.lastConnectedAt ? `Last connected ${fmtDate(s.lastConnectedAt)}` : 'Never connected')}</div>
                        </div>
                        <button onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, s })} className="text-dim hover:text-text opacity-0 group-hover:opacity-100">
                          <MoreHorizontal size={16} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-3">
                        <Badge>{s.auth === 'key' ? 'SSH key' : s.auth === 'agent' ? 'Agent' : 'Password'}</Badge>
                        {s.jumpHostId && <Badge color="info">via jump host</Badge>}
                        <div className="flex-1" />
                        {st === 'connected' ? (
                          <Button size="xs" onClick={() => openTab(s.id)}>
                            Open
                          </Button>
                        ) : (
                          <Button size="xs" variant="primary" icon={<Wifi size={11} />} loading={st === 'connecting' || st === 'reconnecting'} onClick={() => connect(s.id)}>
                            Connect
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Connect', icon: <Wifi />, onClick: () => connect(menu.s.id) },
            { label: 'Edit', icon: <Pencil />, onClick: () => setEditing(menu.s) },
            { label: 'Duplicate', icon: <Copy />, onClick: () => duplicate(menu.s) },
            { separator: true, label: '' },
            { label: 'Remove', icon: <Trash2 />, danger: true, onClick: () => remove(menu.s) }
          ]}
        />
      )}
      {editing && <ServerForm server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16']

function ServerForm({ server, onClose }: { server: ServerProfile | null; onClose: () => void }): React.JSX.Element {
  const { servers, refreshServers, connect } = useApp()
  const [f, setF] = useState<ServerProfileInput>(
    server
      ? { ...server, password: undefined, passphrase: undefined, sudoPassword: undefined, totpSecret: undefined }
      : { name: '', host: '', port: 22, username: 'root', auth: 'password', sudoMode: 'same', color: COLORS[0], group: '', privateKeyPath: '', password: '', passphrase: '', sudoPassword: '', totpSecret: '' }
  )
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; os?: OsInfo; sudoOk?: boolean; error?: string; code?: string } | null>(null)
  const [connectAfter, setConnectAfter] = useState(!server)
  const { run, busy } = useAction()
  const set = <K extends keyof ServerProfileInput>(k: K, v: ServerProfileInput[K]): void => setF((d) => ({ ...d, [k]: v }))
  const valid = f.name.trim() && f.host.trim() && f.username.trim() && (f.auth !== 'key' || f.privateKeyPath)

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.global('servers:test', f))
    } catch (e) {
      setTestResult({ ok: false, error: String(e) })
    } finally {
      setTesting(false)
    }
  }
  const save = async (): Promise<void> => {
    const saved = await run(() => api.global<ServerProfile>('servers:save', { ...f, name: f.name.trim(), host: f.host.trim(), username: f.username.trim(), port: Number(f.port) || 22 }))
    if (!saved) return
    await refreshServers()
    onClose()
    if (connectAfter) void connect(saved.id)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={server ? 'Edit server' : 'Add server'}
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={test} loading={testing} disabled={!valid}>
            Test connection
          </Button>
          <div className="flex-1" />
          <Checkbox checked={connectAfter} onChange={setConnectAfter} label="Connect after saving" className="mr-2" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!valid}>
            {server ? 'Save' : 'Add server'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-4">
        <Field label="Name" className="col-span-3">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Production web" autoFocus />
        </Field>
        <Field label="Group" className="col-span-2">
          <Input value={f.group ?? ''} onChange={(e) => set('group', e.target.value)} placeholder="optional" list="sm-groups" />
          <datalist id="sm-groups">{[...new Set(servers.map((s) => s.group).filter(Boolean))].map((g) => <option key={g} value={g} />)}</datalist>
        </Field>
        <Field label="Color" className="col-span-1">
          <div className="flex flex-wrap gap-1.5 pt-1">
            {COLORS.map((c) => (
              <button key={c} onClick={() => set('color', c)} className="w-5 h-5 rounded-full border-2" style={{ background: c, borderColor: f.color === c ? 'var(--color-text)' : 'transparent' }} />
            ))}
          </div>
        </Field>
        <Field label="Host or IP" className="col-span-3">
          <Input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.10 or server.example.com" mono />
        </Field>
        <Field label="Port" className="col-span-1">
          <Input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} mono />
        </Field>
        <Field label="Username" className="col-span-2">
          <Input value={f.username} onChange={(e) => set('username', e.target.value)} mono />
        </Field>
        <Field label="Authentication" className="col-span-2">
          <Select value={f.auth} onChange={(e) => set('auth', e.target.value as ServerProfileInput['auth'])}>
            <option value="password">Password</option>
            <option value="key">Private key file</option>
            <option value="agent">SSH agent</option>
          </Select>
        </Field>
        {f.auth === 'password' && (
          <Field label={server?.hasPassword ? 'Password (leave blank to keep)' : 'Password'} className="col-span-4">
            <Input type="password" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} autoComplete="off" />
          </Field>
        )}
        {f.auth === 'key' && (
          <>
            <Field label="Private key file" className="col-span-3">
              <div className="flex gap-2">
                <Input value={f.privateKeyPath ?? ''} onChange={(e) => set('privateKeyPath', e.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" mono />
                <Button icon={<FolderKey size={13} />} onClick={() => api.global<string | null>('servers:pickKeyFile').then((p) => p && set('privateKeyPath', p))}>
                  Browse
                </Button>
              </div>
            </Field>
            <Field label={server?.hasPassphrase ? 'Passphrase (blank = keep)' : 'Passphrase'} className="col-span-1">
              <Input type="password" value={f.passphrase ?? ''} onChange={(e) => set('passphrase', e.target.value)} autoComplete="off" />
            </Field>
          </>
        )}
        {f.auth === 'agent' && (
          <div className="col-span-4">
            <Callout>Uses the OpenSSH agent (Windows: the <code>ssh-agent</code> service; macOS/Linux: <code>SSH_AUTH_SOCK</code>). Load your key with <code>ssh-add</code> first.</Callout>
          </div>
        )}
        <Field label="Admin (sudo) password" className="col-span-3" hint="Needed for installs, services, firewall and other root tasks when the login user is not root.">
          <Select value={f.sudoMode} onChange={(e) => set('sudoMode', e.target.value as ServerProfileInput['sudoMode'])}>
            <option value="same">Same as the login password</option>
            <option value="separate">Different sudo password</option>
            <option value="none">No sudo (passwordless sudo or root login)</option>
          </Select>
        </Field>
        {f.sudoMode === 'separate' && (
          <Field label={server?.hasSudoPassword ? 'Sudo password (blank = keep)' : 'Sudo password'} className="col-span-3">
            <Input type="password" value={f.sudoPassword ?? ''} onChange={(e) => set('sudoPassword', e.target.value)} autoComplete="off" />
          </Field>
        )}
        <Field label="Jump host (bastion)" className={f.sudoMode === 'separate' ? 'col-span-6' : 'col-span-3'}>
          <Select value={f.jumpHostId ?? ''} onChange={(e) => set('jumpHostId', e.target.value || undefined)}>
            <option value="">None (direct connection)</option>
            {servers
              .filter((s) => s.id !== server?.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.host})
                </option>
              ))}
          </Select>
        </Field>
        <Field
          label={server?.hasTotpSecret ? '2FA / TOTP secret (blank = keep)' : '2FA / TOTP secret (optional)'}
          className="col-span-6"
          hint="If SSH asks for a Google Authenticator verification code, paste the account's base32 secret here and the app answers the prompt itself. Leave empty to be asked for the code at each login."
        >
          <Input type="password" value={f.totpSecret ?? ''} onChange={(e) => set('totpSecret', e.target.value)} autoComplete="off" mono placeholder="JBSWY3DPEHPK3PXP" />
        </Field>
        <Field label="Notes" className="col-span-6">
          <Input value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} placeholder="optional" />
        </Field>
      </div>
      {testResult && (
        <div className="mt-4">
          {testResult.ok ? (
            <Callout>
              <b className="text-ok-fg">Connected.</b> {testResult.os?.prettyName} · kernel {testResult.os?.kernel} · {testResult.os?.arch} · package manager {testResult.os?.pkgManager}
              {testResult.os?.isRoot ? ' · logged in as root' : testResult.sudoOk ? ' · sudo works' : <span className="text-warn-fg"> · sudo password not accepted (root features will fail)</span>}
            </Callout>
          ) : (
            <Callout kind="danger">
              <b>Connection failed{testResult.code ? ` (${testResult.code})` : ''}.</b> {testResult.error}
            </Callout>
          )}
        </div>
      )}
      <div className="mt-4 text-[11px] text-dim flex items-center gap-1.5">
        <KeyRound size={12} /> Passwords are encrypted with the operating system's credential store (DPAPI on Windows, Keychain on macOS) and never leave this computer.
      </div>
    </Modal>
  )
}
