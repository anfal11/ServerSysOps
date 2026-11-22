import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Ban, Check, Download, Globe, Plus, RefreshCw, RotateCcw, Save, Shield, ShieldAlert, ShieldCheck, ShieldOff, Terminal, Trash2, X } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api, errMsg } from '@/lib/api'
import { Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorBox, Field, Input, KV, Loading, Modal, Page, PageHeader, Pre, Select, Table, Toggle, confirm, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { cls } from '@/lib/format'
import type { AddRuleInput, BlockedIp, BlockedPacket, ExposedPort, FirewallPreset, FirewallRuleEx, FirewallStateEx, FwAction, FwBackend, FwLogLevel, FwPolicy } from '@shared/modules/firewall'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function actionColor(a: string): 'ok' | 'danger' | 'warn' | 'info' | 'muted' {
  const u = a.toUpperCase()
  if (u.startsWith('ALLOW')) return 'ok'
  if (u.startsWith('LIMIT')) return 'info'
  if (u.startsWith('REJECT')) return 'warn'
  if (u.startsWith('DENY') || u.startsWith('DROP')) return 'danger'
  return 'muted'
}

/** Reload when a background task (by id) finishes. */
function useTaskDone(taskId: string | null, onDone: () => void): void {
  const tasks = useApp((s) => s.tasks)
  const fired = useRef<string | null>(null)
  useEffect(() => {
    if (!taskId || fired.current === taskId) return
    const t = tasks.find((x) => x.id === taskId)
    if (t && (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled')) {
      fired.current = taskId
      onDone()
    }
  }, [tasks, taskId, onDone])
}

/** Mutating handlers return `{ warning }` when iptables rules could not be persisted. */
function warnToast(r: unknown): void {
  const w = (r as { warning?: string } | undefined)?.warning
  if (w) useApp.getState().toast({ kind: 'warn', title: 'Rules are not persistent', detail: w })
}

const BACKEND_LABEL: Record<FwBackend, string> = { ufw: 'ufw', firewalld: 'firewalld', iptables: 'iptables' }

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Firewall({ serverId }: PageProps): React.JSX.Element {
  const { run, busy } = useAction()
  const toast = useApp((s) => s.toast)
  const toggleTasks = useApp((s) => s.toggleTasks)
  const [installTask, setInstallTask] = useState<string | null>(null)
  const [addRule, setAddRule] = useState<Partial<AddRuleInput> | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const st = useAsync(() => Promise.all([api.call<FirewallStateEx>('fw:state', serverId), api.call<FirewallPreset[]>('fw:presets', serverId)]), [serverId], { intervalMs: 20000 })
  const state = st.data?.[0]
  const presets = st.data?.[1] ?? []
  const reload = st.reload
  useTaskDone(installTask, () => void reload())
  const ipt = state?.backend === 'iptables'

  const toggleEnabled = async (on: boolean): Promise<void> => {
    if (!state) return
    if (on) {
      const ok = await confirm({
        title: `Enable ${state.backend}`,
        message: (
          <div className="space-y-2">
            {ipt ? (
              <p>
                A safe baseline is applied in one step: accept loopback, established/related connections, ICMP and the SSH port(s) <b>{state.sshPorts.join(', ')}</b>, then the INPUT policy is set to <b>DROP</b>. Existing rules (fail2ban, Docker, custom chains) are kept; FORWARD and the nat table are not touched.
              </p>
            ) : (
              <p>
                Incoming traffic will be filtered according to the default policy (<b>{state.defaultIncoming}</b>) and the rules below.
              </p>
            )}
            <Callout kind="info">
              <ShieldCheck size={13} className="inline mr-1" />
              Port <b>{state.sshPorts.join(', ')}</b> (SSH) is always allowed before enabling. ServerSysOps then opens a second SSH connection to verify access; if that probe fails the firewall is {ipt ? 'set back to ACCEPT' : 'disabled again'} automatically.
            </Callout>
            {ipt && !state.persistent && <Callout kind="warn">Persistence is not set up: the rules would be lost at reboot (the server comes back unfiltered, never locked). Use "Set up persistence" below afterwards.</Callout>}
          </div>
        ),
        confirmLabel: 'Enable firewall'
      })
      if (!ok) return
      const r = await run(() => api.call<{ sshPorts: number[]; warning?: string }>('fw:enable', serverId), { success: 'Firewall enabled and SSH access verified' })
      warnToast(r)
      if (r) await reload()
    } else {
      const ok = await confirm({
        title: `Disable ${state.backend}`,
        message: ipt ? <>Set the INPUT/OUTPUT policies to ACCEPT and remove the rules this app created? All ports become reachable. Unlike ufw, iptables has no "stored but inactive" rule set, so the app's rules are deleted; rules of other tools (fail2ban, Docker{state.docker ? ', FORWARD and the nat table' : ''}) are left alone.</> : <>Stop filtering traffic? All ports will be reachable until the firewall is enabled again. Rules are kept.</>,
        danger: true,
        confirmLabel: 'Disable'
      })
      if (!ok) return
      const r = await run(() => api.call('fw:disable', serverId), { success: 'Firewall disabled' })
      warnToast(r)
      await reload()
    }
  }

  const install = async (backend: FwBackend): Promise<void> => {
    const id = await run(() => api.call<string>('fw:install', serverId, backend))
    if (!id) return
    setInstallTask(id)
    const detail = backend === 'firewalld' ? 'The SSH port is allowed before the service starts and access is verified afterwards.' : backend === 'iptables' ? 'Installs iptables plus the persistence package of this distribution; the firewall stays disabled until you enable it here.' : 'ufw stays disabled after installation; enable it from this page.'
    toast({ kind: 'info', title: `Installing ${BACKEND_LABEL[backend]}…`, detail })
    toggleTasks(true)
  }

  const deleteRule = async (r: FirewallRuleEx): Promise<void> => {
    if (!state) return
    const protectsSsh = state.sshPorts.some((p) => ruleMentionsPort(r, p))
    const ok = await confirm({
      title: 'Delete rule',
      message: (
        <div className="space-y-2">
          <p>
            Delete <Badge color={actionColor(r.action)}>{r.action}</Badge> <code className="font-mono">{r.to}</code> from <code className="font-mono">{r.from}</code>?
          </p>
          {ipt && <pre className="text-[11px] font-mono text-dim whitespace-pre-wrap break-all">{r.raw}</pre>}
          {protectsSsh && (
            <Callout kind="danger">
              <ShieldAlert size={13} className="inline mr-1" />
              This rule allows the SSH port ({state.sshPorts.join(', ')}). With the firewall active and incoming traffic denied, deleting it can lock you out. Type the port to confirm.
            </Callout>
          )}
        </div>
      ),
      danger: true,
      confirmLabel: 'Delete',
      typeToConfirm: protectsSsh ? String(state.sshPort) : undefined
    })
    if (!ok) return
    const res = await run(() => api.call('fw:deleteRule', serverId, { index: r.index, raw: r.raw, force: protectsSsh }), { success: 'Rule deleted' })
    warnToast(res)
    await reload()
  }

  const applyPreset = async (p: FirewallPreset, enable: boolean): Promise<void> => {
    if (p.custom) {
      setAddRule({ action: 'allow', direction: 'in', proto: 'tcp' })
      return
    }
    let force = false
    if (!enable && p.id === 'ssh') {
      const ok = await confirm({ title: 'Remove SSH rule', message: <>Removing the rule for port {state?.sshPort} can lock you out of this server. Type the port to confirm.</>, danger: true, confirmLabel: 'Remove', typeToConfirm: String(state?.sshPort ?? '') })
      if (!ok) return
      force = true
    }
    const r = await run(() => api.call<{ changed: number; warning?: string }>('fw:applyPreset', serverId, p.id, enable, force), { success: enable ? `${p.label} allowed` : `${p.label} rule removed` })
    warnToast(r)
    if (r) await reload()
  }

  const reset = async (): Promise<void> => {
    if (!state) return
    const ok = await confirm({
      title: 'Reset firewall',
      message: (
        <div className="space-y-2">
          {ipt ? (
            <p>
              The rules this app created are removed and the INPUT/OUTPUT policies are set to <b>ACCEPT</b> (= disabled); rules of other tools stay. Enabling the firewall again recreates the baseline including the SSH rule ({state.sshPorts.join(', ')}).
            </p>
          ) : (
            <p>
              All rules are deleted and the firewall is <b>disabled</b>. A single allow rule for the SSH port ({state.sshPorts.join(', ')}) is re-added so you can enable it again safely.
            </p>
          )}
          {state.backend === 'firewalld' && <Callout kind="warn">firewalld: the service is stopped and custom zone files in /etc/firewalld/zones are removed.</Callout>}
          {ipt && state.docker && <Callout kind="info">Docker chains, FORWARD and the nat table are not touched.</Callout>}
        </div>
      ),
      danger: true,
      confirmLabel: 'Reset',
      typeToConfirm: 'reset'
    })
    if (!ok) return
    const r = await run(() => api.call('fw:reset', serverId), { success: ipt ? 'Firewall reset (app rules removed, policies ACCEPT)' : 'Firewall reset (disabled, SSH rule re-added)' })
    warnToast(r)
    await reload()
  }

  const setupPersistence = (): void => void install('iptables')

  const backendBadge = state ? (
    state.backend === 'none' ? (
      <Badge color="muted">no firewall</Badge>
    ) : (
      <span className="flex items-center gap-2">
        <Badge color="accent">{state.nftOnly ? 'nftables' : state.backend}</Badge>
        {state.version && <span className="text-dim text-xs">{state.version.replace(/^ufw\s*/i, '')}</span>}
        {ipt && state.nftBackend && !state.nftOnly && <Badge color="muted">nf_tables</Badge>}
        <Badge color={state.active ? 'ok' : 'warn'}>{state.active ? 'active' : 'inactive'}</Badge>
        {state.active && !state.sshAllowed && !state.nftOnly && (
          <Badge color="danger">
            <ShieldAlert size={11} className="mr-1" /> SSH port not allowed
          </Badge>
        )}
        {ipt && !state.nftOnly && !state.persistent && (
          <Badge color="warn" className="whitespace-nowrap">
            <AlertTriangle size={11} className="mr-1" /> not persistent
          </Badge>
        )}
      </span>
    )
  ) : undefined

  return (
    <>
      <PageHeader
        title="Firewall"
        subtitle={backendBadge}
        actions={
          <>
            <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void reload()} loading={st.loading && !!st.data}>
              Refresh
            </Button>
            {state && state.backend !== 'none' && !state.nftOnly && (
              <div className="flex items-center gap-2 pl-2 border-l border-border" title="Port of the current SSH connection is always allowed before enabling">
                <span className="text-xs text-muted">{state.active ? 'Enabled' : 'Disabled'}</span>
                <Toggle checked={state.active} onChange={(v) => void toggleEnabled(v)} disabled={busy} />
              </div>
            )}
          </>
        }
      />
      <Page>
        {st.error ? (
          <ErrorBox error={st.error} onRetry={reload} />
        ) : !state ? (
          <Loading />
        ) : state.backend === 'none' ? (
          <Card>
            <EmptyState
              icon={<ShieldOff />}
              title="No firewall installed"
              description={
                <>
                  Neither <b>ufw</b>, <b>firewalld</b> nor <b>iptables</b> was found. {state.installable ? <>Recommended for this distribution: <b>{state.recommended}</b>. The SSH port ({state.sshPorts.join(', ')}) is protected automatically during installation.</> : 'The package manager of this server is not supported for automatic installation.'}
                </>
              }
              action={
                <div className="flex gap-2 flex-wrap justify-center">
                  <Button variant={state.recommended === 'ufw' ? 'primary' : 'default'} icon={<Download size={13} />} disabled={!state.installable || !!installTask} loading={!!installTask} onClick={() => void install('ufw')}>
                    Install ufw
                  </Button>
                  <Button variant={state.recommended === 'firewalld' ? 'primary' : 'default'} icon={<Download size={13} />} disabled={!state.installable || !!installTask} loading={!!installTask} onClick={() => void install('firewalld')}>
                    Install firewalld
                  </Button>
                  <Button variant={state.recommended === 'iptables' ? 'primary' : 'default'} icon={<Download size={13} />} disabled={!state.installable || !!installTask} loading={!!installTask} onClick={() => void install('iptables')} title="Manage the kernel firewall directly (iptables + persistence package)">
                    Install iptables
                  </Button>
                </div>
              }
            />
          </Card>
        ) : state.nftOnly ? (
          <div className="space-y-4">
            <Callout kind="info">
              <Shield size={13} className="inline mr-1" />
              Only <b>nftables</b> is present on this server (no <code className="font-mono">iptables</code> binary). The current kernel rule set is shown read-only below. To manage rules from here install <b>iptables</b>; on Debian 12+/Ubuntu this installs the nft-backed variant (<code className="font-mono">iptables-nft</code>) that works alongside nftables.
              <div className="mt-2 flex gap-2">
                <Button variant="primary" size="sm" icon={<Download size={13} />} disabled={!state.installable || !!installTask} loading={!!installTask} onClick={() => void install('iptables')}>
                  Install iptables
                </Button>
                {state.installable && (
                  <Button size="sm" icon={<Download size={13} />} disabled={!!installTask} onClick={() => void install(state.recommended === 'iptables' ? 'ufw' : state.recommended)}>
                    Install {state.recommended === 'iptables' ? 'ufw' : state.recommended} instead
                  </Button>
                )}
              </div>
            </Callout>
            <Card title={<span className="flex items-center gap-2"><Terminal size={14} /> nft list ruleset</span>}>
              {state.raw ? <Pre maxH="max-h-[70vh]">{state.raw}</Pre> : <EmptyState icon={<Shield />} title="Empty rule set" description="nftables has no rules loaded; every listening service is reachable." />}
            </Card>
            <ExposedCard serverId={serverId} state={state} onAllow={() => void 0} />
          </div>
        ) : (
          <div className="space-y-4">
            {!state.active && (
              <Callout kind="warn">
                <AlertTriangle size={13} className="inline mr-1" />
                The firewall is <b>inactive</b>: every listening service is reachable from the network. {ipt ? 'The INPUT policy is ACCEPT and the chain is empty.' : 'Rules are stored but not enforced.'} Use the toggle in the header to enable it; port {state.sshPorts.join(', ')} (SSH) is allowed first.
              </Callout>
            )}
            {state.active && !state.sshAllowed && state.defaultIncoming !== 'allow' && (
              <Callout kind="danger">
                <ShieldAlert size={13} className="inline mr-1" />
                No rule allows the SSH port {state.sshPorts.join(', ')} while incoming traffic is {state.defaultIncoming}. Existing connections keep working, but new logins will fail.{' '}
                <Button size="xs" variant="danger" className="ml-2" onClick={() => void applyPreset(presets.find((p) => p.id === 'ssh') ?? { id: 'ssh', label: 'SSH', description: '', ports: [], allowed: false }, true)}>
                  Allow SSH now
                </Button>
              </Callout>
            )}
            {ipt && !state.persistent && (
              <Callout kind="warn">
                <Save size={13} className="inline mr-1" />
                <b>Rules will not survive a reboot.</b> {state.persistMethod ? <>{state.persistMethod} is installed but not enabled at boot.</> : <>No save/restore service is set up (Debian/Ubuntu: iptables-persistent, RHEL family: iptables-services, Alpine: the OpenRC iptables service).</>} ServerSysOps saves the rules after every change; this installs and enables the restore service.
                <Button size="xs" variant="primary" className="ml-2" icon={<Download size={12} />} disabled={!state.installable || !!installTask} loading={!!installTask} onClick={setupPersistence}>
                  Set up persistence
                </Button>
              </Callout>
            )}
            {ipt && state.docker && (
              <Callout kind="info">
                Docker detected (DOCKER chains). ServerSysOps only manages the <b>INPUT</b> and <b>OUTPUT</b> chains of the filter table; <b>FORWARD</b>, <b>DOCKER-USER</b> and the nat table are never modified, so published container ports stay under Docker's control. To restrict them use the DOCKER-USER chain.
              </Callout>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <DefaultsCard serverId={serverId} state={state} reload={reload} />
              <LoggingCard serverId={serverId} state={state} reload={reload} />
              <Card title="Status">
                <KV
                  rows={[
                    ['Backend', <span className="flex items-center gap-2">{state.backend} {state.version && <span className="text-dim">{state.version}</span>}{ipt && state.nftBackend && <Badge color="muted">nf_tables</Badge>}</span>],
                    ['State', <Badge color={state.active ? 'ok' : 'warn'}>{state.active ? 'active' : 'inactive'}</Badge>],
                    [ipt ? 'Persistent' : 'Starts at boot', ipt ? <span className="flex items-center gap-2">{state.persistent ? <span className="text-ok-fg flex items-center gap-1"><Check size={12} /> yes</span> : <span className="text-warn-fg">no</span>}{state.persistMethod && <span className="text-dim text-xs">{state.persistMethod}</span>}</span> : state.enabledAtBoot ? 'yes' : 'no'],
                    ['SSH port', <span className="font-mono">{state.sshPorts.join(', ')}</span>],
                    ['SSH allowed', state.sshAllowed ? <span className="text-ok-fg flex items-center gap-1"><Check size={12} /> yes</span> : <span className="text-warn-fg">no rule</span>],
                    ...(state.backend === 'firewalld' ? ([['Default zone', <span className="font-mono">{state.defaultZone}</span>]] as [React.ReactNode, React.ReactNode][]) : []),
                    ...(ipt && state.policies
                      ? ([
                          ['Policies', <span className="font-mono text-xs flex gap-2"><PolicyBadge chain="INPUT" policy={state.policies.input} /><PolicyBadge chain="FORWARD" policy={state.policies.forward} /><PolicyBadge chain="OUTPUT" policy={state.policies.output} /></span>],
                          ['IPv6', state.ip6 ? 'ip6tables managed alongside' : <span className="text-dim">ip6tables not usable</span>]
                        ] as [React.ReactNode, React.ReactNode][])
                      : []),
                    [ipt ? 'INPUT rules' : 'Rules', ipt ? `${state.ruleCount ?? 0} (${state.rules.length} incl. OUTPUT)` : state.rules.length]
                  ]}
                />
                {state.backend === 'firewalld' && state.zones && state.zones.length > 0 && (
                  <div className="mt-3 text-[11px] text-dim">
                    Zones: {state.zones.map((z) => `${z.name}${z.interfaces.length ? ` (${z.interfaces.join(', ')})` : ''}`).join(' · ')}
                  </div>
                )}
                {ipt && (
                  <div className="mt-3">
                    <Button size="xs" variant="ghost" icon={<Terminal size={12} />} onClick={() => setShowRaw((v) => !v)}>
                      {showRaw ? 'Hide raw rules' : 'Show raw rules (iptables-save)'}
                    </Button>
                  </div>
                )}
              </Card>
            </div>

            {ipt && showRaw && (
              <Card title={<span className="flex items-center gap-2"><Terminal size={14} /> Raw rules</span>} actions={<span className="text-xs text-dim">iptables-save {state.ip6 ? '+ ip6tables-save' : ''} · all tables, read-only</span>}>
                <Pre maxH="max-h-[60vh]">{state.raw || '(empty)'}</Pre>
              </Card>
            )}

            <Card title="Quick rules" actions={<span className="text-xs text-dim">One click allows a service from anywhere; allowed presets can be removed again.</span>}>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {presets.map((p) => (
                  <PresetButton key={p.id} preset={p} onAdd={() => void applyPreset(p, true)} onRemove={() => void applyPreset(p, false)} disabled={busy} />
                ))}
              </div>
            </Card>

            <Card
              title={`Rules (${state.rules.length})`}
              flush
              actions={
                <Button size="xs" variant="primary" icon={<Plus size={12} />} onClick={() => setAddRule({ action: 'allow', direction: 'in', proto: 'tcp' })}>
                  Add rule
                </Button>
              }
            >
              {ipt && <div className="px-4 py-2 text-[11px] text-dim border-b border-border">INPUT and OUTPUT chains of the filter table, in match order (first match wins). Allow rules you add are inserted before the final DROP/REJECT rule; rules that cannot be summarised show their raw matcher.</div>}
              <Table<FirewallRuleEx>
                rows={state.rules}
                rowKey={(r) => `${r.index}-${r.raw}`}
                dense
                empty={<EmptyState icon={<Shield />} title="No rules" description={`Only the default policy applies (incoming: ${state.defaultIncoming}).`} />}
                columns={[
                  { key: 'idx', header: '#', width: '44px', mono: true, render: (r) => <span className="text-dim">{r.index}</span> },
                  {
                    key: 'to',
                    header: 'To',
                    mono: true,
                    render: (r) => (
                      <span className="flex items-center gap-2" title={ipt ? r.raw : undefined}>
                        <span className="truncate max-w-[480px]">{r.to}</span>
                        {r.v6 && <Badge color="info">v6</Badge>}
                        {r.direction === 'out' && <Badge>out</Badge>}
                        {r.direction === 'fwd' && <Badge>fwd</Badge>}
                      </span>
                    )
                  },
                  { key: 'action', header: 'Action', width: '110px', render: (r) => <Badge color={actionColor(r.action)}>{r.action}</Badge> },
                  { key: 'from', header: 'From', mono: true, render: (r) => <span className={cls(/anywhere/i.test(r.from) && 'text-muted')}>{r.from}</span> },
                  { key: 'comment', header: 'Comment', render: (r) => <span className="text-muted text-xs">{r.comment ?? ''}</span> },
                  {
                    key: 'del',
                    header: '',
                    width: '44px',
                    align: 'right',
                    render: (r) => <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} title="Delete rule" onClick={() => void deleteRule(r)} />
                  }
                ]}
              />
            </Card>

            <BlockedIpsCard serverId={serverId} state={state} onChanged={() => void reload()} />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <ExposedCard serverId={serverId} state={state} onAllow={(port, proto) => setAddRule({ action: 'allow', direction: 'in', proto, port: String(port) })} />
              <BlockedCard serverId={serverId} state={state} />
            </div>

            <Card title={<span className="text-danger-fg">Danger zone</span>}>
              <div className="flex items-center justify-between gap-4">
                <div className="text-xs text-muted">
                  {ipt ? 'Reset removes every rule this app created and sets the policies back to ACCEPT (the firewall is then disabled). Rules of other tools such as fail2ban are kept.' : `Reset deletes all rules, disables the firewall and re-adds only the SSH allow rule (${state.sshPorts.join(', ')}). Useful when the rule set has become a mess.`}
                </div>
                <Button variant="danger" icon={<RotateCcw size={13} />} onClick={() => void reset()}>
                  Reset firewall
                </Button>
              </div>
            </Card>
          </div>
        )}
      </Page>
      {addRule && state && state.backend !== 'none' && (
        <AddRuleModal
          serverId={serverId}
          backend={state.backend}
          ip6={state.ip6 ?? true}
          initial={addRule}
          onClose={() => setAddRule(null)}
          onDone={() => void reload()}
        />
      )}
    </>
  )
}

function ruleMentionsPort(r: FirewallRuleEx, port: number): boolean {
  if (r.direction !== 'in' || !/^(ALLOW|LIMIT)/i.test(r.action)) return false
  const to = r.to.replace(/\s*\(v6\)/g, '').replace(/\s+on\s+\S+$/, '').replace(/\s*\(service\)$/, '').trim().toLowerCase()
  if (to === 'anywhere' || to === 'anywhere/tcp' || to === 'openssh' || (to === 'ssh' && port === 22)) return true
  const m = to.match(/^([\d,:-]+)(?:\/(tcp|udp))?$/)
  if (!m || m[2] === 'udp') return false
  return m[1].split(',').some((part) => {
    const range = part.match(/^(\d+)[:-](\d+)$/)
    return range ? port >= Number(range[1]) && port <= Number(range[2]) : Number(part) === port
  })
}

function PolicyBadge({ chain, policy }: { chain: string; policy: FwPolicy }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span className="text-dim">{chain}</span>
      <Badge color={policy === 'allow' ? 'ok' : policy === 'reject' ? 'warn' : 'danger'}>{policy === 'allow' ? 'ACCEPT' : policy === 'reject' ? 'REJECT' : 'DROP'}</Badge>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

function PresetButton({ preset, onAdd, onRemove, disabled }: { preset: FirewallPreset; onAdd: () => void; onRemove: () => void; disabled: boolean }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cls('relative border rounded-md px-3 py-2 text-left transition-colors min-h-[56px] flex flex-col justify-center', preset.allowed ? 'border-ok/40 bg-ok/10' : 'border-border bg-bg-2 hover:border-border-2')}
    >
      <button disabled={disabled || preset.allowed} onClick={onAdd} className="text-left disabled:cursor-default">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          {preset.allowed && <Check size={13} className="text-ok-fg" />}
          {preset.custom && <Plus size={13} className="text-muted" />}
          {preset.label}
        </div>
        <div className="text-[11px] text-dim truncate">{preset.description}</div>
      </button>
      {preset.allowed && hover && (
        <button onClick={onRemove} disabled={disabled} className="absolute top-1 right-1 text-dim hover:text-danger-fg p-1" title="Remove this rule">
          <X size={13} />
        </button>
      )}
    </div>
  )
}

function DefaultsCard({ serverId, state, reload }: { serverId: string; state: FirewallStateEx; reload: () => Promise<void> }): React.JSX.Element {
  const [incoming, setIncoming] = useState<FwPolicy>(state.defaultIncoming as FwPolicy)
  const [outgoing, setOutgoing] = useState<FwPolicy>(state.defaultOutgoing as FwPolicy)
  const { run, busy } = useAction()
  const ipt = state.backend === 'iptables'
  useEffect(() => {
    setIncoming(state.defaultIncoming as FwPolicy)
    setOutgoing(state.defaultOutgoing as FwPolicy)
  }, [state.defaultIncoming, state.defaultOutgoing])
  const dirty = incoming !== state.defaultIncoming || outgoing !== state.defaultOutgoing
  const apply = async (): Promise<void> => {
    if (incoming === 'allow' && state.active) {
      const ok = await confirm({ title: 'Allow all incoming traffic?', message: 'With incoming set to allow, the firewall only blocks what explicit deny/reject rules match. Every listening service becomes reachable.', danger: true, confirmLabel: 'Apply' })
      if (!ok) return
    }
    if (ipt && outgoing !== 'allow' && state.defaultOutgoing === 'allow') {
      const ok = await confirm({ title: 'Filter outgoing traffic?', message: 'With OUTPUT set to DROP/REJECT the server can only reply to existing connections (loopback and established/related are accepted automatically). DNS, package updates and outgoing mail stop working until you add OUTPUT allow rules. Access is verified with a second login afterwards.', danger: true, confirmLabel: 'Apply' })
      if (!ok) return
    }
    const r = await run(() => api.call<{ addedSsh: boolean; sshPorts: number[]; warning?: string }>('fw:setDefaults', serverId, { incoming, outgoing }), { success: 'Default policies updated' })
    if (r?.addedSsh) useApp.getState().toast({ kind: 'info', title: `Added an allow rule for SSH port ${r.sshPorts.join(', ')}`, detail: 'Required so that denying incoming traffic cannot lock you out.' })
    warnToast(r)
    await reload()
  }
  return (
    <Card title="Default policies">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Incoming" hint={state.backend === 'firewalld' ? `Zone target of ${state.defaultZone ?? 'public'}` : ipt ? 'INPUT chain policy; reject = DROP policy + final REJECT rule' : 'Traffic without a matching rule'}>
          <Select value={incoming} onChange={(e) => setIncoming(e.target.value as FwPolicy)}>
            <option value="deny">deny (drop silently)</option>
            <option value="reject">reject (answer with error)</option>
            <option value="allow">allow</option>
          </Select>
        </Field>
        <Field label="Outgoing" hint={state.backend === 'firewalld' ? 'firewalld does not filter outgoing traffic' : ipt ? 'OUTPUT chain policy' : 'Connections the server makes'}>
          <Select value={outgoing} onChange={(e) => setOutgoing(e.target.value as FwPolicy)} disabled={state.backend === 'firewalld'}>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
            <option value="reject">reject</option>
          </Select>
        </Field>
      </div>
      <div className="flex items-center justify-between mt-3">
        <span className="text-[11px] text-dim">{incoming !== 'allow' && !state.sshAllowed ? 'The SSH port will be allowed automatically.' : ''}</span>
        <Button variant="primary" size="sm" onClick={apply} loading={busy} disabled={!dirty}>
          Apply
        </Button>
      </div>
    </Card>
  )
}

function LoggingCard({ serverId, state, reload }: { serverId: string; state: FirewallStateEx; reload: () => Promise<void> }): React.JSX.Element {
  const { run, busy } = useAction()
  const levels: FwLogLevel[] = ['off', 'low', 'medium', 'high', 'full']
  const ipt = state.backend === 'iptables'
  const current = (state.backend === 'firewalld' ? (state.logging === 'off' ? 'off' : state.logging === 'unicast' ? 'low' : 'high') : (levels.includes(state.logging as FwLogLevel) ? state.logging : 'low')) as FwLogLevel
  const set = async (level: FwLogLevel): Promise<void> => {
    const r = await run(() => api.call('fw:setLogging', serverId, level), { success: `Logging set to ${level}` })
    warnToast(r)
    await reload()
  }
  const hint = state.backend === 'ufw' ? 'low logs blocked packets; medium/high also log allowed and rate-limited traffic (kernel log / /var/log/ufw.log).' : ipt ? 'A LOG rule with prefix [SSO-FW] right before the final DROP/REJECT: low = 3/min, medium = 10/min, high = unlimited (kernel log).' : 'firewalld --set-log-denied: off, unicast (low) or all (high).'
  const allowed = (l: FwLogLevel): boolean => (state.backend === 'ufw' ? true : ipt ? l !== 'full' : ['off', 'low', 'high'].includes(l))
  return (
    <Card title="Logging">
      <Field label="Log level" hint={hint}>
        <Select value={current} onChange={(e) => void set(e.target.value as FwLogLevel)} disabled={busy}>
          {levels.filter(allowed).map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <div className="text-[11px] text-dim mt-3">Current: <span className="font-mono text-muted">{state.logging}</span></div>
    </Card>
  )
}

function ExposedCard({ serverId, state, onAllow }: { serverId: string; state: FirewallStateEx; onAllow: (port: number, proto: 'tcp' | 'udp') => void }): React.JSX.Element {
  const listening = useAsync(() => api.call<ExposedPort[]>('fw:listening', serverId), [serverId, state.active, state.rules.length], { intervalMs: 30000 })
  const rows = useMemo(() => (listening.data ?? []).filter((p) => p.public), [listening.data])
  const exposed = rows.filter((p) => !p.allowed)
  const canAllow = !state.nftOnly
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Globe size={14} /> Exposed services
          {state.active ? <Badge color={exposed.length ? 'muted' : 'ok'}>{exposed.length} not allowed</Badge> : <Badge color="warn">{rows.length} reachable</Badge>}
        </span>
      }
      flush
      actions={
        <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void listening.reload()}>
          Refresh
        </Button>
      }
    >
      <div className="px-4 py-2 text-[11px] text-dim border-b border-border">
        {state.active ? 'Ports that listen on a public address without a matching allow rule are blocked by the firewall (good) unless they should be reachable.' : 'The firewall is inactive, so every public listener is reachable. Enable the firewall and allow only what is needed.'}
      </div>
      {listening.error ? (
        <div className="p-3">
          <ErrorBox error={listening.error} onRetry={listening.reload} />
        </div>
      ) : listening.loading && !listening.data ? (
        <Loading />
      ) : (
        <Table<ExposedPort>
          rows={rows}
          rowKey={(p) => `${p.proto}-${p.address}-${p.port}`}
          dense
          empty="No public listeners"
          columns={[
            { key: 'port', header: 'Port', mono: true, width: '90px', sortValue: (p) => p.port, render: (p) => `${p.port}/${p.proto}` },
            { key: 'addr', header: 'Address', mono: true, render: (p) => <span className="text-muted">{p.address}</span> },
            { key: 'proc', header: 'Process', mono: true, render: (p) => <span>{p.process || <span className="text-dim">?</span>}{p.pid ? <span className="text-dim"> ({p.pid})</span> : null}</span> },
            {
              key: 'state',
              header: state.active ? 'Firewall' : '',
              width: '120px',
              render: (p) => (state.active ? p.allowed ? <Badge color="ok">allowed</Badge> : <Badge color="muted">blocked</Badge> : <Badge color="warn">reachable</Badge>)
            },
            {
              key: 'act',
              header: '',
              width: '80px',
              align: 'right',
              render: (p) => (canAllow && (!p.allowed || !state.active) ? <Button size="xs" onClick={() => onAllow(p.port, p.proto as 'tcp' | 'udp')}>Allow</Button> : null)
            }
          ]}
        />
      )}
    </Card>
  )
}

