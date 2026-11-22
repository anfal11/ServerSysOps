import React, { useEffect, useState } from 'react'
import { Activity, Box, Clock, Cpu, Eraser, FolderOpen, Gauge, HardDrive, KeyRound, Package, Power, Settings, Shield, ShieldAlert, Tag, Terminal as TerminalIcon, Users, Wifi, WifiOff, ListChecks, Home, X } from 'lucide-react'
import { Badge, Button, Callout, Card, Checkbox, Dot, EmptyState, ErrorBox, Field, Input, KV, Pre, ProgressBar, Row, Select, Stat, Table, Tabs, Toggle } from '@/components/ui'
import { THEMES, applyTheme, terminalTheme } from '@/lib/themes'
import { cls } from '@/lib/format'

/**
 * Design gallery: every UI primitive with sample data inside the real app shell.
 * Not reachable from the app; open the renderer with `#gallery` in the URL (used for theme QA).
 */
export default function Gallery(): React.JSX.Element {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'graphite')
  const [tab, setTab] = useState<'all' | 'running' | 'stopped'>('all')
  const [toggle, setToggle] = useState(true)
  const [check, setCheck] = useState(true)
  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  useEffect(() => {
    const onTheme = (): void => setTheme(document.documentElement.dataset.theme ?? 'graphite')
    window.addEventListener('serversysops:theme', onTheme)
    return () => window.removeEventListener('serversysops:theme', onTheme)
  }, [])
  const tt = terminalTheme()
  const nav = [
    { icon: <Gauge />, label: 'Overview', active: true },
    { icon: <TerminalIcon />, label: 'Terminal' },
    { icon: <FolderOpen />, label: 'Files' },
    { icon: <Box />, label: 'Docker' },
    { icon: <Users />, label: 'Users' },
    { icon: <Shield />, label: 'Firewall' }
  ]
  const procs = [
    { pid: 1203, name: 'nginx', user: 'www-data', cpu: 2.1, mem: 1.4, state: 'running' },
    { pid: 884, name: 'postgres', user: 'postgres', cpu: 11.6, mem: 8.2, state: 'running' },
    { pid: 2210, name: 'node', user: 'app', cpu: 48.0, mem: 22.5, state: 'running' },
    { pid: 310, name: 'cron', user: 'root', cpu: 0, mem: 0.1, state: 'sleeping' }
  ]
  return (
    <div className="h-full flex flex-col bg-bg text-text">
      {/* tab bar */}
      <div className="h-10 bg-bg-2 border-b border-border flex items-stretch shrink-0">
        <button className="px-3 flex items-center gap-2 border-r border-border text-muted">
          <Home size={15} />
        </button>
        <div className="px-3 flex items-center gap-2 border-r border-border bg-bg text-text min-w-[140px]">
          <Dot status="ok" />
          <span className="truncate text-xs font-medium flex-1">Production web</span>
          <X size={13} className="text-dim" />
        </div>
        <div className="px-3 flex items-center gap-2 border-r border-border text-muted min-w-[140px]">
          <Dot status="danger" />
          <span className="truncate text-xs font-medium flex-1">Staging db</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1 px-2">
          <Button variant="ghost" size="sm" icon={<ListChecks size={14} />}>
            Tasks (1)
          </Button>
          <span className="text-[10px] bg-warn/20 text-warn-fg border border-warn/40 rounded px-1.5 h-5 flex items-center">2 alerts</span>
          <Button variant="ghost" size="sm" icon={<Settings size={14} />} />
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        {/* sidebar */}
        <aside className="w-[200px] shrink-0 bg-bg-2 border-r border-border flex flex-col">
          <div className="px-4 pt-4 pb-3 border-b border-border">
            <div className="flex items-center gap-2 font-semibold text-[13px] truncate">
              <Dot status="ok" /> Production web
            </div>
            <div className="text-[11px] text-muted font-mono truncate mt-1">deploy@203.0.113.10</div>
            <div className="text-[11px] text-dim truncate">Ubuntu 24.04.1 LTS</div>
          </div>
          <nav className="flex-1 py-2">
            {nav.map((n) => (
              <button key={n.label} className={cls('w-full flex items-center gap-2.5 px-4 h-8 text-[13px] text-left [&>svg]:w-4 [&>svg]:h-4', n.active ? 'bg-panel-2 text-text font-medium' : 'text-muted hover:text-text hover:bg-panel')}>
                {n.icon}
                {n.label}
              </button>
            ))}
          </nav>
          <div className="p-3 border-t border-border">
            <Button variant="ghost" size="sm" className="w-full justify-start" icon={<WifiOff size={14} />}>
              Disconnect
            </Button>
          </div>
        </aside>
        {/* main */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg">
          <div className="flex items-center justify-between px-6 h-14 shrink-0">
            <div className="flex items-baseline gap-3">
              <h1 className="text-[15px] font-semibold">Overview</h1>
              <span className="text-muted text-xs">Ubuntu 24.04.1 LTS, kernel 6.8.0-45-generic</span>
            </div>
            <div className="flex items-center gap-2">
              <Select value={theme} onChange={(e) => setTheme(e.target.value)} className="h-7 text-xs w-48">
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <Button icon={<Wifi size={13} />}>Refresh</Button>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-auto px-6 pb-6 space-y-4">
            <div className="grid grid-cols-4 gap-4">
              <Stat label="CPU" value="23.4" unit="%" bar={23.4} sub="4 cores, load 0.92 0.80 0.71" />
              <Stat label="Memory" value="81.2" unit="%" bar={81.2} sub="6.5 GB of 8 GB" />
              <Stat label="Swap" value="94.0" unit="%" bar={94} sub="1.9 GB of 2 GB" />
              <Stat label="Uptime" value="41d 3h" sub="212 processes, 2 sessions" />
            </div>
            <Callout kind="warn">
              <div className="flex items-center justify-between">
                <span>
                  <b>Reboot required.</b> Updates were installed that need a restart (linux-image-6.8.0-45).
                </span>
                <Button size="xs" variant="subtle">
                  Reboot…
                </Button>
              </div>
            </Callout>
            <Card title="Quick actions" flush>
              <div className="grid grid-cols-2 divide-x divide-border">
                <div>
                  <Row icon={<TerminalIcon />} title="SSH port" value={<span className="font-mono font-semibold">22</span>} valueSub="sshd service" action={<Button>Change</Button>} />
                  <Row icon={<Power />} title="Power" value="Running" valueSub="Reboot or shut down" action={<Button>Reboot…</Button>} />
                  <Row icon={<Shield />} title="Automatic updates" value="On" valueSub="Security updates install daily" action={<Button>Turn off</Button>} />
                  <Row icon={<Tag />} title="Hostname" value={<span className="font-mono font-semibold">web-01</span>} valueSub="Shown in prompts and logs" action={<Button>Rename</Button>} />
                </div>
                <div>
                  <Row icon={<KeyRound />} title="SSH login" value="Root login keys only" valueSub="Password logins allowed" action={<Button>Change</Button>} />
                  <Row icon={<Package />} title="Package updates" value="6 updates available (2 security)" valueSub="Checked 2 hours ago" action={<Button variant="primary">Install</Button>} />
                  <Row icon={<ShieldAlert />} title="Fail2ban" value="Active" valueSub="3 banned · 5 tries / 10m → ban 1h" action={<Button>Configure</Button>} />
                  <Row icon={<Clock />} title="Time zone" value="Europe/London" valueSub="Clock synced with NTP" action={<Button>Change</Button>} />
                </div>
              </div>
            </Card>

            <div className="grid grid-cols-2 gap-4">
              <Card title="Badges, status and text colours">
                <div className="flex flex-wrap gap-2 mb-3">
                  <Badge color="ok">running</Badge>
                  <Badge color="warn">degraded</Badge>
                  <Badge color="danger">failed</Badge>
                  <Badge color="info">info</Badge>
                  <Badge color="accent">selected</Badge>
                  <Badge>muted</Badge>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                  <span className="text-ok-fg">text-ok-fg: 3 services healthy</span>
                  <span className="text-ok">text-ok: active (running)</span>
                  <span className="text-warn-fg">text-warn-fg: 2 warnings</span>
                  <span className="text-warn">text-warn: 81% memory</span>
                  <span className="text-danger-fg">text-danger-fg: 1 failed check</span>
                  <span className="text-danger">text-danger: port 3306 public</span>
                  <span className="text-info-fg">text-info-fg: 4 informational</span>
                  <span className="text-info">text-info: 192.168.1.20</span>
                  <span className="text-accent-fg">text-accent-fg: link-like label</span>
                  <span className="text-accent">text-accent: nginx/1.24</span>
                  <span className="text-muted">text-muted: secondary line</span>
                  <span className="text-dim">text-dim: hint text</span>
                </div>
                <div className="mt-3 space-y-2">
                  <ErrorBox error={new Error('ssh: connect to host 203.0.113.10 port 22: Connection refused')} onRetry={() => {}} />
                  <Callout>Store the TOTP secret in the server profile and ServerSysOps fills the code automatically.</Callout>
                  <Callout kind="danger">This permanently deletes /var/www/old-site. Folders are removed with everything inside.</Callout>
                </div>
              </Card>
              <Card title="Buttons, inputs and controls">
                <div className="flex flex-wrap gap-2 mb-3">
                  <Button variant="primary">Install</Button>
                  <Button>Default</Button>
                  <Button variant="subtle">Subtle</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="danger">Delete</Button>
                  <Button variant="primary" disabled>
                    Disabled
                  </Button>
                  <Button variant="primary" loading>
                    Working
                  </Button>
                  <Button size="xs" variant="primary">
                    xs
                  </Button>
                  <Button size="md">md</Button>
                </div>
                <Tabs tabs={[{ id: 'all', label: 'All', count: 12 }, { id: 'running', label: 'Running', count: 9 }, { id: 'stopped', label: 'Stopped', count: 3 }]} value={tab} onChange={setTab} className="mb-3" />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Hostname" hint="Letters, digits and dashes">
                    <Input defaultValue="web-01" mono />
                  </Field>
                  <Field label="Time zone">
                    <Select defaultValue="Europe/London">
                      <option>Europe/London</option>
                      <option>UTC</option>
                    </Select>
                  </Field>
                  <Field label="Port">
                    <Input defaultValue="" placeholder="2222" />
                  </Field>
                  <div className="flex flex-col gap-2 pt-5">
                    <Checkbox checked={check} onChange={setCheck} label="Open the port in the firewall" />
                    <Toggle checked={toggle} onChange={setToggle} label="Passwordless sudo" />
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  <ProgressBar value={35} />
                  <ProgressBar value={80} />
                  <ProgressBar value={96} />
                </div>
              </Card>
            </div>

            <Card title="Processes" flush actions={<Badge color="ok">live</Badge>}>
              <Table
                rows={procs}
                rowKey={(r) => String(r.pid)}
                selected={(r) => r.pid === 884}
                onRowClick={() => {}}
                columns={[
                  { key: 'pid', header: 'PID', mono: true, render: (r) => r.pid, width: '80px' },
                  { key: 'name', header: 'Process', render: (r) => <span className="font-medium">{r.name}</span> },
                  { key: 'user', header: 'User', render: (r) => <span className="text-muted">{r.user}</span> },
                  { key: 'cpu', header: 'CPU %', align: 'right', sortValue: (r) => r.cpu, render: (r) => <span className={cls(r.cpu > 40 && 'text-warn-fg font-medium')}>{r.cpu.toFixed(1)}</span> },
                  { key: 'mem', header: 'Mem %', align: 'right', render: (r) => r.mem.toFixed(1) },
                  { key: 'state', header: 'State', render: (r) => <Badge color={r.state === 'running' ? 'ok' : 'muted'}>{r.state}</Badge> },
                  { key: 'a', header: '', align: 'right', render: () => <Button size="xs" variant="danger">Kill</Button> }
                ]}
              />
            </Card>

            <div className="grid grid-cols-2 gap-4">
              <Card title="Terminal colours">
                <div className="rounded-md p-3 font-mono text-xs leading-relaxed" style={{ background: tt.background, color: tt.foreground }}>
                  <div>
                    <span style={{ color: tt.green }}>deploy@web-01</span>:<span style={{ color: tt.blue }}>~/app</span>$ systemctl status nginx
                  </div>
                  <div>
                    ● nginx.service - <span style={{ color: tt.brightWhite }}>A high performance web server</span>
                  </div>
                  <div>
                    &nbsp;&nbsp;&nbsp;Active: <span style={{ color: tt.brightGreen }}>active (running)</span> since Mon 2026-11-16 09:12:03 UTC
                  </div>
                  <div style={{ color: tt.yellow }}>warning: 2 packages can be upgraded</div>
                  <div style={{ color: tt.red }}>error: permission denied (publickey)</div>
                  <div>
                    <span style={{ color: tt.cyan }}>192.168.1.20</span> <span style={{ color: tt.magenta }}>[20/Nov/2026]</span> <span style={{ color: tt.brightBlack }}># comment text</span>
                  </div>
                  <div className="flex gap-1 mt-2">
                    {['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'].map((k) => (
                      <span key={k} className="h-4 flex-1 rounded-sm" style={{ background: tt[k] }} title={k} />
                    ))}
                  </div>
                  <div className="mt-1">
                    selected text: <span style={{ background: tt.selectionBackground }}>cat /etc/ssh/sshd_config</span>
                  </div>
                </div>
              </Card>
              <Card title="System">
                <KV
                  rows={[
                    ['CPU', 'Intel Xeon E-2288G @ 3.70GHz (4 cores)'],
                    ['Architecture', 'x86_64'],
                    ['Init', 'systemd'],
                    ['Packages', 'apt'],
                    ['Host key', <span className="font-mono text-xs break-all">SHA256:Y2w8M8H2n1l5kT0mQd6hP4bQxVZt8W0XnQZ3GkP1sAo</span>]
                  ]}
                />
                <Pre className="mt-3">{`$ df -h /\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        80G   61G   19G  77% /`}</Pre>
              </Card>
            </div>
            <div className="bg-panel border border-border rounded-lg">
              <EmptyState icon={<Activity />} title="No alerts" description="Alerts fire when CPU, memory or disk usage stays above the thresholds in Settings." action={<Button variant="primary">Open settings</Button>} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { t: 'Task finished', d: 'All updates installed.', k: 'border-ok/40' },
                { t: 'Connection lost', d: 'reconnecting (attempt 2)…', k: 'border-warn/50' },
                { t: 'Action failed', d: 'sudo password rejected', k: 'border-danger/50' }
              ].map((x) => (
                <div key={x.t} className={cls('bg-panel-2 border rounded-md shadow-xl px-3 py-2.5 text-[13px]', x.k)}>
                  <div className="font-medium">{x.t}</div>
                  <div className="text-muted text-xs mt-0.5 font-mono">{x.d}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-dim">
              <Cpu size={12} /> <HardDrive size={12} /> <Eraser size={12} /> icons in text-dim
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
