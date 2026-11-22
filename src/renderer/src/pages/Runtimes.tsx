import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpCircle, Download, Package, Play, Plus, RefreshCw, RotateCw, Square, Star, Trash2, X } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Callout, Card, EmptyState, ErrorBox, Field, Input, KV, Loading, Page, PageHeader, Select, Table, Tabs, Toggle, confirm, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { PackageUpdate } from '@/components/PackageUpdate'
import type { BunStatus, GoStatus, NodeStatus, PhpFpmAction, PhpSettingKey, PhpSettings, PhpSettingsTarget, PhpStatus, PhpVersionInfo, PipxPackage, PythonStatus, PythonTool } from '@shared/modules/runtimes'

type TabId = 'node' | 'bun' | 'go' | 'php' | 'python'

export default function Runtimes({ serverId }: PageProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('node')
  return (
    <>
      <PageHeader
        title="Runtimes"
        actions={
          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'node', label: 'Node.js' },
              { id: 'bun', label: 'Bun' },
              { id: 'go', label: 'Go' },
              { id: 'php', label: 'PHP' },
              { id: 'python', label: 'Python' }
            ]}
          />
        }
      />
      <Page>
        {tab === 'node' && <NodeTab serverId={serverId} />}
        {tab === 'bun' && <BunTab serverId={serverId} />}
        {tab === 'go' && <GoTab serverId={serverId} />}
        {tab === 'php' && <PhpTab serverId={serverId} />}
        {tab === 'python' && <PythonTab serverId={serverId} />}
      </Page>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Start a background task: runs the call, toasts, and the Tasks drawer opens by itself. */
function useTaskStarter(): { start: (fn: () => Promise<unknown>, title: string) => Promise<boolean>; busy: boolean } {
  const { run, busy } = useAction()
  const toast = useApp((s) => s.toast)
  const start = async (fn: () => Promise<unknown>, title: string): Promise<boolean> => {
    const id = await run(fn)
    if (id === undefined) return false
    toast({ kind: 'info', title: `Started: ${title}`, detail: 'Progress is shown in the Tasks drawer.' })
    return true
  }
  return { start, busy }
}

