import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  FileUp,
  FolderOpen,
  History,
  KeyRound,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Settings,
  Shield,
  Square,
  Table2,
  Trash2,
  Upload,
  UserPlus,
  X
} from 'lucide-react'
import type { PageProps } from '@/pages'
import { api, ApiError, errMsg } from '@/lib/api'
import { useApp } from '@/store/app'
import { cls, fmtBytes, fmtDate } from '@/lib/format'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dot,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  KV,
  Loading,
  MenuButton,
  Modal,
  Page,
  PageHeader,
  Pre,
  SearchInput,
  Select,
  Spinner,
  Stat,
  Table,
  Tabs,
  TextArea,
  confirm,
  useAction,
  useAsync,
  type Column
} from '@/components/ui'
import type {
  DbBackup,
  DbDatabase,
  DbEngine,
  DbEngineStatus,
  DbPrivileges,
  DbQueryResult,
  DbRowsResult,
  DbStatusSummary,
  DbTable,
  DbUser,
  MongoCollection,
  MongoDocsResult,
  MssqlInstallInput,
  SqliteOpenResult
} from '@shared/modules/databases'
import { DB_ENGINE_LABEL, DB_IMPORT_MAX_BYTES, MSSQL_BACKUP_DIR, MSSQL_EDITIONS, MSSQL_EULA_URL, isStrongSqlPassword } from '@shared/modules/databases'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type Section = 'overview' | 'databases' | 'users' | 'backups' | 'browse' | 'sql'
type ServerEngine = 'mysql' | 'postgres' | 'mongo' | 'mssql'

const ENGINE_TABS: { id: DbEngine; label: string }[] = [
  { id: 'mysql', label: 'MySQL / MariaDB' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mongo', label: 'MongoDB' },
  { id: 'mssql', label: 'SQL Server' },
  { id: 'sqlite', label: 'SQLite client' }
]

const CLIENT_NAME: Record<ServerEngine, string> = { mysql: 'mysql / mariadb', postgres: 'psql', mongo: 'mongosh', mssql: 'sqlcmd' }

function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'DB_AUTH'
}

function toastInfo(title: string, detail?: string): void {
  useApp.getState().toast({ kind: 'info', title, detail })
}

function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function genPassword(len = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-_=.'
  for (let attempt = 0; attempt < 20; attempt++) {
    const buf = new Uint32Array(len)
    crypto.getRandomValues(buf)
    const pw = Array.from(buf, (n) => chars[n % chars.length]).join('')
    // Always satisfy the strictest policy (SQL Server): upper + lower + digit + symbol.
    if (isStrongSqlPassword(pw)) return pw
  }
  return 'Aa1!' + genPassword(len - 4)
}

function engineName(e: DbEngine, st?: DbEngineStatus): string {
  if (e === 'mysql') return st?.flavor === 'mariadb' ? 'MariaDB' : 'MySQL'
  return DB_ENGINE_LABEL[e]
}