const IP_RE = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/
const PORT_RE = /^(\d{1,5}(,\d{1,5})*|\d{1,5}[:-]\d{1,5})$/

/** Addresses blocked by plain "deny from <ip>" rules, on whichever backend is active; used by the Traffic page too. */
function BlockedIpsCard({ serverId, state, onChanged }: { serverId: string; state: FirewallStateEx; onChanged: () => void }): React.JSX.Element {
  const blocked = useAsync(() => api.call<BlockedIp[]>('fw:blockedIps', serverId), [serverId, state.rules.length])
  const { run, busy } = useAction()
  const [ip, setIp] = useState('')
  const [comment, setComment] = useState('')
  const ipOk = IP_RE.test(ip.trim())
  const block = async (): Promise<void> => {
    if (!ipOk) return
    const ok = await confirm({
      title: `Block ${ip.trim()}`,
      message: (
        <div className="space-y-2">
          <p>
            All traffic from <code className="font-mono">{ip.trim()}</code> will be dropped by a rule inserted at the top of the rule set ({state.backend}). The address of your own SSH session is refused automatically.
          </p>
          {!state.active && <Callout kind="warn">The firewall is inactive: the rule is stored but not enforced until you enable it.</Callout>}
        </div>
      ),
      danger: true,
      confirmLabel: 'Block'
    })
    if (!ok) return
    const r = await run(() => api.call('fw:blockIp', serverId, { ip: ip.trim(), comment: comment.trim() || undefined }).then(() => true), { success: `${ip.trim()} blocked` })
    if (r) {
      setIp('')
      setComment('')
      await blocked.reload()
      onChanged()
    }
  }
  const unblock = async (b: BlockedIp): Promise<void> => {
    const ok = await confirm({ title: `Unblock ${b.ip}`, message: <>Remove the block rule for <code className="font-mono">{b.ip}</code>{b.comment ? <> ({b.comment})</> : null}?</>, confirmLabel: 'Unblock' })
    if (!ok) return
    const r = await run(() => api.call('fw:unblockIp', serverId, { ip: b.ip }).then(() => true), { success: `${b.ip} unblocked` })
    if (r) {
      await blocked.reload()
      onChanged()
    }
  }
  const rows = blocked.data ?? []
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Ban size={14} /> Blocked addresses
          {blocked.data && <Badge>{rows.length}</Badge>}
        </span>
      }
      flush
      actions={
        <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void blocked.reload()}>
          Refresh
        </Button>
      }
    >
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-end gap-3">
        <Field label="IP address or CIDR" className="min-w-[220px]" hint={ip && !ipOk ? <span className="text-warn-fg">Invalid address</span> : 'IPv4 or IPv6, e.g. 203.0.113.7 or 2001:db8::/48'}>
          <Input value={ip} onChange={(e) => setIp(e.target.value)} mono placeholder="203.0.113.7" onKeyDown={(e) => e.key === 'Enter' && void block()} />
        </Field>
        <Field label="Comment" className="min-w-[200px] flex-1" hint="optional">
          <Input value={comment} onChange={(e) => setComment(e.target.value.slice(0, 60))} placeholder="brute force on sshd" onKeyDown={(e) => e.key === 'Enter' && void block()} />
        </Field>
        <Button variant="danger" size="sm" icon={<Ban size={13} />} onClick={() => void block()} disabled={!ipOk} loading={busy}>
          Block
        </Button>
      </div>
      {blocked.error ? (
        <div className="p-3">
          <ErrorBox error={blocked.error} onRetry={blocked.reload} />
        </div>
      ) : blocked.loading && !blocked.data ? (
        <Loading />
      ) : (
        <Table<BlockedIp>
          rows={rows}
          rowKey={(b) => b.raw}
          dense
          empty="No addresses are blocked"
          className="max-h-72"
          columns={[
            { key: 'ip', header: 'Address', mono: true, render: (b) => <span className="flex items-center gap-2">{b.ip}{b.v6 && <Badge color="info">v6</Badge>}</span> },
            { key: 'comment', header: 'Comment', render: (b) => <span className="text-muted text-xs">{b.comment ?? ''}</span> },
            { key: 'raw', header: 'Rule', mono: true, render: (b) => <span className="text-dim text-[11px] truncate block max-w-[420px]" title={b.raw}>{b.raw}</span> },
            { key: 'act', header: '', width: '90px', align: 'right', render: (b) => <Button size="xs" onClick={() => void unblock(b)} disabled={busy}>Unblock</Button> }
          ]}
        />
      )}
    </Card>
  )
}

