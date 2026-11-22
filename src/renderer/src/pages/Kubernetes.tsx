import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Anchor,
  Ban,
  Boxes,
  CalendarClock,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileText,
  Hash,
  Info,
  Layers,
  ListTree,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Scaling,
  Server,
  Terminal,
  Trash2,
  Zap
} from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import {
  Badge,
  Button,
  Callout,
  Card,
  ContextMenu,
  EmptyState,
  ErrorBox,
  Field,
  IconButton,
  Input,
  Loading,
  MenuButton,
  Modal,
  Page,
  PageHeader,
  Pre,
  SearchInput,
  Select,
  Stat,
  Table,
  Tabs,
  TextArea,
  Toggle,
  confirm,
  useAction,
  useAsync,
  type Column,
  type MenuItem
} from '@/components/ui'
import { useApp } from '@/store/app'
import { useTaskRefresh } from '@/components/PackageUpdate'
import { cls, fmtBytes } from '@/lib/format'
import type {
  K8sApplyMode,
  K8sConfigMap,
  K8sEvent,
  K8sHelmRelease,
  K8sInfo,
  K8sIngress,
  K8sInstallFlavour,
  K8sKind,
  K8sNamespace,
  K8sNode,
  K8sOverview,
  K8sPod,
  K8sPv,
  K8sPvc,
  K8sSecret,
  K8sService,
  K8sStorageClass,
  K8sWorkload,
  K8sWorkloadKind
} from '@shared/modules/kubernetes'

type TabId = 'overview' | 'workloads' | 'pods' | 'network' | 'config' | 'namespaces' | 'apply' | 'events' | 'helm'

/** '' means "All namespaces". */
const ALL_NS = ''

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/

function taskToast(title: string): void {
  useApp.getState().toast({ kind: 'info', title, detail: 'Progress is shown in the Tasks drawer.' })
}

/** kubectl-style age: 45s, 12m, 3h4m, 3d4h, 1y12d. */
export function fmtAge(iso: string | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 120) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  if (d < 365) return `${d}d${h % 24 ? `${h % 24}h` : ''}`
  const y = Math.floor(d / 365)
  return `${y}y${d % 365 ? `${d % 365}d` : ''}`
}

function Age({ iso }: { iso: string | undefined }): React.JSX.Element {
  return (
    <span className="text-xs text-muted whitespace-nowrap" title={iso ? new Date(iso).toLocaleString() : undefined}>
      {fmtAge(iso)}
    </span>
  )
}

function podColor(status: string): 'ok' | 'warn' | 'danger' | 'info' | 'muted' {
  if (status === 'Running') return 'ok'
  if (status === 'Succeeded' || status === 'Completed') return 'muted'
  if (status === 'Pending' || status === 'ContainerCreating' || status === 'PodInitializing' || status === 'Terminating' || status.startsWith('Init:')) return 'warn'
  if (/CrashLoopBackOff|Error|Failed|ImagePull|OOMKilled|Evicted|Unknown|NotReady|BackOff/i.test(status)) return 'danger'
  return 'info'
}

