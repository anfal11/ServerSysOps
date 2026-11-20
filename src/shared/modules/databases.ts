// Shared types for the Databases module (main <-> renderer).

export type DbEngine = 'mysql' | 'postgres' | 'mongo' | 'sqlite'
export type DbServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
export type DbPrivileges = 'all' | 'readonly' | 'none'

export interface DbEngineStatus {
  engine: DbEngine
  installed: boolean
  /** mysql only: which flavour is installed. */
  flavor?: 'mysql' | 'mariadb'
  version?: string
  /** systemd unit name (when found). */
  unit?: string
  running: boolean
  enabled: boolean
  /** Admin client binary present (mysql/mariadb, psql, mongosh/mongo). */
  clientAvailable: boolean
  /** Dump/restore tooling present (mysqldump, pg_dump, mongodump). */
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
  details?: Record<string, string>
}

export interface DbStatusSummary {
  mysql: DbEngineStatus
  postgres: DbEngineStatus
  mongo: DbEngineStatus
  sqlite: { installed: boolean; version?: string }
  backupsDir: string
  backupsCount: number
  os: { pkgManager: string; id: string; prettyName: string }
}

export interface DbDatabase {
  name: string
  sizeBytes?: number
  owner?: string
  charset?: string
  collation?: string
  tables?: number
  system?: boolean
}

export interface DbUser {
  user: string
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

export const DB_BACKUPS_DIR = '/var/backups/servermate'
export const DB_ROWS_MAX_LIMIT = 1000
export const DB_EXPORT_MAX_BYTES = 5 * 1024 * 1024
export const DB_IMPORT_MAX_BYTES = 20 * 1024 * 1024

export const DB_ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: 'MySQL / MariaDB',
  postgres: 'PostgreSQL',
  mongo: 'MongoDB',
  sqlite: 'SQLite client'
}