function BlockedCard({ serverId, state }: { serverId: string; state: FirewallStateEx }): React.JSX.Element {
  const log = useAsync(() => api.call<BlockedPacket[]>('fw:log', serverId, 100), [serverId])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of log.data ?? []) m.set(e.src, (m.get(e.src) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  }, [log.data])
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert size={14} /> Recent blocked packets
          {log.data && <Badge>{log.data.length}</Badge>}
        </span>
      }
      flush
      actions={
        <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void log.reload()}>
          Refresh
        </Button>
      }
    >
      {state.logging === 'off' && <div className="px-4 py-2 text-[11px] text-warn-fg border-b border-border">Logging is off; blocked packets are not recorded. Set the log level to low or higher.</div>}
      {counts.length > 0 && (
        <div className="px-4 py-2 text-[11px] text-dim border-b border-border">
          Top sources: {counts.map(([ip, n]) => `${ip} (${n})`).join(' · ')}
        </div>
      )}
      {log.error ? (
        <div className="p-3">
          <ErrorBox error={log.error} onRetry={log.reload} />
        </div>
      ) : log.loading && !log.data ? (
        <Loading />
      ) : (
        <Table<BlockedPacket>
          rows={log.data ?? []}
          rowKey={(e) => e.raw}
          dense
          empty="No blocked packets in the recent kernel log"
          className="max-h-80"
          columns={[
            { key: 'time', header: 'Time', mono: true, width: '150px', render: (e) => <span className="text-muted text-xs">{e.time}</span> },
            { key: 'action', header: 'Action', width: '80px', render: (e) => <Badge color={actionColor(e.action === 'BLOCK' ? 'DENY' : e.action)}>{e.action}</Badge> },
            { key: 'src', header: 'Source', mono: true, render: (e) => `${e.src}${e.spt ? `:${e.spt}` : ''}` },
            { key: 'dst', header: 'Destination', mono: true, render: (e) => <span className="text-muted">{e.dst}{e.dpt ? `:${e.dpt}` : ''}</span> },
            { key: 'proto', header: 'Proto', mono: true, width: '70px', render: (e) => e.proto },
            { key: 'if', header: 'Iface', mono: true, width: '70px', render: (e) => <span className="text-dim">{e.iface}</span> }
          ]}
        />
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Add rule modal                                                      */
/* ------------------------------------------------------------------ */

function AddRuleModal({ serverId, backend, ip6, initial, onClose, onDone }: { serverId: string; backend: FwBackend; ip6: boolean; initial: Partial<AddRuleInput>; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [f, setF] = useState<{ action: FwAction; direction: 'in' | 'out'; proto: 'tcp' | 'udp' | 'any'; port: string; from: string; to: string; comment: string; v6: boolean }>({
    action: initial.action ?? 'allow',
    direction: initial.direction ?? 'in',
    proto: initial.proto ?? 'tcp',
    port: initial.port !== undefined ? String(initial.port) : '',
    from: initial.from ?? '',
    to: initial.to ?? '',
    comment: initial.comment ?? '',
    v6: initial.v6 ?? false
  })
  const { run, busy } = useAction()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]): void => setF((d) => ({ ...d, [k]: v }))
  const ipt = backend === 'iptables'
  const portOk = !f.port || PORT_RE.test(f.port.replace(/\s+/g, ''))
  const fromOk = !f.from || IP_RE.test(f.from.trim())
  const toOk = !f.to || IP_RE.test(f.to.trim())
  const multi = /[,:-]/.test(f.port)
  const needsProto = ipt ? !!f.port : multi
  const valid = portOk && fromOk && toOk && (f.port || f.from || f.to) && !(needsProto && f.proto === 'any') && !(backend === 'firewalld' && f.direction === 'out') && !(ipt && f.action === 'limit' && !f.port)
  const preview = useMemo(() => {
    if (backend === 'firewalld') return `firewall-cmd --permanent ${f.from || f.action !== 'allow' ? '--add-rich-rule=…' : `--add-port=${f.port || '?'}/${f.proto === 'any' ? 'tcp' : f.proto}`} && firewall-cmd --reload`
    if (ipt) {
      const v6 = f.v6 || f.from.includes(':') || f.to.includes(':')
      const both = !f.from && !f.to && !f.v6 && ip6
      const bin = v6 ? 'ip6tables' : 'iptables'
      const parts = [bin, '-I', f.direction === 'out' ? 'OUTPUT' : 'INPUT', f.action === 'allow' || f.action === 'limit' ? '<before final DROP>' : '1']
      if (f.from.trim()) parts.push('-s', f.from.trim())
      if (f.to.trim()) parts.push('-d', f.to.trim())
      if (f.proto !== 'any') parts.push('-p', f.proto)
      const p = f.port.replace(/\s+/g, '').replace('-', ':')
      if (p) parts.push(...(p.includes(',') ? ['-m', 'multiport', '--dports', p] : ['--dport', p]))
      if (f.action === 'limit') parts.push('-m conntrack --ctstate NEW -m hashlimit --hashlimit-upto 6/minute --hashlimit-burst 6 --hashlimit-mode srcip')
      parts.push('-m', 'comment', '--comment', `"ServerSysOps${f.comment.trim() ? `: ${f.comment.trim()}` : ''}"`)
      parts.push('-j', f.action === 'deny' ? 'DROP' : f.action === 'reject' ? 'REJECT' : 'ACCEPT')
      return parts.join(' ') + (both ? '\n(+ the same rule in ip6tables)' : '')
    }
    const parts = ['ufw', f.action, f.direction]
    if (f.proto !== 'any') parts.push('proto', f.proto)
    parts.push('from', f.from.trim() || (f.v6 && !f.to ? '::/0' : 'any'), 'to', f.to.trim() || (f.v6 && !f.from ? '::/0' : 'any'))
    if (f.port) parts.push('port', f.port.replace(/\s+/g, '').replace('-', ':'))
    if (f.comment.trim()) parts.push('comment', `'${f.comment.trim()}'`)
    return parts.join(' ')
  }, [f, backend, ipt, ip6])

  const submit = async (): Promise<void> => {
    const input: AddRuleInput = {
      action: f.action,
      direction: f.direction,
      proto: f.proto,
      port: f.port.replace(/\s+/g, '') || undefined,
      from: f.from.trim() || undefined,
      to: f.to.trim() || undefined,
      comment: f.comment.trim() || undefined,
      v6: f.v6
    }
    let r: { command: string; output: string; warning?: string } | undefined
    try {
      r = await api.call<{ command: string; output: string; warning?: string }>('fw:addRule', serverId, input)
    } catch (e) {
      const msg = errMsg(e)
      if (!msg.includes('SSH_BLOCK')) {
        useApp.getState().toast({ kind: 'error', title: 'Could not add rule', detail: msg })
        return
      }
      // The rule would block the SSH port: require an explicit typed confirmation before forcing it.
      const ok = await confirm({ title: 'This rule blocks SSH', message: <>{msg.replace('SSH_BLOCK: ', '')} If you continue you may lose access to this server.</>, danger: true, confirmLabel: 'Add rule anyway', typeToConfirm: 'block ssh' })
      if (!ok) return
      r = await run(() => api.call<{ command: string; output: string; warning?: string }>('fw:addRule', serverId, { ...input, force: true }), { success: 'Rule added' })
      if (!r) return
    }
    useApp.getState().toast({ kind: 'success', title: 'Rule added' })
    warnToast(r)
    onDone()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add firewall rule"
      width="max-w-xl"
      badge={<Badge color="accent">{backend}</Badge>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!valid}>
            Add rule
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-4">
        <Field label="Action" className="col-span-2">
          <Select value={f.action} onChange={(e) => set('action', e.target.value as FwAction)}>
            <option value="allow">allow</option>
            <option value="deny">deny (drop)</option>
            <option value="reject">reject</option>
            <option value="limit">limit (rate-limit, anti brute force)</option>
          </Select>
        </Field>
        <Field label="Direction" className="col-span-2">
          <Select value={f.direction} onChange={(e) => set('direction', e.target.value as 'in' | 'out')} disabled={backend === 'firewalld'}>
            <option value="in">incoming</option>
            <option value="out">outgoing</option>
          </Select>
        </Field>
        <Field label="Protocol" className="col-span-2">
          <Select value={f.proto} onChange={(e) => set('proto', e.target.value as 'tcp' | 'udp' | 'any')}>
            <option value="tcp">tcp</option>
            <option value="udp">udp</option>
            <option value="any">any</option>
          </Select>
        </Field>
        <Field label="Port(s)" className="col-span-3" hint={!portOk ? <span className="text-warn-fg">Use 80, 80,443 or 6000:6100</span> : needsProto && f.proto === 'any' ? <span className="text-warn-fg">{ipt ? 'iptables port rules need tcp or udp' : 'Lists and ranges need tcp or udp'}</span> : ipt && f.action === 'limit' && !f.port ? <span className="text-warn-fg">limit needs a port</span> : 'Single port, comma list or range. Empty = any port (needs a source).'}>
          <Input value={f.port} onChange={(e) => set('port', e.target.value)} mono placeholder="443" autoFocus />
        </Field>
        <Field label="From (IP / CIDR)" className="col-span-3" hint={!fromOk ? <span className="text-warn-fg">Invalid address</span> : 'Empty = anywhere'}>
          <Input value={f.from} onChange={(e) => set('from', e.target.value)} mono placeholder="203.0.113.0/24" />
        </Field>
        {backend !== 'firewalld' && (
          <Field label="To (destination IP, optional)" className="col-span-3" hint={!toOk ? <span className="text-warn-fg">Invalid address</span> : 'Restrict to one of the server addresses'}>
            <Input value={f.to} onChange={(e) => set('to', e.target.value)} mono placeholder="any" />
          </Field>
        )}
        <Field label="Comment" className={backend !== 'firewalld' ? 'col-span-3' : 'col-span-6'}>
          <Input value={f.comment} onChange={(e) => set('comment', e.target.value.slice(0, 60))} placeholder="optional" disabled={backend === 'firewalld'} />
        </Field>
        <div className="col-span-6">
          <Checkbox checked={f.v6} onChange={(v) => set('v6', v)} disabled={ipt && !ip6} label={ipt ? 'IPv6 only (ip6tables; without an address the rule is otherwise added to both iptables and ip6tables)' : 'IPv6 only (when no address is given, the rule otherwise applies to both v4 and v6)'} />
        </div>
        <div className="col-span-6">
          <div className="text-xs text-muted mb-1">Command</div>
          <pre className="bg-bg-2 border border-border rounded-md p-2 text-xs font-mono whitespace-pre-wrap break-all">{preview}</pre>
        </div>
      </div>
    </Modal>
  )
}