function millicores(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}` : `${n}m`
}

function Mono({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }): React.JSX.Element {
  return (
    <span className={cls('font-mono text-xs', className)} title={title}>
      {children}
    </span>
  )
}

function NsCell({ ns }: { ns: string }): React.JSX.Element {
  return <span className="text-xs text-muted whitespace-nowrap">{ns}</span>
}

function Toolbar({ children, right }: { children?: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-3 min-h-[28px] flex-wrap">
      {children}
      <div className="flex-1" />
      {right}
    </div>
  )
}

function useFilter<T>(rows: T[] | undefined, filter: string, pick: (r: T) => string[]): T[] {
  return useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (rows ?? []).filter((r) => !f || pick(r).some((v) => (v ?? '').toLowerCase().includes(f)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter])
}

/** Kubernetes workloads/pods etc. are listed per namespace; this key scopes caches by server + namespace. */
const ck = (what: string, serverId: string, ns?: string): string => `k8s:${what}:${serverId}:${ns ?? ''}`

/* Draft manifest for the Apply tab survives tab switches (per server). */
const drafts = new Map<string, string>()

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Kubernetes({ serverId }: PageProps): React.JSX.Element {
  const info = useAsync(() => api.call<K8sInfo>('k8s:detect', serverId), [serverId], { cacheKey: ck('info', serverId) })
  const [tab, setTab] = useState<TabId>('overview')
  const [ns, setNs] = useState<string>(ALL_NS)
  const [draft, setDraftState] = useState<string>(() => drafts.get(serverId) ?? '')
  const { run, busy } = useAction()
  const d = info.data

  const setDraft = (v: string): void => {
    drafts.set(serverId, v)
    setDraftState(v)
  }
  const editAndApply = (yaml: string): void => {
    setDraft(yaml)
    setTab('apply')
  }

  useEffect(() => {
    setNs(ALL_NS)
    setDraftState(drafts.get(serverId) ?? '')
  }, [serverId])
  // A deleted namespace falls back to "All".
  useEffect(() => {
    if (ns && d?.namespaces && !d.namespaces.includes(ns)) setNs(ALL_NS)
  }, [d?.namespaces, ns])
  // Installs / uninstalls / helm install finish as tasks: re-detect.
  useTaskRefresh(serverId, () => info.reload())

  const redetect = (): void => void run(() => api.call<K8sInfo>('k8s:detect', serverId, true)).then((r) => r && info.setData(r))

  const installHelm = async (): Promise<void> => {
    if (
      !(await confirm({
        title: 'Install Helm',
        message: (
          <>
            Downloads the official <Mono>get-helm-3</Mono> script from raw.githubusercontent.com and runs it as root. It installs the latest Helm 3 release to <Mono>/usr/local/bin/helm</Mono>.
          </>
        ),
        confirmLabel: 'Install'
      }))
    )
      return
    await run(async () => {
      await api.call('k8s:helmInstall', serverId)
      taskToast('Installing Helm…')
    })
  }
  const uninstallK3s = async (): Promise<void> => {
    if (
      !(await confirm({
        title: 'Uninstall k3s',
        message: 'Runs k3s-uninstall.sh. This stops the cluster and deletes every workload, volume and all cluster data on this node. This cannot be undone.',
        danger: true,
        confirmLabel: 'Uninstall k3s',
        typeToConfirm: 'uninstall'
      }))
    )
      return
    await run(async () => {
      await api.call('k8s:uninstallK3s', serverId)
      taskToast('Uninstalling k3s…')
    })
  }

  const ok = d?.state === 'ok'
  const headerMenu: MenuItem[] = [
    { label: 'Re-detect cluster', icon: <RefreshCw />, onClick: redetect },
    ...(ok && !d?.helm ? [{ label: 'Install Helm', icon: <Download />, onClick: () => void installHelm() }] : []),
    ...(d?.found.k3s ? [{ separator: true, label: '' }, { label: 'Uninstall k3s', icon: <Trash2 />, danger: true, onClick: () => void uninstallK3s() }] : [])
  ]

  return (
    <>
      <PageHeader
        title="Kubernetes"
        subtitle={
          ok ? (
            <span className="inline-flex items-center gap-1.5">
              {d?.distribution && <Badge color="accent">{d.distribution}</Badge>}
              {d?.serverVersion && <Badge>{d.serverVersion}</Badge>}
              {d?.needsSudo && <Badge color="warn">via sudo</Badge>}
              {d?.commandKind && d.commandKind !== 'kubectl' && <Badge color="info">{d.shellPrefix}</Badge>}
            </span>
          ) : d?.clientVersion ? (
            <Badge>kubectl {d.clientVersion}</Badge>
          ) : undefined
        }
        actions={
          <>
            {ok && (
              <div className="w-56">
                <Select value={ns} onChange={(e) => setNs(e.target.value)} className="h-7 text-xs">
                  <option value={ALL_NS}>All namespaces</option>
                  {(d?.namespaces ?? []).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => info.reload()} loading={(info.loading && !!d) || busy} />
            <MenuButton label="More" items={headerMenu} icon={<MoreHorizontal size={13} />} />
          </>
        }
      />
      <Page>
        {info.error ? (
          <ErrorBox error={info.error} onRetry={info.reload} />
        ) : !d ? (
          <Loading label="Detecting kubectl…" />
        ) : d.state === 'missing' ? (
          <InstallPanel serverId={serverId} info={d} />
        ) : d.state === 'no-cluster' ? (
          <>
            <Card className="mb-4">
              <EmptyState
                icon={<Boxes />}
                title="kubectl found, but no cluster is reachable"
                description={
                  <div className="text-left space-y-2">
                    <div>
                      kubectl {d.clientVersion ? `(${d.clientVersion}) ` : ''}could not reach a cluster with the login user's kubeconfig
                      {d.found.k3s ? ', nor with the k3s kubeconfig under sudo' : ''}
                      {d.found.microk8s ? ', nor through microk8s' : ''}.
                    </div>
                    <ul className="list-disc ml-5 space-y-0.5">
                      <li>
                        Point kubectl at a cluster: <Mono>~/.kube/config</Mono> or the <Mono>KUBECONFIG</Mono> variable must be readable by <Mono>{useApp.getState().servers.find((s) => s.id === serverId)?.username ?? 'the login user'}</Mono>.
                      </li>
                      <li>
                        k3s stores its kubeconfig in <Mono>/etc/rancher/k3s/k3s.yaml</Mono> (root only by default); either sudo must work or copy it to <Mono>~/.kube/config</Mono> with <Mono>chmod 600</Mono>.
                      </li>
                      <li>"connection refused" means the API server is down: check <Mono>systemctl status k3s</Mono> / <Mono>microk8s status</Mono> / <Mono>kubelet</Mono>.</li>
                    </ul>
                    {d.error && <Pre className="mt-2 text-left" maxH="max-h-40">{d.error}</Pre>}
                  </div>
                }
                action={
                  <Button variant="primary" icon={<RefreshCw size={13} />} onClick={redetect} loading={busy}>
                    Detect again
                  </Button>
                }
              />
            </Card>
            <InstallPanel serverId={serverId} info={d} />
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4 mt-1 flex-wrap gap-2">
              <Tabs<TabId>
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'overview', label: 'Overview', count: d.nodeCount },
                  { id: 'workloads', label: 'Workloads' },
                  { id: 'pods', label: 'Pods' },
                  { id: 'network', label: 'Services & Ingress' },
                  { id: 'config', label: 'Config & Storage' },
                  { id: 'namespaces', label: 'Namespaces', count: d.namespaces.length },
                  { id: 'events', label: 'Events' },
                  { id: 'apply', label: 'Apply YAML' },
                  { id: 'helm', label: 'Helm' }
                ]}
              />
            </div>
            {tab === 'overview' && <OverviewTab serverId={serverId} info={d} onEdit={editAndApply} />}
            {tab === 'workloads' && <WorkloadsTab serverId={serverId} ns={ns} onEdit={editAndApply} />}
            {tab === 'pods' && <PodsTab serverId={serverId} ns={ns} info={d} onEdit={editAndApply} />}
            {tab === 'network' && <NetworkTab serverId={serverId} ns={ns} onEdit={editAndApply} />}
            {tab === 'config' && <ConfigTab serverId={serverId} ns={ns} onEdit={editAndApply} />}
            {tab === 'namespaces' && <NamespacesTab serverId={serverId} onChanged={() => void info.reload()} />}
            {tab === 'events' && <EventsTab serverId={serverId} ns={ns} />}
            {tab === 'apply' && <ApplyTab serverId={serverId} draft={draft} setDraft={setDraft} />}
            {tab === 'helm' && <HelmTab serverId={serverId} ns={ns} info={d} onInstall={installHelm} busy={busy} />}
          </>
        )}
      </Page>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Shared modals: text (describe / status / history), YAML, KV         */
/* ------------------------------------------------------------------ */

function TextModal({ title, load, onClose, badge, intervalMs }: { title: string; load: () => Promise<string>; onClose: () => void; badge?: React.ReactNode; intervalMs?: number }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(load, [], { intervalMs })
  const { run } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      badge={badge}
      width="max-w-4xl"
      footer={
        <>
          <span className="text-xs text-dim mr-auto">{loading ? 'Loading…' : ''}</span>
          <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} />
          <Button icon={<Copy size={12} />} disabled={!data} onClick={() => void run(() => navigator.clipboard.writeText(data ?? ''), { success: 'Copied' })}>
            Copy
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} onRetry={reload} /> : loading && data === undefined ? <Loading /> : <Pre maxH="max-h-[70vh]">{data || <span className="text-dim">(no output)</span>}</Pre>}
    </Modal>
  )
}

function YamlModal({ serverId, kind, name, ns, onClose, onEdit }: { serverId: string; kind: K8sKind; name: string; ns?: string; onClose: () => void; onEdit: (yaml: string) => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<string>('k8s:getYaml', serverId, kind, name, ns), [])
  const { run } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title={`${kind}/${name}`}
      badge={ns ? <Badge>{ns}</Badge> : undefined}
      width="max-w-4xl"
      footer={
        <>
          <span className="text-xs text-dim mr-auto">Read-only. "Edit & apply" copies it into the Apply YAML tab.</span>
          <Button icon={<Copy size={12} />} disabled={!data} onClick={() => void run(() => navigator.clipboard.writeText(data ?? ''), { success: 'Copied' })}>
            Copy
          </Button>
          <Button
            icon={<FileCode2 size={12} />}
            disabled={!data}
            onClick={() => {
              onEdit(data ?? '')
              onClose()
            }}
          >
            Edit &amp; apply
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} onRetry={reload} /> : loading ? <Loading /> : <Pre maxH="max-h-[70vh]">{data}</Pre>}
    </Modal>
  )
}

function KVModal({ title, badge, load, onClose, hidden, onReveal }: { title: string; badge?: React.ReactNode; load: () => Promise<Record<string, string>>; onClose: () => void; hidden?: string[]; onReveal?: () => Promise<Record<string, string> | undefined> }): React.JSX.Element {
  const needsLoad = !hidden
  const { data, error, loading, reload, setData } = useAsync(load, [], { enabled: needsLoad })
  const [revealed, setRevealed] = useState(false)
  const { run, busy } = useAction()
  const entries = data ? Object.entries(data) : (hidden ?? []).map((k) => [k, ''] as [string, string])
  const reveal = async (): Promise<void> => {
    if (!onReveal) return
    const r = await onReveal()
    if (r) {
      setData(r)
      setRevealed(true)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      badge={badge}
      width="max-w-4xl"
      footer={
        <>
          <span className="text-xs text-dim mr-auto">{entries.length} key{entries.length === 1 ? '' : 's'}</span>
          {hidden && !revealed && (
            <Button icon={<Eye size={12} />} loading={busy} onClick={() => void run(reveal)}>
              Reveal values
            </Button>
          )}
          {(revealed || !hidden) && data && (
            <Button icon={<Copy size={12} />} onClick={() => void run(() => navigator.clipboard.writeText(Object.entries(data).map(([k, v]) => `${k}=${v}`).join('\n')), { success: 'Copied' })}>
              Copy all
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && needsLoad ? (
        <Loading />
      ) : entries.length === 0 ? (
        <EmptyState title="No data keys" />
      ) : (
        <div className="flex flex-col gap-3">
          {entries.map(([k, v]) => (
            <div key={k}>
              <div className="flex items-center justify-between mb-1">
                <Mono className="font-medium text-text">{k}</Mono>
                {(revealed || !hidden) && (
                  <IconButton title="Copy value" size="xs" icon={<Copy size={11} />} onClick={() => void run(() => navigator.clipboard.writeText(v), { success: `Copied ${k}` })} />
                )}
              </div>
              {hidden && !revealed ? <Pre maxH="max-h-10"><span className="text-dim">••••••••••</span></Pre> : <Pre maxH="max-h-60">{v || <span className="text-dim">(empty)</span>}</Pre>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function OverviewTab({ serverId, info, onEdit }: { serverId: string; info: K8sInfo; onEdit: (yaml: string) => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<K8sOverview>('k8s:overview', serverId), [serverId], { intervalMs: 15000, cacheKey: ck('overview', serverId) })
  const [describe, setDescribe] = useState<K8sNode | null>(null)
  const [yaml, setYaml] = useState<K8sNode | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; n: K8sNode } | null>(null)
  const { run } = useAction()

  const cordon = async (n: K8sNode): Promise<void> => {
    await run(() => api.call('k8s:nodeAction', serverId, n.name, n.unschedulable ? 'uncordon' : 'cordon'), { success: `${n.unschedulable ? 'Uncordoned' : 'Cordoned'} ${n.name}` })
    await reload()
  }
  const drain = async (n: K8sNode): Promise<void> => {
    if (
      !(await confirm({
        title: `Drain node ${n.name}`,
        message: (
          <>
            Evicts every pod from <Mono>{n.name}</Mono> and marks it unschedulable:
            <Pre className="mt-2" maxH="max-h-20">{`kubectl drain ${n.name} --ignore-daemonsets --delete-emptydir-data --force`}</Pre>
            Pods not managed by a controller are deleted for good and emptyDir data is lost. Workloads are rescheduled on the remaining nodes (if any).
          </>
        ),
        danger: true,
        confirmLabel: 'Drain'
      }))
    )
      return
    await run(async () => {
      await api.call('k8s:drain', serverId, n.name)
      taskToast(`Draining ${n.name}…`)
    })
  }

  const columns: Column<K8sNode>[] = [
    {
      key: 'name',
      header: 'Node',
      sortValue: (n) => n.name,
      render: (n) => (
        <div className="min-w-0">
          <div className="font-medium flex items-center gap-2">
            {n.name}
            {n.unschedulable && <Badge color="warn">cordoned</Badge>}
          </div>
          <div className="text-dim text-[11px]">{n.roles.join(', ')}</div>
        </div>
      )
    },
    {
      key: 'status',
      header: 'Status',
      width: '100px',
      sortValue: (n) => (n.ready ? 1 : 0),
      render: (n) => (
        <span title={n.readyMessage}>
          <Badge color={n.ready ? 'ok' : 'danger'}>{n.ready ? 'Ready' : 'NotReady'}</Badge>
        </span>
      )
    },
    { key: 'version', header: 'Version', width: '120px', sortValue: (n) => n.version, render: (n) => <Mono>{n.version}</Mono> },
    { key: 'ip', header: 'Internal IP', width: '130px', render: (n) => <Mono>{n.internalIP || '—'}</Mono> },
    {
      key: 'os',
      header: 'OS / kernel',
      render: (n) => (
        <div className="text-xs min-w-0">
          <div className="truncate max-w-[260px]" title={n.os}>
            {n.os}
          </div>
          <div className="text-dim font-mono text-[11px] truncate max-w-[260px]" title={n.containerRuntime}>
            {n.kernel} · {n.containerRuntime}
          </div>
        </div>
      )
    },
    {
      key: 'cpu',
      header: 'CPU',
      width: '130px',
      sortValue: (n) => (n.cpuUsage ?? 0) / Math.max(1, n.cpuCapacity),
      render: (n) => <Usage used={n.cpuUsage} cap={n.cpuCapacity} fmt={millicores} metrics={data?.metrics} />
    },
    {
      key: 'mem',
      header: 'Memory',
      width: '150px',
      sortValue: (n) => (n.memUsage ?? 0) / Math.max(1, n.memCapacity),
      render: (n) => <Usage used={n.memUsage} cap={n.memCapacity} fmt={(v) => fmtBytes(v, 0)} metrics={data?.metrics} />
    },
    { key: 'age', header: 'Age', width: '70px', sortValue: (n) => n.created, render: (n) => <Age iso={n.created} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '120px',
      render: (n) => (
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          <IconButton title={n.unschedulable ? 'Uncordon' : 'Cordon'} size="xs" icon={n.unschedulable ? <Play size={12} /> : <Ban size={12} />} onClick={() => void cordon(n)} />
          <IconButton title="Describe" size="xs" icon={<Info size={12} />} onClick={() => setDescribe(n)} />
          <IconButton title="More" size="xs" icon={<MoreHorizontal size={12} />} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, n })} />
        </div>
      )
    }
  ]

  const menuItems = (n: K8sNode): MenuItem[] => [
    { label: n.unschedulable ? 'Uncordon' : 'Cordon', icon: n.unschedulable ? <Play /> : <Ban />, onClick: () => void cordon(n) },
    { label: 'Drain…', icon: <Zap />, danger: true, onClick: () => void drain(n) },
    { separator: true, label: '' },
    { label: 'Describe', icon: <Info />, onClick: () => setDescribe(n) },
    { label: 'Get YAML', icon: <FileCode2 />, onClick: () => setYaml(n) },
    { label: 'Copy name', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(n.name) }
  ]

  const o = data
  return (
    <>
      {error && !o ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !o ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
            <Stat label="Nodes ready" value={`${o.nodesReady}/${o.nodes.length}`} bar={o.nodes.length ? (o.nodesReady / o.nodes.length) * 100 : undefined} color={o.nodesReady === o.nodes.length ? 'bg-ok' : 'bg-danger'} sub={info.distribution} />
            <Stat label="Pods running" value={o.pods.running} unit={`/ ${o.pods.total}`} sub={`${o.pods.pending} pending · ${o.pods.failed} failed · ${o.pods.succeeded} completed`} />
            <Stat label="Deployments available" value={`${o.deployments.available}/${o.deployments.total}`} bar={o.deployments.total ? (o.deployments.available / o.deployments.total) * 100 : undefined} color={o.deployments.available === o.deployments.total ? 'bg-ok' : 'bg-warn'} />
            <Stat label="Namespaces" value={o.namespaces} />
            <Stat label="Server version" value={<span className="text-base font-mono">{info.serverVersion ?? '—'}</span>} sub={info.clientVersion ? `kubectl ${info.clientVersion}` : undefined} />
            <Stat label="Metrics" value={<span className="text-base">{o.metrics ? 'available' : 'unavailable'}</span>} sub={o.metrics ? 'metrics.k8s.io' : 'install metrics-server for usage'} />
          </div>
          <Card flush title="Nodes" actions={<IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} loading={loading} />}>
            {error ? (
              <div className="p-2">
                <ErrorBox error={error} onRetry={reload} />
              </div>
            ) : null}
            <Table columns={columns} rows={o.nodes} rowKey={(n) => n.name} dense initialSort={{ key: 'name', dir: 'asc' }} onRowContextMenu={(n, e) => setMenu({ x: e.clientX, y: e.clientY, n })} empty={<EmptyState icon={<Server />} title="No nodes" />} />
          </Card>
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.n)} onClose={() => setMenu(null)} />}
      {describe && <TextModal title={`Describe node ${describe.name}`} load={() => api.call<string>('k8s:describe', serverId, 'node', describe.name)} onClose={() => setDescribe(null)} />}
      {yaml && <YamlModal serverId={serverId} kind="node" name={yaml.name} onClose={() => setYaml(null)} onEdit={onEdit} />}
    </>
  )
}

function Usage({ used, cap, fmt, metrics }: { used?: number; cap: number; fmt: (v: number) => string; metrics?: boolean }): React.JSX.Element {
  if (used === undefined || !metrics) return <span className="text-xs text-muted">{fmt(cap)}</span>
  const pct = cap ? (used / cap) * 100 : 0
  return (
    <div className="text-xs">
      <div className="flex justify-between gap-2">
        <span className={cls(pct > 90 ? 'text-danger-fg' : pct > 75 ? 'text-warn-fg' : '')}>{pct.toFixed(0)}%</span>
        <span className="text-dim">
          {fmt(used)} / {fmt(cap)}
        </span>
      </div>
      <div className="h-1 bg-border rounded mt-1 overflow-hidden">
        <div className={cls('h-full rounded', pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Workloads                                                           */
/* ------------------------------------------------------------------ */

const WORKLOAD_TABS: { id: K8sWorkloadKind; label: string }[] = [
  { id: 'deployment', label: 'Deployments' },
  { id: 'statefulset', label: 'StatefulSets' },
  { id: 'daemonset', label: 'DaemonSets' },
  { id: 'job', label: 'Jobs' },
  { id: 'cronjob', label: 'CronJobs' }
]

function WorkloadsTab({ serverId, ns, onEdit }: { serverId: string; ns: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const [kind, setKind] = useState<K8sWorkloadKind>('deployment')
  const { data, error, loading, reload } = useAsync(() => api.call<K8sWorkload[]>('k8s:workloads', serverId, kind, ns || undefined), [serverId, kind, ns], { intervalMs: 10000, cacheKey: ck(`wl:${kind}`, serverId, ns) })
  const [filter, setFilter] = useState('')
  const [scale, setScale] = useState<K8sWorkload | null>(null)
  const [setImage, setSetImage] = useState<K8sWorkload | null>(null)
  const [status, setStatus] = useState<K8sWorkload | null>(null)
  const [describe, setDescribe] = useState<K8sWorkload | null>(null)
  const [yaml, setYaml] = useState<K8sWorkload | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; w: K8sWorkload } | null>(null)
  const { run } = useAction()
  const rows = useFilter(data, filter, (w) => [w.name, w.namespace, ...w.images])

  const restart = async (w: K8sWorkload): Promise<void> => {
    await run(() => api.call('k8s:rolloutRestart', serverId, w.kind, w.name, w.namespace), { success: `Rollout restarted: ${w.name}` })
    await reload()
  }
  const remove = async (w: K8sWorkload): Promise<void> => {
    if (!(await confirm({ title: `Delete ${w.kind}`, message: <>Delete <Mono>{w.kind}/{w.name}</Mono> in namespace <Mono>{w.namespace}</Mono>? Its pods are terminated.</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('k8s:delete', serverId, w.kind, w.name, w.namespace), { success: `Deleted ${w.name}` })
    await reload()
  }
  const suspend = async (w: K8sWorkload, v: boolean): Promise<void> => {
    await run(() => api.call('k8s:cronjobSuspend', serverId, w.name, w.namespace, v), { success: `${v ? 'Suspended' : 'Resumed'} ${w.name}` })
    await reload()
  }
  const trigger = async (w: K8sWorkload): Promise<void> => {
    const job = await run(() => api.call<string>('k8s:cronjobTrigger', serverId, w.name, w.namespace))
    if (job) useApp.getState().toast({ kind: 'success', title: `Job created: ${job}`, detail: 'See the Jobs tab for its progress.' })
    await reload()
  }

  const canScale = kind === 'deployment' || kind === 'statefulset'
  const canRestart = kind !== 'job' && kind !== 'cronjob'
  const columns: Column<K8sWorkload>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (w) => w.name,
      render: (w) => (
        <div className="min-w-0">
          <div className="font-medium truncate max-w-[280px]" title={w.name}>
            {w.name}
          </div>
          {kind === 'cronjob' && <div className="text-dim text-[11px] font-mono">{w.schedule}</div>}
        </div>
      )
    },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '140px', sortValue: (w: K8sWorkload) => w.namespace, render: (w: K8sWorkload) => <NsCell ns={w.namespace} /> } as Column<K8sWorkload>] : []),
    ...(kind === 'cronjob'
      ? ([
          { key: 'suspend', header: 'State', width: '100px', sortValue: (w) => (w.suspend ? 1 : 0), render: (w) => <Badge color={w.suspend ? 'warn' : 'ok'}>{w.suspend ? 'suspended' : 'active'}</Badge> },
          { key: 'active', header: 'Active', width: '70px', align: 'right', sortValue: (w) => w.active ?? 0, render: (w) => <span className="text-xs">{w.active ?? 0}</span> },
          { key: 'last', header: 'Last schedule', width: '110px', sortValue: (w) => w.lastSchedule ?? '', render: (w) => <Age iso={w.lastSchedule} /> }
        ] as Column<K8sWorkload>[])
      : kind === 'job'
        ? ([
            { key: 'status', header: 'Status', width: '100px', sortValue: (w) => w.status ?? '', render: (w) => <Badge color={w.status === 'Complete' ? 'ok' : w.status === 'Failed' ? 'danger' : w.status === 'Running' ? 'info' : 'warn'}>{w.status}</Badge> },
            { key: 'completions', header: 'Completions', width: '100px', align: 'right', sortValue: (w) => w.ready, render: (w) => <span className="text-xs font-mono">{w.ready}/{w.desired}</span> }
          ] as Column<K8sWorkload>[])
        : ([
            {
              key: 'ready',
              header: 'Ready',
              width: '80px',
              align: 'right',
              sortValue: (w) => w.ready / Math.max(1, w.desired),
              render: (w) => <span className={cls('text-xs font-mono', w.desired > 0 && w.ready < w.desired && 'text-warn-fg', w.desired > 0 && w.ready === 0 && 'text-danger-fg')}>{w.ready}/{w.desired}</span>
            },
            { key: 'upToDate', header: 'Up-to-date', width: '90px', align: 'right', sortValue: (w) => w.upToDate ?? 0, render: (w) => <span className="text-xs">{w.upToDate ?? 0}</span> },
            { key: 'available', header: 'Available', width: '90px', align: 'right', sortValue: (w) => w.available ?? 0, render: (w) => <span className="text-xs">{w.available ?? 0}</span> }
          ] as Column<K8sWorkload>[])),
    {
      key: 'images',
      header: 'Image(s)',
      render: (w) => (
        <div className="min-w-0">
          {w.images.map((img, i) => (
            <div key={i} className="font-mono text-[11px] text-muted truncate max-w-[320px]" title={img}>
              {img}
            </div>
          ))}
        </div>
      )
    },
    { key: 'age', header: 'Age', width: '70px', sortValue: (w) => w.created, render: (w) => <Age iso={w.created} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '150px',
      render: (w) => (
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          {canScale && <IconButton title="Scale" size="xs" icon={<Scaling size={12} />} onClick={() => setScale(w)} />}
          {canRestart && <IconButton title="Restart rollout" size="xs" icon={<RotateCw size={12} />} onClick={() => void restart(w)} />}
          {kind === 'cronjob' && <IconButton title="Trigger now" size="xs" icon={<Play size={12} />} onClick={() => void trigger(w)} />}
          {kind === 'cronjob' && <IconButton title={w.suspend ? 'Resume' : 'Suspend'} size="xs" icon={w.suspend ? <Play size={12} /> : <Pause size={12} />} onClick={() => void suspend(w, !w.suspend)} />}
          <IconButton title="Delete" size="xs" icon={<Trash2 size={12} />} onClick={() => void remove(w)} />
          <IconButton title="More" size="xs" icon={<MoreHorizontal size={12} />} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, w })} />
        </div>
      )
    }
  ]

  const menuItems = (w: K8sWorkload): MenuItem[] => [
    ...(canScale ? [{ label: 'Scale…', icon: <Scaling />, onClick: () => setScale(w) }] : []),
    ...(canRestart ? [{ label: 'Restart rollout', icon: <RotateCw />, onClick: () => void restart(w) }, { label: 'Rollout status', icon: <ListTree />, onClick: () => setStatus(w) }] : []),
    ...(canRestart ? [{ label: 'Set image…', icon: <Layers />, onClick: () => setSetImage(w) }] : []),
    ...(kind === 'cronjob' ? [{ label: 'Trigger now', icon: <Play />, onClick: () => void trigger(w) }, { label: w.suspend ? 'Resume' : 'Suspend', icon: w.suspend ? <Play /> : <Pause />, onClick: () => void suspend(w, !w.suspend) }] : []),
    { separator: true, label: '' },
    { label: 'Describe', icon: <Info />, onClick: () => setDescribe(w) },
    { label: 'Get YAML', icon: <FileCode2 />, onClick: () => setYaml(w) },
    { label: 'Copy name', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(w.name) },
    { separator: true, label: '' },
    { label: 'Delete', icon: <Trash2 />, danger: true, onClick: () => void remove(w) }
  ]

  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">{data?.length ?? 0} {WORKLOAD_TABS.find((t) => t.id === kind)?.label.toLowerCase()}</span>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} loading={loading && !!data} />
          </>
        }
      >
        <Tabs<K8sWorkloadKind> value={kind} onChange={setKind} tabs={WORKLOAD_TABS} />
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by name, namespace or image" className="w-72" />
      </Toolbar>
      {error && !data ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          {error ? (
            <div className="p-2">
              <ErrorBox error={error} onRetry={reload} />
            </div>
          ) : null}
          <Table columns={columns} rows={rows} rowKey={(w) => `${w.namespace}/${w.name}`} dense initialSort={{ key: 'name', dir: 'asc' }} onRowContextMenu={(w, e) => setMenu({ x: e.clientX, y: e.clientY, w })} empty={data?.length ? 'Nothing matches the filter' : <EmptyState icon={<Boxes />} title={`No ${WORKLOAD_TABS.find((t) => t.id === kind)?.label.toLowerCase()}`} description={ns ? `in namespace ${ns}` : 'in any namespace'} />} />
        </Card>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.w)} onClose={() => setMenu(null)} />}
      {scale && <ScaleModal serverId={serverId} w={scale} onClose={() => setScale(null)} onDone={() => void reload()} />}
      {setImage && <SetImageModal serverId={serverId} w={setImage} onClose={() => setSetImage(null)} onDone={() => void reload()} />}
      {status && <TextModal title={`Rollout status: ${status.name}`} badge={<Badge>{status.namespace}</Badge>} load={() => api.call<string>('k8s:rolloutStatus', serverId, status.kind, status.name, status.namespace)} onClose={() => setStatus(null)} intervalMs={5000} />}
      {describe && <TextModal title={`Describe ${describe.kind} ${describe.name}`} badge={<Badge>{describe.namespace}</Badge>} load={() => api.call<string>('k8s:describe', serverId, describe.kind, describe.name, describe.namespace)} onClose={() => setDescribe(null)} />}
      {yaml && <YamlModal serverId={serverId} kind={yaml.kind} name={yaml.name} ns={yaml.namespace} onClose={() => setYaml(null)} onEdit={onEdit} />}
    </>
  )
}

function ScaleModal({ serverId, w, onClose, onDone }: { serverId: string; w: K8sWorkload; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [replicas, setReplicas] = useState(String(w.desired))
  const { run, busy } = useAction()
  const n = Number(replicas)
  const valid = Number.isInteger(n) && n >= 0 && n <= 1000
  const submit = async (): Promise<void> => {
    if (n === 0 && !(await confirm({ title: 'Scale to zero', message: <>Scale <Mono>{w.name}</Mono> to 0 replicas? All its pods stop.</>, danger: true, confirmLabel: 'Scale to 0' }))) return
    const r = await run(() => api.call('k8s:scale', serverId, w.kind, w.name, w.namespace, n), { success: `Scaled ${w.name} to ${n}` })
    if (r !== undefined) {
      onDone()
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Scale ${w.kind} ${w.name}`}
      badge={<Badge>{w.namespace}</Badge>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Scale
          </Button>
        </>
      }
    >
      <Field label="Replicas" hint={`Currently ${w.ready}/${w.desired} ready.`}>
        <Input type="number" min={0} max={1000} value={replicas} onChange={(e) => setReplicas(e.target.value)} mono autoFocus onKeyDown={(e) => e.key === 'Enter' && valid && void submit()} />
      </Field>
    </Modal>
  )
}

