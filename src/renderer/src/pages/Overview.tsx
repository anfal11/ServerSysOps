import React, { useEffect, useMemo, useState } from 'react'
import { Clock, Eraser, HardDrive, KeyRound, Network, Package, Power, RefreshCw, Shield, ShieldAlert, Tag, Terminal as TerminalIcon, Wrench } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { Badge, Button, Callout, Card, Checkbox, ErrorBox, Field, Input, KV, Loading, Modal, Pre, Row, Select, Spinner, Stat, Table, confirm, useAction, useAsync } from '@/components/ui'
import { cls, fmtBytes, fmtDate, fmtPct, fmtRate, fmtUptime } from '@/lib/format'
import type { CleanupScan, OverviewSnapshot, QuickActionsState } from '@shared/types'

/** Sparkline history survives page switches. */
const historyCache = new Map<string, OverviewSnapshot[]>()

type Dialog = null | 'sshport' | 'sshlogin' | 'power' | 'updates' | 'fail2ban' | 'hostname' | 'timezone' | 'swap' | 'cleanup'

export default function Overview({ serverId }: PageProps): React.JSX.Element {
  const interval = useApp((s) => s.settings.metricsIntervalMs)
  // cacheKey: the last snapshot / quick-action state is shown instantly when coming back to this
  // page, and refreshed in the background (no spinner while the ~2-5 s probe scripts run).
  const snap = useAsync(() => api.call<OverviewSnapshot>('overview:snapshot', serverId), [serverId], { intervalMs: interval, cacheKey: `overview:${serverId}` })
  const qa = useAsync(() => api.call<QuickActionsState>('qa:state', serverId), [serverId], { cacheKey: `qa:${serverId}` })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [history, setHistory] = useState<OverviewSnapshot[]>(() => historyCache.get(serverId) ?? [])
  useEffect(() => {
    if (!snap.data) return
    setHistory((h) => {
      const next = h[h.length - 1]?.ts === snap.data!.ts ? h : [...h.slice(-59), snap.data as OverviewSnapshot]
      historyCache.set(serverId, next)
      return next
    })
  }, [snap.data, serverId])

  const d = snap.data
  const q = qa.data
  const close = (): void => setDialog(null)
  const reloadAll = (): void => {
    void snap.reload()
    void qa.reload()
  }
  // Refresh whenever a background task for this server finishes (updates, swap, fail2ban, ...).
  const finishedTasks = useApp((s) => s.tasks.filter((t) => t.serverId === serverId && t.status !== 'running' && t.status !== 'queued').length)
  const firstRun = React.useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const t = setTimeout(reloadAll, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedTasks])

  return (
    <>
      <div className="flex items-center justify-between px-6 h-14 shrink-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[15px] font-semibold">Overview</h1>
          {d && (
            <span className="text-muted text-xs truncate">
              {d.os}, kernel {d.kernel}
            </span>
          )}
        </div>
        <Button icon={<RefreshCw size={13} />} onClick={reloadAll} loading={qa.loading && !!q}>
          Refresh
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-6 pb-6 space-y-4">
        {snap.error ? <ErrorBox error={snap.error} onRetry={snap.reload} /> : null}
        {!d && !snap.error && <Loading />}
        {d && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <Stat label="CPU" value={d.cpuPct.toFixed(1)} unit="%" bar={d.cpuPct} sub={`${d.cpuCount} cores, load ${d.load.map((n) => n.toFixed(2)).join(' ')}`} />
              <Stat label="Memory" value={d.memTotal ? ((d.memUsed / d.memTotal) * 100).toFixed(1) : '0'} unit="%" bar={d.memTotal ? (d.memUsed / d.memTotal) * 100 : 0} sub={`${fmtBytes(d.memUsed)} of ${fmtBytes(d.memTotal)}`} />
              <Stat label="Swap" value={d.swapTotal ? ((d.swapUsed / d.swapTotal) * 100).toFixed(1) : '0.0'} unit="%" bar={d.swapTotal ? (d.swapUsed / d.swapTotal) * 100 : 0} sub={d.swapTotal ? `${fmtBytes(d.swapUsed)} of ${fmtBytes(d.swapTotal)}` : 'No swap configured'} />
              <Stat label="Uptime" value={fmtUptime(d.uptimeSec)} sub={`${d.processes} processes, ${d.sessions} session${d.sessions === 1 ? '' : 's'}`} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Sparkline title="CPU %" values={history.map((h) => h.cpuPct)} max={100} fmt={(v) => `${v.toFixed(0)}%`} />
              <Sparkline title="Network" values={history.map((h) => h.netRx + h.netTx)} fmt={(v) => fmtRate(v)} sub={`↓ ${fmtRate(d.netRx)} · ↑ ${fmtRate(d.netTx)} · disk r ${fmtRate(d.diskRead)} w ${fmtRate(d.diskWrite)}`} />
            </div>

            {d.rebootRequired && (
              <Callout kind="warn">
                <div className="flex items-center justify-between">
                  <span>
                    <b>Reboot required.</b> Updates were installed that need a restart{q?.pendingReboot ? ` (${q.pendingReboot})` : ''}.
                  </span>
                  <Button size="xs" variant="subtle" onClick={() => setDialog('power')}>
                    Reboot…
                  </Button>
                </div>
              </Callout>
            )}

            <Card title="Quick actions" actions={qa.loading ? <Spinner size={14} /> : <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => qa.reload()} />} flush>
              {qa.error ? (
                <div className="p-4">
                  <ErrorBox error={qa.error} onRetry={qa.reload} />
                </div>
              ) : (
                <div className="grid grid-cols-2 divide-x divide-border">
                  <div>
                    <Row icon={<TerminalIcon />} title="SSH port" value={<span className="font-mono font-semibold">{q?.sshPorts.join(', ') ?? d.sshPort}</span>} valueSub={q?.sshSocketActivated ? 'Socket-activated sshd' : 'sshd service'} action={<Button onClick={() => setDialog('sshport')} disabled={!q}>Change</Button>} />
                    <Row icon={<Power />} title="Power" value="Running" valueSub={q?.scheduledShutdown ? `Scheduled: ${q.scheduledShutdown}` : 'Reboot or shut down'} action={<Button onClick={() => setDialog('power')}>Reboot…</Button>} />
                    <Row icon={<Shield />} title="Automatic updates" value={q ? (q.unattendedUpgrades === 'on' ? 'On' : q.unattendedUpgrades === 'off' ? 'Off' : 'Unavailable') : '…'} valueSub="Security updates install daily" action={<AutoUpdatesButton serverId={serverId} q={q} onDone={() => qa.reload()} />} />
                    <Row icon={<Tag />} title="Hostname" value={<span className="font-mono font-semibold">{d.hostname}</span>} valueSub="Shown in prompts and logs" action={<Button onClick={() => setDialog('hostname')}>Rename</Button>} />
                    <Row icon={<HardDrive />} title="Swap" value={fmtBytes(d.swapTotal)} valueSub={`Swappiness ${q?.swap.swappiness ?? '…'}`} action={<Button onClick={() => setDialog('swap')} disabled={!q}>Configure</Button>} />
                  </div>
                  <div>
                    <Row
                      icon={<KeyRound />}
                      title="SSH login"
                      value={q ? (q.permitRootLogin === 'yes' ? 'Root login allowed (password)' : q.permitRootLogin === 'no' ? 'Root login disabled' : 'Root login keys only') : '…'}
                      valueSub={q ? (q.passwordAuth ? 'Password logins allowed' : 'Keys only (passwords off)') : ''}
                      action={<Button onClick={() => setDialog('sshlogin')} disabled={!q}>Change</Button>}
                    />
                    <Row
                      icon={<Package />}
                      title="Package updates"
                      value={q ? (q.updates.count === 0 ? 'Up to date' : `${q.updates.count} update${q.updates.count === 1 ? '' : 's'} available${q.updates.security ? ` (${q.updates.security} security)` : ''}`) : '…'}
                      valueSub={q?.updates.lastChecked ? `Checked ${q.updates.lastChecked}` : ''}
                      action={<Button onClick={() => setDialog('updates')} variant={q && q.updates.count > 0 ? 'primary' : 'default'}>{q && q.updates.count > 0 ? 'Install' : 'Check'}</Button>}
                    />
                    <Row icon={<ShieldAlert />} title="Fail2ban" value={q ? (q.fail2ban.installed ? (q.fail2ban.running ? 'Active' : 'Installed, stopped') : 'Not installed') : '…'} valueSub={q?.fail2ban.installed ? `${q.fail2ban.bannedCount ?? 0} banned · ${q.fail2ban.maxretry ?? '?'} tries / ${q.fail2ban.findtime ?? '?'} → ban ${q.fail2ban.bantime ?? '?'}${q.fail2ban.increment ? ` (escalating up to ${q.fail2ban.maxtime ?? '?'})` : ''}${q.fail2ban.mode === 'aggressive' ? ' · aggressive' : ''}` : 'Bans IPs that fail SSH logins'} action={<Button onClick={() => setDialog('fail2ban')}>{q?.fail2ban.installed ? 'Configure' : 'Set up'}</Button>} />
                    <Row icon={<Clock />} title="Time zone" value={d.timezone} valueSub={d.ntpSynced ? 'Clock synced with NTP' : 'Clock NOT synced'} action={<Button onClick={() => setDialog('timezone')}>Change</Button>} />
                    <Row icon={<Eraser />} title="Disk cleanup" value="Caches, logs, old packages" valueSub="Shows sizes before deleting" action={<Button onClick={() => setDialog('cleanup')}>Scan…</Button>} />
                  </div>
                </div>
              )}
            </Card>

            <div className="grid grid-cols-2 gap-4">
              <Card title="System">
                <KV
                  rows={[
                    ['Hostname', d.hostname],
                    ['Operating system', d.os],
                    ['Kernel', <span className="font-mono">{d.kernel}</span>],
                    ['Architecture', d.arch],
                    ['Processor', d.cpuModel || '—'],
                    ['Package manager', d.pkgManager || '—'],
                    ['Init system', d.initSystem || '—'],
                    ['Logged in as', d.user],
                    ['Firewall', q ? (q.firewall === 'none' ? 'none detected' : q.firewall) : '…']
                  ]}
                />
              </Card>
              <Card title="Network">
                <KV
                  rows={[
                    [
                      'IP addresses',
                      <div className="font-mono space-y-0.5">
                        {d.ipAddresses.map((ip) => (
                          <div key={ip}>{ip}</div>
                        ))}
                      </div>
                    ],
                    ['SSH endpoint', <span className="font-mono">{useApp.getState().servers.find((s) => s.id === serverId)?.host}:{d.sshPort}</span>],
                    ['Host key', <span className="font-mono text-xs break-all">{d.hostKeyFingerprint ?? '—'}</span>],
                    [
                      'Interfaces',
                      <div className="space-y-0.5">
                        {d.interfaces
                          .filter((i) => i.name !== 'lo')
                          .map((i) => (
                            <div key={i.name} className="flex items-center gap-2 text-xs">
                              <span className={cls('inline-block w-1.5 h-1.5 rounded-full', i.state === 'up' || i.state === 'unknown' ? 'bg-ok' : 'bg-dim')} />
                              <span className="font-mono">{i.name}</span>
                              <span className="text-dim">{i.mac}</span>
                              <span className="text-dim">↓{fmtBytes(i.rxBytes)} ↑{fmtBytes(i.txBytes)}</span>
                            </div>
                          ))}
                      </div>
                    ]
                  ]}
                />
              </Card>
            </div>

            <Card title="Disks" flush>
              <Table
                rows={d.disks}
                rowKey={(r) => r.mount}
                columns={[
                  { key: 'mount', header: 'Mount point', render: (r) => <span className="font-mono">{r.mount}</span> },
                  { key: 'dev', header: 'Device', render: (r) => <span className="font-mono text-muted">{r.device}</span> },
                  { key: 'fs', header: 'Type', render: (r) => <span className="text-muted">{r.fstype}</span> },
                  {
                    key: 'usage',
                    header: 'Usage',
                    width: '40%',
                    render: (r) => (
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-1.5 bg-border rounded overflow-hidden">
                          <div className={cls('h-full', r.usePct > 90 ? 'bg-danger' : r.usePct > 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${r.usePct}%` }} />
                        </div>
                        <span className="w-10 text-right text-xs">{r.usePct}%</span>
                      </div>
                    )
                  },
                  { key: 'used', header: 'Used', align: 'right', render: (r) => fmtBytes(r.usedBytes) },
                  { key: 'free', header: 'Free', align: 'right', render: (r) => fmtBytes(r.availBytes) },
                  { key: 'size', header: 'Size', align: 'right', render: (r) => fmtBytes(r.sizeBytes) }
                ]}
              />
            </Card>
          </>
        )}
      </div>

      {q && dialog === 'sshport' && <SshPortDialog serverId={serverId} q={q} onClose={close} />}
      {q && dialog === 'sshlogin' && <SshLoginDialog serverId={serverId} q={q} onClose={close} onDone={reloadAll} />}
      {dialog === 'power' && <PowerDialog serverId={serverId} onClose={close} scheduled={q?.scheduledShutdown} onDone={reloadAll} />}
      {dialog === 'updates' && <UpdatesDialog serverId={serverId} q={q} onClose={close} onDone={reloadAll} />}
      {dialog === 'fail2ban' && <Fail2banDialog serverId={serverId} q={q} onClose={close} onDone={reloadAll} />}
      {d && dialog === 'hostname' && <HostnameDialog serverId={serverId} current={d.hostname} onClose={close} onDone={reloadAll} />}
      {d && dialog === 'timezone' && <TimezoneDialog serverId={serverId} current={d.timezone} ntp={d.ntpSynced || !!q?.ntp} onClose={close} onDone={reloadAll} />}
      {q && dialog === 'swap' && <SwapDialog serverId={serverId} q={q} onClose={close} onDone={reloadAll} />}
      {dialog === 'cleanup' && <CleanupDialog serverId={serverId} onClose={close} onDone={reloadAll} />}
    </>
  )
}

/* ------------------------------------------------------------------ */

function Sparkline({ title, values, max, fmt, sub }: { title: string; values: number[]; max?: number; fmt: (v: number) => string; sub?: string }): React.JSX.Element {
  const m = max ?? Math.max(1, ...values)
  const w = 600
  const h = 48
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - (Math.min(v, m) / m) * h}`)
  const last = values[values.length - 1] ?? 0
  return (
    <div className="bg-panel border border-border rounded-lg px-4 py-3">
      <div className="flex items-center justify-between text-xs text-muted mb-1">
        <span>{title}</span>
        <span className="text-text font-medium">{fmt(last)}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-12">
        {pts.length > 1 && (
          <>
            <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill="var(--color-accent)" fillOpacity={0.15} />
            <polyline points={pts.join(' ')} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {sub && <div className="text-[11px] text-dim mt-1">{sub}</div>}
    </div>
  )
}

function AutoUpdatesButton({ serverId, q, onDone }: { serverId: string; q?: QuickActionsState; onDone: () => void }): React.JSX.Element {
  const { run, busy } = useAction()
  if (!q || q.unattendedUpgrades === 'unavailable') return <Button disabled>Unavailable</Button>
  const on = q.unattendedUpgrades === 'on'
  return (
    <Button
      loading={busy}
      onClick={async () => {
        await run(() => api.call('qa:setAutoUpdates', serverId, !on))
        setTimeout(onDone, 1500)
      }}
    >
      Turn {on ? 'off' : 'on'}
    </Button>
  )
}

function SshPortDialog({ serverId, q, onClose }: { serverId: string; q: QuickActionsState; onClose: () => void }): React.JSX.Element {
  const [port, setPort] = useState('')
  const { run, busy } = useAction()
  const n = Number(port)
  const valid = Number.isInteger(n) && n > 0 && n < 65536 && !q.sshPorts.includes(n)
  return (
    <Modal
      open
      onClose={onClose}
      title="Change SSH port"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              const ok = await run(() => api.call('qa:changeSshPort', serverId, n), { success: `Changing SSH port to ${n} (see Tasks)` })
              if (ok) onClose()
            }}
          >
            Change port
          </Button>
        </>
      }
    >
      <KV className="mb-4" rows={[['sshd listens on', <b className="font-mono">{q.sshPorts.join(', ')}</b>], ['Firewall', q.firewall === 'none' ? 'none detected' : q.firewall], ['Mode', q.sshSocketActivated ? 'socket-activated (ssh.socket)' : 'sshd service']]} />
      <Field label="New port">
        <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="e.g. 2222" mono autoFocus />
      </Field>
      <Callout>
        <b>Safe, staged change:</b> sshd first listens on both ports. The app then logs in on port {port || 'N'} before port {q.sshPorts[0]} is removed, so a failed change cannot lock you out. The saved profile is updated automatically.
      </Callout>
      <div className="text-[11px] text-dim mt-3">Cloud firewalls (AWS security groups, DigitalOcean, Hetzner…) must allow the new port as well; this app cannot change them. A local ufw/firewalld rule is added for you.</div>
    </Modal>
  )
}

function SshLoginDialog({ serverId, q, onClose, onDone }: { serverId: string; q: QuickActionsState; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [prl, setPrl] = useState(q.permitRootLogin)
  const [pw, setPw] = useState(q.passwordAuth)
  const { run, busy } = useAction()
  const server = useApp.getState().servers.find((s) => s.id === serverId)
  const risky = !pw && server?.auth === 'password'
  return (
    <Modal
      open
      onClose={onClose}
      title="SSH login security"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={risky}
            onClick={async () => {
              const ok = await run(() => api.call('qa:setSshLogin', serverId, { permitRootLogin: prl, passwordAuth: pw }), { success: 'Applying SSH login rules (see Tasks)' })
              if (ok) {
                onClose()
                setTimeout(onDone, 4000)
              }
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <p className="text-muted text-xs mb-4">Settings are written to the top of sshd_config (a drop-in that wins over later values), checked with <code>sshd -t</code> and rolled back automatically if this app can no longer log in.</p>
      <Field label="Root login" className="mb-3">
        <Select value={prl} onChange={(e) => setPrl(e.target.value)}>
          <option value="prohibit-password">Keys only (prohibit-password)</option>
          <option value="yes">Allowed with password (yes)</option>
          <option value="no">Disabled (no)</option>
          <option value="forced-commands-only">Forced commands only</option>
        </Select>
      </Field>
      <Checkbox checked={pw} onChange={setPw} label="Allow password logins (all users)" />
      <div className="text-[11px] text-dim mt-1.5 ml-6">Turning this off allows SSH keys only. Every user who logs in with a password will be locked out.</div>
      {risky && (
        <Callout kind="danger">
          <div className="mt-0">This profile logs in with a password, so disabling password logins would lock this app out. Switch the profile to an SSH key first (Users page → SSH keys, then edit the server).</div>
        </Callout>
      )}
    </Modal>
  )
}

function PowerDialog({ serverId, onClose, scheduled, onDone }: { serverId: string; onClose: () => void; scheduled?: string; onDone: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'reboot' | 'poweroff'>('reboot')
  const [delay, setDelay] = useState('0')
  const { run, busy } = useAction()
  const name = useApp.getState().servers.find((s) => s.id === serverId)?.name ?? 'server'
  return (
    <Modal
      open
      onClose={onClose}
      title="Power"
      footer={
        <>
          {scheduled && (
            <Button
              variant="subtle"
              onClick={async () => {
                await run(() => api.call('qa:power', serverId, 'cancel'), { success: 'Scheduled shutdown cancelled' })
                onClose()
                onDone()
              }}
            >
              Cancel scheduled
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              const d = Number(delay) || 0
              const ok = await confirm({
                title: mode === 'reboot' ? 'Reboot server' : 'Shut down server',
                message: <>{mode === 'reboot' ? 'Reboot' : 'Shut down'} <b>{name}</b> {d > 0 ? `in ${d} minute${d === 1 ? '' : 's'}` : 'now'}? {mode === 'poweroff' && 'You will need console or cloud access to power it on again.'}</>,
                danger: true,
                confirmLabel: mode === 'reboot' ? 'Reboot' : 'Shut down',
                typeToConfirm: mode === 'poweroff' ? name : undefined
              })
              if (!ok) return
              await run(() => api.call('qa:power', serverId, mode, d), { success: d > 0 ? 'Scheduled' : mode === 'reboot' ? 'Rebooting… the app reconnects automatically' : 'Shutting down' })
              onClose()
              onDone()
            }}
          >
            {mode === 'reboot' ? 'Reboot' : 'Shut down'}
          </Button>
        </>
      }
    >
      {scheduled && <Callout kind="warn">A shutdown/reboot is already scheduled: {scheduled}</Callout>}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="Action">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'reboot' | 'poweroff')}>
            <option value="reboot">Reboot</option>
            <option value="poweroff">Shut down (power off)</option>
          </Select>
        </Field>
        <Field label="Delay (minutes, 0 = now)">
          <Input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} />
        </Field>
      </div>
      <div className="text-[11px] text-dim mt-3">Uses <code>shutdown</code>; logged-in users get a wall message. Reboots usually take 30–90 s; the connection is restored automatically.</div>
    </Modal>
  )
}

function UpdatesDialog({ serverId, q, onClose, onDone }: { serverId: string; q?: QuickActionsState; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [list, setList] = useState<string[] | null>(q?.updates.list ?? null)
  const [security, setSecurity] = useState(q?.updates.security ?? 0)
  const [checking, setChecking] = useState(false)
  const { run, busy } = useAction()
  const check = async (): Promise<void> => {
    setChecking(true)
    const r = await run(() => api.call<{ list: string[]; security: number }>('qa:checkUpdates', serverId))
    if (r) {
      setList(r.list)
      setSecurity(r.security)
    }
    setChecking(false)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Package updates"
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={check} loading={checking} icon={<RefreshCw size={12} />}>
            Check now
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={!list || list.length === 0}
            loading={busy}
            onClick={async () => {
              const ok = await run(() => api.call('qa:upgradeAll', serverId), { success: 'Installing updates (see Tasks)' })
              if (ok) {
                onClose()
                setTimeout(onDone, 3000)
              }
            }}
          >
            Install all updates
          </Button>
        </>
      }
    >
      {list === null ? (
        <Loading />
      ) : list.length === 0 ? (
        <Callout>Everything is up to date{q?.updates.lastChecked ? ` (package lists refreshed ${q.updates.lastChecked})` : ''}. Click "Check now" to refresh the package lists.</Callout>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2 text-xs text-muted">
            <Badge color="accent">{list.length} packages</Badge>
            {security > 0 && <Badge color="warn">{security} security</Badge>}
          </div>
          <Pre maxH="max-h-96">{list.join('\n')}</Pre>
        </>
      )}
    </Modal>
  )
}

function Fail2banDialog({ serverId, q, onClose, onDone }: { serverId: string; q?: QuickActionsState; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const f = q?.fail2ban
  const [maxretry, setMaxretry] = useState(String(f?.maxretry ?? 5))
  const [findtime, setFindtime] = useState(f?.findtime ?? '10m')
  const [bantime, setBantime] = useState(f?.bantime ?? '1h')
  const [ignore, setIgnore] = useState((f?.ignoreip ?? '').replace(/127\.0\.0\.1\/8|::1/g, '').trim())
  const [addMine, setAddMine] = useState(true)
  const [increment, setIncrement] = useState(f?.increment ?? true)
  const [maxtime, setMaxtime] = useState(f?.maxtime ?? '1w')
  const [aggressive, setAggressive] = useState(f?.mode ? f.mode === 'aggressive' : true)
  const [status, setStatus] = useState<string | null>(null)
  const [unban, setUnban] = useState('')
  const { run, busy } = useAction()
  const installed = !!f?.installed
  return (
    <Modal
      open
      onClose={onClose}
      title="Fail2ban (SSH brute-force protection)"
      badge={<Badge color={installed ? (f?.running ? 'ok' : 'warn') : 'muted'}>{installed ? (f?.running ? 'active' : 'stopped') : 'not installed'}</Badge>}
      width="max-w-2xl"
      footer={
        <>
          {installed && (
            <Button
              variant="subtle"
              onClick={async () => {
                await run(() => api.call('qa:fail2banToggle', serverId, !f?.running), { success: f?.running ? 'Fail2ban stopped' : 'Fail2ban started' })
                onDone()
              }}
            >
              {f?.running ? 'Stop' : 'Start'}
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              const ips = [ignore, addMine && q?.clientIp ? q.clientIp : ''].filter(Boolean).join(' ')
              const ok = await run(() => api.call('qa:fail2banSetup', serverId, { maxretry: Number(maxretry), findtime, bantime, ignoreip: ips, sshPorts: q?.sshPorts ?? [22], increment, maxtime, aggressive }), { success: installed ? 'Applying Fail2ban settings (see Tasks)' : 'Installing Fail2ban (see Tasks)' })
              if (ok) {
                onClose()
                setTimeout(onDone, 5000)
              }
            }}
          >
            {installed ? 'Apply' : 'Install & enable'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="Max failed logins">
          <Input type="number" min={1} value={maxretry} onChange={(e) => setMaxretry(e.target.value)} />
        </Field>
        <Field label="Within">
          <Input value={findtime} onChange={(e) => setFindtime(e.target.value)} mono />
        </Field>
        <Field label="Ban for">
          <Input value={bantime} onChange={(e) => setBantime(e.target.value)} mono />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_140px] gap-3 items-end mt-3">
        <Checkbox checked={increment} onChange={setIncrement} label="Repeat offenders are banned longer each time (bantime.increment)" />
        <Field label="Up to">
          <Input value={maxtime} onChange={(e) => setMaxtime(e.target.value)} mono disabled={!increment} />
        </Field>
      </div>
      <Checkbox className="mt-2" checked={aggressive} onChange={setAggressive} label="Aggressive mode: also count probes, bad protocol attempts and rejected keys (mode = aggressive)" />
      <Field label="Never ban (IPs / CIDRs)" className="mt-3">
        <Input value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder="203.0.113.7 10.0.0.0/8" mono />
      </Field>
      {q?.clientIp && <Checkbox className="mt-3" checked={addMine} onChange={setAddMine} label={`Never ban my current IP (${q.clientIp})`} />}
      <div className="text-[11px] text-dim mt-3">
        Times: s, m, h, d or w (e.g. 10m, 1d). Use -1 to ban forever. Watches SSH port(s) {q?.sshPorts.join(', ') ?? 22}. Bans go through the active firewall ({q?.firewall === 'ufw' ? 'ufw' : q?.firewall === 'firewalld' ? 'firewalld' : "fail2ban's own iptables chain"}); the config is tested with <code>fail2ban-client -t</code> before the service is restarted.
        {f?.banaction && <> Current banaction: <code>{f.banaction}</code>.</>}
      </div>
      {installed && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={async () => setStatus((await run(() => api.call<string>('qa:fail2banStatus', serverId))) ?? null)}>
              Show status & banned IPs
            </Button>
            <Input value={unban} onChange={(e) => setUnban(e.target.value)} placeholder="IP to unban" mono className="h-6 text-xs w-40" />
            <Button size="xs" disabled={!unban} onClick={() => run(() => api.call('qa:fail2banUnban', serverId, unban.trim()), { success: `Unbanned ${unban}` })}>
              Unban
            </Button>
          </div>
          {status && <Pre className="mt-2">{status}</Pre>}
        </div>
      )}
    </Modal>
  )
}

function HostnameDialog({ serverId, current, onClose, onDone }: { serverId: string; current: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState(current)
  const [hosts, setHosts] = useState(true)
  const { run, busy } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title="Change hostname"
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || name === current}
            onClick={async () => {
              const ok = await run(() => api.call('qa:setHostname', serverId, name.trim(), hosts), { success: `Hostname set to ${name.trim()}` })
              if (ok) {
                onClose()
                onDone()
              }
            }}
          >
            Change
          </Button>
        </>
      }
    >
      <Field label="Hostname">
        <Input value={name} onChange={(e) => setName(e.target.value)} mono autoFocus />
      </Field>
      <Checkbox className="mt-3" checked={hosts} onChange={setHosts} label="Update the 127.0.1.1 line in /etc/hosts" />
    </Modal>
  )
}

function TimezoneDialog({ serverId, current, ntp, onClose, onDone }: { serverId: string; current: string; ntp: boolean; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const zones = useAsync(() => api.call<string[]>('qa:listTimezones', serverId), [serverId])
  const [tz, setTz] = useState(current)
  const [sync, setSync] = useState(ntp)
  const { run, busy } = useAction()
  const list = useMemo(() => (zones.data && zones.data.length ? zones.data : [current]), [zones.data, current])
  return (
    <Modal
      open
      onClose={onClose}
      title="Timezone & time sync"
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              const ok = await run(() => api.call('qa:setTimezone', serverId, tz, sync), { success: `Timezone set to ${tz}` })
              if (ok) {
                onClose()
                onDone()
              }
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <Field label="Timezone">
        {zones.loading ? (
          <Loading />
        ) : (
          <Select value={tz} onChange={(e) => setTz(e.target.value)}>
            {!list.includes(tz) && <option value={tz}>{tz}</option>}
            {list.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Checkbox className="mt-3" checked={sync} onChange={setSync} label="Synchronise the clock automatically (NTP)" />
    </Modal>
  )
}

function SwapDialog({ serverId, q, onClose, onDone }: { serverId: string; q: QuickActionsState; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [size, setSize] = useState('keep')
  const [sw, setSw] = useState(String(q.swap.swappiness))
  const { run, busy } = useAction()
  const curGb = q.swap.swapfileSize ? Math.round(q.swap.swapfileSize / 1024 ** 3) : 0
  return (
    <Modal
      open
      onClose={onClose}
      title="Swap file"
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              const ok = await run(() => api.call('qa:setSwap', serverId, { sizeGb: size === 'keep' ? null : Number(size), swappiness: Number(sw) }), { success: 'Configuring swap (see Tasks)' })
              if (ok) {
                onClose()
                setTimeout(onDone, 3000)
              }
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      {q.swap.otherSwap.length > 0 && <p className="text-xs text-muted mb-3">Other swap is active and is left untouched: {q.swap.otherSwap.join(', ')}.</p>}
      <Field label="Size of /swapfile">
        <Select value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="keep">Keep current ({curGb ? `${curGb} GB` : 'none'})</option>
          <option value="0">Remove /swapfile</option>
          {[1, 2, 4, 8, 16, 32].map((g) => (
            <option key={g} value={g}>
              {g} GB
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Swappiness (0–100)" className="mt-3" hint="Lower = keep more in RAM. 10–30 suits most servers; the kernel default is 60.">
        <Input type="number" min={0} max={100} value={sw} onChange={(e) => setSw(e.target.value)} />
      </Field>
    </Modal>
  )
}

function CleanupDialog({ serverId, onClose, onDone }: { serverId: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const scan = useAsync(() => api.call<CleanupScan>('qa:cleanupScan', serverId), [serverId])
  const [checked, setChecked] = useState<Record<string, boolean> | null>(null)
  const { run, busy } = useAction()
  useEffect(() => {
    if (scan.data && !checked) setChecked(Object.fromEntries(scan.data.items.map((i) => [i.id, i.checked && (i.bytes > 0 || (i.count ?? 0) > 0)])))
  }, [scan.data, checked])
  const total = scan.data?.items.filter((i) => checked?.[i.id]).reduce((a, i) => a + i.bytes, 0) ?? 0
  return (
    <Modal
      open
      onClose={onClose}
      title="Disk cleanup"
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!checked || !Object.values(checked).some(Boolean)}
            onClick={async () => {
              const ids = Object.entries(checked ?? {})
                .filter(([, v]) => v)
                .map(([k]) => k)
              const ok = await run(() => api.call('qa:cleanupRun', serverId, ids), { success: 'Cleaning up (see Tasks)' })
              if (ok) {
                onClose()
                setTimeout(onDone, 4000)
              }
            }}
          >
            Clean up ~{fmtBytes(total)}
          </Button>
        </>
      }
    >
      {scan.error ? (
        <ErrorBox error={scan.error} onRetry={scan.reload} />
      ) : !scan.data || !checked ? (
        <Loading label="Scanning…" />
      ) : (
        <>
          <div className="text-xs text-muted mb-3">
            Free on /: <b className="text-text">{fmtBytes(scan.data.freeBytes)}</b>
          </div>
          <div className="space-y-2">
            {scan.data.items.map((i) => (
              <label key={i.id} className={cls('flex items-center gap-3 border rounded-md px-3 py-2.5 cursor-pointer', checked[i.id] ? 'border-accent/50 bg-accent/10' : 'border-border bg-bg-2')}>
                <Checkbox checked={!!checked[i.id]} onChange={(v) => setChecked({ ...checked, [i.id]: v })} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium">{i.label}</div>
                  <div className="text-[11px] text-dim">{i.description}</div>
                </div>
                <div className="text-xs font-semibold whitespace-nowrap">{i.count !== undefined && i.bytes === 0 ? `${i.count} pkg` : fmtBytes(i.bytes)}</div>
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

void fmtPct
void fmtDate
void Wrench
void Network
