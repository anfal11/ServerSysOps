import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, Eye, EyeOff, KeyRound, Lock, MoreHorizontal, Plus, RefreshCw, Shield, ShieldOff, Terminal, Trash2, Unlock, UserPlus, Users as UsersIcon, Wand2, XCircle } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Callout, Card, Checkbox, ContextMenu, EmptyState, ErrorBox, Field, Input, Loading, Modal, Page, PageHeader, SearchInput, Select, Table, Tabs, TextArea, Toggle, confirm, useAction, useAsync, type MenuItem } from '@/components/ui'
import { useApp } from '@/store/app'
import { cls } from '@/lib/format'
import type { CreateUserInput, GroupInfo, LastLoginsResult, SessionInfoEx, SshKeyInfo, UserInfoEx } from '@shared/modules/users'

type Tab = 'users' | 'sessions' | 'history'

const ADMIN_GROUPS = ['sudo', 'wheel', 'admin']

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function generatePassword(len = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*-_=+?'
  const buf = new Uint32Array(len)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => alphabet[n % alphabet.length]).join('')
}

function copyText(s: string): void {
  void navigator.clipboard?.writeText(s).then(
    () => useApp.getState().toast({ kind: 'success', title: 'Copied to clipboard' }),
    () => useApp.getState().toast({ kind: 'error', title: 'Could not copy' })
  )
}

function statusOf(u: UserInfoEx): { label: string; color: 'ok' | 'warn' | 'danger' | 'info' | 'muted' } {
  if (u.accountExpired) return { label: 'Locked', color: 'danger' }
  if (u.keyOnly) return { label: 'Key-only', color: 'info' }
  if (u.locked && u.hasPassword) return { label: 'Locked', color: 'warn' }
  if (!u.hasPassword) return { label: 'No password', color: 'muted' }
  return { label: 'Active', color: 'ok' }
}

function PasswordInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }): React.JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" mono autoFocus={autoFocus} className="pr-8" />
        <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-text" title={show ? 'Hide' : 'Show'}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <Button type="button" icon={<Wand2 size={13} />} onClick={() => { onChange(generatePassword()); setShow(true) }} title="Generate a strong password">
        Generate
      </Button>
      <Button type="button" icon={<Copy size={13} />} onClick={() => value && copyText(value)} disabled={!value} title="Copy" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Users({ serverId }: PageProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('users')
  const [includeSystem, setIncludeSystem] = useState(false)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; u: UserInfoEx } | null>(null)
  const [modal, setModal] = useState<{ kind: 'keys' | 'groups' | 'password' | 'shell' | 'delete'; u: UserInfoEx } | null>(null)
  const { run } = useAction()
  const users = useAsync(() => api.call<UserInfoEx[]>('users:list', serverId, { includeSystem }), [serverId, includeSystem])
  const sessions = useAsync(() => api.call<SessionInfoEx[]>('users:sessions', serverId), [serverId], { intervalMs: 10000, enabled: tab === 'sessions' })
  const history = useAsync(() => api.call<LastLoginsResult>('users:lastLogins', serverId, 200), [serverId], { enabled: tab === 'history' })

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = users.data ?? []
    if (!f) return list
    return list.filter((u) => u.name.toLowerCase().includes(f) || (u.fullName ?? '').toLowerCase().includes(f) || u.groups.some((g) => g.toLowerCase().includes(f)) || u.shell.includes(f) || String(u.uid) === f)
  }, [users.data, filter])

  const act = async (fn: () => Promise<unknown>, success?: string): Promise<void> => {
    await run(fn, { success })
    await users.reload()
  }

  const toggleAdmin = async (u: UserInfoEx): Promise<void> => {
    if (u.isAdmin) {
      if (!(await confirm({ title: 'Revoke admin rights', message: <>Remove <b>{u.name}</b> from the admin group and delete its ServerMate sudoers entry?</>, danger: true, confirmLabel: 'Revoke' }))) return
      await act(() => api.call('users:setAdmin', serverId, u.name, false), `${u.name} is no longer an administrator`)
    } else {
      if (!(await confirm({ title: 'Grant admin rights', message: <>Add <b>{u.name}</b> to the sudo/wheel group? The user will be able to run any command as root.</>, confirmLabel: 'Grant' }))) return
      await act(() => api.call('users:setAdmin', serverId, u.name, true), `${u.name} is now an administrator`)
    }
  }

  const toggleLock = async (u: UserInfoEx): Promise<void> => {
    const locked = u.accountExpired || (u.locked && !u.keyOnly)
    if (locked) {
      await act(() => api.call('users:unlock', serverId, u.name), `${u.name} unlocked`)
      return
    }
    let terminate = false
    const ok = await confirm({
      title: `Lock ${u.name}`,
      message: (
        <LockMessage name={u.name} onTerminate={(v) => (terminate = v)} />
      ),
      danger: true,
      confirmLabel: 'Lock'
    })
    if (!ok) return
    await act(() => api.call('users:lock', serverId, u.name, { terminateSessions: terminate }), `${u.name} locked`)
  }

  const toggleKeyOnly = async (u: UserInfoEx): Promise<void> => {
    if (u.keyOnly) {
      await act(() => api.call('users:keyOnly', serverId, u.name, false), `Password login re-enabled for ${u.name}`)
      return
    }
    const ok = await confirm({
      title: 'Key-only login',
      message: (
        <div className="space-y-2">
          <p>
            Disable password login for <b>{u.name}</b>: the password is locked and an sshd <code>Match User</code> block turns off <code>PasswordAuthentication</code> for this account. Only SSH keys will work.
          </p>
          {u.sshKeys === 0 && (
            <Callout kind="danger">
              <b>{u.name} has no SSH keys.</b> Add a key first, otherwise this account cannot log in at all.
            </Callout>
          )}
          {u.self && <Callout kind="warn">This is the account ServerMate uses. If this profile logs in with a password, the change is refused to avoid locking you out.</Callout>}
        </div>
      ),
      confirmLabel: 'Disable password login',
      danger: true
    })
    if (!ok) return
    await act(() => api.call('users:keyOnly', serverId, u.name, true), `${u.name} is now key-only`)
  }

  const menuItems = (u: UserInfoEx): MenuItem[] => {
    const locked = u.accountExpired || (u.locked && !u.keyOnly)
    return [
      { label: 'SSH keys…', icon: <KeyRound />, onClick: () => setModal({ kind: 'keys', u }) },
      { label: 'Edit groups…', icon: <UsersIcon />, onClick: () => setModal({ kind: 'groups', u }) },
      { label: 'Set password…', icon: <Lock />, onClick: () => setModal({ kind: 'password', u }) },
      { label: 'Change shell…', icon: <Terminal />, onClick: () => setModal({ kind: 'shell', u }) },
      { separator: true, label: '' },
      { label: u.isAdmin ? 'Revoke admin rights' : 'Grant admin rights', icon: u.isAdmin ? <ShieldOff /> : <Shield />, onClick: () => void toggleAdmin(u), disabled: u.name === 'root' || (u.isAdmin && u.self) },
      { label: u.keyOnly ? 'Allow password login' : 'Key-only login', icon: <KeyRound />, onClick: () => void toggleKeyOnly(u) },
      { label: locked ? 'Unlock account' : 'Lock account', icon: locked ? <Unlock /> : <Lock />, onClick: () => void toggleLock(u), disabled: !locked && u.self },
      { separator: true, label: '' },
      { label: 'Delete user…', icon: <Trash2 />, danger: true, onClick: () => setModal({ kind: 'delete', u }), disabled: u.name === 'root' || u.self }
    ]
  }

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={users.data ? `${users.data.filter((u) => !u.system).length} accounts · ${users.data.filter((u) => u.isAdmin).length} admins` : undefined}
        actions={
          <>
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'users', label: 'Users' },
                { id: 'sessions', label: 'Sessions', count: sessions.data?.length },
                { id: 'history', label: 'Login history' }
              ]}
            />
            {tab === 'users' && (
              <>
                <Toggle checked={includeSystem} onChange={setIncludeSystem} label="Show system users" />
                <Button variant="primary" icon={<UserPlus size={14} />} onClick={() => setCreating(true)}>
                  Create user
                </Button>
              </>
            )}
          </>
        }
      />
      <Page>
        {tab === 'users' && (
          <>
            <div className="flex items-center gap-2 mb-3">
              <SearchInput value={filter} onChange={setFilter} placeholder="Filter by name, group, shell" className="w-64" />
              <div className="flex-1" />
              <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void users.reload()}>
                Refresh
              </Button>
            </div>
            {users.error ? (
              <ErrorBox error={users.error} onRetry={users.reload} />
            ) : users.loading && !users.data ? (
              <Loading />
            ) : (
              <Card flush>
                <Table<UserInfoEx>
                  rows={filtered}
                  rowKey={(u) => u.name}
                  onRowContextMenu={(u, e) => setMenu({ x: e.clientX, y: e.clientY, u })}
                  empty={filter ? 'No users match the filter' : 'No users'}
                  columns={[
                    {
                      key: 'name',
                      header: 'Name',
                      sortValue: (u) => u.name,
                      render: (u) => (
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{u.name}</span>
                          {u.self && <Badge color="accent">you</Badge>}
                          {u.fullName && <span className="text-dim text-xs truncate max-w-[180px]">{u.fullName}</span>}
                        </div>
                      )
                    },
                    { key: 'uid', header: 'UID', mono: true, width: '70px', sortValue: (u) => u.uid, render: (u) => u.uid },
                    { key: 'home', header: 'Home', mono: true, render: (u) => <span className="text-muted">{u.home}</span> },
                    { key: 'shell', header: 'Shell', mono: true, render: (u) => <span className={cls(/nologin|false$/.test(u.shell) && 'text-dim')}>{u.shell}</span> },
                    {
                      key: 'groups',
                      header: 'Groups',
                      render: (u) => (
                        <div className="flex flex-wrap gap-1 max-w-[320px]">
                          {u.groups.slice(0, 6).map((g) => (
                            <Badge key={g} color={ADMIN_GROUPS.includes(g) ? 'warn' : 'muted'}>
                              {g}
                            </Badge>
                          ))}
                          {u.groups.length > 6 && <Badge>+{u.groups.length - 6}</Badge>}
                        </div>
                      )
                    },
                    {
                      key: 'admin',
                      header: 'Admin',
                      width: '90px',
                      sortValue: (u) => (u.isAdmin ? 1 : 0),
                      render: (u) => (u.isAdmin ? <Badge color="warn">{u.sudoers && !u.groups.some((g) => ADMIN_GROUPS.includes(g)) ? 'sudoers' : 'Admin'}</Badge> : <span className="text-dim">—</span>)
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      width: '110px',
                      sortValue: (u) => statusOf(u).label,
                      render: (u) => {
                        const s = statusOf(u)
                        return <Badge color={s.color}>{s.label}</Badge>
                      }
                    },
                    { key: 'last', header: 'Last login', sortValue: (u) => u.lastLogin ?? '', render: (u) => <span className="text-muted text-xs">{u.lastLogin ?? 'Never'}</span> },
                    {
                      key: 'keys',
                      header: 'SSH keys',
                      width: '80px',
                      align: 'center',
                      sortValue: (u) => u.sshKeys,
                      render: (u) => (
                        <button className={cls('inline-flex items-center gap-1 hover:text-accent', u.sshKeys ? '' : 'text-dim')} onClick={() => setModal({ kind: 'keys', u })} title="Manage SSH keys">
                          <KeyRound size={12} /> {u.sshKeys}
                        </button>
                      )
                    },
                    {
                      key: 'menu',
                      header: '',
                      width: '40px',
                      render: (u) => (
                        <button onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, u })} className="text-dim hover:text-text p-1" title="Actions">
                          <MoreHorizontal size={15} />
                        </button>
                      )
                    }
                  ]}
                />
              </Card>
            )}
          </>
        )}

        {tab === 'sessions' && <SessionsTab serverId={serverId} data={sessions.data} error={sessions.error} loading={sessions.loading} reload={sessions.reload} />}
        {tab === 'history' && <HistoryTab serverId={serverId} data={history.data} error={history.error} loading={history.loading} reload={history.reload} />}
      </Page>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.u)} onClose={() => setMenu(null)} />}
      {creating && <CreateUserModal serverId={serverId} onClose={() => setCreating(false)} onDone={() => void users.reload()} />}
      {modal?.kind === 'keys' && <KeysModal serverId={serverId} user={modal.u} onClose={() => setModal(null)} onChanged={() => void users.reload()} />}
      {modal?.kind === 'groups' && <GroupsModal serverId={serverId} user={modal.u} onClose={() => setModal(null)} onDone={() => void users.reload()} />}
      {modal?.kind === 'password' && <PasswordModal serverId={serverId} user={modal.u} onClose={() => setModal(null)} onDone={() => void users.reload()} />}
      {modal?.kind === 'shell' && <ShellModal serverId={serverId} user={modal.u} onClose={() => setModal(null)} onDone={() => void users.reload()} />}
      {modal?.kind === 'delete' && <DeleteModal serverId={serverId} user={modal.u} onClose={() => setModal(null)} onDone={() => void users.reload()} />}
    </>
  )
}