function SetImageModal({ serverId, w, onClose, onDone }: { serverId: string; w: K8sWorkload; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [container, setContainer] = useState(w.containers[0] ?? '')
  const idx = Math.max(0, w.containers.indexOf(container))
  const [image, setImage] = useState(w.images[idx] ?? '')
  const { run, busy } = useAction()
  const valid = Boolean(container && image.trim())
  const submit = async (): Promise<void> => {
    if (!(await confirm({ title: 'Set image', message: <>Change the image of container <Mono>{container}</Mono> in <Mono>{w.kind}/{w.name}</Mono> to <Mono>{image.trim()}</Mono>? This starts a new rollout.</>, confirmLabel: 'Set image' }))) return
    const r = await run(() => api.call('k8s:setImage', serverId, w.kind, w.name, w.namespace, container, image.trim()), { success: `Image updated: ${w.name}` })
    if (r !== undefined) {
      onDone()
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Set image: ${w.name}`}
      badge={<Badge>{w.namespace}</Badge>}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Set image
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Field label="Container">
          <Select
            value={container}
            onChange={(e) => {
              setContainer(e.target.value)
              const i = w.containers.indexOf(e.target.value)
              if (i >= 0) setImage(w.images[i] ?? '')
            }}
          >
            {w.containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Image" className="col-span-2" hint={w.images[idx] ? `Current: ${w.images[idx]}` : undefined}>
          <Input value={image} onChange={(e) => setImage(e.target.value)} mono autoFocus placeholder="nginx:1.27" />
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Pods                                                                */
/* ------------------------------------------------------------------ */

const POD_STATUS_FILTERS = ['', 'Running', 'Pending', 'Failed', 'Succeeded'] as const

function PodsTab({ serverId, ns, info, onEdit }: { serverId: string; ns: string; info: K8sInfo; onEdit: (yaml: string) => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<K8sPod[]>('k8s:pods', serverId, ns || undefined), [serverId, ns], { intervalMs: 5000, cacheKey: ck('pods', serverId, ns) })
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [logs, setLogs] = useState<K8sPod | null>(null)
  const [describe, setDescribe] = useState<K8sPod | null>(null)
  const [events, setEvents] = useState<K8sPod | null>(null)
  const [yaml, setYaml] = useState<K8sPod | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; p: K8sPod } | null>(null)
  const { run } = useAction()

  const matchesStatus = (p: K8sPod): boolean => {
    if (!statusFilter) return true
    if (statusFilter === 'Running') return p.status === 'Running'
    if (statusFilter === 'Pending') return podColor(p.status) === 'warn'
    if (statusFilter === 'Failed') return podColor(p.status) === 'danger'
    if (statusFilter === 'Succeeded') return p.status === 'Succeeded' || p.status === 'Completed'
    return true
  }
  const textRows = useFilter(data, filter, (p) => [p.name, p.namespace, p.node, p.status, p.ip, p.owner ?? ''])
  const rows = useMemo(() => textRows.filter(matchesStatus), [textRows, statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (p: K8sPod, force: boolean): Promise<void> => {
    if (!(await confirm({ title: force ? 'Force delete pod' : 'Delete pod', message: <>Delete pod <Mono>{p.name}</Mono> in <Mono>{p.namespace}</Mono>?{p.owner ? ` It is managed by ${p.owner} and will be recreated.` : ' It is not managed by a controller and will not come back.'}{force && ' Force deletion skips graceful termination.'}</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('k8s:delete', serverId, 'pod', p.name, p.namespace, force), { success: `Deleted ${p.name}` })
    await reload()
  }
  const shell = (p: K8sPod, container?: string): void => {
    const c = container ?? p.containers[0]
    if (!info.shellPrefix || !K8S_NAME.test(p.namespace) || !K8S_NAME.test(p.name) || !c || !K8S_NAME.test(c)) return
    useApp.getState().openTerminal(serverId, `${info.shellPrefix} exec -it -n ${p.namespace} ${p.name} -c ${c} -- sh -c 'command -v bash >/dev/null && exec bash || exec sh'`)
  }

  const columns: Column<K8sPod>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (p) => p.name,
      render: (p) => (
        <div className="min-w-0">
          <div className="font-medium truncate max-w-[300px]" title={p.name}>
            {p.name}
          </div>
          {p.owner && <div className="text-dim text-[11px] truncate max-w-[300px]">{p.owner}</div>}
        </div>
      )
    },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '140px', sortValue: (p: K8sPod) => p.namespace, render: (p: K8sPod) => <NsCell ns={p.namespace} /> } as Column<K8sPod>] : []),
    { key: 'ready', header: 'Ready', width: '70px', align: 'right', sortValue: (p) => p.readyCount / Math.max(1, p.containerCount), render: (p) => <span className={cls('text-xs font-mono', p.readyCount < p.containerCount && p.status === 'Running' && 'text-warn-fg')}>{p.readyCount}/{p.containerCount}</span> },
    { key: 'status', header: 'Status', width: '140px', sortValue: (p) => p.status, render: (p) => <Badge color={podColor(p.status)}>{p.status}</Badge> },
    { key: 'restarts', header: 'Restarts', width: '80px', align: 'right', sortValue: (p) => p.restarts, render: (p) => <span className={cls('text-xs', p.restarts > 5 && 'text-warn-fg')}>{p.restarts}</span> },
    { key: 'node', header: 'Node', width: '140px', sortValue: (p) => p.node, render: (p) => <Mono className="text-muted truncate block max-w-[140px]" title={p.node}>{p.node || '—'}</Mono> },
    { key: 'ip', header: 'IP', width: '120px', render: (p) => <Mono className="text-muted">{p.ip || '—'}</Mono> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (p) => p.created, render: (p) => <Age iso={p.created} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '150px',
      render: (p) => (
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          <IconButton title="Logs" size="xs" icon={<FileText size={12} />} onClick={() => setLogs(p)} />
          <IconButton title="Shell" size="xs" icon={<Terminal size={12} />} disabled={p.status !== 'Running' || !p.containers.length} onClick={() => shell(p)} />
          <IconButton title="Describe" size="xs" icon={<Info size={12} />} onClick={() => setDescribe(p)} />
          <IconButton title="Delete" size="xs" icon={<Trash2 size={12} />} onClick={() => void remove(p, false)} />
          <IconButton title="More" size="xs" icon={<MoreHorizontal size={12} />} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, p })} />
        </div>
      )
    }
  ]

  const menuItems = (p: K8sPod): MenuItem[] => [
    { label: 'Logs', icon: <FileText />, onClick: () => setLogs(p) },
    ...(p.containers.length > 1 ? p.containers.map((c) => ({ label: `Shell in ${c}`, icon: <Terminal />, disabled: p.status !== 'Running', onClick: () => shell(p, c) })) : [{ label: 'Shell', icon: <Terminal />, disabled: p.status !== 'Running' || !p.containers.length, onClick: () => shell(p) }]),
    { separator: true, label: '' },
    { label: 'Describe', icon: <Info />, onClick: () => setDescribe(p) },
    { label: 'Events', icon: <ListTree />, onClick: () => setEvents(p) },
    { label: 'Get YAML', icon: <FileCode2 />, onClick: () => setYaml(p) },
    { label: 'Copy name', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(p.name) },
    { separator: true, label: '' },
    { label: 'Delete', icon: <Trash2 />, danger: true, onClick: () => void remove(p, false) },
    { label: 'Force delete', icon: <Zap />, danger: true, onClick: () => void remove(p, true) }
  ]

  const counts = useMemo(() => {
    const c = { running: 0, bad: 0 }
    for (const p of data ?? []) {
      if (p.status === 'Running') c.running++
      else if (podColor(p.status) === 'danger') c.bad++
    }
    return c
  }, [data])

  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">
              {counts.running} of {data?.length ?? 0} running{counts.bad ? ` · ${counts.bad} failing` : ''}
            </span>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} loading={loading && !!data} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by name, namespace, node, status or IP" className="w-80" />
        <div className="w-40">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-7 text-xs">
            {POD_STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s || 'All statuses'}
              </option>
            ))}
          </Select>
        </div>
      </Toolbar>
      {error && !data ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          {error ? (
            <div className="p-2">
              <ErrorBox error={error} onRetry={reload} />
            </div>
          ) : null}
          <Table columns={columns} rows={rows} rowKey={(p) => `${p.namespace}/${p.name}`} dense initialSort={{ key: 'name', dir: 'asc' }} onRowContextMenu={(p, e) => setMenu({ x: e.clientX, y: e.clientY, p })} empty={data?.length ? 'No pods match the filter' : <EmptyState icon={<Boxes />} title="No pods" description={ns ? `in namespace ${ns}` : 'in any namespace'} />} />
        </Card>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.p)} onClose={() => setMenu(null)} />}
      {logs && <PodLogsModal serverId={serverId} pod={logs} onClose={() => setLogs(null)} />}
      {describe && <TextModal title={`Describe pod ${describe.name}`} badge={<Badge>{describe.namespace}</Badge>} load={() => api.call<string>('k8s:describe', serverId, 'pod', describe.name, describe.namespace)} onClose={() => setDescribe(null)} />}
      {events && <PodEventsModal serverId={serverId} pod={events} onClose={() => setEvents(null)} />}
      {yaml && <YamlModal serverId={serverId} kind="pod" name={yaml.name} ns={yaml.namespace} onClose={() => setYaml(null)} onEdit={onEdit} />}
    </>
  )
}

const TAILS = [100, 500, 2000]

function PodLogsModal({ serverId, pod, onClose }: { serverId: string; pod: K8sPod; onClose: () => void }): React.JSX.Element {
  const all = [...pod.containers, ...pod.initContainers]
  const [container, setContainer] = useState(all[0] ?? '')
  const [tail, setTail] = useState(500)
  const [previous, setPrevious] = useState(false)
  const [timestamps, setTimestamps] = useState(false)
  const [follow, setFollow] = useState(true)
  const [stick, setStick] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)
  const { data, error, loading, reload } = useAsync(() => api.call<string>('k8s:podLogs', serverId, pod.namespace, pod.name, { container: container || undefined, tail, previous, timestamps }), [pod.name, container, tail, previous, timestamps], { intervalMs: follow ? 3000 : undefined })
  const { run } = useAction()
  useEffect(() => {
    if (stick && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [data, stick])
  const lineCount = useMemo(() => (data ? data.replace(/\r\n?/g, '\n').split('\n').filter((l, i, a) => i < a.length - 1 || l).length : 0), [data])

  return (
    <Modal
      open
      onClose={onClose}
      title={`Logs: ${pod.name}`}
      badge={<Badge color={podColor(pod.status)}>{pod.status}</Badge>}
      width="max-w-5xl"
      footer={
        <>
          <span className="text-xs text-dim mr-auto">
            {lineCount} lines{loading ? ' · refreshing…' : ''}
          </span>
          <Button icon={<Copy size={12} />} onClick={() => void run(() => navigator.clipboard.writeText(data ?? ''), { success: 'Copied to clipboard' })}>
            Copy
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <Field label="Container" className="w-56">
          <Select value={container} onChange={(e) => setContainer(e.target.value)}>
            {pod.containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            {pod.initContainers.map((c) => (
              <option key={`init:${c}`} value={c}>
                {c} (init)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tail" className="w-28">
          <Select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            {TAILS.map((t) => (
              <option key={t} value={t}>
                {t} lines
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-4 self-end h-8">
          <Toggle checked={previous} onChange={setPrevious} label="Previous instance" />
          <Toggle checked={timestamps} onChange={setTimestamps} label="Timestamps" />
          <Toggle checked={follow} onChange={setFollow} label="Follow (3s)" />
          <Toggle checked={stick} onChange={setStick} label="Stick to bottom" />
          <IconButton title="Refresh now" icon={<RefreshCw size={13} />} onClick={() => reload()} />
        </div>
      </div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : (
        <pre ref={preRef} className="bg-bg-2 border border-border rounded-md p-3 text-xs font-mono overflow-auto whitespace-pre-wrap break-words h-[60vh] leading-[1.45]">
          {data === undefined ? <span className="text-dim">Loading…</span> : data || <span className="text-dim">No log output</span>}
        </pre>
      )}
    </Modal>
  )
}

function eventColumns(withNs: boolean): Column<K8sEvent>[] {
  return [
    { key: 'type', header: 'Type', width: '90px', sortValue: (e) => e.type, render: (e) => <Badge color={e.type === 'Warning' ? 'warn' : 'muted'}>{e.type}</Badge> },
    { key: 'reason', header: 'Reason', width: '150px', sortValue: (e) => e.reason, render: (e) => <span className="text-xs font-medium whitespace-nowrap">{e.reason}</span> },
    ...(withNs ? [{ key: 'ns', header: 'Namespace', width: '130px', sortValue: (e: K8sEvent) => e.namespace, render: (e: K8sEvent) => <NsCell ns={e.namespace} /> } as Column<K8sEvent>] : []),
    { key: 'object', header: 'Object', width: '220px', sortValue: (e) => e.object, render: (e) => <Mono className="text-muted truncate block max-w-[220px]" title={e.object}>{e.object}</Mono> },
    { key: 'message', header: 'Message', render: (e) => <span className="text-xs whitespace-pre-wrap break-words">{e.message}</span> },
    { key: 'count', header: 'Count', width: '60px', align: 'right', sortValue: (e) => e.count, render: (e) => <span className="text-xs">{e.count}</span> },
    { key: 'last', header: 'Last seen', width: '90px', sortValue: (e) => e.last, render: (e) => <Age iso={e.last} /> }
  ]
}

function PodEventsModal({ serverId, pod, onClose }: { serverId: string; pod: K8sPod; onClose: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<K8sEvent[]>('k8s:events', serverId, pod.namespace, 'Pod', pod.name), [pod.name], { intervalMs: 5000 })
  return (
    <Modal open onClose={onClose} title={`Events: ${pod.name}`} badge={<Badge>{pod.namespace}</Badge>} width="max-w-5xl" footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table columns={eventColumns(false)} rows={data ?? []} rowKey={(e) => `${e.last}-${e.reason}-${e.count}-${e.message.slice(0, 40)}`} dense initialSort={{ key: 'last', dir: 'desc' }} empty={<EmptyState title="No events" description="Events expire after about an hour." />} />
        </Card>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Services & Ingress                                                  */
/* ------------------------------------------------------------------ */

function NetworkTab({ serverId, ns, onEdit }: { serverId: string; ns: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const svcs = useAsync(() => api.call<K8sService[]>('k8s:services', serverId, ns || undefined), [serverId, ns], { cacheKey: ck('svc', serverId, ns) })
  const ings = useAsync(() => api.call<K8sIngress[]>('k8s:ingresses', serverId, ns || undefined), [serverId, ns], { cacheKey: ck('ing', serverId, ns) })
  const [filter, setFilter] = useState('')
  const [yaml, setYaml] = useState<{ kind: K8sKind; name: string; ns: string } | null>(null)
  const [describe, setDescribe] = useState<{ kind: K8sKind; name: string; ns: string } | null>(null)
  const { run } = useAction()
  const svcRows = useFilter(svcs.data, filter, (s) => [s.name, s.namespace, s.type, s.clusterIP, ...s.externalIPs])
  const ingRows = useFilter(ings.data, filter, (i) => [i.name, i.namespace, i.className, ...i.hosts])

  const remove = async (kind: 'service' | 'ingress', name: string, nsName: string, reload: () => Promise<void>): Promise<void> => {
    if (!(await confirm({ title: `Delete ${kind}`, message: <>Delete <Mono>{kind}/{name}</Mono> in <Mono>{nsName}</Mono>?{kind === 'service' ? ' Clients lose the cluster IP / node ports immediately.' : ' External traffic to its hosts stops.'}</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('k8s:delete', serverId, kind, name, nsName), { success: `Deleted ${name}` })
    await reload()
  }

  const svcColumns: Column<K8sService>[] = [
    { key: 'name', header: 'Name', sortValue: (s) => s.name, render: (s) => <span className="font-medium">{s.name}</span> },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '130px', sortValue: (s: K8sService) => s.namespace, render: (s: K8sService) => <NsCell ns={s.namespace} /> } as Column<K8sService>] : []),
    { key: 'type', header: 'Type', width: '110px', sortValue: (s) => s.type, render: (s) => <Badge color={s.type === 'LoadBalancer' ? 'accent' : s.type === 'NodePort' ? 'info' : 'muted'}>{s.type}</Badge> },
    { key: 'cip', header: 'Cluster IP', width: '130px', render: (s) => <Mono className="text-muted">{s.clusterIP || '—'}</Mono> },
    { key: 'ext', header: 'External IP', width: '150px', render: (s) => <Mono className={s.externalIPs.length ? '' : 'text-dim'}>{s.externalIPs.join(', ') || (s.type === 'LoadBalancer' ? '<pending>' : '—')}</Mono> },
    { key: 'ports', header: 'Ports', render: (s) => <Mono className="text-muted whitespace-pre-wrap">{s.ports.join('  ')}</Mono> },
    {
      key: 'sel',
      header: 'Selector',
      render: (s) => (
        <span className="font-mono text-[11px] text-dim truncate block max-w-[220px]" title={Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(', ')}>
          {Object.entries(s.selector)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ') || '—'}
        </span>
      )
    },
    { key: 'age', header: 'Age', width: '70px', sortValue: (s) => s.created, render: (s) => <Age iso={s.created} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '100px',
      render: (s) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton title="Describe" size="xs" icon={<Info size={12} />} onClick={() => setDescribe({ kind: 'service', name: s.name, ns: s.namespace })} />
          <IconButton title="Get YAML" size="xs" icon={<FileCode2 size={12} />} onClick={() => setYaml({ kind: 'service', name: s.name, ns: s.namespace })} />
          <IconButton title="Delete" size="xs" icon={<Trash2 size={12} />} disabled={s.name === 'kubernetes' && s.namespace === 'default'} onClick={() => void remove('service', s.name, s.namespace, svcs.reload)} />
        </div>
      )
    }
  ]

  const ingColumns: Column<K8sIngress>[] = [
    { key: 'name', header: 'Name', sortValue: (i) => i.name, render: (i) => <span className="font-medium">{i.name}</span> },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '130px', sortValue: (i: K8sIngress) => i.namespace, render: (i: K8sIngress) => <NsCell ns={i.namespace} /> } as Column<K8sIngress>] : []),
    { key: 'class', header: 'Class', width: '100px', sortValue: (i) => i.className, render: (i) => <Badge>{i.className || 'default'}</Badge> },
    {
      key: 'rules',
      header: 'Host / path → backend',
      render: (i) => (
        <div className="font-mono text-[11px] text-muted">
          {i.rules.map((r, k) => (
            <div key={k} className="whitespace-nowrap">
              <span className="text-text">{r.host}</span>
              {r.path} <span className="text-dim">→</span> {r.backend || '—'}
            </div>
          ))}
        </div>
      )
    },
    { key: 'tls', header: 'TLS', width: '60px', sortValue: (i) => (i.tls ? 1 : 0), render: (i) => <Badge color={i.tls ? 'ok' : 'muted'}>{i.tls ? 'yes' : 'no'}</Badge> },
    { key: 'addr', header: 'Address', width: '150px', render: (i) => <Mono className="text-muted">{i.addresses.join(', ') || '—'}</Mono> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (i) => i.created, render: (i) => <Age iso={i.created} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '100px',
      render: (i) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton title="Describe" size="xs" icon={<Info size={12} />} onClick={() => setDescribe({ kind: 'ingress', name: i.name, ns: i.namespace })} />
          <IconButton title="Get YAML" size="xs" icon={<FileCode2 size={12} />} onClick={() => setYaml({ kind: 'ingress', name: i.name, ns: i.namespace })} />
          <IconButton title="Delete" size="xs" icon={<Trash2 size={12} />} onClick={() => void remove('ingress', i.name, i.namespace, ings.reload)} />
        </div>
      )
    }
  ]

  return (
    <>
      <Toolbar
        right={
          <IconButton
            title="Refresh"
            icon={<RefreshCw size={13} />}
            onClick={() => {
              void svcs.reload()
              void ings.reload()
            }}
          />
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter services and ingresses" className="w-72" />
      </Toolbar>
      <Card flush title={`Services (${svcs.data?.length ?? 0})`} className="mb-4">
        {svcs.error ? (
          <div className="p-2">
            <ErrorBox error={svcs.error} onRetry={svcs.reload} />
          </div>
        ) : svcs.loading && !svcs.data ? (
          <Loading />
        ) : (
          <Table columns={svcColumns} rows={svcRows} rowKey={(s) => `${s.namespace}/${s.name}`} dense initialSort={{ key: 'name', dir: 'asc' }} empty={svcs.data?.length ? 'No services match the filter' : <EmptyState icon={<Anchor />} title="No services" />} />
        )}
      </Card>
      <Card flush title={`Ingresses (${ings.data?.length ?? 0})`}>
        {ings.error ? (
          <div className="p-2">
            <ErrorBox error={ings.error} onRetry={ings.reload} />
          </div>
        ) : ings.loading && !ings.data ? (
          <Loading />
        ) : (
          <Table columns={ingColumns} rows={ingRows} rowKey={(i) => `${i.namespace}/${i.name}`} dense initialSort={{ key: 'name', dir: 'asc' }} empty={ings.data?.length ? 'No ingresses match the filter' : <EmptyState icon={<Anchor />} title="No ingresses" description="An ingress controller (traefik on k3s, ingress-nginx…) must be installed for ingresses to work." />} />
        )}
      </Card>
      {yaml && <YamlModal serverId={serverId} kind={yaml.kind} name={yaml.name} ns={yaml.ns} onClose={() => setYaml(null)} onEdit={onEdit} />}
      {describe && <TextModal title={`Describe ${describe.kind} ${describe.name}`} badge={<Badge>{describe.ns}</Badge>} load={() => api.call<string>('k8s:describe', serverId, describe.kind, describe.name, describe.ns)} onClose={() => setDescribe(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Config & Storage                                                    */
/* ------------------------------------------------------------------ */

type ConfigSub = 'configmaps' | 'secrets' | 'pvcs' | 'pvs' | 'storageclasses'

function ConfigTab({ serverId, ns, onEdit }: { serverId: string; ns: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const [sub, setSub] = useState<ConfigSub>('configmaps')
  return (
    <>
      <Toolbar>
        <Tabs<ConfigSub>
          value={sub}
          onChange={setSub}
          tabs={[
            { id: 'configmaps', label: 'ConfigMaps' },
            { id: 'secrets', label: 'Secrets' },
            { id: 'pvcs', label: 'PersistentVolumeClaims' },
            { id: 'pvs', label: 'PersistentVolumes' },
            { id: 'storageclasses', label: 'StorageClasses' }
          ]}
        />
      </Toolbar>
      {sub === 'configmaps' && <ConfigMapsTable serverId={serverId} ns={ns} onEdit={onEdit} />}
      {sub === 'secrets' && <SecretsTable serverId={serverId} ns={ns} onEdit={onEdit} />}
      {sub === 'pvcs' && <PvcTable serverId={serverId} ns={ns} onEdit={onEdit} />}
      {sub === 'pvs' && <PvTable serverId={serverId} onEdit={onEdit} />}
      {sub === 'storageclasses' && <StorageClassTable serverId={serverId} onEdit={onEdit} />}
    </>
  )
}

function ListShell<T>({ state, rows, columns, rowKey, filter, setFilter, placeholder, emptyTitle, right }: { state: { data: T[] | undefined; error: unknown; loading: boolean; reload: () => Promise<void> }; rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; filter: string; setFilter: (v: string) => void; placeholder: string; emptyTitle: string; right?: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">{state.data?.length ?? 0} items</span>
            {right}
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => state.reload()} loading={state.loading && !!state.data} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder={placeholder} className="w-72" />
      </Toolbar>
      {state.error && !state.data ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : state.loading && !state.data ? (
        <Loading />
      ) : (
        <Card flush>
          {state.error ? (
            <div className="p-2">
              <ErrorBox error={state.error} onRetry={state.reload} />
            </div>
          ) : null}
          <Table columns={columns} rows={rows} rowKey={rowKey} dense initialSort={{ key: 'name', dir: 'asc' }} empty={state.data?.length ? 'Nothing matches the filter' : <EmptyState icon={<Hash />} title={emptyTitle} />} />
        </Card>
      )}
    </>
  )
}

function rowActions(kind: K8sKind, opts: { onView?: () => void; onYaml: () => void; onDelete?: () => void; onDescribe?: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-0.5">
      {opts.onView && <IconButton title="View data" size="xs" icon={<Eye size={12} />} onClick={opts.onView} />}
      {opts.onDescribe && <IconButton title="Describe" size="xs" icon={<Info size={12} />} onClick={opts.onDescribe} />}
      <IconButton title="Get YAML" size="xs" icon={<FileCode2 size={12} />} onClick={opts.onYaml} />
      {opts.onDelete && <IconButton title={`Delete ${kind}`} size="xs" icon={<Trash2 size={12} />} onClick={opts.onDelete} />}
    </div>
  )
}

function useDelete(serverId: string): (kind: K8sKind, name: string, ns: string | undefined, extra: string, reload: () => Promise<void>) => Promise<void> {
  const { run } = useAction()
  return async (kind, name, ns, extra, reload) => {
    if (!(await confirm({ title: `Delete ${kind}`, message: <>Delete <Mono>{kind}/{name}</Mono>{ns ? <> in <Mono>{ns}</Mono></> : null}? {extra}</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('k8s:delete', serverId, kind, name, ns), { success: `Deleted ${name}` })
    await reload()
  }
}

function ConfigMapsTable({ serverId, ns, onEdit }: { serverId: string; ns: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const state = useAsync(() => api.call<K8sConfigMap[]>('k8s:configmaps', serverId, ns || undefined), [serverId, ns], { cacheKey: ck('cm', serverId, ns) })
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<K8sConfigMap | null>(null)
  const [yaml, setYaml] = useState<K8sConfigMap | null>(null)
  const del = useDelete(serverId)
  const rows = useFilter(state.data, filter, (c) => [c.name, c.namespace, ...c.keys])
  const columns: Column<K8sConfigMap>[] = [
    { key: 'name', header: 'Name', sortValue: (c) => c.name, render: (c) => <span className="font-medium">{c.name}</span> },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '140px', sortValue: (c: K8sConfigMap) => c.namespace, render: (c: K8sConfigMap) => <NsCell ns={c.namespace} /> } as Column<K8sConfigMap>] : []),
    { key: 'keys', header: 'Keys', sortValue: (c) => c.keys.length + c.binaryKeys.length, render: (c) => <span className="text-xs text-muted truncate block max-w-[420px]" title={[...c.keys, ...c.binaryKeys].join(', ')}>{c.keys.length + c.binaryKeys.length} · {[...c.keys, ...c.binaryKeys].join(', ') || '—'}</span> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (c) => c.created, render: (c) => <Age iso={c.created} /> },
    { key: 'actions', header: '', align: 'right', width: '100px', render: (c) => rowActions('configmap', { onView: () => setView(c), onYaml: () => setYaml(c), onDelete: () => void del('configmap', c.name, c.namespace, 'Pods that mount it keep the old values until restarted.', state.reload) }) }
  ]
  return (
    <>
      <ListShell state={state} rows={rows} columns={columns} rowKey={(c) => `${c.namespace}/${c.name}`} filter={filter} setFilter={setFilter} placeholder="Filter configmaps" emptyTitle="No configmaps" />
      {view && <KVModal title={`ConfigMap ${view.name}`} badge={<Badge>{view.namespace}</Badge>} load={() => api.call<Record<string, string>>('k8s:configmapData', serverId, view.namespace, view.name)} onClose={() => setView(null)} />}
      {yaml && <YamlModal serverId={serverId} kind="configmap" name={yaml.name} ns={yaml.namespace} onClose={() => setYaml(null)} onEdit={onEdit} />}
    </>
  )
}

function SecretsTable({ serverId, ns, onEdit }: { serverId: string; ns: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const state = useAsync(() => api.call<K8sSecret[]>('k8s:secrets', serverId, ns || undefined), [serverId, ns], { cacheKey: ck('secrets', serverId, ns) })
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<K8sSecret | null>(null)
  const [yaml, setYaml] = useState<K8sSecret | null>(null)
  const del = useDelete(serverId)
  const rows = useFilter(state.data, filter, (s) => [s.name, s.namespace, s.type, ...s.keys])
  const reveal = async (s: K8sSecret): Promise<Record<string, string> | undefined> => {
    if (!(await confirm({ title: 'Reveal secret values', message: <>Decode and display the values of secret <Mono>{s.name}</Mono> on screen? This is recorded in the activity log.</>, danger: true, confirmLabel: 'Reveal' }))) return undefined
    return api.call<Record<string, string>>('k8s:secretReveal', serverId, s.namespace, s.name)
  }
  const columns: Column<K8sSecret>[] = [
    { key: 'name', header: 'Name', sortValue: (s) => s.name, render: (s) => <span className="font-medium">{s.name}</span> },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '140px', sortValue: (s: K8sSecret) => s.namespace, render: (s: K8sSecret) => <NsCell ns={s.namespace} /> } as Column<K8sSecret>] : []),
    { key: 'type', header: 'Type', width: '220px', sortValue: (s) => s.type, render: (s) => <Mono className="text-muted">{s.type}</Mono> },
    { key: 'keys', header: 'Keys', sortValue: (s) => s.keys.length, render: (s) => <span className="text-xs text-muted truncate block max-w-[360px]" title={s.keys.join(', ')}>{s.keys.length} · {s.keys.join(', ') || '—'}</span> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (s) => s.created, render: (s) => <Age iso={s.created} /> },
    { key: 'actions', header: '', align: 'right', width: '100px', render: (s) => rowActions('secret', { onView: () => setView(s), onYaml: () => setYaml(s), onDelete: () => void del('secret', s.name, s.namespace, 'Workloads referencing it fail to start until it is recreated.', state.reload) }) }
  ]
  return (
    <>
      <ListShell state={state} rows={rows} columns={columns} rowKey={(s) => `${s.namespace}/${s.name}`} filter={filter} setFilter={setFilter} placeholder="Filter secrets" emptyTitle="No secrets" />
      {view && <KVModal title={`Secret ${view.name}`} badge={<Badge>{view.type}</Badge>} hidden={view.keys} load={() => Promise.resolve({})} onReveal={() => reveal(view)} onClose={() => setView(null)} />}
      {yaml && <YamlModal serverId={serverId} kind="secret" name={yaml.name} ns={yaml.namespace} onClose={() => setYaml(null)} onEdit={onEdit} />}
    </>
  )
}

function PvcTable({ serverId, ns, onEdit }: { serverId: string; ns: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const state = useAsync(() => api.call<K8sPvc[]>('k8s:pvcs', serverId, ns || undefined), [serverId, ns], { cacheKey: ck('pvc', serverId, ns) })
  const [filter, setFilter] = useState('')
  const [yaml, setYaml] = useState<K8sPvc | null>(null)
  const [describe, setDescribe] = useState<K8sPvc | null>(null)
  const del = useDelete(serverId)
  const rows = useFilter(state.data, filter, (p) => [p.name, p.namespace, p.status, p.volume, p.storageClass])
  const columns: Column<K8sPvc>[] = [
    { key: 'name', header: 'Name', sortValue: (p) => p.name, render: (p) => <span className="font-medium">{p.name}</span> },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '140px', sortValue: (p: K8sPvc) => p.namespace, render: (p: K8sPvc) => <NsCell ns={p.namespace} /> } as Column<K8sPvc>] : []),
    { key: 'status', header: 'Status', width: '90px', sortValue: (p) => p.status, render: (p) => <Badge color={p.status === 'Bound' ? 'ok' : p.status === 'Pending' ? 'warn' : p.status === 'Lost' ? 'danger' : 'muted'}>{p.status}</Badge> },
    { key: 'volume', header: 'Volume', render: (p) => <Mono className="text-muted truncate block max-w-[280px]" title={p.volume}>{p.volume || '—'}</Mono> },
    { key: 'cap', header: 'Capacity', width: '90px', align: 'right', render: (p) => <Mono>{p.capacity || '—'}</Mono> },
    { key: 'modes', header: 'Access modes', width: '120px', render: (p) => <span className="text-xs text-muted">{p.accessModes.join(', ')}</span> },
    { key: 'sc', header: 'Storage class', width: '130px', sortValue: (p) => p.storageClass, render: (p) => <span className="text-xs">{p.storageClass || '—'}</span> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (p) => p.created, render: (p) => <Age iso={p.created} /> },
    { key: 'actions', header: '', align: 'right', width: '100px', render: (p) => rowActions('persistentvolumeclaim', { onDescribe: () => setDescribe(p), onYaml: () => setYaml(p), onDelete: () => void del('persistentvolumeclaim', p.name, p.namespace, 'With a "Delete" reclaim policy the underlying volume and its data are removed too. Deletion waits while a pod still uses the claim.', state.reload) }) }
  ]
  return (
    <>
      <ListShell state={state} rows={rows} columns={columns} rowKey={(p) => `${p.namespace}/${p.name}`} filter={filter} setFilter={setFilter} placeholder="Filter claims" emptyTitle="No persistent volume claims" />
      {yaml && <YamlModal serverId={serverId} kind="persistentvolumeclaim" name={yaml.name} ns={yaml.namespace} onClose={() => setYaml(null)} onEdit={onEdit} />}
      {describe && <TextModal title={`Describe pvc ${describe.name}`} badge={<Badge>{describe.namespace}</Badge>} load={() => api.call<string>('k8s:describe', serverId, 'persistentvolumeclaim', describe.name, describe.namespace)} onClose={() => setDescribe(null)} />}
    </>
  )
}

function PvTable({ serverId, onEdit }: { serverId: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const state = useAsync(() => api.call<K8sPv[]>('k8s:pvs', serverId), [serverId], { cacheKey: ck('pv', serverId) })
  const [filter, setFilter] = useState('')
  const [yaml, setYaml] = useState<K8sPv | null>(null)
  const rows = useFilter(state.data, filter, (p) => [p.name, p.status, p.claim, p.storageClass])
  const columns: Column<K8sPv>[] = [
    { key: 'name', header: 'Name', sortValue: (p) => p.name, render: (p) => <Mono className="font-medium text-text">{p.name}</Mono> },
    { key: 'cap', header: 'Capacity', width: '90px', align: 'right', render: (p) => <Mono>{p.capacity || '—'}</Mono> },
    { key: 'modes', header: 'Access modes', width: '120px', render: (p) => <span className="text-xs text-muted">{p.accessModes.join(', ')}</span> },
    { key: 'reclaim', header: 'Reclaim', width: '90px', sortValue: (p) => p.reclaimPolicy, render: (p) => <Badge color={p.reclaimPolicy === 'Delete' ? 'warn' : 'muted'}>{p.reclaimPolicy}</Badge> },
    { key: 'status', header: 'Status', width: '90px', sortValue: (p) => p.status, render: (p) => <Badge color={p.status === 'Bound' ? 'ok' : p.status === 'Available' ? 'info' : p.status === 'Failed' ? 'danger' : 'warn'}>{p.status}</Badge> },
    { key: 'claim', header: 'Claim', render: (p) => <Mono className="text-muted">{p.claim || '—'}</Mono> },
    { key: 'sc', header: 'Storage class', width: '130px', sortValue: (p) => p.storageClass, render: (p) => <span className="text-xs">{p.storageClass || '—'}</span> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (p) => p.created, render: (p) => <Age iso={p.created} /> },
    { key: 'actions', header: '', align: 'right', width: '60px', render: (p) => rowActions('persistentvolume', { onYaml: () => setYaml(p) }) }
  ]
  return (
    <>
      <ListShell state={state} rows={rows} columns={columns} rowKey={(p) => p.name} filter={filter} setFilter={setFilter} placeholder="Filter volumes" emptyTitle="No persistent volumes" />
      {yaml && <YamlModal serverId={serverId} kind="persistentvolume" name={yaml.name} onClose={() => setYaml(null)} onEdit={onEdit} />}
    </>
  )
}

function StorageClassTable({ serverId, onEdit }: { serverId: string; onEdit: (yaml: string) => void }): React.JSX.Element {
  const state = useAsync(() => api.call<K8sStorageClass[]>('k8s:storageclasses', serverId), [serverId], { cacheKey: ck('sc', serverId) })
  const [filter, setFilter] = useState('')
  const [yaml, setYaml] = useState<K8sStorageClass | null>(null)
  const rows = useFilter(state.data, filter, (s) => [s.name, s.provisioner])
  const columns: Column<K8sStorageClass>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (s) => s.name,
      render: (s) => (
        <span className="font-medium inline-flex items-center gap-2">
          {s.name}
          {s.isDefault && <Badge color="accent">default</Badge>}
        </span>
      )
    },
    { key: 'prov', header: 'Provisioner', render: (s) => <Mono className="text-muted">{s.provisioner}</Mono> },
    { key: 'reclaim', header: 'Reclaim policy', width: '120px', render: (s) => <span className="text-xs">{s.reclaimPolicy}</span> },
    { key: 'bind', header: 'Binding mode', width: '170px', render: (s) => <span className="text-xs">{s.bindingMode}</span> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (s) => s.created, render: (s) => <Age iso={s.created} /> },
    { key: 'actions', header: '', align: 'right', width: '60px', render: (s) => rowActions('storageclass', { onYaml: () => setYaml(s) }) }
  ]
  return (
    <>
      <ListShell state={state} rows={rows} columns={columns} rowKey={(s) => s.name} filter={filter} setFilter={setFilter} placeholder="Filter storage classes" emptyTitle="No storage classes" />
      {yaml && <YamlModal serverId={serverId} kind="storageclass" name={yaml.name} onClose={() => setYaml(null)} onEdit={onEdit} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Namespaces                                                          */
/* ------------------------------------------------------------------ */

const SYSTEM_NS = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease'])

function NamespacesTab({ serverId, onChanged }: { serverId: string; onChanged: () => void }): React.JSX.Element {
  const state = useAsync(() => api.call<K8sNamespace[]>('k8s:namespaces', serverId), [serverId], { cacheKey: ck('ns', serverId) })
  const [filter, setFilter] = useState('')
  const [create, setCreate] = useState(false)
  const [describe, setDescribe] = useState<K8sNamespace | null>(null)
  const { run } = useAction()
  const rows = useFilter(state.data, filter, (n) => [n.name, n.status])
  const remove = async (n: K8sNamespace): Promise<void> => {
    if (
      !(await confirm({
        title: 'Delete namespace',
        message: (
          <>
            Delete namespace <Mono>{n.name}</Mono> and <b>everything in it</b> ({n.pods} pod{n.pods === 1 ? '' : 's'}, services, secrets, volumes claims…)? This cannot be undone.
          </>
        ),
        danger: true,
        confirmLabel: 'Delete namespace',
        typeToConfirm: n.name
      }))
    )
      return
    await run(() => api.call('k8s:delete', serverId, 'namespace', n.name), { success: `Deleting ${n.name}…` })
    await state.reload()
    onChanged()
  }
  const columns: Column<K8sNamespace>[] = [
    { key: 'name', header: 'Name', sortValue: (n) => n.name, render: (n) => <span className="font-medium">{n.name}</span> },
    { key: 'status', header: 'Status', width: '110px', sortValue: (n) => n.status, render: (n) => <Badge color={n.status === 'Active' ? 'ok' : n.status === 'Terminating' ? 'warn' : 'muted'}>{n.status}</Badge> },
    { key: 'pods', header: 'Pods', width: '70px', align: 'right', sortValue: (n) => n.pods, render: (n) => <span className="text-xs">{n.pods}</span> },
    { key: 'age', header: 'Age', width: '70px', sortValue: (n) => n.created, render: (n) => <Age iso={n.created} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '80px',
      render: (n) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton title="Describe" size="xs" icon={<Info size={12} />} onClick={() => setDescribe(n)} />
          <IconButton title={SYSTEM_NS.has(n.name) ? 'System namespace' : 'Delete'} size="xs" icon={<Trash2 size={12} />} disabled={SYSTEM_NS.has(n.name)} onClick={() => void remove(n)} />
        </div>
      )
    }
  ]
  return (
    <>
      <ListShell
        state={state}
        rows={rows}
        columns={columns}
        rowKey={(n) => n.name}
        filter={filter}
        setFilter={setFilter}
        placeholder="Filter namespaces"
        emptyTitle="No namespaces"
        right={
          <Button icon={<Plus size={12} />} onClick={() => setCreate(true)}>
            Create namespace
          </Button>
        }
      />
      {create && (
        <CreateNamespaceModal
          serverId={serverId}
          onClose={() => setCreate(false)}
          onCreated={() => {
            void state.reload()
            onChanged()
          }}
        />
      )}
      {describe && <TextModal title={`Describe namespace ${describe.name}`} load={() => api.call<string>('k8s:describe', serverId, 'namespace', describe.name)} onClose={() => setDescribe(null)} />}
    </>
  )
}

function CreateNamespaceModal({ serverId, onClose, onCreated }: { serverId: string; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const { run, busy } = useAction()
  const valid = K8S_NAME.test(name) && name.length <= 63
  const submit = async (): Promise<void> => {
    const r = await run(() => api.call('k8s:createNamespace', serverId, name), { success: `Namespace ${name} created` })
    if (r !== undefined) {
      onCreated()
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Create namespace"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <Field label="Name" hint="Lowercase letters, digits and dashes; max 63 characters.">
        <Input value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="my-app" mono autoFocus onKeyDown={(e) => e.key === 'Enter' && valid && void submit()} />
      </Field>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function EventsTab({ serverId, ns }: { serverId: string; ns: string }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<K8sEvent[]>('k8s:events', serverId, ns || undefined), [serverId, ns], { intervalMs: 10000, cacheKey: ck('events', serverId, ns) })
  const [warnOnly, setWarnOnly] = useState(false)
  const [filter, setFilter] = useState('')
  const textRows = useFilter(data, filter, (e) => [e.reason, e.object, e.message, e.namespace])
  const rows = useMemo(() => (warnOnly ? textRows.filter((e) => e.type === 'Warning') : textRows), [textRows, warnOnly])
  const warnings = (data ?? []).filter((e) => e.type === 'Warning').length
  return (
    <>
      <Toolbar
        right={
          <>
            <span className="text-xs text-muted mr-2">
              {data?.length ?? 0} events · {warnings} warning{warnings === 1 ? '' : 's'}
            </span>
            <IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => reload()} loading={loading && !!data} />
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter by reason, object or message" className="w-80" />
        <Toggle checked={warnOnly} onChange={setWarnOnly} label="Warnings only" />
      </Toolbar>
      {error && !data ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <Card flush>
          <Table columns={eventColumns(ns === ALL_NS)} rows={rows} rowKey={(e) => `${e.namespace}/${e.object}/${e.reason}/${e.last}/${e.message.slice(0, 40)}`} dense initialSort={{ key: 'last', dir: 'desc' }} empty={data?.length ? 'No events match the filter' : <EmptyState icon={<ListTree />} title="No recent events" description="Kubernetes keeps events for about an hour." />} />
        </Card>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Apply YAML                                                          */
/* ------------------------------------------------------------------ */

function ApplyTab({ serverId, draft, setDraft }: { serverId: string; draft: string; setDraft: (v: string) => void }): React.JSX.Element {
  const [output, setOutput] = useState<{ mode: K8sApplyMode; text: string; ok: boolean } | null>(null)
  const { run, busy } = useAction()
  const go = async (mode: K8sApplyMode): Promise<void> => {
    if (mode === 'delete' && !(await confirm({ title: 'Delete resources from manifest', message: 'Runs kubectl delete -f with the manifest below. Every resource it describes is deleted.', danger: true, confirmLabel: 'Delete' }))) return
    if (mode === 'apply' && !(await confirm({ title: 'Apply manifest', message: 'Runs kubectl apply -f with the manifest below. Existing resources are updated in place, new ones created.', confirmLabel: 'Apply' }))) return
    setOutput(null)
    try {
      const text = await api.call<string>('k8s:apply', serverId, draft, mode)
      setOutput({ mode, text, ok: true })
      if (mode !== 'dry-run') useApp.getState().toast({ kind: 'success', title: mode === 'apply' ? 'Manifest applied' : 'Resources deleted' })
    } catch (e) {
      setOutput({ mode, text: e instanceof Error ? e.message : String(e), ok: false })
    }
  }
  const empty = !draft.trim()
  return (
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
      <Card
        className="xl:col-span-3"
        title="Manifest"
        actions={
          <>
            <Button size="xs" variant="ghost" icon={<Copy size={11} />} disabled={empty} onClick={() => void run(() => navigator.clipboard.writeText(draft), { success: 'Copied' })}>
              Copy
            </Button>
            <Button size="xs" variant="ghost" disabled={empty} onClick={() => setDraft('')}>
              Clear
            </Button>
          </>
        }
      >
        <TextArea value={draft} onChange={(e) => setDraft(e.target.value)} mono rows={22} spellCheck={false} placeholder={'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: default\nspec:\n  replicas: 2\n  …'} className="min-h-[420px]" />
        <div className="flex items-center gap-2 mt-3">
          <Button icon={<Eye size={12} />} disabled={empty} loading={busy} onClick={() => void run(() => go('dry-run'))}>
            Dry run (server)
          </Button>
          <Button variant="primary" icon={<Play size={12} />} disabled={empty} loading={busy} onClick={() => void run(() => go('apply'))}>
            Apply
          </Button>
          <div className="flex-1" />
          <Button variant="danger" icon={<Trash2 size={12} />} disabled={empty} loading={busy} onClick={() => void run(() => go('delete'))}>
            Delete
          </Button>
        </div>
        <div className="text-[11px] text-dim mt-2">The manifest is streamed to kubectl's stdin on the server; multi-document YAML (---) is supported. Resources without a namespace go to the kubeconfig's default namespace.</div>
      </Card>
      <Card className="xl:col-span-2" title="Output" actions={output && <Badge color={output.ok ? 'ok' : 'danger'}>{output.mode}</Badge>}>
        {output ? <Pre maxH="max-h-[520px]" className={cls(!output.ok && 'border-danger/40')}>{output.text}</Pre> : <EmptyState icon={<FileCode2 />} title="No output yet" description="Paste a manifest or open any resource's YAML and choose “Edit & apply”, then dry-run or apply it." />}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Helm                                                                */
/* ------------------------------------------------------------------ */

function HelmTab({ serverId, ns, info, onInstall, busy }: { serverId: string; ns: string; info: K8sInfo; onInstall: () => Promise<void>; busy: boolean }): React.JSX.Element {
  const state = useAsync(() => api.call<K8sHelmRelease[]>('k8s:helmReleases', serverId, ns || undefined), [serverId, ns], { enabled: info.helm, cacheKey: ck('helm', serverId, ns) })
  const [filter, setFilter] = useState('')
  const [history, setHistory] = useState<K8sHelmRelease | null>(null)
  const { run } = useAction()
  const rows = useFilter(state.data, filter, (r) => [r.name, r.namespace, r.chart, r.status])
  if (!info.helm) {
    return (
      <Card>
        <EmptyState
          icon={<Anchor />}
          title="Helm is not installed"
          description="Helm is the package manager for Kubernetes. Install it with the official get-helm-3 script to list, inspect and uninstall releases from here."
          action={
            <Button variant="primary" icon={<Download size={13} />} loading={busy} onClick={() => void onInstall()}>
              Install Helm
            </Button>
          }
        />
      </Card>
    )
  }
  const uninstall = async (r: K8sHelmRelease): Promise<void> => {
    if (!(await confirm({ title: 'Uninstall release', message: <>Uninstall Helm release <Mono>{r.name}</Mono> from <Mono>{r.namespace}</Mono>? All resources of chart <Mono>{r.chart}</Mono> are deleted (persistent volume claims may remain).</>, danger: true, confirmLabel: 'Uninstall' }))) return
    await run(() => api.call('k8s:helmUninstall', serverId, r.name, r.namespace), { success: `Uninstalled ${r.name}` })
    await state.reload()
  }
  const columns: Column<K8sHelmRelease>[] = [
    { key: 'name', header: 'Release', sortValue: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    ...(ns === ALL_NS ? [{ key: 'ns', header: 'Namespace', width: '140px', sortValue: (r: K8sHelmRelease) => r.namespace, render: (r: K8sHelmRelease) => <NsCell ns={r.namespace} /> } as Column<K8sHelmRelease>] : []),
    { key: 'chart', header: 'Chart', sortValue: (r) => r.chart, render: (r) => <Mono>{r.chart}</Mono> },
    { key: 'app', header: 'App version', width: '110px', render: (r) => <Mono className="text-muted">{r.appVersion || '—'}</Mono> },
    { key: 'rev', header: 'Rev', width: '50px', align: 'right', sortValue: (r) => Number(r.revision), render: (r) => <span className="text-xs">{r.revision}</span> },
    { key: 'status', header: 'Status', width: '110px', sortValue: (r) => r.status, render: (r) => <Badge color={r.status === 'deployed' ? 'ok' : r.status === 'failed' ? 'danger' : /pending|uninstalling/.test(r.status) ? 'warn' : 'muted'}>{r.status}</Badge> },
    { key: 'updated', header: 'Updated', width: '160px', sortValue: (r) => r.updated, render: (r) => <span className="text-xs text-muted whitespace-nowrap">{r.updated.replace(/\.\d+ .*$/, '').replace('T', ' ')}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '80px',
      render: (r) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton title="History" size="xs" icon={<ListTree size={12} />} onClick={() => setHistory(r)} />
          <IconButton title="Uninstall" size="xs" icon={<Trash2 size={12} />} onClick={() => void uninstall(r)} />
        </div>
      )
    }
  ]
  return (
    <>
      <ListShell state={state} rows={rows} columns={columns} rowKey={(r) => `${r.namespace}/${r.name}`} filter={filter} setFilter={setFilter} placeholder="Filter releases" emptyTitle="No Helm releases" right={info.helmPrefix ? <Badge>{info.helmPrefix}</Badge> : undefined} />
      {history && <TextModal title={`History: ${history.name}`} badge={<Badge>{history.namespace}</Badge>} load={() => api.call<string>('k8s:helmHistory', serverId, history.name, history.namespace)} onClose={() => setHistory(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Install panel                                                       */
/* ------------------------------------------------------------------ */

function InstallPanel({ serverId, info }: { serverId: string; info: K8sInfo }): React.JSX.Element {
  const { run, busy } = useAction()
  const install = async (flavour: K8sInstallFlavour): Promise<void> => {
    const titles: Record<K8sInstallFlavour, string> = { k3s: 'Install k3s', microk8s: 'Install MicroK8s', kubectl: 'Install kubectl' }
    const msgs: Record<K8sInstallFlavour, React.ReactNode> = {
      k3s: (
        <>
          Downloads and runs the official installer from <Mono>https://get.k3s.io</Mono> as root. It installs a single-node Kubernetes cluster (k3s server with traefik, CoreDNS and local-path storage), enables the <Mono>k3s</Mono> systemd service and copies the kubeconfig to <Mono>~/.kube/config</Mono> for your user.
        </>
      ),
      microk8s: (
        <>
          Runs <Mono>snap install microk8s --classic</Mono> as root, adds your user to the <Mono>microk8s</Mono> group, waits for the cluster and enables the <Mono>dns</Mono> and <Mono>hostpath-storage</Mono> add-ons. Requires snapd.
        </>
      ),
      kubectl: (
        <>
          Installs only the <Mono>kubectl</Mono> client from the official pkgs.k8s.io repository (apt / dnf / yum) or the signed binary from <Mono>dl.k8s.io</Mono> on other distributions. You still need a cluster and a kubeconfig.
        </>
      )
    }
    if (!(await confirm({ title: titles[flavour], message: <>{msgs[flavour]} Runs as root through sudo; progress is shown in the Tasks drawer.</>, confirmLabel: 'Install' }))) return
    await run(async () => {
      await api.call('k8s:install', serverId, flavour)
      taskToast(`${titles[flavour]}…`)
    })
  }
  return (
    <>
      <Card className="mb-4">
        <EmptyState
          icon={<Boxes />}
          title={info.state === 'missing' ? 'Kubernetes is not installed on this server' : 'Install a cluster on this server'}
          description={
            info.state === 'missing'
              ? 'No kubectl, k3s or microk8s binary was found. Install a lightweight single-node distribution below, or only the kubectl client to manage a remote cluster.'
              : 'kubectl is present but no cluster responds. You can also install a local single-node cluster here.'
          }
        />
      </Card>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card
          title={
            <span className="inline-flex items-center gap-2">
              k3s <Badge color="accent">recommended</Badge>
            </span>
          }
        >
          <Callout kind="info">
            Lightweight certified Kubernetes from Rancher/SUSE in a single binary (~70 MB). Includes traefik ingress, CoreDNS, local-path storage and metrics-server. Needs root; runs as the <Mono>k3s</Mono> systemd service. The kubeconfig is copied to <Mono>~/.kube/config</Mono> so plain <Mono>kubectl</Mono> works for your user.
          </Callout>
          <Button variant="primary" icon={<Download size={13} />} className="mt-3" loading={busy} onClick={() => void install('k3s')}>
            Install k3s
          </Button>
        </Card>
        <Card title="MicroK8s">
          <Callout kind={info.found.snap || info.pkgManager === 'apt' ? 'info' : 'warn'}>
            Canonical's snap-based distribution with add-ons (<Mono>microk8s enable …</Mono>). Needs root and snapd{info.found.snap ? '' : info.pkgManager === 'apt' ? ' (snapd will be installed first)' : ' — snapd is not available on this distribution'}. Your user is added to the <Mono>microk8s</Mono> group; <Mono>dns</Mono> and <Mono>hostpath-storage</Mono> are enabled.
          </Callout>
          <Button icon={<Download size={13} />} className="mt-3" loading={busy} disabled={!info.found.snap && info.pkgManager !== 'apt'} onClick={() => void install('microk8s')}>
            Install MicroK8s
          </Button>
        </Card>
        <Card title="kubectl only">
          <Callout kind="info">
            Installs just the client to manage a cluster elsewhere: {info.pkgManager === 'apt' || info.pkgManager === 'dnf' || info.pkgManager === 'yum' ? <>adds the official <Mono>pkgs.k8s.io</Mono> {info.pkgManager} repository and installs <Mono>kubectl</Mono></> : <>downloads the latest stable binary from <Mono>dl.k8s.io</Mono>, verifies its checksum and installs it to <Mono>/usr/local/bin</Mono></>}. Needs root. Afterwards place a kubeconfig at <Mono>~/.kube/config</Mono>.
          </Callout>
          <Button icon={<Download size={13} />} className="mt-3" loading={busy} disabled={info.found.kubectl} onClick={() => void install('kubectl')}>
            {info.found.kubectl ? 'kubectl is installed' : 'Install kubectl'}
          </Button>
        </Card>
      </div>
      <div className="mt-4">
        <Callout kind="warn">
          <span className="inline-flex items-center gap-2">
            <CalendarClock size={13} /> Installing a cluster opens ports (6443 for the API server, 10250 kubelet, and 80/443 via the bundled ingress on k3s). Check the Firewall page afterwards.
          </span>
        </Callout>
      </div>
    </>
  )
}
