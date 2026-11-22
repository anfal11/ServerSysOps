// Shared types for the Databases module (main <-> renderer).

export type DbEngine = 'mysql' | 'postgres' | 'mongo' | 'mssql' | 'sqlite'
export type DbServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
export type DbPrivileges = 'all' | 'readonly' | 'none'

export interface MssqlSettings {
  /** TCP port (network.tcpport). */
  port: number
  /** memory.memorylimitmb; undefined = default (80 % of RAM). */
  memoryLimitMb?: number
  /** sqlagent.enabled */
  agentEnabled: boolean
}

export interface DbEngineStatus {
  engine: DbEngine
  installed: boolean
  /** mysql only: which flavour is installed. */
  flavor?: 'mysql' | 'mariadb'
  version?: string
  /** mssql: SERVERPROPERTY('Edition'). */
  edition?: string
  /** systemd unit name (when found). */
  unit?: string
  running: boolean
  enabled: boolean
  /** Admin client binary present (mysql/mariadb, psql, mongosh/mongo, sqlcmd). */
  clientAvailable: boolean
  /** Dump/restore tooling present (mysqldump, pg_dump, mongodump; sqlcmd for mssql). */
  dumpToolAvailable: boolean
  /** Whether the admin connection worked (undefined when the server is not running). */
  authOk?: boolean
  authError?: string
  /** A stored in-memory admin credential is being used for this engine. */
  usingCredentials?: boolean
  dataDir?: string
  port?: number
  bindAddress?: string
  sizeBytes?: number
  /** postgres on RHEL-like systems: the cluster has not been initialised yet. */
  needsInitdb?: boolean
  /** mssql: values from /var/opt/mssql/mssql.conf. */
  mssql?: MssqlSettings
  details?: Record<string, string>
}

export interface DbStatusSummary {
  mysql: DbEngineStatus
  postgres: DbEngineStatus
  mongo: DbEngineStatus
  mssql: DbEngineStatus
  sqlite: { installed: boolean; version?: string }
  backupsDir: string
  backupsCount: number
  os: { pkgManager: string; id: string; prettyName: string; versionId: string; memTotalBytes?: number }
}

export interface DbDatabase {
  name: string
  sizeBytes?: number
  owner?: string
  charset?: string
  collation?: string
  tables?: number
  system?: boolean
  /** mssql: ONLINE / RESTORING / … */
  state?: string
  /** mssql: SIMPLE / FULL / BULK_LOGGED */
  recoveryModel?: string
}

export interface DbUser {
  user: string
  /** mysql: host; mongo: authentication database; mssql: default database. */
  host?: string
  /** Human-readable privileges summary. */
  privileges: string
  roles?: string[]
  superuser?: boolean
  canLogin?: boolean
  plugin?: string
  system?: boolean
}

export interface DbCreateUserInput {
  user: string
  host?: string
  password: string
  database?: string
  privileges: DbPrivileges
}

export interface DbGrantInput {
  user: string
  host?: string
  database: string
  privileges: DbPrivileges
}

export interface DbBackup {
  file: string
  name: string
  engine?: DbEngine
  database?: string
  sizeBytes: number
  mtime: number
}

export interface DbTable {
  name: string
  /** Estimated row count (exact for sqlite). */
  rows?: number
  sizeBytes?: number
  type?: 'table' | 'view'
  engine?: string
}

export interface DbRowsOptions {
  limit?: number
  offset?: number
  /** Raw WHERE expression (admin tooling: passed through to the engine, never through a shell). */
  where?: string
  orderBy?: string
  orderDir?: 'asc' | 'desc'
}

export interface DbRowsResult {
  columns: string[]
  rows: (string | null)[][]
  /** Total rows matching (exact when a filter is set, otherwise an estimate for big tables). */
  total?: number
  totalIsEstimate?: boolean
  /** Primary key columns; empty => read-only grid. */
  pk: string[]
}

export interface DbQueryResult {
  columns: string[]
  rows: (string | null)[][]
  affected?: number
  ms: number
  /** Extra textual output (command tags, notices). */
  message?: string
  truncated?: boolean
}

export interface DbExportInput {
  table?: string
  sql?: string
}

export interface MongoCollection {
  name: string
  count: number
  sizeBytes: number
  storageBytes?: number
  indexes?: number
}

export interface MongoDocsOptions {
  limit?: number
  offset?: number
  /** JSON / EJSON filter document. */
  filter?: string
  sort?: string
}

export interface MongoDocsResult {
  /** Each document as a pretty EJSON string. */
  docs: string[]
  /** _id of each document as EJSON (for delete). */
  ids: string[]
  total: number
}

export interface SqliteOpenResult {
  path: string
  sizeBytes: number
  tables: DbTable[]
}

export interface MssqlInstallInput {
  saPassword: string
  /** Express | Developer | Standard | Enterprise | Web | Evaluation, or a 25-character product key. */
  edition: string
  acceptEula: boolean
}

export const MSSQL_EDITIONS: { id: string; label: string }[] = [
  { id: 'Express', label: 'Express (free, 10 GB per database)' },
  { id: 'Developer', label: 'Developer (free, non-production use only)' },
  { id: 'Evaluation', label: 'Evaluation (180 days)' },
  { id: 'Standard', label: 'Standard (paid, license required)' },
  { id: 'Enterprise', label: 'Enterprise (paid, license required)' },
  { id: 'Web', label: 'Web (paid, hosting license)' }
]

/** SQL Server password policy: at least 8 chars and three of upper / lower / digit / symbol — we require all four. */
export function isStrongSqlPassword(pw: string): boolean {
  return pw.length >= 8 && pw.length <= 128 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)
}

export const DB_BACKUPS_DIR = '/var/backups/centralserver'
export const MSSQL_BACKUP_DIR = '/var/opt/mssql/backup'
export const MSSQL_EULA_URL = 'https://go.microsoft.com/fwlink/?linkid=2104294'
export const DB_ROWS_MAX_LIMIT = 1000
export const DB_EXPORT_MAX_BYTES = 5 * 1024 * 1024
export const DB_IMPORT_MAX_BYTES = 20 * 1024 * 1024

export const DB_ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: 'MySQL / MariaDB',
  postgres: 'PostgreSQL',
  mongo: 'MongoDB',
  mssql: 'SQL Server',
  sqlite: 'SQLite client'
}
