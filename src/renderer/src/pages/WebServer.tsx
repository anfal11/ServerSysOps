import React, { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  BarChart3,
  Download,
  ExternalLink,
  FileCode2,
  Globe,
  Lock,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Square,
  Trash2,
  Wrench
} from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { cls, fmtBytes } from '@/lib/format'
import { Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorBox, Field, Input, KV, Loading, Modal, Page, PageHeader, Pre, Select, Table, Tabs, TextArea, Toggle, confirm, useAction, useAsync, type Column } from '@/components/ui'
import { PackageUpdate } from '@/components/PackageUpdate'
import type { PhpFpmInfo, SslCert, SslStatus, WebDetectResult, WebLogResult, WebLogSummary, WebServerId, WebServerInfo, WebServiceAction, WebSite, WebSiteSpec, WebSiteType, WebTestResult } from '@shared/modules/webserver'

type ManageTab = 'sites' | 'ssl' | 'logs'

function toastStarted(title: string): void {
  useApp.getState().toast({ kind: 'info', title: `Started: ${title}` })
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function WebServer({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<WebDetectResult>('web:detect', serverId), [serverId], { intervalMs: 20000 })
  const [selected, setSelected] = useState<WebServerId | null>(null)
  const [testOut, setTestOut] = useState<{ name: string; result: WebTestResult } | null>(null)
  const [newSite, setNewSite] = useState(false)
  const tasks = useApp((s) => s.tasks)
  const { run: runRefresh, busy: refreshing } = useAction()
  const refreshPkgLists = async (): Promise<void> => {
    const id = await runRefresh(() => api.call<string>('pkg:refresh', serverId))
    if (id) toastStarted('Refresh package lists')
  }

  // Refresh when a task for this server finishes (installs etc.).
  const doneCount = tasks.filter((t) => t.serverId === serverId && t.status !== 'running' && t.status !== 'queued').length
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount])

  const servers = data?.servers ?? []
  const current = useMemo(() => servers.find((s) => s.id === selected) ?? servers.find((s) => s.sitesSupported) ?? servers[0], [servers, selected])

  return (
    <>
      <PageHeader
        title="Web server"
        subtitle={current ? `${current.name} ${current.version}` : data ? 'No web server detected' : undefined}
        actions={
          <>
            {current?.sitesSupported && current.id !== 'caddy' && (
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setNewSite(true)}>
                New site
              </Button>
            )}
            <Button variant="ghost" icon={<Download size={13} />} onClick={() => void refreshPkgLists()} loading={refreshing} title="Re-read the distribution repositories so available package updates are detected (apt-get update etc.)">
              Refresh package lists
            </Button>
            <Button icon={<RefreshCw size={13} />} onClick={() => void reload()} title="Refresh">
              Refresh
            </Button>
          </>
        }
      />
      <Page>
        {error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Loading />
        ) : data ? (
          <div className="flex flex-col gap-5">
            <section>
              <SectionTitle>Installed</SectionTitle>
              {servers.length === 0 ? (
                <div className="bg-panel border border-border rounded-lg">
                  <EmptyState icon={<Globe />} title="No web server detected" description="Install one of the servers below. Nginx is the usual choice for static sites, PHP and reverse proxying." />
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
                  {servers.map((s) => (
                    <ServerCard key={s.id} serverId={serverId} srv={s} hasSystemd={data.hasSystemd} onChanged={reload} onTest={(r) => setTestOut({ name: s.name, result: r })} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <SectionTitle>Web ports in use</SectionTitle>
              <Pre maxH="max-h-56" className="text-[11px]">
                {data.ports.length ? data.ports.join('\n') : <span className="text-dim">No TCP listeners on web ports (80, 443, 8080, 8443, 3000-3010, 5000, 8000-8090).</span>}
              </Pre>
            </section>

            {data.available.length > 0 && (
              <section>
                <SectionTitle>Available to install</SectionTitle>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {data.available.map((a) => (
                    <AvailableCard key={a.id} serverId={serverId} item={a} />
                  ))}
                </div>
              </section>
            )}

            {current && (
              <section>
                <Manage serverId={serverId} srv={current} servers={servers} detect={data} onSelect={setSelected} newSite={newSite} onNewSiteClose={() => setNewSite(false)} />
              </section>
            )}
          </div>
        ) : null}
      </Page>

      <Modal open={!!testOut} onClose={() => setTestOut(null)} title={`Configuration test – ${testOut?.name ?? ''}`} badge={testOut ? <Badge color={testOut.result.ok ? 'ok' : 'danger'}>{testOut.result.ok ? 'OK' : 'FAILED'}</Badge> : undefined} footer={<Button onClick={() => setTestOut(null)}>Close</Button>}>
        <Pre maxH="max-h-[60vh]">{testOut?.result.output}</Pre>
      </Modal>
    </>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-2">{children}</div>
}

/* ------------------------------------------------------------------ */
/* Installed server card                                               */
/* ------------------------------------------------------------------ */

/** Distro package providing a detected web server (apache2 vs httpd follows the unit name the service detected). */
function webPackage(srv: WebServerInfo): string {
  switch (srv.id) {
    case 'nginx':
      return 'nginx'
    case 'apache':
      return srv.unit === 'httpd' ? 'httpd' : 'apache2'
    case 'caddy':
      return 'caddy'
    case 'openlitespeed':
      return 'openlitespeed'
    case 'lighttpd':
      return 'lighttpd'
    default:
      return srv.unit
  }
}

function ServerCard({ serverId, srv, hasSystemd, onChanged, onTest }: { serverId: string; srv: WebServerInfo; hasSystemd: boolean; onChanged: () => Promise<void>; onTest: (r: WebTestResult) => void }): React.JSX.Element {
  const { run, busy } = useAction()
  const [acting, setActing] = useState<string | null>(null)

  const act = async (action: WebServiceAction): Promise<void> => {
    if (action === 'stop' && !(await confirm({ title: `Stop ${srv.name}`, message: <>All sites served by <b>{srv.name}</b> will go offline until it is started again.</>, danger: true, confirmLabel: 'Stop' }))) return
    setActing(action)
    const labels: Record<WebServiceAction, string> = { start: 'Started', stop: 'Stopped', restart: 'Restarted', reload: 'Reloaded (configuration tested first)', enable: 'Enabled on boot', disable: 'Disabled on boot' }
    const label = labels[action]
    await run(() => api.call('web:service', serverId, srv.id, action), { success: `${srv.name}: ${label}`, error: `${srv.name}: ${action} failed` })
    setActing(null)
    await onChanged()
  }
  const test = async (): Promise<void> => {
    setActing('test')
    const r = await run(() => api.call<WebTestResult>('web:test', serverId, srv.id))
    setActing(null)
    if (r) onTest(r)
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-md bg-accent/15 text-accent-fg flex items-center justify-center shrink-0">
          <Globe size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-semibold truncate">{srv.name}</div>
            {srv.version && <span className="text-muted text-xs font-mono">v{srv.version}</span>}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Badge color={srv.running ? 'ok' : 'danger'}>{srv.running ? 'running' : 'stopped'}</Badge>
            {hasSystemd && <Badge color={srv.enabled ? 'info' : 'muted'}>{srv.enabled ? 'enabled on boot' : 'not enabled on boot'}</Badge>}
            <Badge>{srv.unit}</Badge>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <KV
          rows={[
            [
              'Package',
              <span className="inline-flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs">{webPackage(srv)}</span>
                <PackageUpdate serverId={serverId} packages={[webPackage(srv)]} restart={[srv.unit]} label={srv.name} />
              </span>
            ],
            ['Config', <span className="font-mono text-xs">{srv.configDir}</span>],
            ...(srv.sitesDir ? ([['Sites', <span className="font-mono text-xs">{srv.sitesDir}</span>]] as [React.ReactNode, React.ReactNode][]) : []),
            ['Logs', <span className="font-mono text-xs">{srv.logDir}</span>],
            ['Test', <span className="font-mono text-xs">{srv.configTestCmd}</span>],
            ...(srv.adminUrl
              ? ([
                  [
                    'Admin',
                    <button className="font-mono text-xs text-accent hover:underline inline-flex items-center gap-1" onClick={() => api.openExternal(srv.adminUrl!)}>
                      {srv.adminUrl} <ExternalLink size={11} />
                    </button>
                  ]
                ] as [React.ReactNode, React.ReactNode][])
              : [])
          ]}
        />
      </div>
      <div className="flex items-center gap-1.5 mt-4 flex-wrap">
        {srv.running ? (
          <Button size="xs" icon={<Square size={11} />} loading={acting === 'stop'} disabled={busy} onClick={() => act('stop')}>
            Stop
          </Button>
        ) : (
          <Button size="xs" variant="primary" icon={<Play size={11} />} loading={acting === 'start'} disabled={busy} onClick={() => act('start')}>
            Start
          </Button>
        )}
        <Button size="xs" icon={<RotateCw size={11} />} loading={acting === 'restart'} disabled={busy} onClick={() => act('restart')}>
          Restart
        </Button>
        <Button size="xs" icon={<RefreshCw size={11} />} loading={acting === 'reload'} disabled={busy || !srv.running} onClick={() => act('reload')} title="Settings are tested before reload">
          Reload
        </Button>
        <Button size="xs" icon={<Wrench size={11} />} loading={acting === 'test'} disabled={busy} onClick={test}>
          Test config
        </Button>
        <div className="flex-1" />
        {hasSystemd && (
          <Toggle
            checked={srv.enabled}
            disabled={busy}
            onChange={(v) => void act(v ? 'enable' : 'disable')}
            label={
              <span className="text-xs text-muted inline-flex items-center gap-1">
                <Power size={11} /> On boot
              </span>
            }
          />
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Available to install                                                */
/* ------------------------------------------------------------------ */

function AvailableCard({ serverId, item }: { serverId: string; item: WebDetectResult['available'][number] }): React.JSX.Element {
  const { run, busy } = useAction()
  const install = async (): Promise<void> => {
    const ok = await confirm({
      title: `Install ${item.name}`,
      message: (
        <>
          Install <b>{item.name}</b> ({item.packages}) and enable it on boot? If another web server already listens on port 80/443 the new one will fail to start until you stop the other.
        </>
      ),
      confirmLabel: 'Install'
    })
    if (!ok) return
    const id = await run(() => api.call<string>('web:install', serverId, item.id))
    if (id) toastStarted(`Install ${item.name}`)
  }
  return (
    <Card className="justify-between">
      <div>
        <div className="font-semibold flex items-center gap-2">
          <Globe size={14} className="text-muted" /> {item.name}
        </div>
        <div className="text-muted text-xs mt-1.5 leading-relaxed">{item.description}</div>
        <div className="text-dim text-[11px] mt-2 font-mono truncate" title={item.packages}>
          {item.packages}
        </div>
      </div>
      <div className="mt-3">
        <Button size="sm" icon={<Download size={12} />} loading={busy} onClick={install}>
          Install
        </Button>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Management (tabs)                                                   */
/* ------------------------------------------------------------------ */

function Manage({ serverId, srv, servers, detect, onSelect, newSite, onNewSiteClose }: { serverId: string; srv: WebServerInfo; servers: WebServerInfo[]; detect: WebDetectResult; onSelect: (id: WebServerId) => void; newSite: boolean; onNewSiteClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<ManageTab>('sites')
  const sites = useAsync(() => (srv.sitesSupported || srv.id === 'caddy' ? api.call<WebSite[]>('web:sites', serverId, srv.id) : Promise.resolve([] as WebSite[])), [serverId, srv.id])

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <SectionTitle>Manage</SectionTitle>
          {servers.length > 1 && (
            <div className="-mt-2 w-48">
              <Select value={srv.id} onChange={(e) => onSelect(e.target.value as WebServerId)}>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <Tabs<ManageTab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'sites', label: 'Sites', count: sites.data?.length },
            { id: 'ssl', label: 'SSL' },
            { id: 'logs', label: 'Logs' }
          ]}
        />
      </div>
      {tab === 'sites' && <SitesTab serverId={serverId} srv={srv} host={detect.host} sites={sites} />}
      {tab === 'ssl' && <SslTab serverId={serverId} srv={srv} sites={sites.data ?? []} />}
      {tab === 'logs' && <LogsTab serverId={serverId} srv={srv} sites={sites.data ?? []} />}
      {newSite && (
        <NewSiteModal
          serverId={serverId}
          srv={srv}
          onClose={onNewSiteClose}
          onCreated={() => {
            onNewSiteClose()
            setTab('sites')
            void sites.reload()
          }}
        />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

function siteUrl(site: WebSite, host: string): string {
  const domain = site.serverNames.find((d) => d && d !== '_' && !d.startsWith('*')) ?? host
  const port = site.listen.map((l) => (l.match(/(?:^|:)(\d+)(?:\s|$)/) ?? [])[1]).find((p) => p && p !== '80' && p !== '443')
  return `${site.ssl ? 'https' : 'http'}://${domain}${port && !site.ssl ? `:${port}` : ''}`
}

function SitesTab({ serverId, srv, host, sites }: { serverId: string; srv: WebServerInfo; host: string; sites: ReturnType<typeof useAsync<WebSite[]>> }): React.JSX.Element {
  const { run, busy } = useAction()
  const [editing, setEditing] = useState<WebSite | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

  const toggle = async (site: WebSite, enabled: boolean): Promise<void> => {
    if (!enabled && !(await confirm({ title: 'Disable site', message: <>Disable <b>{site.name}</b>? Its domains will stop being served after reload.</>, danger: true, confirmLabel: 'Disable' }))) return
    setToggling(site.name)
    await run(() => api.call('web:siteEnable', serverId, srv.id, site.name, enabled), { success: `${site.name} ${enabled ? 'enabled' : 'disabled'} and ${srv.name} reloaded` })
    setToggling(null)
    await sites.reload()
  }
  const remove = async (site: WebSite): Promise<void> => {
    const ok = await confirm({
      title: 'Delete site',
      message: (
        <>
          Delete the configuration file <span className="font-mono">{site.path}</span>
          {site.enabled ? ' and its enabled link' : ''}? The web root and its files are <b>not</b> removed.
        </>
      ),
      danger: true,
      confirmLabel: 'Delete',
      typeToConfirm: site.name
    })
    if (!ok) return
    await run(() => api.call('web:siteDelete', serverId, srv.id, site.name, site.path), { success: `${site.name} deleted` })
    await sites.reload()
  }

  const columns: Column<WebSite>[] = [
    { key: 'name', header: 'Name', render: (s) => <span className="font-medium">{s.name}</span>, sortValue: (s) => s.name },
    {
      key: 'domains',
      header: 'Domains',
      render: (s) => (
        <div className="flex flex-wrap gap-1 max-w-[360px]">
          {s.serverNames.length ? s.serverNames.slice(0, 6).map((d) => <Badge key={d}>{d}</Badge>) : <span className="text-dim">—</span>}
          {s.serverNames.length > 6 && <Badge color="muted">+{s.serverNames.length - 6}</Badge>}
        </div>
      )
    },
    { key: 'listen', header: 'Listen', mono: true, render: (s) => <span className="text-muted">{s.listen.join(', ') || '—'}</span> },
    {
      key: 'target',
      header: 'Root / proxy',
      mono: true,
      render: (s) => (s.proxy ? <span className="text-info-fg">→ {s.proxy}</span> : s.root ? <span className="text-muted">{s.root}</span> : <span className="text-dim">—</span>)
    },
    { key: 'ssl', header: 'SSL', width: '70px', render: (s) => (s.ssl ? <Badge color="ok">SSL</Badge> : <Badge>http</Badge>) },
    {
      key: 'enabled',
      header: 'Enabled',
      width: '90px',
      render: (s) => (s.editable && srv.sitesDir && srv.id !== 'caddy' ? <Toggle checked={s.enabled} disabled={busy || toggling === s.name || !canToggle(srv, s)} onChange={(v) => void toggle(s, v)} /> : <Badge color={s.enabled ? 'ok' : 'muted'}>{s.enabled ? 'yes' : 'no'}</Badge>)
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (s) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="xs" variant="ghost" icon={<ExternalLink size={11} />} title={siteUrl(s, host)} onClick={() => api.openExternal(siteUrl(s, host))}>
            Open
          </Button>
          <Button size="xs" variant="ghost" icon={<Pencil size={11} />} onClick={() => setEditing(s)}>
            {s.editable ? 'Edit' : 'View'}
          </Button>
          {s.editable && (
            <Button size="xs" variant="ghost" className="text-danger-fg" icon={<Trash2 size={11} />} disabled={busy} onClick={() => remove(s)}>
              Delete
            </Button>
          )}
        </div>
      )
    }
  ]

  if (!srv.sitesSupported && srv.id !== 'caddy') {
    return (
      <Card>
        <Callout>
          Site management is not available for {srv.name}. {srv.adminUrl ? 'Use the WebAdmin console to manage virtual hosts.' : `Edit the configuration in ${srv.configDir} with the Files page.`}
        </Callout>
      </Card>
    )
  }
  return (
    <>
      <Card flush>
        {sites.error ? (
          <div className="p-4">
            <ErrorBox error={sites.error} onRetry={sites.reload} />
          </div>
        ) : sites.loading && !sites.data ? (
          <Loading />
        ) : (
          <>
            {srv.id === 'caddy' && (
              <div className="px-4 pt-3">
                <Callout>Read-only summary of the site blocks in /etc/caddy/Caddyfile. Caddy obtains HTTPS certificates automatically. Edit the Caddyfile with “View” and save – it is validated before reload.</Callout>
              </div>
            )}
            <Table<WebSite>
              columns={columns}
              rows={sites.data ?? []}
              rowKey={(s) => s.path + ':' + s.name}
              empty={
                <EmptyState
                  icon={<FileCode2 />}
                  title="No sites configured"
                  description={srv.sitesDir ? `No virtual host files found in ${srv.sitesDir}.` : 'No site blocks found.'}
                />
              }
            />
          </>
        )}
      </Card>
      {editing && (
        <SiteEditor
          serverId={serverId}
          srv={srv}
          site={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void sites.reload()
          }}
        />
      )}
    </>
  )
}

function canToggle(srv: WebServerInfo, s: WebSite): boolean {
  // Toggling needs a sites-available / sites-enabled layout; conf.d files are always active.
  return !!srv.sitesDir && s.path.startsWith(srv.sitesDir + '/') && /sites-available/.test(srv.sitesDir)
}

function SiteEditor({ serverId, srv, site, onClose, onSaved }: { serverId: string; srv: WebServerInfo; site: WebSite; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<string>('web:siteRead', serverId, srv.id, site.path), [site.path])
  const [content, setContent] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [reloadAfter, setReloadAfter] = useState(true)
  const toast = useApp((s) => s.toast)
  const value = content ?? data ?? ''
  const dirty = content !== null && content !== data

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      await api.call<WebTestResult>('web:siteWrite', serverId, srv.id, site.path, value, reloadAfter)
      toast({ kind: 'success', title: `${site.name} saved`, detail: reloadAfter ? `Configuration tested and ${srv.name} reloaded. Backup: ${site.path}.bak` : `Configuration tested. Backup: ${site.path}.bak` })
      onSaved()
    } catch (e) {
      setSaveError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <>
          <FileCode2 size={15} /> {site.path}
        </>
      }
      width="max-w-4xl"
      badge={site.enabled ? <Badge color="ok">enabled</Badge> : <Badge>disabled</Badge>}
      footer={
        <>
          <Checkbox checked={reloadAfter} onChange={setReloadAfter} label={`Reload ${srv.name} after save`} />
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={loading || !!error || !dirty}>
            Save &amp; test
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : loading && data === undefined ? (
        <Loading />
      ) : (
        <>
          <TextArea mono value={value} onChange={(e) => setContent(e.target.value)} rows={24} spellCheck={false} className="min-h-[50vh]" />
          <div className="text-[11px] text-dim mt-2">The file is backed up to {site.path}.bak, then the configuration is tested ({srv.configTestCmd}). If the test fails the previous version is restored.</div>
          {saveError ? (
            <div className="mt-3">
              <ErrorBox error={saveError} />
            </div>
          ) : null}
        </>
      )}
    </Modal>
  )
}

function parseDomains(s: string): string[] {
  return [...new Set(s.split(/[\s,;]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))]
}
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

function NewSiteModal({ serverId, srv, onClose, onCreated }: { serverId: string; srv: WebServerInfo; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [domainsRaw, setDomainsRaw] = useState('')
  const [type, setType] = useState<WebSiteType>('static')
  const [root, setRoot] = useState('')
  const [rootTouched, setRootTouched] = useState(false)
  const [proxyTarget, setProxyTarget] = useState('http://127.0.0.1:3000')
  const [phpVersion, setPhpVersion] = useState('')
  const [http2, setHttp2] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const toast = useApp((s) => s.toast)
  const php = useAsync(() => api.call<PhpFpmInfo>('web:phpFpm', serverId), [serverId], { enabled: type === 'php' })

  const domains = parseDomains(domainsRaw)
  const first = domains[0] ?? ''
  useEffect(() => {
    if (!nameTouched) setName(first.replace(/^www\./, ''))
    if (!rootTouched) setRoot(first ? `/var/www/${first.replace(/^www\./, '')}` : '')
  }, [first, nameTouched, rootTouched])
  useEffect(() => {
    if (type === 'php' && !phpVersion && php.data?.sockets.length) setPhpVersion(php.data.sockets[0])
  }, [php.data, type, phpVersion])

  const badDomain = domains.find((d) => !DOMAIN_RE.test(d))
  const nameOk = /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(name)
  const proxyOk = type !== 'proxy' || /^https?:\/\/[A-Za-z0-9.\-_[\]:]+(:\d{1,5})?(\/[A-Za-z0-9\-._~/]*)?$/.test(proxyTarget)
  const rootOk = type === 'proxy' || (root.startsWith('/') && root.length > 1 && !root.includes('..'))
  const valid = domains.length > 0 && !badDomain && nameOk && proxyOk && rootOk && (type !== 'php' || !!phpVersion)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const spec: WebSiteSpec = { name, domains, type, http2, root: type === 'proxy' ? undefined : root, proxyTarget: type === 'proxy' ? proxyTarget : undefined, phpVersion: type === 'php' ? phpVersion : undefined }
    try {
      const r = await api.call<{ path: string; test: WebTestResult }>('web:siteCreate', serverId, srv.id, spec)
      toast({ kind: 'success', title: `Site ${name} created`, detail: `${r.path}\n${srv.name} reloaded.` })
      onCreated()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New site"
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} loading={busy} disabled={!valid}>
            Create &amp; enable
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-4">
        <Field label="Domains" className="col-span-6" hint="Separate multiple domains with spaces or commas, e.g. example.com www.example.com">
          <Input value={domainsRaw} onChange={(e) => setDomainsRaw(e.target.value)} placeholder="example.com www.example.com" mono autoFocus />
          {badDomain && <div className="text-[11px] text-danger-fg mt-1">Invalid domain: {badDomain}</div>}
        </Field>
        <Field label="Site name" className="col-span-3" hint={`File: ${srv.sitesDir ?? srv.configDir}/${name || '…'}${srv.id === 'apache' || !/sites-available/.test(srv.sitesDir ?? '') ? '.conf' : ''}`}>
          <Input
            value={name}
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value)
            }}
            mono
          />
        </Field>
        <Field label="Type" className="col-span-3">
          <div className="flex flex-col gap-1.5 pt-1 text-[13px]">
            {(
              [
                ['static', 'Static files', 'Serve HTML/CSS/JS from a directory'],
                ['proxy', 'Reverse proxy', 'Forward requests to an app (Node, Python, Docker…)'],
                ['php', 'PHP (FPM)', 'PHP application via php-fpm socket']
              ] as [WebSiteType, string, string][]
            ).map(([id, label, desc]) => (
              <label key={id} className="inline-flex items-start gap-2 cursor-pointer">
                <input type="radio" name="sitetype" className="mt-1 accent-[var(--color-accent)]" checked={type === id} onChange={() => setType(id)} />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="text-dim text-[11px] block">{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        {type !== 'proxy' && (
          <Field label="Web root" className="col-span-6" hint="Created if missing (with a placeholder index.html) and owned by the web server user.">
            <Input
              value={root}
              onChange={(e) => {
                setRootTouched(true)
                setRoot(e.target.value)
              }}
              mono
              placeholder="/var/www/example.com"
            />
          </Field>
        )}
        {type === 'proxy' && (
          <Field label="Proxy target" className="col-span-6" hint="Upstream URL. WebSocket upgrade and X-Forwarded-* headers are configured automatically.">
            <Input value={proxyTarget} onChange={(e) => setProxyTarget(e.target.value)} mono placeholder="http://127.0.0.1:3000" />
          </Field>
        )}
        {type === 'php' && (
          <Field label="PHP-FPM socket / version" className="col-span-6" hint={php.data?.phpVersion ? `php ${php.data.phpVersion} detected. ${php.data.units.map((u) => `${u.unit} (${u.active ? 'active' : 'inactive'})`).join(', ') || 'No php-fpm unit found.'}` : 'Install php-fpm from the Runtimes page if nothing is listed.'}>
            {php.loading && !php.data ? (
              <Loading label="Detecting PHP-FPM…" />
            ) : php.data?.sockets.length ? (
              <Select value={phpVersion} onChange={(e) => setPhpVersion(e.target.value)}>
                {php.data.sockets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            ) : (
              <>
                <Input value={phpVersion} onChange={(e) => setPhpVersion(e.target.value)} mono placeholder="8.2  or  /run/php/php8.2-fpm.sock" />
                <Callout kind="warn">No PHP-FPM socket was found in /run/php or /run/php-fpm. The site will fail to serve PHP until php-fpm is installed and running.</Callout>
              </>
            )}
            {php.data?.units.map((u) => (
              <div key={u.unit} className="flex items-center gap-2 mt-1.5 text-xs">
                <span className="font-mono text-muted">{u.unit}</span>
                <PackageUpdate serverId={serverId} packages={[u.unit]} restart={[u.unit]} label={u.unit} />
              </div>
            ))}
          </Field>
        )}
        <div className="col-span-6">
          <Checkbox checked={http2} onChange={setHttp2} label="Enable HTTP/2 (takes effect once SSL is enabled)" />
        </div>
      </div>
      <Callout>
        The virtual host is written to {srv.sitesDir ?? srv.configDir}, enabled, tested with <span className="font-mono">{srv.configTestCmd}</span> and {srv.name} is reloaded. Use the SSL tab afterwards to obtain a Let’s Encrypt certificate.
      </Callout>
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* SSL                                                                 */
/* ------------------------------------------------------------------ */

function expiryColor(c: SslCert): 'ok' | 'warn' | 'danger' | 'muted' {
  if (c.daysLeft === undefined) return 'muted'
  if (c.daysLeft < 0) return 'danger'
  if (c.daysLeft < 14) return 'warn'
  return 'ok'
}

function SslTab({ serverId, srv, sites }: { serverId: string; srv: WebServerInfo; sites: WebSite[] }): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<SslStatus>('web:ssl:status', serverId), [serverId])
  const { run, busy } = useAction()
  const [obtain, setObtain] = useState(false)
  const tasks = useApp((s) => s.tasks)
  const doneCount = tasks.filter((t) => t.serverId === serverId && t.status !== 'running' && t.status !== 'queued').length
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount])

  const install = async (): Promise<void> => {
    const id = await run(() => api.call<string>('web:ssl:install', serverId, srv.id))
    if (id) toastStarted('Install certbot')
  }
  const renew = async (dryRun: boolean): Promise<void> => {
    const id = await run(() => api.call<string>('web:ssl:renew', serverId, dryRun))
    if (id) toastStarted(dryRun ? 'Test certificate renewal' : 'Renew certificates')
  }

  const certCols: Column<SslCert>[] = [
    { key: 'name', header: 'Certificate', render: (c) => <span className="font-medium">{c.name}</span>, sortValue: (c) => c.name },
    {
      key: 'domains',
      header: 'Domains',
      render: (c) => (
        <div className="flex flex-wrap gap-1 max-w-[380px]">
          {c.domains.map((d) => (
            <Badge key={d}>{d}</Badge>
          ))}
        </div>
      )
    },
    {
      key: 'expiry',
      header: 'Expires',
      sortValue: (c) => c.daysLeft ?? 99999,
      render: (c) => (
        <div className="flex items-center gap-2">
          <Badge color={expiryColor(c)}>{c.daysLeft === undefined ? 'unknown' : c.daysLeft < 0 ? `expired ${-c.daysLeft}d ago` : `${c.daysLeft} days`}</Badge>
          <span className="text-muted text-xs font-mono">{c.expiry.split(' ')[0]}</span>
        </div>
      )
    },
    { key: 'type', header: 'Key', width: '80px', render: (c) => <span className="text-muted text-xs">{c.keyType ?? '—'}</span> },
    { key: 'path', header: 'Path', mono: true, render: (c) => <span className="text-muted text-xs">{c.path}</span> }
  ]

  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading && !data) return <Loading />
  if (!data) return <></>
  const caddy = srv.id === 'caddy'
  const supported = srv.id === 'nginx' || srv.id === 'apache'

  return (
    <div className="flex flex-col gap-3">
      {caddy && <Callout>Caddy obtains and renews TLS certificates automatically for every site with a public domain name. No certbot setup is needed.</Callout>}
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <ShieldCheck size={14} /> Let’s Encrypt (certbot)
          </span>
        }
        actions={
          <>
            {data.certbotInstalled ? (
              <>
                <Button size="xs" onClick={() => renew(true)} disabled={busy} title="certbot renew --dry-run">
                  Test renewal
                </Button>
                <Button size="xs" icon={<RotateCw size={11} />} onClick={() => renew(false)} disabled={busy}>
                  Renew all
                </Button>
                {supported && (
                  <Button size="xs" variant="primary" icon={<Lock size={11} />} onClick={() => setObtain(true)}>
                    Obtain certificate
                  </Button>
                )}
              </>
            ) : (
              !caddy && (
                <Button size="xs" variant="primary" icon={<Download size={11} />} onClick={install} loading={busy}>
                  Install certbot{supported ? ` + ${srv.id} plugin` : ''}
                </Button>
              )
            )}
            <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void reload()} title="Refresh" />
          </>
        }
      >
        <KV
          rows={[
            [
              'certbot',
              data.certbotInstalled ? (
                <span className="inline-flex items-center gap-2">
                  <Badge color="ok">installed{data.certbotVersion ? ` v${data.certbotVersion}` : ''}</Badge>
                  <PackageUpdate serverId={serverId} packages={['certbot']} label="certbot" />
                </span>
              ) : (
                <Badge color="muted">not installed</Badge>
              )
            ],
            ['Auto-renewal', data.renewalActive ? <Badge color="ok">{data.renewal ?? 'active'}</Badge> : data.certbotInstalled ? <Badge color="warn">no timer / cron found</Badge> : <span className="text-dim">—</span>],
            ['Certificates', <span>{data.certs.length}</span>]
          ]}
        />
        {!data.certbotInstalled && !caddy && (
          <div className="mt-3 text-xs text-muted">
            Installs <span className="font-mono">certbot</span> with the {srv.id === 'apache' ? 'Apache' : 'Nginx'} plugin from the distribution packages (falls back to snap). Certificates are then obtained with <span className="font-mono">certbot --{srv.id === 'apache' ? 'apache' : 'nginx'}</span>, which also edits the virtual host for HTTPS.
          </div>
        )}
      </Card>
      <Card flush>
        <Table<SslCert> columns={certCols} rows={data.certs} rowKey={(c) => c.name} initialSort={{ key: 'expiry', dir: 'asc' }} empty={<EmptyState icon={<Lock />} title="No certificates" description={data.certbotInstalled ? 'Use “Obtain certificate” to request one for a site.' : 'Install certbot first.'} />} />
      </Card>
      {obtain && (
        <ObtainModal
          serverId={serverId}
          srv={srv}
          sites={sites}
          onClose={() => setObtain(false)}
          onStarted={() => {
            setObtain(false)
          }}
        />
      )}
    </div>
  )
}

function ObtainModal({ serverId, srv, sites, onClose, onStarted }: { serverId: string; srv: WebServerInfo; sites: WebSite[]; onClose: () => void; onStarted: () => void }): React.JSX.Element {
  const [domainsRaw, setDomainsRaw] = useState('')
  const [email, setEmail] = useState('')
  const [redirect, setRedirect] = useState(true)
  const [agree, setAgree] = useState(false)
  const { run, busy } = useAction()
  const domains = parseDomains(domainsRaw)
  const badDomain = domains.find((d) => !DOMAIN_RE.test(d))
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  const valid = domains.length > 0 && !badDomain && emailOk && agree
  const candidates = sites.filter((s) => s.enabled && s.serverNames.some((d) => d !== '_' && !d.startsWith('*') && d.includes('.')))

  const go = async (): Promise<void> => {
    const id = await run(() => api.call<string>('web:ssl:obtain', serverId, srv.id, domains, email, redirect))
    if (id) {
      toastStarted(`Obtain certificate for ${domains[0]}`)
      onStarted()
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Obtain Let’s Encrypt certificate"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={go} loading={busy} disabled={!valid} icon={<Lock size={12} />}>
            Obtain
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {candidates.length > 0 && (
          <Field label="Prefill from site">
            <Select value="" onChange={(e) => e.target.value && setDomainsRaw(candidates.find((s) => s.name === e.target.value)?.serverNames.filter((d) => d !== '_' && !d.startsWith('*')).join(' ') ?? '')}>
              <option value="">Choose a site…</option>
              {candidates.map((s) => (
                <option key={s.path + s.name} value={s.name}>
                  {s.name} – {s.serverNames.join(', ')}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Domains" hint="All domains must resolve to this server and be reachable on port 80 (HTTP-01 challenge).">
          <Input value={domainsRaw} onChange={(e) => setDomainsRaw(e.target.value)} placeholder="example.com www.example.com" mono />
          {badDomain && <div className="text-[11px] text-danger-fg mt-1">Invalid domain: {badDomain}</div>}
        </Field>
        <Field label="E-mail for expiry notices">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" type="email" />
        </Field>
        <Checkbox checked={redirect} onChange={setRedirect} label="Redirect HTTP to HTTPS (certbot --redirect)" />
        <Checkbox checked={agree} onChange={setAgree} label="I agree to the Let’s Encrypt Subscriber Agreement (--agree-tos)" />
        <Callout>
          Runs <span className="font-mono">certbot --{srv.id === 'apache' ? 'apache' : 'nginx'} -d … --non-interactive -m …</span> as a task. certbot edits the matching virtual host, installs the certificate and reloads {srv.name}.
        </Callout>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

function LogsTab({ serverId, srv, sites }: { serverId: string; srv: WebServerInfo; sites: WebSite[] }): React.JSX.Element {
  const [kind, setKind] = useState<'access' | 'error'>('access')
  const [lines, setLines] = useState(200)
  const [site, setSite] = useState('')
  const [auto, setAuto] = useState(false)
  const [summary, setSummary] = useState<WebLogSummary | null>(null)
  const [summaryErr, setSummaryErr] = useState<unknown>(null)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const caddy = srv.id === 'caddy'

  const log = useAsync(() => api.call<WebLogResult>('web:logs', serverId, srv.id, kind, lines, site || undefined), [serverId, srv.id, kind, lines, site], { intervalMs: auto ? 5000 : undefined })

  const analyze = async (): Promise<void> => {
    setSummaryBusy(true)
    setSummaryErr(null)
    try {
      setSummary(await api.call<WebLogSummary>('web:logs:summary', serverId, srv.id, site || undefined))
    } catch (e) {
      setSummaryErr(e)
    } finally {
      setSummaryBusy(false)
    }
  }

  const siteNames = useMemo(() => [...new Set(sites.filter((s) => s.editable).map((s) => s.name.replace(/\.conf$/, '')))], [sites])

  return (
    <div className="flex flex-col gap-3">
      <Card flush>
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border flex-wrap">
          <Tabs<'access' | 'error'>
            value={kind}
            onChange={setKind}
            tabs={[
              { id: 'access', label: 'Access' },
              { id: 'error', label: 'Error' }
            ]}
          />
          <div className="w-28">
            <Select value={lines} onChange={(e) => setLines(Number(e.target.value))} className="h-7 text-xs">
              {[100, 200, 500, 1000, 2000, 5000].map((n) => (
                <option key={n} value={n}>
                  {n} lines
                </option>
              ))}
            </Select>
          </div>
          {!caddy && siteNames.length > 0 && (
            <div className="w-48">
              <Select value={site} onChange={(e) => setSite(e.target.value)} className="h-7 text-xs">
                <option value="">All sites (main log)</option>
                {siteNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <Toggle checked={auto} onChange={setAuto} label={<span className="text-xs text-muted">Auto-refresh (5 s)</span>} />
          <div className="flex-1" />
          <span className="text-[11px] text-dim font-mono truncate max-w-[320px]" title={log.data?.path}>
            {log.data?.path}
          </span>
          <Button size="xs" variant="ghost" icon={<RefreshCw size={11} className={cls(log.loading && 'animate-spin')} />} onClick={() => void log.reload()} title="Refresh" />
        </div>
        <div className="p-3">
          {log.error ? (
            <ErrorBox error={log.error} onRetry={log.reload} />
          ) : log.loading && !log.data ? (
            <Loading />
          ) : (
            <LogViewer content={log.data?.content ?? ''} kind={kind} />
          )}
        </div>
      </Card>

      {!caddy && (
        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <BarChart3 size={14} /> Access log summary {site ? `– ${site}` : ''}
            </span>
          }
          actions={
            <Button size="xs" icon={<Activity size={11} />} onClick={analyze} loading={summaryBusy}>
              {summary ? 'Re-analyze' : 'Analyze last 5000 requests'}
            </Button>
          }
        >
          {summaryErr ? (
            <ErrorBox error={summaryErr} />
          ) : !summary ? (
            <div className="text-xs text-muted">Counts requests, top paths, top client IPs and the status-code distribution over the last 5000 lines of the access log (combined log format).</div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4 text-[13px]">
                <span>
                  <span className="text-muted">Requests </span>
                  <b>{summary.requests.toLocaleString()}</b>
                </span>
                <span>
                  <span className="text-muted">Bytes sent </span>
                  <b>{fmtBytes(summary.bytes)}</b>
                </span>
                <span>
                  <span className="text-muted">Errors (4xx/5xx) </span>
                  <b>{summary.statuses.filter((s) => /^[45]/.test(s.key)).reduce((a, b) => a + b.count, 0).toLocaleString()}</b>
                </span>
                <span className="text-dim text-[11px] font-mono ml-auto truncate">{summary.path}</span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <CountTable title="Top paths" rows={summary.topPaths} total={summary.requests} mono />
                <CountTable title="Top client IPs" rows={summary.topIps} total={summary.requests} mono />
                <CountTable title="Status codes" rows={summary.statuses} total={summary.requests} colorize />
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function LogViewer({ content, kind }: { content: string; kind: 'access' | 'error' }): React.JSX.Element {
  const lines = content.replace(/\n+$/, '').split('\n')
  if (!content.trim()) return <div className="text-xs text-dim py-6 text-center">Log is empty.</div>
  return (
    <div className="bg-bg-2 border border-border rounded-md p-2 text-[11px] font-mono overflow-auto max-h-[480px] leading-[1.55]">
      {lines.map((l, i) => {
        let color = ''
        if (kind === 'error') {
          if (/\[(error|crit|alert|emerg)\]|error|failed/i.test(l)) color = 'text-danger-fg'
          else if (/\[(warn|notice)\]|warn/i.test(l)) color = 'text-warn-fg'
        } else {
          const m = l.match(/"\s(\d{3})\s/)
          const st = m ? Number(m[1]) : 0
          if (st >= 500) color = 'text-danger-fg'
          else if (st >= 400) color = 'text-warn-fg'
          else if (st >= 300) color = 'text-info-fg'
        }
        return (
          <div key={i} className={cls('whitespace-pre-wrap break-all hover:bg-panel-2/60 px-1', color)}>
            {l}
          </div>
        )
      })}
    </div>
  )
}

function CountTable({ title, rows, total, mono, colorize }: { title: string; rows: { key: string; count: number }[]; total: number; mono?: boolean; colorize?: boolean }): React.JSX.Element {
  const statusColor = (k: string): string => (k.startsWith('5') ? 'text-danger-fg' : k.startsWith('4') ? 'text-warn-fg' : k.startsWith('3') ? 'text-info-fg' : k.startsWith('2') ? 'text-ok-fg' : '')
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted font-medium mb-1.5">{title}</div>
      {rows.length === 0 ? (
        <div className="text-dim text-xs">—</div>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r) => {
              const pct = total ? (r.count / total) * 100 : 0
              return (
                <tr key={r.key} className="border-b border-border/50">
                  <td className={cls('py-1 pr-2 truncate max-w-[220px]', mono && 'font-mono', colorize && statusColor(r.key))} title={r.key}>
                    {r.key}
                  </td>
                  <td className="py-1 text-right tabular-nums w-16">{r.count.toLocaleString()}</td>
                  <td className="py-1 pl-2 w-24">
                    <div className="h-1.5 bg-border rounded overflow-hidden">
                      <div className="h-full bg-accent rounded" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