function LockMessage({ name, onTerminate }: { name: string; onTerminate: (v: boolean) => void }): React.JSX.Element {
  const [t, setT] = useState(false)
  return (
    <div className="space-y-3">
      <p>
        Lock <b>{name}</b>: the password is disabled and the account is set to expired, so neither password nor key logins work until it is unlocked.
      </p>
      <Callout kind="warn">Locking does not end sessions that are already open.</Callout>
      <Checkbox
        checked={t}
        onChange={(v) => {
          setT(v)
          onTerminate(v)
        }}
        label={
          <>
            Also terminate all running processes of {name} (<code>pkill -KILL -u {name}</code>)
          </>
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sessions tab                                                        */
/* ------------------------------------------------------------------ */

function SessionsTab({ serverId, data, error, loading, reload }: { serverId: string; data?: SessionInfoEx[]; error: unknown; loading: boolean; reload: () => Promise<void> }): React.JSX.Element {
  const { run } = useAction()
  const kill = async (s: SessionInfoEx): Promise<void> => {
    const ok = await confirm({
      title: 'Terminate session',
      message: (
        <>
          Kill every process on <b>{s.tty}</b> ({s.user} from {s.from})?{s.self && <Callout kind="danger">This looks like the session of this app; you may disconnect yourself.</Callout>}
        </>
      ),
      danger: true,
      confirmLabel: 'Terminate'
    })
    if (!ok) return
    await run(() => api.call('users:killSession', serverId, { tty: s.tty }), { success: `Session ${s.tty} terminated` })
    await reload()
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading && !data) return <Loading />
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-muted">Logged-in users from <code>who -u</code>. Refreshes every 10 s.</div>
        <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
      <Card flush>
        <Table<SessionInfoEx>
          rows={data ?? []}
          rowKey={(s) => `${s.tty}-${s.pid ?? ''}`}
          empty="No interactive sessions"
          columns={[
            { key: 'user', header: 'User', render: (s) => <span className="font-medium">{s.user}{s.self && <Badge color="accent" className="ml-2">this app</Badge>}</span> },
            { key: 'tty', header: 'TTY', mono: true, render: (s) => s.tty },
            { key: 'from', header: 'From', mono: true, render: (s) => s.from },
            { key: 'since', header: 'Since', mono: true, render: (s) => s.since },
            { key: 'idle', header: 'Idle', render: (s) => <span className={cls(s.idle === 'active' && 'text-green-300')}>{s.idle ?? '—'}</span> },
            { key: 'what', header: 'What', mono: true, render: (s) => <span className="text-muted truncate block max-w-[280px]">{s.what ?? ''}</span> },
            { key: 'pid', header: 'PID', mono: true, width: '70px', render: (s) => s.pid ?? '' },
            { key: 'act', header: '', width: '110px', align: 'right', render: (s) => <Button size="xs" variant="danger" icon={<XCircle size={11} />} onClick={() => void kill(s)}>Terminate</Button> }
          ]}
        />
      </Card>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* History tab                                                         */
/* ------------------------------------------------------------------ */

function HistoryTab({ serverId, data, error, loading, reload }: { serverId: string; data?: LastLoginsResult; error: unknown; loading: boolean; reload: () => Promise<void> }): React.JSX.Element {
  const setPage = useApp((s) => s.setPage)
  const [showFailed, setShowFailed] = useState(false)
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading && !data) return <Loading />
  const d = data ?? { entries: [], failedRecent: [] }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Callout kind={d.failedCount && d.failedCount > 50 ? 'warn' : 'info'}>
          <div className="flex items-center gap-3">
            <AlertTriangle size={14} className="shrink-0" />
            <span>
              <b>{d.failedCount === undefined ? 'Unknown number of' : d.failedCount}</b> failed login attempts recorded{d.wtmpSince ? ` (history since ${d.wtmpSince})` : ''}.
              {d.failedCount === undefined ? ' /var/log/btmp is not readable without root.' : ''} Brute-force attempts are normal on public servers; set up <b>Fail2ban</b> in Overview to ban offending IPs automatically.
            </span>
            <Button size="xs" onClick={() => setPage(serverId, 'overview')}>
              Open Overview
            </Button>
            {d.failedRecent.length > 0 && (
              <Button size="xs" variant="ghost" onClick={() => setShowFailed((v) => !v)}>
                {showFailed ? 'Hide' : 'Show'} recent failures
              </Button>
            )}
          </div>
        </Callout>
        <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
      {showFailed && (
        <Card title="Recent failed logins" flush>
          <Table
            rows={d.failedRecent}
            rowKey={(e) => `${e.user}-${e.from}-${e.start}`}
            dense
            columns={[
              { key: 'user', header: 'User', mono: true, render: (e) => e.user },
              { key: 'from', header: 'From', mono: true, render: (e) => e.from },
              { key: 'tty', header: 'TTY', mono: true, render: (e) => e.tty },
              { key: 'start', header: 'When', mono: true, render: (e) => e.start }
            ]}
          />
        </Card>
      )}
      <Card title={`Last logins (${d.entries.length})`} flush>
        <Table
          rows={d.entries}
          rowKey={(e) => `${e.user}-${e.tty}-${e.start}-${e.from}`}
          dense
          columns={[
            { key: 'user', header: 'User', sortValue: (e) => e.user, render: (e) => <span className="font-medium">{e.user}</span> },
            { key: 'tty', header: 'TTY', mono: true, render: (e) => e.tty },
            { key: 'from', header: 'From', mono: true, render: (e) => e.from || <span className="text-dim">local</span> },
            { key: 'start', header: 'Login', mono: true, render: (e) => e.start },
            { key: 'end', header: 'Logout', mono: true, render: (e) => (e.stillLoggedIn ? <Badge color="ok">still logged in</Badge> : <span className="text-muted">{e.end ?? '—'}</span>) },
            { key: 'dur', header: 'Duration', mono: true, render: (e) => <span className="text-muted">{e.duration ?? ''}</span> }
          ]}
        />
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Create user                                                         */
/* ------------------------------------------------------------------ */

function CreateUserModal({ serverId, onClose, onDone }: { serverId: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const shells = useAsync(() => api.call<string[]>('users:shells', serverId), [serverId])
  const [f, setF] = useState<CreateUserInput>({ name: '', password: '', fullName: '', shell: '/bin/bash', sudo: false, createHome: true, sshKey: '', passwordlessSudo: false, expirePassword: false })
  const { run, busy } = useAction()
  const set = <K extends keyof CreateUserInput>(k: K, v: CreateUserInput[K]): void => setF((d) => ({ ...d, [k]: v }))
  const nameOk = /^[a-z_][a-z0-9_-]{0,31}$/.test(f.name)
  const valid = nameOk && (f.password || f.sshKey?.trim())
  useEffect(() => {
    if (shells.data && !shells.data.includes(f.shell)) set('shell', shells.data.find((s) => /bash$/.test(s)) ?? shells.data[0] ?? '/bin/sh')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shells.data])

  const submit = async (): Promise<void> => {
    const r = await run(() => api.call<{ name: string; notes: string[] }>('users:create', serverId, { ...f, password: f.password || undefined, fullName: f.fullName || undefined, sshKey: f.sshKey?.trim() || undefined }), { success: `User ${f.name} created` })
    if (!r) return
    for (const n of r.notes) useApp.getState().toast({ kind: 'info', title: `${f.name}: ${n}` })
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create user"
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!valid}>
            Create user
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-4">
        <Field label="Username" className="col-span-3" hint={f.name && !nameOk ? <span className="text-amber-300">1-32 chars: lowercase letters, digits, "_" or "-"; start with a letter or "_"</span> : 'Lowercase, e.g. deploy'}>
          <Input value={f.name} onChange={(e) => set('name', e.target.value.trim())} mono autoFocus placeholder="deploy" />
        </Field>
        <Field label="Full name (optional)" className="col-span-3">
          <Input value={f.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} placeholder="Deploy bot" />
        </Field>
        <Field label="Password" className="col-span-6" hint="Leave empty for a key-only account (the password stays locked until one is set).">
          <PasswordInput value={f.password ?? ''} onChange={(v) => set('password', v)} />
        </Field>
        <Field label="Login shell" className="col-span-3">
          <Select value={f.shell} onChange={(e) => set('shell', e.target.value)}>
            {(shells.data ?? [f.shell]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <div className="col-span-3 flex flex-col gap-2 pt-5">
          <Checkbox checked={f.createHome} onChange={(v) => set('createHome', v)} label="Create home directory" />
          <Checkbox checked={f.expirePassword} onChange={(v) => set('expirePassword', v)} label="Require password change at first login" disabled={!f.password} />
        </div>
        <Field label="SSH public key (optional)" className="col-span-6" hint="Paste one or more lines from id_ed25519.pub / id_rsa.pub. Written to ~/.ssh/authorized_keys (700/600).">
          <TextArea value={f.sshKey ?? ''} onChange={(e) => set('sshKey', e.target.value)} rows={3} mono placeholder="ssh-ed25519 AAAA… user@laptop" />
        </Field>
        <div className="col-span-6 border border-border rounded-md p-3 space-y-2 bg-bg-2/40">
          <Checkbox checked={f.sudo} onChange={(v) => { set('sudo', v); if (!v) set('passwordlessSudo', false) }} label={<span className="flex items-center gap-2"><Shield size={13} /> Administrator (add to the sudo / wheel group)</span>} />
          <Checkbox checked={f.passwordlessSudo} onChange={(v) => set('passwordlessSudo', v)} disabled={!f.sudo} label={<>Passwordless sudo (<code>/etc/sudoers.d/servermate-{f.name || 'name'}</code>, validated with <code>visudo -cf</code>)</>} />
          {f.passwordlessSudo && <Callout kind="warn">Anyone holding this account's key or password gets root without a second factor. Recommended only for automation accounts with key-only login.</Callout>}
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* SSH keys                                                            */
/* ------------------------------------------------------------------ */

function KeysModal({ serverId, user, onClose, onChanged }: { serverId: string; user: UserInfoEx; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const keys = useAsync(() => api.call<SshKeyInfo[]>('users:keys', serverId, user.name), [serverId, user.name])
  const [text, setText] = useState('')
  const { run, busy } = useAction()
  const add = async (): Promise<void> => {
    const r = await run(() => api.call<{ added: number; skipped: number }>('users:addKey', serverId, user.name, text))
    if (!r) return
    useApp.getState().toast({ kind: r.added ? 'success' : 'info', title: r.added ? `${r.added} key(s) added` : 'Key already present', detail: r.skipped ? `${r.skipped} duplicate(s) skipped` : undefined })
    setText('')
    await keys.reload()
    onChanged()
  }
  const remove = async (k: SshKeyInfo): Promise<void> => {
    if (!(await confirm({ title: 'Remove SSH key', message: <>Remove key <code className="font-mono">{k.fingerprint}</code>{k.comment ? <> ({k.comment})</> : null} from <b>{user.name}</b>?</>, danger: true, confirmLabel: 'Remove' }))) return
    await run(() => api.call('users:removeKey', serverId, user.name, { line: k.line, fingerprint: k.fingerprint }), { success: 'Key removed' })
    await keys.reload()
    onChanged()
  }
  return (
    <Modal open onClose={onClose} title={`SSH keys of ${user.name}`} width="max-w-3xl" badge={user.keyOnly ? <Badge color="info">key-only</Badge> : undefined} footer={<Button onClick={onClose}>Close</Button>}>
      {keys.error ? (
        <ErrorBox error={keys.error} onRetry={keys.reload} />
      ) : keys.loading && !keys.data ? (
        <Loading />
      ) : (
        <Card flush className="mb-4">
          <Table<SshKeyInfo>
            rows={keys.data ?? []}
            rowKey={(k) => `${k.line}`}
            dense
            empty={<EmptyState icon={<KeyRound />} title="No keys" description={`${user.home}/.ssh/authorized_keys is empty or missing.`} />}
            columns={[
              { key: 'type', header: 'Type', width: '90px', render: (k) => <Badge color={k.type === 'invalid' ? 'danger' : 'muted'}>{k.type}{k.bits ? ` ${k.bits}` : ''}</Badge> },
              { key: 'fp', header: 'Fingerprint', mono: true, render: (k) => <span className="text-xs break-all">{k.fingerprint}</span> },
              { key: 'comment', header: 'Comment', render: (k) => <span className="text-muted">{k.comment || <span className="text-dim">—</span>}{k.options && <Badge className="ml-2" color="info" >options</Badge>}</span> },
              { key: 'act', header: '', width: '80px', align: 'right', render: (k) => <div className="flex gap-1 justify-end"><Button size="xs" variant="ghost" icon={<Copy size={11} />} title="Copy key" onClick={() => copyText(k.raw)} /><Button size="xs" variant="danger" icon={<Trash2 size={11} />} title="Remove" onClick={() => void remove(k)} /></div> }
            ]}
          />
        </Card>
      )}
      <Field label="Add key" hint="OpenSSH public key format. Validated on the server with ssh-keygen; duplicates are skipped.">
        <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={3} mono placeholder="ssh-ed25519 AAAA… user@laptop" />
      </Field>
      <div className="flex justify-end mt-2">
        <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={add} loading={busy} disabled={!text.trim()}>
          Add key
        </Button>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

function GroupsModal({ serverId, user, onClose, onDone }: { serverId: string; user: UserInfoEx; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const groups = useAsync(() => api.call<GroupInfo[]>('users:groups', serverId), [serverId])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(user.groups))
  const [filter, setFilter] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const { run, busy } = useAction()
  const primary = useMemo(() => groups.data?.find((g) => g.gid === user.gid)?.name, [groups.data, user.gid])
  const visible = useMemo(() => {
    const f = filter.toLowerCase()
    return (groups.data ?? []).filter((g) => (showSystem || !g.system || selected.has(g.name) || ADMIN_GROUPS.includes(g.name) || ['docker', 'adm', 'www-data', 'systemd-journal'].includes(g.name)) && (!f || g.name.toLowerCase().includes(f)))
  }, [groups.data, filter, showSystem, selected])
  const save = async (): Promise<void> => {
    const list = [...selected].filter((g) => g !== primary)
    const ok = await run(() => api.call('users:setGroups', serverId, user.name, list), { success: `Groups of ${user.name} updated` })
    if (ok === undefined) return
    onDone()
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Groups of ${user.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 mb-3">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter groups" className="flex-1" />
        <Toggle checked={showSystem} onChange={setShowSystem} label="All groups" />
      </div>
      {groups.error ? (
        <ErrorBox error={groups.error} onRetry={groups.reload} />
      ) : groups.loading && !groups.data ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-1.5 max-h-80 overflow-auto pr-1">
          {visible.map((g) => (
            <Checkbox
              key={g.name}
              checked={selected.has(g.name)}
              disabled={g.name === primary}
              onChange={(v) =>
                setSelected((s) => {
                  const n = new Set(s)
                  if (v) n.add(g.name)
                  else n.delete(g.name)
                  return n
                })
              }
              label={
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-xs">{g.name}</span>
                  {g.name === primary && <Badge>primary</Badge>}
                  {ADMIN_GROUPS.includes(g.name) && <Badge color="warn">admin</Badge>}
                  <span className="text-dim text-[11px]">{g.gid}</span>
                </span>
              }
            />
          ))}
        </div>
      )}
      <div className="text-[11px] text-dim mt-3">Supplementary groups are set with <code>usermod -G</code>. The primary group cannot be removed here.</div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Password / shell / delete                                           */
/* ------------------------------------------------------------------ */

function PasswordModal({ serverId, user, onClose, onDone }: { serverId: string; user: UserInfoEx; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [pw, setPw] = useState('')
  const { run, busy } = useAction()
  const save = async (): Promise<void> => {
    const ok = await run(() => api.call('users:setPassword', serverId, user.name, pw), { success: `Password of ${user.name} changed` })
    if (ok === undefined) return
    onDone()
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Set password for ${user.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={pw.length < 1}>
            Set password
          </Button>
        </>
      }
    >
      <Field label="New password" hint="Applied with chpasswd. Copy the generated password before closing; it is not stored anywhere.">
        <PasswordInput value={pw} onChange={setPw} autoFocus />
      </Field>
      {user.keyOnly && <Callout kind="info">This account is key-only: the new password works for <code>su</code>/console but SSH still requires a key.</Callout>}
      {user.self && <Callout kind="warn">This is the account ServerMate uses. Update the saved profile password afterwards.</Callout>}
    </Modal>
  )
}

function ShellModal({ serverId, user, onClose, onDone }: { serverId: string; user: UserInfoEx; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const shells = useAsync(() => api.call<string[]>('users:shells', serverId), [serverId])
  const [shell, setShell] = useState(user.shell)
  const { run, busy } = useAction()
  const list = useMemo(() => [...new Set([...(shells.data ?? []), user.shell])], [shells.data, user.shell])
  const save = async (): Promise<void> => {
    const ok = await run(() => api.call('users:setShell', serverId, user.name, shell), { success: `Shell of ${user.name} set to ${shell}` })
    if (ok === undefined) return
    onDone()
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Change shell of ${user.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={shell === user.shell}>
            Change shell
          </Button>
        </>
      }
    >
      <Field label="Login shell" hint="From /etc/shells plus nologin / false for service accounts.">
        <Select value={shell} onChange={(e) => setShell(e.target.value)}>
          {list.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
      {/(nologin|false)$/.test(shell) && <Callout kind="warn">A non-interactive shell prevents SSH and console logins for this account.</Callout>}
    </Modal>
  )
}

function DeleteModal({ serverId, user, onClose, onDone }: { serverId: string; user: UserInfoEx; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [removeHome, setRemoveHome] = useState(false)
  const [backupHome, setBackupHome] = useState(true)
  const [typed, setTyped] = useState('')
  const { run, busy } = useAction()
  const del = async (): Promise<void> => {
    const r = await run(() => api.call<{ backup?: string }>('users:delete', serverId, user.name, { removeHome, backupHome }), { success: `User ${user.name} deleted` })
    if (!r) return
    if (r.backup) useApp.getState().toast({ kind: 'info', title: 'Home directory archived', detail: r.backup })
    onDone()
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete ${user.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={del} loading={busy} disabled={typed !== user.name} icon={<Trash2 size={13} />}>
            Delete user
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p>
          Running processes of <b>{user.name}</b> are killed, the account is removed with <code>userdel</code> and its ServerMate sudoers entry is deleted.
        </p>
        <Checkbox checked={removeHome} onChange={setRemoveHome} label={<>Remove home directory <code>{user.home}</code> and mail spool</>} />
        <Checkbox checked={backupHome} onChange={setBackupHome} label={<>Archive the home directory first to <code>/var/backups/servermate/</code> (tar.gz)</>} />
        {removeHome && !backupHome && <Callout kind="danger">The home directory will be permanently deleted without a backup.</Callout>}
        {user.isAdmin && <Callout kind="warn">This user is an administrator.</Callout>}
        <Field label={<span>Type <b className="font-mono text-text">{user.name}</b> to confirm</span>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} mono autoFocus />
        </Field>
      </div>
    </Modal>
  )
}