/** Error display that offers to store admin credentials when the engine refused the connection. */
function DbErrorBox({ error, onRetry, onCredentials }: { error: unknown; onRetry?: () => void; onCredentials?: () => void }): React.JSX.Element {
  if (isAuthError(error) && onCredentials) {
    return (
      <Callout kind="warn">
        <div className="flex items-start gap-3">
          <div className="flex-1 whitespace-pre-wrap break-words">
            <b>Admin access refused.</b> {errMsg(error)}
            <div className="mt-1 text-amber-200/70">Enter an admin login and password; they are kept in memory only while the app runs and are passed to the client through its environment, never on a command line.</div>
          </div>
          <Button size="xs" icon={<KeyRound size={11} />} onClick={onCredentials}>
            Set credentials
          </Button>
          {onRetry && (
            <Button size="xs" variant="subtle" icon={<RefreshCw size={11} />} onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      </Callout>
    )
  }
  return <ErrorBox error={error} onRetry={onRetry} />
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Databases({ serverId }: PageProps): React.JSX.Element {
  const [engine, setEngine] = useState<DbEngine>('mysql')
  const status = useAsync(() => api.call<DbStatusSummary>('db:status', serverId), [serverId], { intervalMs: 20000 })
  const st = status.data

  const subtitle = useMemo(() => {
    if (!st) return undefined
    const parts: string[] = []
    if (st.mysql.installed) parts.push(`${engineName('mysql', st.mysql)} ${st.mysql.version ?? ''}`.trim())
    if (st.postgres.installed) parts.push(`PostgreSQL ${st.postgres.version ?? ''}`.trim())
    if (st.mongo.installed) parts.push(`MongoDB ${st.mongo.version ?? ''}`.trim())
    if (st.mssql.installed) parts.push(`SQL Server ${st.mssql.version ?? ''}`.trim())
    return parts.length ? parts.join(' · ') : 'No database server installed'
  }, [st])

  return (
    <>
      <PageHeader
        title="Databases"
        subtitle={subtitle}
        actions={
          <Button icon={<RefreshCw size={13} />} onClick={() => void status.reload()} loading={status.loading && !!st}>
            Refresh
          </Button>
        }
      />
      <Page>
        <div className="flex items-center gap-3 mb-4">
          <Tabs tabs={ENGINE_TABS.map((t) => ({ id: t.id, label: t.label }))} value={engine} onChange={setEngine} />
          {st && engine !== 'sqlite' && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Dot status={!st[engine].installed ? 'muted' : st[engine].running ? 'ok' : 'danger'} />
              {!st[engine].installed ? 'not installed' : st[engine].running ? 'running' : 'stopped'}
            </div>
          )}
        </div>
        {status.error && !st ? (
          <ErrorBox error={status.error} onRetry={() => void status.reload()} />
        ) : !st ? (
          <Loading />
        ) : engine === 'sqlite' ? (
          <SqliteClient serverId={serverId} installed={st.sqlite.installed} version={st.sqlite.version} reloadStatus={status.reload} />
        ) : (
          <EngineView key={engine} serverId={serverId} engine={engine} st={st[engine]} summary={st} reloadStatus={status.reload} />
        )}
      </Page>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Engine view (server engines)                                        */
/* ------------------------------------------------------------------ */

function EngineView({ serverId, engine, st, summary, reloadStatus }: { serverId: string; engine: ServerEngine; st: DbEngineStatus; summary: DbStatusSummary; reloadStatus: () => Promise<void> }): React.JSX.Element {
  const [section, setSection] = useState<Section>('overview')
  const [selectedDb, setSelectedDb] = useState<string>('')
  const [credsOpen, setCredsOpen] = useState(false)
  const usable = st.installed && st.running && st.clientAvailable
  const dbs = useAsync(() => api.call<DbDatabase[]>('db:databases', serverId, engine), [serverId, engine, st.running, st.usingCredentials], { enabled: usable })
  const userDbs = useMemo(() => (dbs.data ?? []).filter((d) => !d.system), [dbs.data])

  useEffect(() => {
    if (!selectedDb && userDbs.length) setSelectedDb(userDbs[0].name)
  }, [userDbs, selectedDb])

  if (!st.installed) return <InstallPanel serverId={serverId} engine={engine} summary={summary} />

  const sections: { id: Section; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'databases', label: 'Databases', count: dbs.data?.length },
    { id: 'users', label: 'Users' },
    { id: 'backups', label: 'Backups' },
    { id: 'browse', label: 'Browse' },
    { id: 'sql', label: engine === 'mongo' ? 'Shell' : 'SQL' }
  ]
  const openCreds = (): void => setCredsOpen(true)
  const goBrowse = (db: string): void => {
    setSelectedDb(db)
    setSection('browse')
  }

  return (
    <div className="flex flex-col gap-4">
      <Tabs tabs={sections} value={section} onChange={setSection} />
      {section !== 'overview' && !st.running && <Callout kind="warn">{engineName(engine, st)} is not running. Start it from the Overview section.</Callout>}
      {section === 'overview' && <EngineStatus serverId={serverId} engine={engine} st={st} reload={reloadStatus} onCredentials={openCreds} />}
      {section === 'databases' && <DatabasesTable serverId={serverId} engine={engine} dbs={dbs} onBrowse={goBrowse} onCredentials={openCreds} />}
      {section === 'users' && <UsersTable serverId={serverId} engine={engine} dbs={userDbs} onCredentials={openCreds} />}
      {section === 'backups' && <BackupsPanel serverId={serverId} engine={engine} dbs={userDbs} summary={summary} />}
      {(section === 'browse' || section === 'sql') && (
        <div className="flex items-center gap-3">
          <Field label="Database" className="w-72">
            <Select value={selectedDb} onChange={(e) => setSelectedDb(e.target.value)}>
              {!selectedDb && <option value="">— choose —</option>}
              {(dbs.data ?? []).map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                  {d.system ? ' (system)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          {dbs.error ? <DbErrorBox error={dbs.error} onRetry={() => void dbs.reload()} onCredentials={openCreds} /> : null}
        </div>
      )}
      {section === 'browse' && selectedDb && (engine === 'mongo' ? <MongoBrowser serverId={serverId} db={selectedDb} onCredentials={openCreds} /> : <DataBrowser serverId={serverId} engine={engine} db={selectedDb} onCredentials={openCreds} />)}
      {section === 'sql' && selectedDb && (engine === 'mongo' ? <MongoShell serverId={serverId} db={selectedDb} /> : <SqlEditor serverId={serverId} engine={engine} db={selectedDb} onCredentials={openCreds} />)}
      {(section === 'browse' || section === 'sql') && !selectedDb && !dbs.loading && !dbs.error && <Callout>No database available. Create one in the Databases section first.</Callout>}
      {credsOpen && (
        <CredentialsModal
          serverId={serverId}
          engine={engine}
          onClose={() => setCredsOpen(false)}
          onSaved={() => {
            setCredsOpen(false)
            void reloadStatus()
            void dbs.reload()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Install                                                             */
/* ------------------------------------------------------------------ */

function InstallPanel({ serverId, engine, summary }: { serverId: string; engine: ServerEngine; summary: DbStatusSummary }): React.JSX.Element {
  const { run, busy } = useAction()
  const install = async (variant?: 'mysql' | 'mariadb'): Promise<void> => {
    const id = await run(() => api.call<string>('db:install', serverId, engine, variant))
    if (id) toastInfo(`Installing ${variant === 'mariadb' ? 'MariaDB' : engineName(engine)}…`, 'Follow the progress in the Tasks drawer. The status refreshes automatically.')
  }
  if (engine === 'mssql') return <MssqlInstallPanel serverId={serverId} summary={summary} />
  const descr =
    engine === 'mysql'
      ? `MySQL is not installed. Install MySQL or MariaDB (a compatible community fork) from the distribution's repositories (${summary.os.prettyName}).`
      : engine === 'postgres'
        ? `PostgreSQL is not installed. Install the server and contrib packages from the distribution's repositories (${summary.os.prettyName}); on RHEL-like systems the cluster is initialised automatically.`
        : `MongoDB is not installed. Add the official MongoDB 8.0 repository (apt or dnf) and install mongodb-org. mongod will listen on 127.0.0.1:27017 without authentication by default.`
  return (
    <Card>
      <EmptyState
        icon={<Database />}
        title={`${engineName(engine)} is not installed`}
        description={descr}
        action={
          <div className="flex items-center gap-2">
            {engine === 'mysql' ? (
              <>
                <Button variant="primary" icon={<Download size={13} />} loading={busy} onClick={() => install('mysql')} disabled={summary.os.id === 'debian'} title={summary.os.id === 'debian' ? 'Debian ships MariaDB only' : undefined}>
                  Install MySQL
                </Button>
                <Button variant="primary" icon={<Download size={13} />} loading={busy} onClick={() => install('mariadb')}>
                  Install MariaDB
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<Download size={13} />} loading={busy} onClick={() => install()}>
                Install {engineName(engine)}
              </Button>
            )}
          </div>
        }
      />
    </Card>
  )
}

function MssqlInstallPanel({ serverId, summary }: { serverId: string; summary: DbStatusSummary }): React.JSX.Element {
  const [edition, setEdition] = useState('Express')
  const [productKey, setProductKey] = useState('')
  const [pw, setPw] = useState(genPassword())
  const [showPw, setShowPw] = useState(false)
  const [eula, setEula] = useState(false)
  const { run, busy } = useAction()
  const os = summary.os
  const major = os.versionId.split('.')[0]
  const rhelLike = ['rhel', 'rocky', 'almalinux', 'centos', 'ol'].includes(os.id)
  const supported = (os.id === 'ubuntu' && ['20.04', '22.04', '24.04'].includes(os.versionId)) || (rhelLike && ['8', '9'].includes(major))
  const lowMem = summary.os.memTotalBytes !== undefined && summary.os.memTotalBytes < 1.9 * 1024 ** 3
  const useKey = edition === '__key'
  const keyOk = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/i.test(productKey.trim())
  const pwOk = isStrongSqlPassword(pw)
  const valid = supported && !lowMem && eula && pwOk && (!useKey || keyOk)
  const install = async (): Promise<void> => {
    const input: MssqlInstallInput = { saPassword: pw, edition: useKey ? productKey.trim().toUpperCase() : edition, acceptEula: eula }
    const id = await run(() => api.call<string>('db:install', serverId, 'mssql', input))
    if (id) toastInfo('Installing SQL Server 2022…', 'Packages, mssql-tools18 and the non-interactive setup run as a task. The SA password is kept in memory for this session.')
  }
  return (
    <Card>
      <div className="flex flex-col gap-4 max-w-2xl mx-auto py-4">
        <div className="text-center">
          <div className="text-dim mb-2 flex justify-center">
            <Database size={32} />
          </div>
          <div className="font-medium text-[14px]">SQL Server is not installed</div>
          <div className="text-muted text-xs mt-1">
            Installs Microsoft SQL Server 2022 and the sqlcmd tools from packages.microsoft.com, then runs <code>mssql-conf setup</code> non-interactively. Supported by Microsoft on Ubuntu 20.04 / 22.04 / 24.04 and RHEL 8 / 9 (and compatible) only; needs at least 2 GB of RAM.
          </div>
        </div>
        {!supported && <Callout kind="danger">{os.prettyName} is not a platform Microsoft publishes SQL Server packages for. Use Ubuntu 20.04/22.04/24.04 or RHEL 8/9 (Rocky, Alma, Oracle Linux), or run SQL Server in Docker.</Callout>}
        {lowMem && <Callout kind="danger">This server has {fmtBytes(summary.os.memTotalBytes)} of RAM; SQL Server refuses to start with less than 2 GB.</Callout>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Edition" className={useKey ? 'col-span-1' : 'col-span-2'}>
            <Select value={edition} onChange={(e) => setEdition(e.target.value)}>
              {MSSQL_EDITIONS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
              <option value="__key">I have a product key…</option>
            </Select>
          </Field>
          {useKey && (
            <Field label="Product key" hint="25 characters, XXXXX-XXXXX-XXXXX-XXXXX-XXXXX">
              <Input value={productKey} onChange={(e) => setProductKey(e.target.value)} mono placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" />
            </Field>
          )}
          <Field label="SA password" className="col-span-2" hint={pwOk ? 'Strong enough for the SQL Server password policy.' : 'At least 8 characters with upper-case, lower-case letters, digits and symbols — SQL Server rejects weaker passwords.'}>
            <div className="flex gap-2">
              <Input type={showPw ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} mono autoComplete="off" />
              <Button onClick={() => setShowPw((s) => !s)}>{showPw ? 'Hide' : 'Show'}</Button>
              <Button onClick={() => setPw(genPassword())}>Generate</Button>
            </div>
          </Field>
        </div>
        <Checkbox
          checked={eula}
          onChange={setEula}
          label={
            <span>
              I accept the{' '}
              <button type="button" className="text-accent hover:underline" onClick={(e) => { e.stopPropagation(); api.openExternal(MSSQL_EULA_URL) }}>
                Microsoft SQL Server license terms
              </button>{' '}
              (and the ODBC / mssql-tools EULA)
            </span>
          }
        />
        <div className="flex justify-center">
          <Button variant="primary" icon={<Download size={13} />} loading={busy} disabled={!valid} onClick={install}>
            Install SQL Server 2022
          </Button>
        </div>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Overview / status                                                   */
/* ------------------------------------------------------------------ */

function EngineStatus({ serverId, engine, st, reload, onCredentials }: { serverId: string; engine: ServerEngine; st: DbEngineStatus; reload: () => Promise<void>; onCredentials: () => void }): React.JSX.Element {
  const { run, busy } = useAction()
  const [secureOpen, setSecureOpen] = useState(false)
  const svc = async (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'): Promise<void> => {
    if (action === 'stop' && !(await confirm({ title: `Stop ${engineName(engine, st)}`, message: 'Applications using this database server will lose their connections.', danger: true, confirmLabel: 'Stop' }))) return
    await run(() => api.call('db:service', serverId, engine, action), { success: `${engineName(engine, st)}: ${action}` })
    await reload()
  }
  const name = engineName(engine, st)
  const rows: [React.ReactNode, React.ReactNode][] = [
    ['Version', st.version ?? '—'],
    ...(engine === 'mssql' ? ([['Edition', st.edition ?? '—']] as [React.ReactNode, React.ReactNode][]) : []),
    [
      'Status',
      <span className="flex items-center gap-2">
        <Badge color={st.running ? 'ok' : 'danger'}>{st.running ? 'running' : 'stopped'}</Badge>
        <Badge color={st.enabled ? 'ok' : 'muted'}>{st.enabled ? 'enabled at boot' : 'not enabled'}</Badge>
        {st.unit && <span className="text-dim text-xs font-mono">{st.unit}.service</span>}
      </span>
    ],
    ['Data directory', <span className="font-mono text-xs">{st.dataDir ?? '—'}</span>],
    ['Port', st.port ?? '—'],
    ['Bind address', <span className="font-mono text-xs">{st.bindAddress ?? '—'}</span>],
    ['Size on disk', fmtBytes(st.sizeBytes)],
    ['Admin access', st.authOk === undefined ? '—' : st.authOk ? <span className="text-green-300">{st.usingCredentials ? (engine === 'mssql' ? 'SQL login (stored credentials)' : 'stored credentials') : engine === 'postgres' ? 'peer auth as postgres' : engine === 'mongo' ? 'localhost (no auth)' : 'root via unix socket'}</span> : <span className="text-amber-300">{engine === 'mssql' && !st.usingCredentials ? 'login required' : 'failed'}</span>]
  ]
  for (const [k, v] of Object.entries(st.details ?? {})) if (v) rows.push([k.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase()), <span className="font-mono text-xs">{v}</span>])

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Stat label="Engine" value={name} sub={st.version} />
        <Stat label="Service" value={st.running ? 'Running' : 'Stopped'} sub={st.enabled ? 'starts at boot' : 'manual start'} color={st.running ? 'bg-ok' : 'bg-danger'} bar={st.running ? 100 : 0} />
        <Stat label="Size on disk" value={fmtBytes(st.sizeBytes)} sub={st.dataDir} />
        <Stat label="Listening" value={st.port ?? '—'} sub={st.bindAddress} />
      </div>
      {st.authOk === false && <DbErrorBox error={new ApiError(st.authError ?? 'Admin connection failed', 'DB_AUTH')} onRetry={() => void reload()} onCredentials={onCredentials} />}
      {st.needsInitdb && <Callout kind="warn">The PostgreSQL cluster is not initialised. Run <code>postgresql-setup --initdb</code> (RHEL) or <code>initdb</code> (Arch) before starting the service. The installer does this automatically.</Callout>}
      {!st.clientAvailable && <Callout kind="warn">The admin client ({CLIENT_NAME[engine]}) is not installed, so databases cannot be managed from here.{engine === 'mssql' && <> Install it with <code>ACCEPT_EULA=Y apt-get install mssql-tools18 unixodbc-dev</code> (or <code>dnf install mssql-tools18 unixODBC-devel</code>).</>}</Callout>}
      {engine === 'mongo' && st.running && st.authOk && !st.usingCredentials && <Callout>MongoDB is running without access control (default). Create an admin user in the Users section and enable <code>security.authorization</code> in /etc/mongod.conf if the server is reachable from outside.</Callout>}
      <Card
        title="Service"
        actions={
          <>
            {st.running ? (
              <>
                <Button size="xs" icon={<RotateCw size={11} />} loading={busy} onClick={() => svc('restart')}>
                  Restart
                </Button>
                <Button size="xs" variant="danger" icon={<Square size={11} />} loading={busy} onClick={() => svc('stop')}>
                  Stop
                </Button>
              </>
            ) : (
              <Button size="xs" variant="primary" icon={<Play size={11} />} loading={busy} onClick={() => svc('start')}>
                Start
              </Button>
            )}
            <Button size="xs" icon={<Power size={11} />} loading={busy} onClick={() => svc(st.enabled ? 'disable' : 'enable')}>
              {st.enabled ? 'Disable at boot' : 'Enable at boot'}
            </Button>
            <Button size="xs" icon={<KeyRound size={11} />} onClick={onCredentials}>
              Admin credentials
            </Button>
            {engine === 'mysql' && (
              <Button size="xs" icon={<Shield size={11} />} onClick={() => setSecureOpen(true)} disabled={!st.running}>
                Secure installation
              </Button>
            )}
          </>
        }
      >
        <KV rows={rows} />
      </Card>
      {engine === 'mssql' && st.mssql && <MssqlSettingsCard serverId={serverId} st={st} reload={reload} />}
      {secureOpen && <SecureModal serverId={serverId} st={st} onClose={() => setSecureOpen(false)} onDone={() => void reload()} />}
    </div>
  )
}

function MssqlSettingsCard({ serverId, st, reload }: { serverId: string; st: DbEngineStatus; reload: () => Promise<void> }): React.JSX.Element {
  const cur = st.mssql ?? { port: 1433, agentEnabled: false }
  const [port, setPort] = useState(String(cur.port))
  const [memOn, setMemOn] = useState(cur.memoryLimitMb !== undefined)
  const [mem, setMem] = useState(String(cur.memoryLimitMb ?? 4096))
  const [agent, setAgent] = useState(cur.agentEnabled)
  const { run, busy } = useAction()
  useEffect(() => {
    setPort(String(cur.port))
    setMemOn(cur.memoryLimitMb !== undefined)
    setMem(String(cur.memoryLimitMb ?? 4096))
    setAgent(cur.agentEnabled)
  }, [cur.port, cur.memoryLimitMb, cur.agentEnabled])
  const portN = Number(port)
  const memN = Number(mem)
  const patch: { port?: number; memoryLimitMb?: number | null; agentEnabled?: boolean } = {}
  if (portN !== cur.port) patch.port = portN
  if (memOn && memN !== cur.memoryLimitMb) patch.memoryLimitMb = memN
  if (!memOn && cur.memoryLimitMb !== undefined) patch.memoryLimitMb = null
  if (agent !== cur.agentEnabled) patch.agentEnabled = agent
  const dirty = Object.keys(patch).length > 0
  const valid = Number.isInteger(portN) && portN >= 1 && portN <= 65535 && (!memOn || (Number.isInteger(memN) && memN >= 2048))
  const apply = async (): Promise<void> => {
    const list = [patch.port !== undefined ? `TCP port → ${patch.port}` : null, patch.memoryLimitMb !== undefined ? `memory limit → ${patch.memoryLimitMb === null ? 'default' : patch.memoryLimitMb + ' MB'}` : null, patch.agentEnabled !== undefined ? `SQL Agent → ${patch.agentEnabled ? 'enabled' : 'disabled'}` : null].filter(Boolean)
    if (!(await confirm({ title: 'Apply SQL Server settings', message: <>{list.join(', ')}. <b>mssql-server will be restarted</b>; open connections are dropped.</>, danger: true, confirmLabel: 'Apply & restart' }))) return
    await run(() => api.call('db:mssql:configure', serverId, patch), { success: 'Settings applied, SQL Server restarted' })
    await reload()
  }
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Settings size={13} /> Server settings (mssql-conf)
        </span>
      }
      actions={
        <Button size="xs" variant="primary" disabled={!dirty || !valid} loading={busy} onClick={apply}>
          Apply & restart
        </Button>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Field label="TCP port" hint="network.tcpport — remember the firewall and the stored client port.">
          <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} mono />
        </Field>
        <Field label="Memory limit (MB)" hint="memory.memorylimitmb — default is 80 % of RAM. Minimum 2048.">
          <div className="flex items-center gap-2">
            <Checkbox checked={memOn} onChange={setMemOn} />
            <Input type="number" value={mem} onChange={(e) => setMem(e.target.value)} disabled={!memOn} mono />
          </div>
        </Field>
        <Field label="SQL Server Agent" hint="sqlagent.enabled — needed for scheduled jobs.">
          <div className="h-8 flex items-center">
            <Checkbox checked={agent} onChange={setAgent} label={agent ? 'Enabled' : 'Disabled'} />
          </div>
        </Field>
      </div>
    </Card>
  )
}

function SecureModal({ serverId, st, onClose, onDone }: { serverId: string; st: DbEngineStatus; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [pw, setPw] = useState('')
  const [setPwOn, setSetPwOn] = useState(false)
  const [anon, setAnon] = useState(true)
  const [test, setTest] = useState(true)
  const [remote, setRemote] = useState(true)
  const [result, setResult] = useState<string[] | null>(null)
  const { run, busy } = useAction()
  const go = async (): Promise<void> => {
    const r = await run(() => api.call<string[]>('db:secure', serverId, 'mysql', { rootPassword: setPwOn ? pw : undefined, removeAnonymous: anon, removeTestDb: test, disallowRemoteRoot: remote }), { success: 'Installation secured' })
    if (r) {
      setResult(r)
      onDone()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Secure ${engineName('mysql', st)} installation`}
      footer={
        <>
          <Button onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
          {!result && (
            <Button variant="primary" loading={busy} disabled={setPwOn && pw.length < 8} onClick={go}>
              Apply
            </Button>
          )}
        </>
      }
    >
      {result ? (
        <Pre>{result.join('\n') || 'Nothing to do.'}</Pre>
      ) : (
        <div className="flex flex-col gap-3 text-[13px]">
          <Callout>Equivalent of <code>mysql_secure_installation</code>, applied non-interactively through the local socket.</Callout>
          <Checkbox checked={setPwOn} onChange={setSetPwOn} label="Set a password for root@localhost" />
          {setPwOn && (
            <Field hint={st.flavor === 'mariadb' ? 'MariaDB keeps unix_socket authentication for root in addition to the password, so local admin access keeps working.' : 'MySQL will stop using auth_socket for root; the password is remembered in memory for this session so management keeps working.'}>
              <div className="flex gap-2">
                <Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="at least 8 characters" mono autoComplete="off" />
                <Button onClick={() => setPw(genPassword())}>Generate</Button>
              </div>
            </Field>
          )}
          <Checkbox checked={anon} onChange={setAnon} label="Remove anonymous users" />
          <Checkbox checked={test} onChange={setTest} label="Remove the test database" />
          <Checkbox checked={remote} onChange={setRemote} label="Disallow root login from remote hosts" />
        </div>
      )}
    </Modal>
  )
}

function CredentialsModal({ serverId, engine, onClose, onSaved }: { serverId: string; engine: ServerEngine; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [user, setUser] = useState(engine === 'postgres' ? 'postgres' : engine === 'mongo' ? 'admin' : engine === 'mssql' ? 'sa' : 'root')
  const [pw, setPw] = useState('')
  const { run, busy } = useAction()
  const save = async (clear = false): Promise<void> => {
    const r = await run(() => api.call<{ stored: boolean }>('db:setCredentials', serverId, engine, clear ? '' : user, pw), { success: clear ? 'Credentials cleared' : 'Credentials accepted', error: 'Connection with these credentials failed' })
    if (r) onSaved()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${engineName(engine)} admin credentials`}
      footer={
        <>
          <Button onClick={() => save(true)} disabled={busy}>
            Clear stored
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!user} onClick={() => save(false)}>
            Test & use
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Callout>
          Used when local socket / peer authentication is not available (for example MySQL root with a password, PostgreSQL over TCP, or MongoDB with access control). Kept only in the memory of this app; never written to disk.
          {engine === 'postgres' && ' The connection is made to 127.0.0.1 with password authentication.'}
          {engine === 'mongo' && ' Authenticates against the admin database.'}
          {engine === 'mssql' && ' SQL Server always needs a SQL login (sa or another sysadmin); the password is passed to sqlcmd via SQLCMDPASSWORD.'}
        </Callout>
        <Field label="User">
          <Input value={user} onChange={(e) => setUser(e.target.value)} mono autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && void save(false)} />
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

function DatabasesTable({ serverId, engine, dbs, onBrowse, onCredentials }: { serverId: string; engine: ServerEngine; dbs: ReturnType<typeof useAsync<DbDatabase[]>>; onBrowse: (db: string) => void; onCredentials: () => void }): React.JSX.Element {
  const [create, setCreate] = useState(false)
  const [filter, setFilter] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const { run } = useAction()

  const drop = async (d: DbDatabase): Promise<void> => {
    if (!(await confirm({ title: `Drop database ${d.name}`, message: <>All data in <b className="font-mono">{d.name}</b> ({fmtBytes(d.sizeBytes)}) will be deleted permanently. Make a backup first.</>, danger: true, confirmLabel: 'Drop database', typeToConfirm: d.name }))) return
    await run(() => api.call('db:dropDatabase', serverId, engine, d.name), { success: `Dropped ${d.name}` })
    await dbs.reload()
  }
  const backup = async (d: DbDatabase): Promise<void> => {
    const id = await run(() => api.call<string>('db:backup', serverId, engine, d.name))
    if (id) toastInfo(`Backing up ${d.name}…`, 'The dump is written to /var/backups/servermate (see Tasks).')
  }

  const list = (dbs.data ?? []).filter((d) => (showSystem || !d.system) && (!filter || d.name.toLowerCase().includes(filter.toLowerCase())))
  const columns: Column<DbDatabase>[] = [
    { key: 'name', header: 'Name', render: (d) => <span className="font-mono text-xs flex items-center gap-2">{d.name}{d.system && <Badge>system</Badge>}{d.state && d.state !== 'ONLINE' && <Badge color="warn">{d.state}</Badge>}</span>, sortValue: (d) => d.name },
    { key: 'size', header: 'Size', align: 'right', render: (d) => fmtBytes(d.sizeBytes), sortValue: (d) => d.sizeBytes ?? 0, width: '110px' },
    engine === 'postgres' || engine === 'mssql'
      ? { key: 'owner', header: 'Owner', render: (d) => <span className="font-mono text-xs">{d.owner ?? '—'}</span>, sortValue: (d) => d.owner ?? '' }
      : { key: 'charset', header: engine === 'mongo' ? '' : 'Charset / collation', render: (d) => (engine === 'mongo' ? '' : <span className="text-xs text-muted">{[d.charset, d.collation].filter(Boolean).join(' / ') || '—'}</span>) },
    ...(engine === 'mssql' ? [{ key: 'recovery', header: 'Recovery / collation', render: (d: DbDatabase) => <span className="text-xs text-muted">{[d.recoveryModel, d.collation].filter(Boolean).join(' · ') || '—'}</span> } as Column<DbDatabase>] : []),
    ...(engine === 'mssql' ? [] : [{ key: 'tables', header: engine === 'mongo' ? 'Collections' : 'Tables', align: 'right', render: (d: DbDatabase) => d.tables ?? '—', sortValue: (d: DbDatabase) => d.tables ?? -1, width: '110px' } as Column<DbDatabase>]),
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '260px',
      render: (d) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="xs" variant="ghost" icon={<Table2 size={11} />} onClick={() => onBrowse(d.name)}>
            Browse
          </Button>
          <Button size="xs" variant="ghost" icon={<Archive size={11} />} onClick={() => backup(d)}>
            Backup
          </Button>
          <Button size="xs" variant="ghost" className="text-red-300" icon={<Trash2 size={11} />} disabled={d.system} onClick={() => drop(d)}>
            Drop
          </Button>
        </div>
      )
    }
  ]

  return (
    <>
      <Card
        flush
        title="Databases"
        actions={
          <>
            <SearchInput value={filter} onChange={setFilter} className="w-48" />
            <Checkbox checked={showSystem} onChange={setShowSystem} label={<span className="text-xs text-muted">system</span>} />
            <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void dbs.reload()} title="Refresh" />
            <Button size="xs" variant="primary" icon={<Plus size={11} />} onClick={() => setCreate(true)}>
              Create database
            </Button>
          </>
        }
      >
        {dbs.error ? (
          <div className="p-4">
            <DbErrorBox error={dbs.error} onRetry={() => void dbs.reload()} onCredentials={onCredentials} />
          </div>
        ) : dbs.loading && !dbs.data ? (
          <Loading />
        ) : (
          <Table columns={columns} rows={list} rowKey={(d) => d.name} dense empty="No databases" initialSort={{ key: 'name', dir: 'asc' }} />
        )}
      </Card>
      {create && (
        <CreateDatabaseModal
          serverId={serverId}
          engine={engine}
          onClose={() => setCreate(false)}
          onCreated={() => {
            setCreate(false)
            void dbs.reload()
          }}
        />
      )}
    </>
  )
}

function CreateDatabaseModal({ serverId, engine, onClose, onCreated }: { serverId: string; engine: ServerEngine; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [charset, setCharset] = useState(engine === 'mysql' ? 'utf8mb4' : engine === 'postgres' ? 'UTF8' : '')
  const [owner, setOwner] = useState('')
  const users = useAsync(() => api.call<DbUser[]>('db:users', serverId, engine), [serverId, engine], { enabled: engine === 'postgres' })
  const { run, busy } = useAction()
  const valid = /^[A-Za-z0-9_][A-Za-z0-9_$\-]{0,63}$/.test(name)
  const create = async (): Promise<void> => {
    const ok = await run(() => api.call('db:createDatabase', serverId, engine, name, { charset: charset || undefined, owner: owner || undefined }).then(() => true), { success: `Created ${name}` })
    if (ok) onCreated()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Create database"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={create}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="Letters, digits, _ and - only.">
          <Input value={name} onChange={(e) => setName(e.target.value)} mono autoFocus onKeyDown={(e) => e.key === 'Enter' && valid && void create()} />
        </Field>
        {engine === 'mysql' && (
          <Field label="Character set">
            <Select value={charset} onChange={(e) => setCharset(e.target.value)}>
              <option value="utf8mb4">utf8mb4 (recommended)</option>
              <option value="utf8">utf8 (utf8mb3)</option>
              <option value="latin1">latin1</option>
              <option value="">server default</option>
            </Select>
          </Field>
        )}
        {engine === 'postgres' && (
          <>
            <Field label="Owner">
              <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">postgres (default)</option>
                {(users.data ?? []).filter((u) => u.canLogin !== false && u.user !== 'postgres').map((u) => (
                  <option key={u.user} value={u.user}>
                    {u.user}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Encoding">
              <Select value={charset} onChange={(e) => setCharset(e.target.value)}>
                <option value="UTF8">UTF8</option>
                <option value="">template default</option>
              </Select>
            </Field>
          </>
        )}
        {engine === 'mongo' && <Callout>MongoDB creates databases lazily; an empty collection named <code>default</code> is created so the database shows up.</Callout>}
        {engine === 'mssql' && <Callout>Created with the server default collation and SIMPLE/FULL recovery model inherited from <code>model</code>.</Callout>}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

function UsersTable({ serverId, engine, dbs, onCredentials }: { serverId: string; engine: ServerEngine; dbs: DbDatabase[]; onCredentials: () => void }): React.JSX.Element {
  const users = useAsync(() => api.call<DbUser[]>('db:users', serverId, engine), [serverId, engine])
  const [create, setCreate] = useState(false)
  const [pwFor, setPwFor] = useState<DbUser | null>(null)
  const [grantFor, setGrantFor] = useState<DbUser | null>(null)
  const [showSystem, setShowSystem] = useState(false)
  const [filter, setFilter] = useState('')
  const { run } = useAction()

  const drop = async (u: DbUser): Promise<void> => {
    const label = engine === 'mysql' ? `${u.user}@${u.host}` : u.user
    if (!(await confirm({ title: 'Drop user', message: <>Drop <b className="font-mono">{label}</b>? Applications using this account will no longer be able to connect.</>, danger: true, confirmLabel: 'Drop user' }))) return
    await run(() => api.call('db:dropUser', serverId, engine, u.user, u.host), { success: `Dropped ${label}` })
    await users.reload()
  }

  const list = (users.data ?? []).filter((u) => (showSystem || !u.system) && (!filter || u.user.toLowerCase().includes(filter.toLowerCase())))
  const columns: Column<DbUser>[] = [
    { key: 'user', header: 'User', render: (u) => <span className="font-mono text-xs flex items-center gap-2">{u.user || <i className="text-muted">(anonymous)</i>}{u.superuser && <Badge color="warn">super</Badge>}{u.system && <Badge>system</Badge>}</span>, sortValue: (u) => u.user, width: '220px' },
    ...(engine !== 'postgres' ? [{ key: 'host', header: engine === 'mongo' ? 'Auth database' : engine === 'mssql' ? 'Default database' : 'Host', render: (u: DbUser) => <span className="font-mono text-xs">{u.host}</span>, sortValue: (u: DbUser) => u.host ?? '', width: '160px' } as Column<DbUser>] : []),
    { key: 'priv', header: engine === 'mssql' ? 'Roles' : 'Privileges', render: (u) => <span className="text-xs text-muted break-words">{u.privileges}</span> },
    ...(engine === 'mysql' || engine === 'mssql' ? [{ key: 'plugin', header: engine === 'mssql' ? 'Type' : 'Auth', render: (u: DbUser) => <span className="text-xs text-dim">{u.plugin ?? ''}</span>, width: '160px' } as Column<DbUser>] : []),
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '300px',
      render: (u) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="xs" variant="ghost" icon={<Shield size={11} />} onClick={() => setGrantFor(u)} disabled={!u.user}>
            Grant
          </Button>
          <Button size="xs" variant="ghost" icon={<KeyRound size={11} />} onClick={() => setPwFor(u)} disabled={!u.user}>
            Password
          </Button>
          <Button size="xs" variant="ghost" className="text-red-300" icon={<Trash2 size={11} />} onClick={() => drop(u)} disabled={u.user === 'root' || u.user === 'postgres' || u.user.toLowerCase() === 'sa'}>
            Drop
          </Button>
        </div>
      )
    }
  ]

  return (
    <>
      <Card
        flush
        title="Users"
        actions={
          <>
            <SearchInput value={filter} onChange={setFilter} className="w-48" />
            <Checkbox checked={showSystem} onChange={setShowSystem} label={<span className="text-xs text-muted">system</span>} />
            <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void users.reload()} title="Refresh" />
            <Button size="xs" variant="primary" icon={<UserPlus size={11} />} onClick={() => setCreate(true)}>
              Create user
            </Button>
          </>
        }
      >
        {users.error ? (
          <div className="p-4">
            <DbErrorBox error={users.error} onRetry={() => void users.reload()} onCredentials={onCredentials} />
          </div>
        ) : users.loading && !users.data ? (
          <Loading />
        ) : (
          <Table columns={columns} rows={list} rowKey={(u) => `${u.user}@${u.host ?? ''}`} dense empty="No users" initialSort={{ key: 'user', dir: 'asc' }} />
        )}
      </Card>
      {create && (
        <CreateUserModal
          serverId={serverId}
          engine={engine}
          dbs={dbs}
          onClose={() => setCreate(false)}
          onCreated={() => {
            setCreate(false)
            void users.reload()
          }}
        />
      )}
      {pwFor && <PasswordModal serverId={serverId} engine={engine} user={pwFor} onClose={() => setPwFor(null)} />}
      {grantFor && (
        <GrantModal
          serverId={serverId}
          engine={engine}
          user={grantFor}
          dbs={dbs}
          onClose={() => setGrantFor(null)}
          onDone={() => {
            setGrantFor(null)
            void users.reload()
          }}
        />
      )}
    </>
  )
}

function PrivilegesSelect({ value, onChange, engine }: { value: DbPrivileges; onChange: (v: DbPrivileges) => void; engine: ServerEngine }): React.JSX.Element {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as DbPrivileges)}>
      <option value="all">{engine === 'mongo' ? 'dbOwner (read/write/admin)' : engine === 'mssql' ? 'db_owner (full control of the database)' : 'All privileges on the database'}</option>
      <option value="readonly">{engine === 'mongo' ? 'read' : engine === 'mssql' ? 'db_datareader (read-only)' : 'Read-only (SELECT)'}</option>
      <option value="none">No grants (login only)</option>
    </Select>
  )
}

function CreateUserModal({ serverId, engine, dbs, onClose, onCreated }: { serverId: string; engine: ServerEngine; dbs: DbDatabase[]; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [user, setUser] = useState('')
  const [host, setHost] = useState('%')
  const [pw, setPw] = useState(genPassword())
  const [database, setDatabase] = useState(dbs[0]?.name ?? '')
  const [privs, setPrivs] = useState<DbPrivileges>('all')
  const { run, busy } = useAction()
  const valid = /^[A-Za-z0-9_][A-Za-z0-9_$\-]{0,63}$/.test(user) && pw.length > 0 && (engine !== 'mysql' || /^[A-Za-z0-9_.%:\-]{1,60}$/.test(host)) && (engine !== 'mssql' || isStrongSqlPassword(pw))
  const create = async (): Promise<void> => {
    const ok = await run(() => api.call('db:createUser', serverId, engine, { user, host: engine === 'mysql' ? host : undefined, password: pw, database: privs === 'none' ? undefined : database || undefined, privileges: privs }).then(() => true), { success: `Created user ${user}` })
    if (ok) onCreated()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Create user"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={create}>
            Create user
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-3">
        <Field label="User name" className={engine === 'mysql' ? 'col-span-4' : 'col-span-6'}>
          <Input value={user} onChange={(e) => setUser(e.target.value)} mono autoFocus />
        </Field>
        {engine === 'mysql' && (
          <Field label="Host" className="col-span-2" hint="% = any host">
            <Input value={host} onChange={(e) => setHost(e.target.value)} mono />
          </Field>
        )}
        <Field label="Password" className="col-span-6" hint={engine === 'mssql' ? 'SQL Server policy: at least 8 characters with upper-case, lower-case letters, digits and symbols.' : undefined}>
          <div className="flex gap-2">
            <Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} mono autoComplete="off" />
            <Button onClick={() => setPw(genPassword())}>Generate</Button>
          </div>
        </Field>
        <Field label={engine === 'mssql' ? 'Database role' : 'Privileges'} className="col-span-3">
          <PrivilegesSelect value={privs} onChange={setPrivs} engine={engine} />
        </Field>
        <Field label={engine === 'mssql' ? 'Database (also default database)' : 'On database'} className="col-span-3">
          <Select value={database} onChange={(e) => setDatabase(e.target.value)} disabled={privs === 'none'}>
            {engine === 'mongo' && privs !== 'none' && <option value="">all databases (root / readAnyDatabase)</option>}
            {dbs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        {engine === 'mongo' && (
          <div className="col-span-6">
            <Callout>The user is created in the <code>admin</code> authentication database.</Callout>
          </div>
        )}
        {engine === 'mssql' && (
          <div className="col-span-6">
            <Callout>Creates a SQL login (<code>CREATE LOGIN … CHECK_POLICY = ON</code>) and, when a database is chosen, a database user mapped to it with the selected role.</Callout>
          </div>
        )}
      </div>
    </Modal>
  )
}

function PasswordModal({ serverId, engine, user, onClose }: { serverId: string; engine: ServerEngine; user: DbUser; onClose: () => void }): React.JSX.Element {
  const [pw, setPw] = useState(genPassword())
  const { run, busy } = useAction()
  const label = engine === 'mysql' ? `${user.user}@${user.host}` : user.user
  const save = async (): Promise<void> => {
    const ok = await run(() => api.call('db:setPassword', serverId, engine, user.user, user.host, pw).then(() => true), { success: `Password changed for ${label}` })
    if (ok) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Change password · ${label}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!pw} onClick={save}>
            Change password
          </Button>
        </>
      }
    >
      <Field label="New password">
        <div className="flex gap-2">
          <Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} mono autoComplete="off" autoFocus onKeyDown={(e) => e.key === 'Enter' && void save()} />
          <Button onClick={() => setPw(genPassword())}>Generate</Button>
        </div>
      </Field>
    </Modal>
  )
}

function GrantModal({ serverId, engine, user, dbs, onClose, onDone }: { serverId: string; engine: ServerEngine; user: DbUser; dbs: DbDatabase[]; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [database, setDatabase] = useState(dbs[0]?.name ?? '')
  const [privs, setPrivs] = useState<DbPrivileges>('all')
  const { run, busy } = useAction()
  const label = engine === 'mysql' ? `${user.user}@${user.host}` : user.user
  const go = async (): Promise<void> => {
    const ok = await run(() => api.call('db:grant', serverId, engine, { user: user.user, host: user.host, database, privileges: privs }).then(() => true), { success: privs === 'none' ? `Revoked privileges on ${database}` : `Granted ${privs} on ${database}` })
    if (ok) onDone()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Grant · ${label}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!database} onClick={go}>
            Apply
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Database">
          <Select value={database} onChange={(e) => setDatabase(e.target.value)}>
            {dbs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Privileges" hint="Existing privileges on this database are replaced. Choose “No grants” to revoke.">
          <PrivilegesSelect value={privs} onChange={setPrivs} engine={engine} />
        </Field>
      </div>
      <div className="mt-3 text-xs text-muted">Current: {user.privileges}</div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

function BackupsPanel({ serverId, engine, dbs, summary }: { serverId: string; engine: ServerEngine; dbs: DbDatabase[]; summary: DbStatusSummary }): React.JSX.Element {
  const backups = useAsync(() => api.call<DbBackup[]>('db:backups', serverId), [serverId], { intervalMs: 10000 })
  const [db, setDb] = useState(dbs[0]?.name ?? '')
  const [restoreOf, setRestoreOf] = useState<DbBackup | null>(null)
  const [onlyEngine, setOnlyEngine] = useState(true)
  const { run, busy } = useAction()

  useEffect(() => {
    if (!db && dbs.length) setDb(dbs[0].name)
  }, [dbs, db])

  const backup = async (): Promise<void> => {
    if (!db) return
    const id = await run(() => api.call<string>('db:backup', serverId, engine, db))
    if (id) toastInfo(`Backing up ${db}…`, 'Follow the progress in the Tasks drawer.')
  }
  const del = async (b: DbBackup): Promise<void> => {
    if (!(await confirm({ title: 'Delete backup', message: <>Delete <b className="font-mono">{b.name}</b> ({fmtBytes(b.sizeBytes)}) from the server?</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('db:deleteBackup', serverId, b.file), { success: 'Backup deleted' })
    await backups.reload()
  }
  const list = (backups.data ?? []).filter((b) => !onlyEngine || b.engine === engine || !b.engine)
  const columns: Column<DbBackup>[] = [
    { key: 'name', header: 'File', render: (b) => <span className="font-mono text-xs">{b.name}</span>, sortValue: (b) => b.name },
    { key: 'engine', header: 'Engine', render: (b) => (b.engine ? <Badge color="accent">{DB_ENGINE_LABEL[b.engine]}</Badge> : <Badge>unknown</Badge>), width: '140px' },
    { key: 'db', header: 'Database', render: (b) => <span className="font-mono text-xs">{b.database ?? '—'}</span>, sortValue: (b) => b.database ?? '' },
    { key: 'size', header: 'Size', align: 'right', render: (b) => fmtBytes(b.sizeBytes), sortValue: (b) => b.sizeBytes, width: '100px' },
    { key: 'mtime', header: 'Created', render: (b) => <span className="text-xs text-muted">{fmtDate(b.mtime)}</span>, sortValue: (b) => b.mtime, width: '150px' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '200px',
      render: (b) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="xs" variant="ghost" icon={<Upload size={11} />} disabled={b.engine !== engine} onClick={() => setRestoreOf(b)}>
            Restore
          </Button>
          <Button size="xs" variant="ghost" className="text-red-300" icon={<Trash2 size={11} />} onClick={() => del(b)}>
            Delete
          </Button>
        </div>
      )
    }
  ]
  const tool = engine === 'mysql' ? 'mysqldump --single-transaction | gzip' : engine === 'postgres' ? 'pg_dump | gzip' : engine === 'mssql' ? 'BACKUP DATABASE … WITH COMPRESSION, INIT' : 'mongodump --archive --gzip'
  const dir = engine === 'mssql' ? MSSQL_BACKUP_DIR : summary.backupsDir
  return (
    <div className="flex flex-col gap-4">
      <Card title="Create backup">
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Database" className="w-72">
            <Select value={db} onChange={(e) => setDb(e.target.value)}>
              {!dbs.length && <option value="">no databases</option>}
              {dbs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} ({fmtBytes(d.sizeBytes)})
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" icon={<Archive size={13} />} loading={busy} disabled={!db || !summary[engine].dumpToolAvailable} onClick={backup}>
            Backup now
          </Button>
          <div className="text-xs text-dim pb-2">
            {tool} → <span className="font-mono">{dir}/&lt;db&gt;-&lt;timestamp&gt;{engine === 'mssql' ? '.bak' : '…'}</span>
          </div>
        </div>
        {!summary[engine].dumpToolAvailable && <Callout kind="warn">The dump tool for {engineName(engine, summary[engine])} is not installed on the server.</Callout>}
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <FolderOpen size={13} /> Backups live in <span className="font-mono text-text">{dir}</span> ({engine === 'mssql' ? 'written by the mssql service user, mode 700' : 'mode 700'}). Download them with the Files module.
          <Button size="xs" variant="subtle" onClick={() => useApp.getState().setPage(serverId, 'files')}>
            Reveal in Files
          </Button>
        </div>
      </Card>
      <Card
        flush
        title="Existing backups"
        actions={
          <>
            <Checkbox checked={onlyEngine} onChange={setOnlyEngine} label={<span className="text-xs text-muted">this engine only</span>} />
            <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void backups.reload()} title="Refresh" />
          </>
        }
      >
        {backups.error ? (
          <div className="p-4">
            <ErrorBox error={backups.error} onRetry={() => void backups.reload()} />
          </div>
        ) : backups.loading && !backups.data ? (
          <Loading />
        ) : (
          <Table columns={columns} rows={list} rowKey={(b) => b.file} dense empty="No backups yet" initialSort={{ key: 'mtime', dir: 'desc' }} />
        )}
      </Card>
      {restoreOf && <RestoreModal serverId={serverId} engine={engine} backup={restoreOf} dbs={dbs} onClose={() => setRestoreOf(null)} />}
    </div>
  )
}

function RestoreModal({ serverId, engine, backup, dbs, onClose }: { serverId: string; engine: ServerEngine; backup: DbBackup; dbs: DbDatabase[]; onClose: () => void }): React.JSX.Element {
  const [target, setTarget] = useState(backup.database ?? dbs[0]?.name ?? '')
  const [custom, setCustom] = useState(false)
  const { run, busy } = useAction()
  const valid = /^[A-Za-z0-9_][A-Za-z0-9_$\-]{0,63}$/.test(target)
  const exists = dbs.some((d) => d.name === target)
  const go = async (): Promise<void> => {
    if (exists && !(await confirm({ title: `Restore into ${target}`, message: <>Objects in <b className="font-mono">{target}</b> that also exist in the dump will be overwritten{engine === 'mongo' ? ' (collections are dropped first)' : ''}. Continue?</>, danger: true, confirmLabel: 'Restore', typeToConfirm: target }))) return
    const id = await run(() => api.call<string>('db:restore', serverId, engine, target, backup.file))
    if (id) {
      toastInfo(`Restoring into ${target}…`, 'Follow the progress in the Tasks drawer.')
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Restore backup"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!valid} onClick={go}>
            Restore
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <KV rows={[['File', <span className="font-mono text-xs">{backup.name}</span>], ['Size', fmtBytes(backup.sizeBytes)], ['Created', fmtDate(backup.mtime)]]} />
        <Field label="Target database" hint={exists ? 'Existing database — contents will be merged/overwritten.' : 'The database will be created.'}>
          {custom ? (
            <Input value={target} onChange={(e) => setTarget(e.target.value)} mono autoFocus />
          ) : (
            <Select value={target} onChange={(e) => (e.target.value === '__new' ? setCustom(true) : setTarget(e.target.value))}>
              {backup.database && !dbs.some((d) => d.name === backup.database) && <option value={backup.database}>{backup.database} (new)</option>}
              {dbs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
              <option value="__new">Other / new database…</option>
            </Select>
          )}
        </Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Result grid                                                         */
/* ------------------------------------------------------------------ */

function ResultGrid({
  columns,
  rows,
  pk,
  sort,
  onSort,
  onEdit,
  onDelete,
  maxH = 'max-h-[60vh]'
}: {
  columns: string[]
  rows: (string | null)[][]
  pk?: string[]
  sort?: { col: string; dir: 'asc' | 'desc' }
  onSort?: (col: string) => void
  onEdit?: (rowIdx: number, col: string, value: string | null) => Promise<boolean>
  onDelete?: (rowIdx: number) => void
  maxH?: string
}): React.JSX.Element {
  const [edit, setEdit] = useState<{ r: number; c: number; v: string; isNull: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const editable = !!onEdit && !!pk?.length
  const commit = async (): Promise<void> => {
    if (!edit || !onEdit) return
    setSaving(true)
    const ok = await onEdit(edit.r, columns[edit.c], edit.isNull ? null : edit.v)
    setSaving(false)
    if (ok) setEdit(null)
  }
  return (
    <div className={cls('overflow-auto', maxH)}>
      <table className="text-xs border-collapse min-w-full">
        <thead className="sticky top-0 z-10">
          <tr className="bg-panel text-muted text-left">
            {onDelete && <th className="border-b border-border w-8" />}
            {columns.map((c) => (
              <th key={c} onClick={() => onSort?.(c)} className={cls('font-medium px-2.5 py-1.5 border-b border-border whitespace-nowrap select-none', onSort && 'cursor-pointer hover:text-text')}>
                {c}
                {pk?.includes(c) && <KeyRound size={9} className="inline ml-1 text-amber-300" />}
                {sort?.col === c && <span className="ml-1 text-dim">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + (onDelete ? 1 : 0)} className="text-center text-muted py-8 font-sans">
                No rows
              </td>
            </tr>
          )}
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border/60 hover:bg-panel-2/60">
              {onDelete && (
                <td className="px-1 text-center">
                  <button title="Delete row" onClick={() => onDelete(ri)} className="text-dim hover:text-red-300">
                    <Trash2 size={11} />
                  </button>
                </td>
              )}
              {row.map((v, ci) => {
                const isEditing = edit && edit.r === ri && edit.c === ci
                return (
                  <td
                    key={ci}
                    onDoubleClick={() => editable && setEdit({ r: ri, c: ci, v: v ?? '', isNull: v === null })}
                    title={v ?? 'NULL'}
                    className={cls('px-2.5 py-1 align-top max-w-[360px] whitespace-pre overflow-hidden text-ellipsis', editable && 'cursor-text')}
                  >
                    {isEditing ? (
                      <div className="flex items-center gap-1 -my-0.5">
                        <input
                          autoFocus
                          value={edit.isNull ? '' : edit.v}
                          placeholder={edit.isNull ? 'NULL' : ''}
                          disabled={edit.isNull || saving}
                          onChange={(e) => setEdit({ ...edit, v: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commit()
                            if (e.key === 'Escape') setEdit(null)
                          }}
                          className="bg-bg-2 border border-accent rounded px-1.5 h-6 text-xs min-w-[160px] outline-none"
                        />
                        <button title="Set NULL" onClick={() => setEdit({ ...edit, isNull: !edit.isNull })} className={cls('text-[10px] px-1 rounded border', edit.isNull ? 'border-accent text-accent' : 'border-border text-dim hover:text-text')}>
                          NULL
                        </button>
                        <button title="Save (Enter)" onClick={() => void commit()} className="text-green-300" disabled={saving}>
                          {saving ? <Spinner size={11} /> : <Play size={11} />}
                        </button>
                        <button title="Cancel (Esc)" onClick={() => setEdit(null)} className="text-dim hover:text-text">
                          <X size={11} />
                        </button>
                      </div>
                    ) : v === null ? (
                      <i className="text-dim">NULL</i>
                    ) : (
                      v.length > 300 ? v.slice(0, 300) + '…' : v
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Data browser (MySQL / PostgreSQL / SQLite)                          */
/* ------------------------------------------------------------------ */

function DataBrowser({ serverId, engine, db, onCredentials }: { serverId: string; engine: DbEngine; db: string; onCredentials?: () => void }): React.JSX.Element {
  const tables = useAsync(() => api.call<DbTable[]>('db:tables', serverId, engine, db), [serverId, engine, db])
  const [table, setTable] = useState<string>('')
  const [filter, setFilter] = useState('')
  const [where, setWhere] = useState('')
  const [whereApplied, setWhereApplied] = useState('')
  const [limit, setLimit] = useState(100)
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | undefined>()
  const { run, busy } = useAction()

  useEffect(() => {
    setTable('')
    setOffset(0)
    setSort(undefined)
    setWhere('')
    setWhereApplied('')
  }, [db])
  useEffect(() => {
    if (!table && tables.data?.length) setTable(tables.data[0].name)
  }, [tables.data, table])

  const rows = useAsync(
    () => api.call<DbRowsResult>('db:rows', serverId, engine, db, table, { limit, offset, where: whereApplied || undefined, orderBy: sort?.col, orderDir: sort?.dir }),
    [serverId, engine, db, table, limit, offset, whereApplied, sort?.col, sort?.dir],
    { enabled: !!table }
  )
  const data = rows.data
  const total = data?.total
  const pkValuesOf = (rowIdx: number): Record<string, string | null> => {
    const out: Record<string, string | null> = {}
    if (!data) return out
    for (const k of data.pk) out[k] = data.rows[rowIdx][data.columns.indexOf(k)] ?? null
    return out
  }
  const onEdit = async (rowIdx: number, col: string, value: string | null): Promise<boolean> => {
    const r = await run(() => api.call<number | undefined>('db:updateCell', serverId, engine, db, table, pkValuesOf(rowIdx), col, value), { success: 'Row updated' })
    if (r === undefined) return false
    await rows.reload()
    return true
  }
  const onDelete = async (rowIdx: number): Promise<void> => {
    const pk = pkValuesOf(rowIdx)
    if (!(await confirm({ title: 'Delete row', message: <>Delete the row where <span className="font-mono">{Object.entries(pk).map(([k, v]) => `${k} = ${v ?? 'NULL'}`).join(', ')}</span>?</>, danger: true, confirmLabel: 'Delete row' }))) return
    await run(() => api.call('db:deleteRow', serverId, engine, db, table, pk), { success: 'Row deleted' })
    await rows.reload()
  }
  const exportCsv = async (): Promise<void> => {
    const csv = await run(() => api.call<string>('db:exportCsv', serverId, engine, db, { table }), { error: 'Export failed' })
    if (csv) downloadText(`${table}.csv`, csv)
  }
  const selTable = tables.data?.find((t) => t.name === table)
  const tableList = (tables.data ?? []).filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="grid grid-cols-[260px_1fr] gap-4 min-h-[420px]">
      <Card flush title={`Tables${tables.data ? ` (${tables.data.length})` : ''}`} actions={<Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void tables.reload()} title="Refresh" />}>
        <div className="p-2 border-b border-border">
          <SearchInput value={filter} onChange={setFilter} placeholder="Filter tables" />
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {tables.error ? (
            <div className="p-3">
              <DbErrorBox error={tables.error} onRetry={() => void tables.reload()} onCredentials={onCredentials} />
            </div>
          ) : tables.loading && !tables.data ? (
            <Loading />
          ) : tableList.length === 0 ? (
            <div className="text-center text-muted text-xs py-8">No tables</div>
          ) : (
            tableList.map((t) => (
              <button
                key={t.name}
                onClick={() => {
                  setTable(t.name)
                  setOffset(0)
                  setSort(undefined)
                }}
                className={cls('w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs border-b border-border/40 hover:bg-panel-2', table === t.name && 'bg-accent/15')}
              >
                <Table2 size={12} className={t.type === 'view' ? 'text-sky-300' : 'text-muted'} />
                <span className="font-mono truncate flex-1">{t.name}</span>
                <span className="text-dim tabular-nums">{t.rows !== undefined ? `~${t.rows.toLocaleString()}` : ''}</span>
                <span className="text-dim w-14 text-right">{t.sizeBytes !== undefined ? fmtBytes(t.sizeBytes, 0) : ''}</span>
              </button>
            ))
          )}
        </div>
      </Card>
      <Card flush className="min-w-0">
        {!table ? (
          <EmptyState icon={<Table2 />} title="Pick a table" description="Rows load 100 at a time. Double-click a cell to edit it (tables with a primary key only)." />
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 h-11 border-b border-border flex-wrap">
              <span className="font-mono text-xs font-semibold">{table}</span>
              {selTable?.type === 'view' && <Badge color="info">view</Badge>}
              {data && (data.pk.length ? <Badge color="ok">PK: {data.pk.join(', ')}</Badge> : <Badge color="warn">read-only (no primary key)</Badge>)}
              <div className="flex-1" />
              <Button size="xs" variant="ghost" icon={<Download size={11} />} onClick={exportCsv} loading={busy} title="Export the whole table as CSV (max 5 MB)">
                Export CSV
              </Button>
              <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void rows.reload()} title="Refresh" />
            </div>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <span className="text-xs text-muted font-mono">WHERE</span>
              <Input
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                placeholder={engine === 'postgres' ? `"status" = 'active' AND id > 100` : engine === 'mssql' ? `[status] = N'active' AND id > 100` : `status = 'active' AND id > 100`}
                mono
                className="h-7 text-xs flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setWhereApplied(where)
                    setOffset(0)
                  }
                }}
              />
              <Button
                size="xs"
                onClick={() => {
                  setWhereApplied(where)
                  setOffset(0)
                }}
              >
                Apply
              </Button>
              {whereApplied && (
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<X size={11} />}
                  onClick={() => {
                    setWhere('')
                    setWhereApplied('')
                    setOffset(0)
                  }}
                >
                  Clear
                </Button>
              )}
              <Select
                value={String(limit)}
                onChange={(e) => {
                  setLimit(Number(e.target.value))
                  setOffset(0)
                }}
                className="h-7 text-xs w-24"
              >
                {[50, 100, 250, 500, 1000].map((n) => (
                  <option key={n} value={n}>
                    {n} rows
                  </option>
                ))}
              </Select>
            </div>
            {rows.error ? (
              <div className="p-3">
                <DbErrorBox error={rows.error} onRetry={() => void rows.reload()} onCredentials={onCredentials} />
              </div>
            ) : !data ? (
              <Loading />
            ) : (
              <ResultGrid
                columns={data.columns}
                rows={data.rows}
                pk={data.pk}
                sort={sort}
                onSort={(col) => {
                  setSort((s) => (s?.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }))
                  setOffset(0)
                }}
                onEdit={data.pk.length ? onEdit : undefined}
                onDelete={data.pk.length ? onDelete : undefined}
                maxH="max-h-[52vh]"
              />
            )}
            <div className="flex items-center gap-2 px-3 h-10 border-t border-border text-xs text-muted">
              {rows.loading && <Spinner size={12} />}
              <span>
                {data ? `${offset + 1}–${offset + data.rows.length}` : '—'}
                {total !== undefined && ` of ${data?.totalIsEstimate ? '~' : ''}${total.toLocaleString()}`}
              </span>
              <div className="flex-1" />
              <Button size="xs" variant="ghost" icon={<ChevronLeft size={12} />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Prev
              </Button>
              <Button size="xs" variant="ghost" disabled={!data || data.rows.length < limit} onClick={() => setOffset(offset + limit)}>
                Next <ChevronRight size={12} />
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* SQL editor                                                          */
/* ------------------------------------------------------------------ */

function SqlEditor({ serverId, engine, db, onCredentials }: { serverId: string; engine: DbEngine; db: string; onCredentials?: () => void }): React.JSX.Element {
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<DbQueryResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [history, setHistory] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { run, busy } = useAction()

  const execute = useCallback(async (): Promise<void> => {
    const q = sql.trim()
    if (!q || running) return
    setRunning(true)
    setError(null)
    try {
      const r = await api.call<DbQueryResult>('db:query', serverId, engine, db, q)
      setResult(r)
      setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 20))
    } catch (e) {
      setError(e)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [sql, running, serverId, engine, db])

  const exportCsv = async (): Promise<void> => {
    const q = history[0] ?? sql.trim()
    if (!q) return
    const csv = await run(() => api.call<string>('db:exportCsv', serverId, engine, db, { sql: q }), { error: 'Export failed' })
    if (csv) downloadText(`query-${Date.now()}.csv`, csv)
  }
  const importFile = async (f: File | undefined): Promise<void> => {
    if (!f) return
    if (f.size > DB_IMPORT_MAX_BYTES) {
      useApp.getState().toast({ kind: 'error', title: 'File too large', detail: 'SQL imports are limited to 20 MB. Upload bigger files with the Files module and restore them from the Backups section.' })
      return
    }
    if (!(await confirm({ title: 'Import SQL file', message: <>Run <b className="font-mono">{f.name}</b> ({fmtBytes(f.size)}) against <b className="font-mono">{db}</b>? Statements execute with admin privileges.</>, danger: true, confirmLabel: 'Import' }))) return
    const text = await f.text()
    const id = await run(() => api.call<string>('db:importSql', serverId, engine, db, text))
    if (id) toastInfo(`Importing ${f.name}…`, 'Follow the progress in the Tasks drawer.')
  }

  return (
    <div className="flex flex-col gap-3">
      <Card
        flush
        title={
          <span>
            SQL · <span className="font-mono text-xs text-muted">{db}</span>
          </span>
        }
        actions={
          <>
            <MenuButton
              size="xs"
              variant="ghost"
              icon={<History size={11} />}
              label="History"
              items={history.length ? history.map((h) => ({ label: <span className="font-mono text-xs truncate max-w-[480px] block">{h.replace(/\s+/g, ' ').slice(0, 120)}</span>, onClick: () => setSql(h) })) : [{ label: <span className="text-dim">No queries yet</span>, disabled: true }]}
            />
            <input ref={fileRef} type="file" accept=".sql,.txt" className="hidden" onChange={(e) => void importFile(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
            <Button size="xs" variant="ghost" icon={<FileUp size={11} />} onClick={() => fileRef.current?.click()} loading={busy} title="Import a .sql file (max 20 MB) into this database">
              Import SQL
            </Button>
            <Button size="xs" variant="ghost" icon={<Download size={11} />} onClick={exportCsv} disabled={!result || !result.columns.length} title="Export the last query result as CSV">
              Export CSV
            </Button>
            <Button size="xs" variant="primary" icon={<Play size={11} />} loading={running} onClick={() => void execute()} disabled={!sql.trim()}>
              Run <span className="opacity-60 font-normal">Ctrl+Enter</span>
            </Button>
          </>
        }
      >
        <TextArea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void execute()
            }
          }}
          mono
          rows={7}
          spellCheck={false}
          placeholder={engine === 'postgres' ? 'SELECT * FROM pg_stat_activity;' : engine === 'sqlite' ? 'SELECT name FROM sqlite_master;' : engine === 'mssql' ? 'SELECT name, state_desc FROM sys.databases;\nGO' : 'SHOW TABLES;'}
          className="rounded-none border-0 border-b border-border focus:ring-0"
        />
        <div className="px-3 py-1.5 text-[11px] text-dim flex items-center gap-2">
          Runs with admin privileges through the local {engine === 'postgres' ? 'psql' : engine === 'sqlite' ? 'sqlite3' : engine === 'mssql' ? 'sqlcmd' : 'mysql'} client; multiple statements{engine === 'mssql' ? ' and GO batches' : ''} are allowed.
          {result && (
            <span className="ml-auto text-muted">
              {result.columns.length ? `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? '' : 's'}` : result.affected !== undefined ? `${result.affected.toLocaleString()} row${result.affected === 1 ? '' : 's'} affected` : 'OK'} · {result.ms} ms
              {result.truncated && <span className="text-amber-300"> · output truncated</span>}
            </span>
          )}
        </div>
      </Card>
      {error ? <DbErrorBox error={error} onCredentials={onCredentials} /> : null}
      {result && (
        <Card flush>
          {result.columns.length ? <ResultGrid columns={result.columns} rows={result.rows} maxH="max-h-[50vh]" /> : <div className="px-4 py-3 text-sm text-muted">{result.affected !== undefined ? `${result.affected.toLocaleString()} row(s) affected.` : 'Statement executed.'}</div>}
          {result.message && <Pre maxH="max-h-40" className="m-3">{result.message}</Pre>}
        </Card>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* MongoDB browser + shell                                             */
/* ------------------------------------------------------------------ */

function MongoBrowser({ serverId, db, onCredentials }: { serverId: string; db: string; onCredentials: () => void }): React.JSX.Element {
  const cols = useAsync(() => api.call<MongoCollection[]>('db:mongo:collections', serverId, db), [serverId, db])
  const [coll, setColl] = useState('')
  const [filter, setFilter] = useState('')
  const [filterApplied, setFilterApplied] = useState('')
  const [sort, setSort] = useState('')
  const [limit, setLimit] = useState(25)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState('')
  const { run, busy } = useAction()

  useEffect(() => {
    setColl('')
    setOffset(0)
  }, [db])
  useEffect(() => {
    if (!coll && cols.data?.length) setColl(cols.data[0].name)
  }, [cols.data, coll])

  const docs = useAsync(() => api.call<MongoDocsResult>('db:mongo:documents', serverId, db, coll, { filter: filterApplied || undefined, sort: sort || undefined, limit, offset }), [serverId, db, coll, filterApplied, sort, limit, offset], { enabled: !!coll })

  const createColl = async (): Promise<void> => {
    const name = window.prompt('New collection name')
    if (!name) return
    await run(() => api.call('db:mongo:createCollection', serverId, db, name), { success: `Created ${name}` })
    await cols.reload()
  }
  const dropColl = async (c: MongoCollection): Promise<void> => {
    if (!(await confirm({ title: `Drop collection ${c.name}`, message: <>{c.count.toLocaleString()} documents in <b className="font-mono">{db}.{c.name}</b> will be deleted permanently.</>, danger: true, confirmLabel: 'Drop collection', typeToConfirm: c.name }))) return
    await run(() => api.call('db:mongo:dropCollection', serverId, db, c.name), { success: `Dropped ${c.name}` })
    if (coll === c.name) setColl('')
    await cols.reload()
  }
  const delDoc = async (i: number): Promise<void> => {
    const id = docs.data?.ids[i]
    if (!id) return
    if (!(await confirm({ title: 'Delete document', message: <>Delete the document with <span className="font-mono">_id: {id}</span>?</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.call('db:mongo:deleteDocument', serverId, db, coll, id), { success: 'Document deleted' })
    await docs.reload()
    await cols.reload()
  }
  const list = (cols.data ?? []).filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()))
  const selected = cols.data?.find((c) => c.name === coll)

  return (
    <div className="grid grid-cols-[280px_1fr] gap-4 min-h-[420px]">
      <Card
        flush
        title={`Collections${cols.data ? ` (${cols.data.length})` : ''}`}
        actions={
          <>
            <Button size="xs" variant="ghost" icon={<Plus size={11} />} onClick={createColl} title="Create collection" />
            <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void cols.reload()} title="Refresh" />
          </>
        }
      >
        <div className="p-2 border-b border-border">
          <SearchInput value={search} onChange={setSearch} placeholder="Filter collections" />
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {cols.error ? (
            <div className="p-3">
              <DbErrorBox error={cols.error} onRetry={() => void cols.reload()} onCredentials={onCredentials} />
            </div>
          ) : cols.loading && !cols.data ? (
            <Loading />
          ) : list.length === 0 ? (
            <div className="text-center text-muted text-xs py-8">No collections</div>
          ) : (
            list.map((c) => (
              <div key={c.name} className={cls('flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border/40 hover:bg-panel-2 group', coll === c.name && 'bg-accent/15')}>
                <button
                  onClick={() => {
                    setColl(c.name)
                    setOffset(0)
                  }}
                  className="flex-1 min-w-0 text-left flex items-center gap-2"
                >
                  <span className="font-mono truncate flex-1">{c.name}</span>
                  <span className="text-dim tabular-nums">{c.count >= 0 ? c.count.toLocaleString() : '?'}</span>
                  <span className="text-dim w-14 text-right">{fmtBytes(c.sizeBytes, 0)}</span>
                </button>
                <button onClick={() => dropColl(c)} title="Drop collection" className="text-dim hover:text-red-300 opacity-0 group-hover:opacity-100">
                  <Trash2 size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </Card>
      <Card flush className="min-w-0">
        {!coll ? (
          <EmptyState icon={<Database />} title="Pick a collection" description="Documents are shown as Extended JSON. Filter with a JSON query document." />
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
              <span className="font-mono text-xs font-semibold">{coll}</span>
              {selected && <span className="text-xs text-dim">{selected.indexes ?? 0} index(es) · storage {fmtBytes(selected.storageBytes)}</span>}
              <div className="flex-1" />
              <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void docs.reload()} title="Refresh" />
            </div>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <span className="text-xs text-muted">find</span>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder='{ "status": "active", "age": { "$gt": 18 } }'
                mono
                className="h-7 text-xs flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setFilterApplied(filter)
                    setOffset(0)
                  }
                }}
              />
              <span className="text-xs text-muted">sort</span>
              <Input value={sort} onChange={(e) => setSort(e.target.value)} placeholder='{ "_id": -1 }' mono className="h-7 text-xs w-40" />
              <Button
                size="xs"
                onClick={() => {
                  setFilterApplied(filter)
                  setOffset(0)
                }}
                loading={busy}
              >
                Apply
              </Button>
              <Select
                value={String(limit)}
                onChange={(e) => {
                  setLimit(Number(e.target.value))
                  setOffset(0)
                }}
                className="h-7 text-xs w-24"
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n} docs
                  </option>
                ))}
              </Select>
            </div>
            <div className="max-h-[52vh] overflow-auto p-3 flex flex-col gap-2">
              {docs.error ? (
                <DbErrorBox error={docs.error} onRetry={() => void docs.reload()} onCredentials={onCredentials} />
              ) : !docs.data ? (
                <Loading />
              ) : docs.data.docs.length === 0 ? (
                <div className="text-center text-muted text-xs py-8">No documents</div>
              ) : (
                docs.data.docs.map((d, i) => (
                  <div key={docs.data?.ids[i] ?? i} className="relative group">
                    <Pre maxH="max-h-64" className="pr-8">
                      {d}
                    </Pre>
                    <button onClick={() => delDoc(i)} title="Delete document" className="absolute top-2 right-2 text-dim hover:text-red-300 opacity-0 group-hover:opacity-100">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center gap-2 px-3 h-10 border-t border-border text-xs text-muted">
              {docs.loading && <Spinner size={12} />}
              <span>
                {docs.data ? `${offset + 1}–${offset + docs.data.docs.length} of ${docs.data.total.toLocaleString()}` : '—'}
              </span>
              <div className="flex-1" />
              <Button size="xs" variant="ghost" icon={<ChevronLeft size={12} />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Prev
              </Button>
              <Button size="xs" variant="ghost" disabled={!docs.data || offset + limit >= docs.data.total} onClick={() => setOffset(offset + limit)}>
                Next <ChevronRight size={12} />
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

function MongoShell({ serverId, db }: { serverId: string; db: string }): React.JSX.Element {
  const [js, setJs] = useState('')
  const [out, setOut] = useState<{ output: string; ms: number } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [history, setHistory] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const execute = async (): Promise<void> => {
    const q = js.trim()
    if (!q || running) return
    setRunning(true)
    setError(null)
    try {
      const r = await api.call<{ output: string; ms: number }>('db:mongo:eval', serverId, db, q)
      setOut(r)
      setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 20))
    } catch (e) {
      setError(e)
      setOut(null)
    } finally {
      setRunning(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Card
        flush
        title={
          <span>
            mongosh · <span className="font-mono text-xs text-muted">{db}</span>
          </span>
        }
        actions={
          <>
            <MenuButton size="xs" variant="ghost" icon={<History size={11} />} label="History" items={history.length ? history.map((h) => ({ label: <span className="font-mono text-xs truncate max-w-[480px] block">{h.replace(/\s+/g, ' ').slice(0, 120)}</span>, onClick: () => setJs(h) })) : [{ label: <span className="text-dim">No commands yet</span>, disabled: true }]} />
            <Button size="xs" variant="primary" icon={<Play size={11} />} loading={running} onClick={() => void execute()} disabled={!js.trim()}>
              Run <span className="opacity-60 font-normal">Ctrl+Enter</span>
            </Button>
          </>
        }
      >
        <TextArea
          value={js}
          onChange={(e) => setJs(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void execute()
            }
          }}
          mono
          rows={6}
          spellCheck={false}
          placeholder={`db.getCollectionNames()\ndb.users.find({ active: true }).limit(5)\ndb.stats()`}
          className="rounded-none border-0 border-b border-border focus:ring-0"
        />
        <div className="px-3 py-1.5 text-[11px] text-dim flex items-center gap-2">
          JavaScript is evaluated by mongosh with <code>db</code> set to <span className="font-mono">{db}</span>; cursors are expanded with toArray().
          {out && <span className="ml-auto text-muted">{out.ms} ms</span>}
        </div>
      </Card>
      {error ? <ErrorBox error={error} /> : null}
      {out && <Pre maxH="max-h-[50vh]">{out.output}</Pre>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* SQLite client                                                       */
/* ------------------------------------------------------------------ */

function SqliteClient({ serverId, installed, version, reloadStatus }: { serverId: string; installed: boolean; version?: string; reloadStatus: () => Promise<void> }): React.JSX.Element {
  const [path, setPath] = useState('')
  const [opened, setOpened] = useState<SqliteOpenResult | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [tab, setTab] = useState<'browse' | 'sql'>('browse')
  const { run, busy } = useAction()

  const open = async (p = path): Promise<void> => {
    const t = p.trim()
    if (!t.startsWith('/')) {
      useApp.getState().toast({ kind: 'error', title: 'Enter an absolute path', detail: 'Example: /var/www/app/data.sqlite' })
      return
    }
    const r = await run(() => api.call<SqliteOpenResult>('db:sqlite:open', serverId, t), { error: 'Could not open database' })
    if (r) {
      setOpened(r)
      setPath(t)
      setRecent((l) => [t, ...l.filter((x) => x !== t)].slice(0, 8))
    }
  }
  const install = async (): Promise<void> => {
    const id = await run(() => api.call<string>('db:install', serverId, 'sqlite'))
    if (id) toastInfo('Installing sqlite3…', 'Follow the progress in the Tasks drawer.')
    void reloadStatus()
  }

  if (!installed) {
    return (
      <Card>
        <EmptyState
          icon={<Database />}
          title="sqlite3 is not installed"
          description="The SQLite client lets you open any .sqlite / .db file on the server by path, browse tables and run SQL. Install the sqlite3 command-line tool from the distribution's repositories."
          action={
            <Button variant="primary" icon={<Download size={13} />} loading={busy} onClick={install}>
              Install sqlite3
            </Button>
          }
        />
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Open database file" actions={version && <span className="text-xs text-dim">sqlite3 {version}</span>}>
        <div className="flex items-end gap-2">
          <Field label="Absolute path on the server" className="flex-1">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/var/lib/app/data.sqlite" mono list="sm-sqlite-recent" onKeyDown={(e) => e.key === 'Enter' && void open()} />
            <datalist id="sm-sqlite-recent">
              {recent.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
          <Button variant="primary" icon={<FolderOpen size={13} />} loading={busy} onClick={() => void open()} disabled={!path.trim()}>
            Open
          </Button>
        </div>
        {opened && (
          <div className="mt-3 flex items-center gap-3 text-xs text-muted">
            <Badge color="ok">open</Badge>
            <span className="font-mono text-text">{opened.path}</span>
            <span>{fmtBytes(opened.sizeBytes)}</span>
            <span>{opened.tables.length} table(s)</span>
            <div className="flex-1" />
            <Tabs tabs={[{ id: 'browse', label: 'Browse' }, { id: 'sql', label: 'SQL' }]} value={tab} onChange={setTab} />
          </div>
        )}
        {!opened && <div className="mt-2 text-[11px] text-dim">Files are opened as root through the sqlite3 CLI, so permission is not an issue. Writes go straight to the file: back it up first.</div>}
      </Card>
      {opened && tab === 'browse' && <DataBrowser key={opened.path} serverId={serverId} engine="sqlite" db={opened.path} />}
      {opened && tab === 'sql' && <SqlEditor key={opened.path} serverId={serverId} engine="sqlite" db={opened.path} />}
    </div>
  )
}