/** Reload page data whenever a task of this server finishes. */
function useReloadOnTaskDone(serverId: string, reload: () => Promise<void>): void {
  const tasks = useApp((s) => s.tasks)
  const key = tasks
    .filter((t) => t.serverId === serverId && (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'))
    .map((t) => t.id)
    .join(',')
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }): React.JSX.Element {
  return <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={onClick} loading={loading} title="Refresh" />
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-2 mt-6 first:mt-0">{children}</div>
}

/* ------------------------------------------------------------------ */
/* Node.js                                                             */
/* ------------------------------------------------------------------ */

function NodeTab({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<NodeStatus>('rt:node:status', serverId), [serverId])
  const { run, busy } = useAction()
  const { start, busy: starting } = useTaskStarter()
  useReloadOnTaskDone(serverId, reload)
  const [pick, setPick] = useState('')
  const [pkg, setPkg] = useState('')
  const [nvmUser, setNvmUser] = useState('')

  const available = data?.available ?? []
  useEffect(() => {
    if (!pick && available.length) {
      const firstNotInstalled = available.find((v) => !v.installed && v.label === 'Active LTS') ?? available.find((v) => !v.installed) ?? available[0]
      setPick(firstNotInstalled.version)
    }
  }, [available, pick])
  const loginUsers = useMemo(() => (data?.users ?? []).filter((u) => u.name === 'root' || !/nologin|false$/.test(u.shell)), [data])
  useEffect(() => {
    if (!nvmUser && loginUsers.length) setNvmUser(loginUsers.find((u) => u.name !== 'root')?.name ?? loginUsers[0].name)
  }, [loginUsers, nvmUser])

  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading || !data) return <Loading />

  const removeVersion = async (v: string): Promise<void> => {
    if (!(await confirm({ title: `Remove Node.js ${v}`, message: <>Delete <b className="font-mono">/opt/serversysops/node/{v}</b>? Projects pinned to this version will fail until it is reinstalled.</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('rt:node:remove', serverId, v), { success: `Removed Node.js ${v}` })
    await reload()
  }
  const setDefault = async (v: string): Promise<void> => {
    await run(() => api.call('rt:node:setDefault', serverId, v), { success: `Node.js ${v} is now the default` })
    await reload()
  }
  const installGlobal = async (spec: string): Promise<void> => {
    const s = spec.trim()
    if (!s) return
    if (await start(() => api.call('rt:node:globalInstall', serverId, s), `npm install -g ${s}`)) setPkg('')
  }
  const removeGlobal = async (name: string): Promise<void> => {
    if (!(await confirm({ title: 'Remove global package', message: <>Run <code className="font-mono">npm uninstall -g {name}</code>?</>, danger: true, confirmLabel: 'Remove' }))) return
    await run(() => api.call('rt:node:globalRemove', serverId, name), { success: `Removed ${name}` })
    await reload()
  }
  const selected = available.find((v) => v.version === pick)
  const globalNames = new Set(data.globals.map((g) => g.name))

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between">
        <SectionTitle>Installed versions</SectionTitle>
        <RefreshButton onClick={() => void reload()} />
      </div>
      <Card flush>
        <Table
          rows={data.versions}
          rowKey={(r) => r.version}
          empty={<span>No Node.js version installed by ServerSysOps yet. Pick one below.</span>}
          columns={[
            {
              key: 'version',
              header: 'Version',
              render: (r) => (
                <span className="flex items-center gap-2 font-mono">
                  {r.version}
                  {r.default && (
                    <Badge color="accent">
                      <Star size={10} className="mr-1" /> Default
                    </Badge>
                  )}
                </span>
              ),
              sortValue: (r) => r.version
            },
            { key: 'path', header: 'Location', mono: true, render: (r) => <span className="text-muted">{r.path}</span> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (r) => (
                <span className="inline-flex gap-1">
                  {!r.default && (
                    <Button size="xs" onClick={() => void setDefault(r.version)} disabled={busy}>
                      Use
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} title="Delete" onClick={() => void removeVersion(r.version)} disabled={busy} />
                </span>
              )
            }
          ]}
        />
      </Card>
      <div className="mt-3">
        <Callout>
          <code className="font-mono">node</code>, <code className="font-mono">npm</code>, <code className="font-mono">npx</code>, <code className="font-mono">corepack</code> in <code className="font-mono">/usr/local/bin</code> run the version a project asks for in <code className="font-mono">.nvmrc</code> or{' '}
          <code className="font-mono">.node-version</code> (in its folder or above), or in <code className="font-mono">SERVERSYSOPS_NODE_VERSION</code>, and the default otherwise. A version that isn&apos;t installed fails with a message. Global npm packages are
          installed in <code className="font-mono">/usr/local</code>, shared by all versions.
        </Callout>
      </div>
      {data.versions.length > 0 && !data.shimInstalled && (
        <div className="mt-3">
          <Callout kind="warn">
            <div className="flex items-center justify-between gap-3">
              <span>
                The <code className="font-mono">/usr/local/bin/node</code> shim is missing, so the installed versions are not on the PATH.
              </span>
              <Button size="xs" onClick={() => void run(() => api.call('rt:node:installShim', serverId), { success: 'Shim installed' }).then(reload)} loading={busy}>
                Install shim
              </Button>
            </div>
          </Callout>
        </div>
      )}

      {data.others.length > 0 && (
        <>
          <SectionTitle>Other installations</SectionTitle>
          <Card flush>
            <Table
              rows={data.others}
              rowKey={(r) => r.path}
              columns={[
                { key: 'path', header: 'Location', mono: true, render: (r) => r.path },
                { key: 'version', header: 'Version', mono: true, render: (r) => r.version },
                { key: 'note', header: '', align: 'right', render: () => <Badge>Not managed by ServerSysOps</Badge> }
              ]}
            />
          </Card>
        </>
      )}

      <SectionTitle>Install a version</SectionTitle>
      <Card>
        {data.arch === 'unsupported' ? (
          <Callout kind="warn">Official Node.js binaries are not available for this CPU architecture.</Callout>
        ) : (
          <div className="flex items-end gap-3">
            <Field label="Version" className="w-80" hint={data.availableLive ? 'List fetched from nodejs.org on the server.' : 'Offline list (curl is missing or nodejs.org was unreachable from the server).'}>
              <Select value={pick} onChange={(e) => setPick(e.target.value)}>
                {available.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                    {v.label ? ` (${v.label}${v.lts ? ` · ${v.lts}` : ''})` : v.lts ? ` (${v.lts})` : ''}
                    {v.installed ? ': installed' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="primary" icon={<Download size={13} />} disabled={!pick || !!selected?.installed} loading={starting} onClick={() => void start(() => api.call('rt:node:install', serverId, pick), `Install Node.js ${pick}`)} className="mb-[22px]">
              Install
            </Button>
          </div>
        )}
      </Card>

      <SectionTitle>Global npm packages</SectionTitle>
      <Card flush>
        <Table
          rows={data.globals}
          rowKey={(r) => r.name}
          empty={data.defaultVersion ? 'No global packages installed in /usr/local.' : 'Install a Node.js version first.'}
          columns={[
            { key: 'name', header: 'Package', mono: true, render: (r) => r.name, sortValue: (r) => r.name },
            { key: 'version', header: 'Version', mono: true, render: (r) => <span className="text-muted">{r.version}</span> },
            { key: 'actions', header: '', align: 'right', render: (r) => <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} title="Remove" onClick={() => void removeGlobal(r.name)} disabled={busy} /> }
          ]}
        />
        <div className="flex items-center gap-2 p-3 border-t border-border">
          <Input
            value={pkg}
            onChange={(e) => setPkg(e.target.value)}
            placeholder="package[@version], e.g. pm2 or typescript@5"
            mono
            className="max-w-sm"
            disabled={!data.defaultVersion}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void installGlobal(pkg)
            }}
          />
          <Button icon={<Plus size={13} />} onClick={() => void installGlobal(pkg)} disabled={!pkg.trim() || !data.defaultVersion} loading={starting}>
            Install
          </Button>
          <div className="flex-1" />
          {['pm2', 'pnpm', 'yarn'].map((q) => (
            <Button key={q} size="xs" variant="subtle" disabled={globalNames.has(q) || !data.defaultVersion} onClick={() => void installGlobal(q)} title={globalNames.has(q) ? 'Already installed' : `npm install -g ${q}`}>
              {q}
            </Button>
          ))}
        </div>
      </Card>

      <SectionTitle>nvm (per user)</SectionTitle>
      <Card>
        <p className="text-xs text-muted mb-3 leading-relaxed">
          nvm installs Node.js versions in a user&apos;s home directory and only affects that user&apos;s interactive shells. Use it when a developer wants to manage their own versions independently of the system-wide ones above.
        </p>
        {data.nvmUsers.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {data.nvmUsers.map((u) => (
              <Badge key={u.user} color="ok">
                {u.user}: nvm {u.nvmVersion}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-end gap-3">
          <Field label="User" className="w-64">
            <Select value={nvmUser} onChange={(e) => setNvmUser(e.target.value)}>
              {loginUsers.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name} ({u.home})
                </option>
              ))}
            </Select>
          </Field>
          <Button icon={<Download size={13} />} disabled={!nvmUser} loading={starting} onClick={() => void start(() => api.call('rt:node:installNvm', serverId, nvmUser), `Install nvm for ${nvmUser}`)}>
            {data.nvmUsers.some((u) => u.user === nvmUser) ? 'Reinstall nvm' : 'Install nvm'}
          </Button>
        </div>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Bun                                                                 */
/* ------------------------------------------------------------------ */

function BunTab({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<BunStatus>('rt:bun:status', serverId), [serverId])
  const { run, busy } = useAction()
  const { start, busy: starting } = useTaskStarter()
  useReloadOnTaskDone(serverId, reload)
  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading || !data) return <Loading />

  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: 'Remove Bun', message: <>Delete <b className="font-mono">/opt/serversysops/bun</b> and the <code className="font-mono">bun</code>/<code className="font-mono">bunx</code> links in /usr/local/bin?</>, danger: true, confirmLabel: 'Remove' }))) return
    await run(() => api.call('rt:bun:remove', serverId), { success: 'Bun removed' })
    await reload()
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between">
        <SectionTitle>System-wide Bun</SectionTitle>
        <RefreshButton onClick={() => void reload()} />
      </div>
      <Card
        title={
          <span className="flex items-center gap-2">
            Bun {data.installed ? <Badge color="ok">installed</Badge> : <Badge>not installed</Badge>}
          </span>
        }
        actions={
          data.installed ? (
            <>
              <Button size="xs" icon={<ArrowUpCircle size={12} />} loading={starting} onClick={() => void start(() => api.call('rt:bun:upgrade', serverId), 'Upgrade Bun')}>
                Upgrade
              </Button>
              <Button size="xs" variant="danger" icon={<Trash2 size={12} />} onClick={() => void remove()} loading={busy}>
                Remove
              </Button>
            </>
          ) : (
            <Button size="xs" variant="primary" icon={<Download size={12} />} loading={starting} onClick={() => void start(() => api.call('rt:bun:install', serverId), 'Install Bun')}>
              Install
            </Button>
          )
        }
      >
        {data.installed ? (
          <KV
            rows={[
              ['Version', <span className="font-mono">{data.version}</span>],
              ['Location', <span className="font-mono text-muted">{data.path}</span>],
              ['/usr/local/bin/bun', data.linked ? <Badge color="ok">linked</Badge> : <Badge color="warn">not linked</Badge>]
            ]}
          />
        ) : (
          <p className="text-xs text-muted leading-relaxed">
            Installs Bun with the official installer into <code className="font-mono">/opt/serversysops/bun</code> and links <code className="font-mono">bun</code> and <code className="font-mono">bunx</code> into <code className="font-mono">/usr/local/bin</code> so every user can run them.
          </p>
        )}
      </Card>

      {data.others.length > 0 && (
        <>
          <SectionTitle>Other installations</SectionTitle>
          <Card flush>
            <Table
              rows={data.others}
              rowKey={(r) => r.path}
              columns={[
                { key: 'path', header: 'Location', mono: true, render: (r) => r.path },
                { key: 'version', header: 'Version', mono: true, render: (r) => r.version },
                { key: 'note', header: '', align: 'right', render: () => <Badge>Not managed by ServerSysOps</Badge> }
              ]}
            />
          </Card>
        </>
      )}

      <SectionTitle>Per-user installations</SectionTitle>
      <Card flush>
        <Table
          rows={data.users}
          rowKey={(r) => r.user}
          empty="No user has Bun installed in their home directory (~/.bun)."
          columns={[
            { key: 'user', header: 'User', mono: true, render: (r) => r.user },
            { key: 'path', header: 'Location', mono: true, render: (r) => <span className="text-muted">{r.path}</span> }
          ]}
        />
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

function GoTab({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<GoStatus>('rt:go:status', serverId), [serverId])
  const { run, busy } = useAction()
  const { start, busy: starting } = useTaskStarter()
  useReloadOnTaskDone(serverId, reload)
  const [pick, setPick] = useState('')
  const available = data?.available ?? []
  useEffect(() => {
    if (!pick && available.length) setPick((available.find((v) => !v.installed) ?? available[0]).version)
  }, [available, pick])

  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading || !data) return <Loading />

  const removeVersion = async (v: string): Promise<void> => {
    if (!(await confirm({ title: `Remove Go ${v}`, message: <>Delete <b className="font-mono">/opt/serversysops/go/{v}</b>?</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('rt:go:remove', serverId, v), { success: `Removed Go ${v}` })
    await reload()
  }
  const setDefault = async (v: string): Promise<void> => {
    await run(() => api.call('rt:go:setDefault', serverId, v), { success: `Go ${v} is now the default` })
    await reload()
  }
  const selected = available.find((v) => v.version === pick)

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between">
        <SectionTitle>Installed versions</SectionTitle>
        <RefreshButton onClick={() => void reload()} />
      </div>
      <Card flush>
        <Table
          rows={data.versions}
          rowKey={(r) => r.version}
          empty="No Go toolchain installed by ServerSysOps yet. Pick one below."
          columns={[
            {
              key: 'version',
              header: 'Version',
              render: (r) => (
                <span className="flex items-center gap-2 font-mono">
                  {r.version}
                  {r.default && (
                    <Badge color="accent">
                      <Star size={10} className="mr-1" /> Default
                    </Badge>
                  )}
                </span>
              )
            },
            { key: 'path', header: 'Location', mono: true, render: (r) => <span className="text-muted">{r.path}</span> },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (r) => (
                <span className="inline-flex gap-1">
                  {!r.default && (
                    <Button size="xs" onClick={() => void setDefault(r.version)} disabled={busy || data.usrLocalGoIsDir} title={data.usrLocalGoIsDir ? 'Move the existing /usr/local/go away first' : 'Make default'}>
                      Use
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} title="Delete" onClick={() => void removeVersion(r.version)} disabled={busy} />
                </span>
              )
            }
          ]}
        />
      </Card>
      <div className="mt-3">
        <Callout>
          The default version is linked at <code className="font-mono">/usr/local/go</code>; <code className="font-mono">/etc/profile.d/serversysops-go.sh</code> adds <code className="font-mono">/usr/local/go/bin</code> to the PATH of login shells and <code className="font-mono">go</code>/<code className="font-mono">gofmt</code> are linked into{' '}
          <code className="font-mono">/usr/local/bin</code>. Other versions can be used directly from <code className="font-mono">/opt/serversysops/go/&lt;version&gt;/bin/go</code>.
        </Callout>
      </div>
      {data.usrLocalGoIsDir && (
        <div className="mt-3">
          <Callout kind="warn">
            <code className="font-mono">/usr/local/go</code> is an existing installation not managed by ServerSysOps. To switch to a managed version move it away first, e.g. <code className="font-mono">mv /usr/local/go /usr/local/go.old</code>.
          </Callout>
        </div>
      )}

      {data.others.length > 0 && (
        <>
          <SectionTitle>Other installations</SectionTitle>
          <Card flush>
            <Table
              rows={data.others}
              rowKey={(r) => r.path}
              columns={[
                { key: 'path', header: 'Location', mono: true, render: (r) => r.path },
                { key: 'version', header: 'Version', mono: true, render: (r) => r.version },
                { key: 'note', header: '', align: 'right', render: () => <Badge>Not managed by ServerSysOps</Badge> }
              ]}
            />
          </Card>
        </>
      )}

      <SectionTitle>Install a version</SectionTitle>
      <Card>
        {data.arch === 'unsupported' ? (
          <Callout kind="warn">Official Go binaries are not available for this CPU architecture.</Callout>
        ) : (
          <div className="flex items-end gap-3">
            <Field label="Version" className="w-80" hint={data.availableLive ? 'List fetched from go.dev on the server. The download is verified against the published SHA-256.' : 'Offline list (curl is missing or go.dev was unreachable from the server).'}>
              <Select value={pick} onChange={(e) => setPick(e.target.value)}>
                {available.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                    {v.installed ? ': installed' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="primary" icon={<Download size={13} />} disabled={!pick || !!selected?.installed} loading={starting} onClick={() => void start(() => api.call('rt:go:install', serverId, pick), `Install Go ${pick}`)} className="mb-[22px]">
              Install
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* PHP                                                                 */
/* ------------------------------------------------------------------ */

/** Distro packages of one PHP version (Debian/Ubuntu: php8.3-cli, php8.3-fpm; RHEL family: php-cli, php-fpm). */
function phpPackages(family: PhpStatus['family'], version: string): string[] {
  return family === 'debian' ? [`php${version}-cli`, `php${version}-fpm`] : ['php-cli', 'php-fpm']
}

function PhpTab({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<PhpStatus>('rt:php:status', serverId), [serverId])
  const { run, busy } = useAction()
  const { start, busy: starting } = useTaskStarter()
  useReloadOnTaskDone(serverId, reload)
  const [pick, setPick] = useState('')
  const installedVersions = useMemo(() => new Set((data?.versions ?? []).map((v) => v.version)), [data])
  useEffect(() => {
    if (!pick && data?.availableVersions.length) {
      const notInstalled = [...data.availableVersions].reverse().find((v) => !installedVersions.has(v))
      setPick(notInstalled ?? data.availableVersions[data.availableVersions.length - 1])
    }
  }, [data, pick, installedVersions])

  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading || !data) return <Loading />

  const removeVersion = async (v: PhpVersionInfo): Promise<void> => {
    if (!(await confirm({ title: `Remove PHP ${v.version}`, message: <>Purge all <b className="font-mono">php{v.version}</b> packages (FPM, CLI and extensions)? Sites using this PHP version will stop working.</>, danger: true, confirmLabel: 'Remove', typeToConfirm: v.version }))) return
    await start(() => api.call('rt:php:remove', serverId, v.version), `Remove PHP ${v.version}`)
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between">
        <SectionTitle>Installed versions</SectionTitle>
        <RefreshButton onClick={() => void reload()} />
      </div>
      {data.versions.length === 0 ? (
        <Card>
          <EmptyState icon={<Package />} title="PHP is not installed" description="Install a version below. ServerSysOps installs php-fpm, the CLI and the most common extensions (mbstring, xml, curl, zip, opcache)." />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.versions.map((v) => (
            <PhpVersionCard key={v.binary + v.fullVersion} serverId={serverId} status={data} v={v} reload={reload} onRemove={() => void removeVersion(v)} />
          ))}
        </div>
      )}

      <SectionTitle>Composer</SectionTitle>
      <Card
        title={
          <span className="flex items-center gap-2">
            Composer {data.composer.installed ? <Badge color="ok">{data.composer.version ?? 'installed'}</Badge> : <Badge>not installed</Badge>}
          </span>
        }
        actions={
          <Button size="xs" variant={data.composer.installed ? 'default' : 'primary'} icon={<Download size={12} />} loading={starting} disabled={data.versions.length === 0} onClick={() => void start(() => api.call('rt:php:composerInstall', serverId), 'Install Composer')}>
            {data.composer.installed ? 'Reinstall / update' : 'Install Composer'}
          </Button>
        }
      >
        <p className="text-xs text-muted leading-relaxed">
          {data.composer.installed ? (
            <>
              Installed at <code className="font-mono">{data.composer.path}</code>.
            </>
          ) : (
            <>
              Downloads the official installer, verifies its SHA-384 signature and installs <code className="font-mono">/usr/local/bin/composer</code>. Requires a PHP CLI.
            </>
          )}
        </p>
      </Card>

      <SectionTitle>Install a PHP version</SectionTitle>
      <Card>
        {data.family === 'other' ? (
          <Callout kind="warn">PHP installation is supported on Debian/Ubuntu (apt) and RHEL-family (dnf/yum) servers. This server uses {data.pkgManager}.</Callout>
        ) : (
          <>
            <div className="flex items-end gap-3">
              <Field
                label="Version"
                className="w-64"
                hint={
                  data.family === 'debian'
                    ? `Versions beyond the distribution's own come from ${data.repoName}${data.repoReady ? ' (already configured)' : ' (added automatically when needed)'}.`
                    : `Uses the Remi repository and dnf module streams${data.repoReady ? ' (already configured)' : ' (added automatically)'}. RHEL-family systems run one PHP version at a time; installing another version replaces the current one.`
                }
              >
                <Select value={pick} onChange={(e) => setPick(e.target.value)}>
                  {data.availableVersions.map((v) => (
                    <option key={v} value={v}>
                      PHP {v}
                      {installedVersions.has(v) ? ': installed' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="primary" icon={<Download size={13} />} disabled={!pick || installedVersions.has(pick)} loading={starting || busy} onClick={() => void start(() => api.call('rt:php:install', serverId, pick), `Install PHP ${pick}`)} className="mb-[22px]">
                Install
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

const PHP_SETTING_META: { key: PhpSettingKey; label: string; hint: string }[] = [
  { key: 'upload_max_filesize', label: 'upload_max_filesize', hint: 'e.g. 64M' },
  { key: 'post_max_size', label: 'post_max_size', hint: 'should be ≥ upload_max_filesize' },
  { key: 'memory_limit', label: 'memory_limit', hint: 'e.g. 256M or -1' },
  { key: 'max_execution_time', label: 'max_execution_time', hint: 'seconds' },
  { key: 'max_input_vars', label: 'max_input_vars', hint: 'e.g. 3000' }
]

function PhpVersionCard({ serverId, status, v, reload, onRemove }: { serverId: string; status: PhpStatus; v: PhpVersionInfo; reload: () => Promise<void>; onRemove: () => void }): React.JSX.Element {
  const { run, busy } = useAction()
  const { start, busy: starting } = useTaskStarter()
  const toast = useApp((s) => s.toast)
  const [form, setForm] = useState<PhpSettings>(() => ({ ...v.settings }))
  const [target, setTarget] = useState<PhpSettingsTarget>(v.fpmIniPath ? 'fpm' : 'cli')
  const [ext, setExt] = useState('')
  const [showExt, setShowExt] = useState(false)
  useEffect(() => setForm({ ...v.settings }), [v.settings])

  const fpm = async (action: PhpFpmAction): Promise<void> => {
    await run(() => api.call('rt:php:fpm', serverId, v.version, action), { success: `${v.fpmUnit ?? 'php-fpm'}: ${action}` })
    await reload()
  }
  const setDefault = async (): Promise<void> => {
    await run(() => api.call('rt:php:setDefault', serverId, v.version), { success: `php now points to PHP ${v.version}` })
    await reload()
  }
  const dirty = PHP_SETTING_META.some((m) => (form[m.key] ?? '') !== (v.settings[m.key] ?? '')) || (form.display_errors ?? '') !== (v.settings.display_errors ?? '')
  const save = async (): Promise<void> => {
    const patch: PhpSettings = {}
    for (const k of [...PHP_SETTING_META.map((m) => m.key), 'display_errors' as PhpSettingKey]) {
      if ((form[k] ?? '') !== (v.settings[k] ?? '') && form[k] !== undefined) patch[k] = form[k]
    }
    const out = await run(() => api.call<string>('rt:php:setSettings', serverId, v.version, patch, target), { success: 'php.ini updated' })
    if (out !== undefined) {
      if (out.trim()) toast({ kind: 'info', title: 'PHP settings', detail: out.trim() })
      await reload()
    }
  }
  const addExt = async (): Promise<void> => {
    if (!ext) return
    if (await start(() => api.call('rt:php:extInstall', serverId, v.version, ext), `Install PHP ${v.version} extension ${ext}`)) setExt('')
  }
  const removeExt = async (name: string): Promise<void> => {
    if (!(await confirm({ title: `Remove extension ${name}`, message: <>Remove the package providing <b className="font-mono">{name}</b> for PHP {v.version} and restart FPM?</>, danger: true, confirmLabel: 'Remove' }))) return
    await start(() => api.call('rt:php:extRemove', serverId, v.version, name), `Remove PHP ${v.version} extension ${name}`)
  }
  const installedLower = new Set(v.extensions.map((e) => e.toLowerCase()))
  const extAliases: Record<string, string[]> = { mysql: ['mysqli', 'pdo_mysql', 'mysqlnd'], pgsql: ['pgsql', 'pdo_pgsql'], sqlite3: ['sqlite3', 'pdo_sqlite'], opcache: ['zend opcache', 'opcache'], xml: ['xml', 'dom', 'simplexml'] }
  const extInstalled = (e: string): boolean => installedLower.has(e) || (extAliases[e] ?? []).some((a) => installedLower.has(a))
  const addable = status.availableExtensions.filter((e) => !extInstalled(e))
  const removable = status.availableExtensions.filter((e) => extInstalled(e) && !['opcache'].includes(e))

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          PHP {v.fullVersion}
          {v.isDefault && (
            <Badge color="accent">
              <Star size={10} className="mr-1" /> Default (php)
            </Badge>
          )}
          {v.fpmUnit ? v.fpmActive ? <Badge color="ok">FPM running</Badge> : <Badge color="danger">FPM stopped</Badge> : <Badge>no FPM</Badge>}
          {v.fpmUnit && !v.fpmEnabled && <Badge color="warn">not enabled at boot</Badge>}
          {status.family !== 'other' && (
            <PackageUpdate serverId={serverId} packages={phpPackages(status.family, v.version)} restart={v.fpmUnit ? [v.fpmUnit] : undefined} label={`PHP ${v.version}`} />
          )}
        </span>
      }
      actions={
        <>
          {v.fpmUnit && (
            <>
              {v.fpmActive ? (
                <>
                  <Button size="xs" icon={<RotateCw size={12} />} onClick={() => void fpm('restart')} loading={busy} title="systemctl restart">
                    Restart
                  </Button>
                  <Button size="xs" icon={<Square size={12} />} onClick={() => void fpm('stop')} loading={busy} title="systemctl stop">
                    Stop
                  </Button>
                </>
              ) : (
                <Button size="xs" icon={<Play size={12} />} onClick={() => void fpm('start')} loading={busy} title="systemctl start">
                  Start
                </Button>
              )}
              {!v.fpmEnabled && (
                <Button size="xs" variant="subtle" onClick={() => void fpm('enable')} loading={busy} title="systemctl enable --now">
                  Enable
                </Button>
              )}
            </>
          )}
          {!v.isDefault && status.family === 'debian' && (
            <Button size="xs" onClick={() => void setDefault()} loading={busy} title="update-alternatives --set php">
              Set as default
            </Button>
          )}
          <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} title="Remove this PHP version" onClick={onRemove} />
        </>
      }
    >
      <KV
        rows={[
          ['Binary', <span className="font-mono text-muted">{v.binary}</span>],
          ['CLI php.ini', <span className="font-mono text-muted">{v.iniPath}</span>],
          ['FPM php.ini', <span className="font-mono text-muted">{v.fpmIniPath ?? '—'}</span>],
          ...(v.fpmUnit ? ([['FPM unit', <span className="font-mono text-muted">{v.fpmUnit}</span>]] as [React.ReactNode, React.ReactNode][]) : [])
        ]}
      />

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-bg-2 border border-border rounded-md p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium">Extensions</div>
            <Button size="xs" variant="ghost" onClick={() => setShowExt((s) => !s)}>
              {showExt ? 'Show common' : `Show all (${v.extensions.length})`}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(showExt ? v.extensions : removable).map((e) => (
              <span key={e} className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[11px] font-mono bg-panel-2 border border-border-2">
                {e}
                {!showExt && (
                  <button className="text-dim hover:text-danger-fg" title={`Remove ${e}`} onClick={() => void removeExt(e)}>
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
            {!showExt && removable.length === 0 && <span className="text-dim text-xs">None of the common extensions is installed.</span>}
          </div>
          {status.family !== 'other' && (
            <div className="flex items-center gap-2 mt-3">
              <Select value={ext} onChange={(e) => setExt(e.target.value)} className="h-7 text-xs">
                <option value="">Add extension…</option>
                {addable.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
              <Button size="xs" icon={<Plus size={11} />} disabled={!ext} loading={starting} onClick={() => void addExt()}>
                Add
              </Button>
            </div>
          )}
        </div>

        <div className="bg-bg-2 border border-border rounded-md p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium">Settings</div>
            <span className="text-[11px] text-dim">values read from {v.settingsSource === 'fpm' ? 'the FPM php.ini' : 'the CLI php.ini'}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {PHP_SETTING_META.map((m) => (
              <Field key={m.key} label={m.label} hint={m.hint}>
                <Input mono value={form[m.key] ?? ''} onChange={(e) => setForm((f) => ({ ...f, [m.key]: e.target.value }))} placeholder="unchanged" className="h-7 text-xs" />
              </Field>
            ))}
            <div className="flex flex-col justify-end pb-[22px]">
              <Toggle checked={(form.display_errors ?? 'Off') === 'On'} onChange={(on) => setForm((f) => ({ ...f, display_errors: on ? 'On' : 'Off' }))} label={<span className="text-xs">display_errors</span>} />
            </div>
          </div>
          <div className="flex items-end gap-2 mt-2">
            <Field label="Apply to" className="w-40">
              <Select value={target} onChange={(e) => setTarget(e.target.value as PhpSettingsTarget)} className="h-7 text-xs">
                <option value="fpm">FPM (web)</option>
                <option value="cli">CLI</option>
                <option value="both">FPM and CLI</option>
              </Select>
            </Field>
            <div className="flex-1" />
            <Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
          <div className="text-[11px] text-dim mt-2 leading-relaxed">A backup is written next to php.ini (php.ini.serversysops.bak); FPM changes are tested with php-fpm -t before FPM is restarted.</div>
        </div>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

function PythonTab({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<PythonStatus>('rt:py:status', serverId), [serverId])
  const pipxInstalled = !!data?.pipx
  const pipx = useAsync(() => api.call<PipxPackage[]>('rt:py:pipxList', serverId), [serverId, pipxInstalled], { enabled: pipxInstalled })
  const { run, busy } = useAction()
  const { start, busy: starting } = useTaskStarter()
  const reloadAll = async (): Promise<void> => {
    await reload()
    if (pipxInstalled) await pipx.reload()
  }
  useReloadOnTaskDone(serverId, reloadAll)
  const [pkg, setPkg] = useState('')
  const pm = useApp((s) => s.connections[serverId]?.os?.pkgManager)
  // Distro package names of the tools (uv and pyenv are not package-managed and are skipped).
  const pyPkg = (tool: PythonTool | 'python3'): string[] => {
    if (tool === 'python3') return ['python3']
    if (pm === 'apt') return tool === 'pip' ? ['python3-pip'] : tool === 'venv' ? ['python3-venv'] : tool === 'pipx' ? ['pipx'] : []
    if (pm === 'dnf' || pm === 'yum') return tool === 'pip' ? ['python3-pip'] : tool === 'pipx' ? ['pipx'] : []
    return []
  }

  if (error) return <ErrorBox error={error} onRetry={reload} />
  if (loading || !data) return <Loading />

  const installTool = (which: PythonTool): Promise<boolean> => start(() => api.call('rt:py:installTools', serverId, which), `Install ${which}`)
  const installPipx = async (): Promise<void> => {
    const s = pkg.trim()
    if (!s) return
    if (await start(() => api.call('rt:py:pipxInstall', serverId, s), `pipx install ${s}`)) setPkg('')
  }
  const removePipx = async (name: string): Promise<void> => {
    if (!(await confirm({ title: 'Remove pipx package', message: <>Run <code className="font-mono">pipx uninstall {name}</code>?</>, danger: true, confirmLabel: 'Remove' }))) return
    await run(() => api.call('rt:py:pipxRemove', serverId, name), { success: `Removed ${name}` })
    await pipx.reload()
  }
  const toolRow = (label: string, present: boolean, detail: React.ReactNode, which: PythonTool | null, hint: string): [React.ReactNode, React.ReactNode] => [
    label,
    <span className="flex items-center gap-3">
      {present ? <Badge color="ok">installed</Badge> : <Badge>missing</Badge>}
      <span className="font-mono text-muted text-xs">{detail}</span>
      {present && which && pyPkg(which).length > 0 && <PackageUpdate serverId={serverId} packages={pyPkg(which)} label={label} />}
      {!present && which && (
        <Button size="xs" icon={<Download size={11} />} loading={starting} onClick={() => void installTool(which)} title={hint}>
          Install
        </Button>
      )}
      {present && which === 'uv' && (
        <Button size="xs" variant="ghost" loading={starting} onClick={() => void installTool('uv')} title="Re-run the installer to update">
          Update
        </Button>
      )}
    </span>
  ]

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between">
        <SectionTitle>System Python</SectionTitle>
        <RefreshButton onClick={() => void reloadAll()} />
      </div>
      <Card>
        {!data.python3 && (
          <div className="mb-3">
            <Callout kind="warn">python3 is not installed. Installing pip or venv below installs the distribution&apos;s python3 first.</Callout>
          </div>
        )}
        <KV
          rows={[
            [
              'python3',
              data.python3 ? (
                <span className="flex items-center gap-3">
                  <span className="font-mono">
                    {data.python3.version} <span className="text-muted">({data.python3.path})</span>
                  </span>
                  <PackageUpdate serverId={serverId} packages={pyPkg('python3')} label="python3" />
                </span>
              ) : (
                <Badge>missing</Badge>
              )
            ],
            toolRow('pip', !!data.pip, data.pip?.version ?? '', 'pip', 'Install python3-pip'),
            toolRow('venv', data.venvAvailable, data.venvAvailable ? 'python3 -m venv' : '', 'venv', 'Install python3-venv'),
            toolRow('pipx', !!data.pipx, data.pipx ? `${data.pipx.version} (${data.pipx.path})` : '', 'pipx', 'Install pipx (isolated CLI tools)'),
            toolRow('uv', !!data.uv, data.uv ? `${data.uv.version} (${data.uv.path})` : '', 'uv', 'Install uv into /usr/local/bin'),
            ['pyenv', data.pyenvUsers.length ? <span className="text-xs">per-user installs: {data.pyenvUsers.map((u) => <Badge key={u} className="mr-1">{u}</Badge>)}</span> : <span className="text-muted text-xs">not found in any home directory</span>]
          ]}
        />
      </Card>

      <SectionTitle>pipx applications</SectionTitle>
      <Card flush>
        {!data.pipx ? (
          <EmptyState title="pipx is not installed" description="pipx installs Python command-line applications in isolated environments for the login user." action={<Button size="xs" icon={<Download size={11} />} loading={starting} onClick={() => void installTool('pipx')}>Install pipx</Button>} />
        ) : pipx.error ? (
          <div className="p-3">
            <ErrorBox error={pipx.error} onRetry={pipx.reload} />
          </div>
        ) : (
          <>
            <Table
              rows={pipx.data ?? []}
              rowKey={(r) => r.name}
              empty={pipx.loading ? 'Loading…' : 'No applications installed with pipx for the login user.'}
              columns={[
                { key: 'name', header: 'Package', mono: true, render: (r) => r.name, sortValue: (r) => r.name },
                { key: 'version', header: 'Version', mono: true, render: (r) => <span className="text-muted">{r.version}</span> },
                { key: 'apps', header: 'Commands', mono: true, render: (r) => <span className="text-muted">{r.apps.join(', ')}</span> },
                { key: 'actions', header: '', align: 'right', render: (r) => <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} title="Remove" onClick={() => void removePipx(r.name)} disabled={busy} /> }
              ]}
            />
            <div className="flex items-center gap-2 p-3 border-t border-border">
              <Input
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder="package, e.g. httpie or ruff==0.8.0"
                mono
                className="max-w-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void installPipx()
                }}
              />
              <Button icon={<Plus size={13} />} onClick={() => void installPipx()} disabled={!pkg.trim()} loading={starting}>
                Install
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
