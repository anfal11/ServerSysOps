import type { Ctx } from '../core'
import type { SshClient, ExecOptions } from '../ssh/SshClient'
import type { TaskHandle } from '../tasks/TaskManager'
import type { ExecResult } from '@shared/types'
import type {
  DbBackup,
  DbCreateUserInput,
  DbDatabase,
  DbEngine,
  DbEngineStatus,
  DbExportInput,
  DbGrantInput,
  DbPrivileges,
  DbQueryResult,
  DbRowsOptions,
  DbRowsResult,
  DbServiceAction,
  DbStatusSummary,
  DbTable,
  DbUser,
  MongoCollection,
  MongoDocsOptions,
  MongoDocsResult,
  SqliteOpenResult
} from '@shared/modules/databases'
import { DB_BACKUPS_DIR, DB_EXPORT_MAX_BYTES, DB_IMPORT_MAX_BYTES, DB_ROWS_MAX_LIMIT } from '@shared/modules/databases'
import { assertAbsPath, b64Echo, shq } from '../ssh/shell'
import { installCmd, runPkg } from './pkg'

/*
 * Databases module (main process).
 *
 * All engines are driven through their local admin CLI over the server's unix socket
 * (mysql/mariadb, psql as the postgres OS user, mongosh on localhost, sqlite3 on a file).
 * SQL / JS is always passed via stdin (or a single quoted --eval argument), never
 * interpolated into a shell string. Identifiers are validated with a strict regex and quoted;
 * string values are escaped by doubling quotes.
 *
 * NOTE: the "WHERE clause" filter of the data browser and the SQL editor are admin tooling —
 * the operator already has full database access, so the SQL itself is not sanitised beyond
 * never letting it touch the shell.
 */

/* ------------------------------------------------------------------ */
/* Errors / credentials                                                */
/* ------------------------------------------------------------------ */

class DbError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface Cred {
  user: string
  password: string
}

/** In-memory admin credentials per server+engine (never persisted). */
const creds = new Map<string, Partial<Record<DbEngine, Cred>>>()

function getCred(serverId: string, engine: DbEngine): Cred | undefined {
  return creds.get(serverId)?.[engine]
}

const AUTH_RE = /access denied|password authentication failed|authentication failed|requires authentication|peer authentication failed|ERROR 1045|Unauthorized|not authorized/i
const DOWN_RE = /can't connect to local|could not connect to server|connection refused|No such file or directory|ECONNREFUSED|is the server running|MongoNetworkError|Connection reset/i

function throwExec(engine: DbEngine, r: ExecResult, fallback: string): never {
  const msg = (r.stderr || r.stdout || fallback).trim()
  const short = msg.split('\n').filter(Boolean).slice(-6).join('\n') || fallback
  if (AUTH_RE.test(msg)) throw new DbError('DB_AUTH', `${engineLabel(engine)} refused the admin connection: ${short}`)
  if (DOWN_RE.test(msg)) throw new DbError('DB_DOWN', `${engineLabel(engine)} does not seem to be running: ${short}`)
  throw new DbError('DB_ERROR', short)
}

function engineLabel(e: DbEngine): string {
  return e === 'mysql' ? 'MySQL/MariaDB' : e === 'postgres' ? 'PostgreSQL' : e === 'mongo' ? 'MongoDB' : 'SQLite'
}

/* ------------------------------------------------------------------ */
/* Identifiers / literals                                              */
/* ------------------------------------------------------------------ */

const IDENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_$\-]{0,63}$/
const HOST_RE = /^[A-Za-z0-9_.%:\-]{1,60}$/
const SYSTEM_MYSQL_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])
const SYSTEM_PG_DBS = new Set(['postgres', 'template0', 'template1'])
const SYSTEM_MONGO_DBS = new Set(['admin', 'config', 'local'])

/** Strict identifier for things we create (database names, user names, table names). */
function assertIdent(s: unknown, what = 'name'): string {
  if (typeof s !== 'string' || !IDENT_RE.test(s)) throw new Error(`Invalid ${what}: ${String(s)} (letters, digits, _ $ - only, max 64 chars)`)
  return s
}

/** Looser check for identifiers coming back from the schema (columns, existing tables). */
function assertLooseIdent(s: unknown, what = 'identifier'): string {
  // eslint-disable-next-line no-control-regex
  if (typeof s !== 'string' || s.length === 0 || s.length > 128 || /[\x00-\x1f\x7f]/.test(s)) throw new Error(`Invalid ${what}`)
  return s
}

function assertHost(h: unknown): string {
  const s = h === undefined || h === null || h === '' ? 'localhost' : String(h)
  if (!HOST_RE.test(s)) throw new Error(`Invalid host: ${s}`)
  return s
}

function assertEngine(e: unknown): DbEngine {
  if (e === 'mysql' || e === 'postgres' || e === 'mongo' || e === 'sqlite') return e
  throw new Error(`Unknown database engine: ${String(e)}`)
}

/** Back-tick quote (MySQL). */
function qMy(name: string): string {
  return '`' + assertLooseIdent(name).replace(/`/g, '``') + '`'
}
/** Double-quote (PostgreSQL / SQLite). */
function qDq(name: string): string {
  return '"' + assertLooseIdent(name).replace(/"/g, '""') + '"'
}
/** Quote a possibly schema-qualified PostgreSQL table name ("schema.table" or "table"). */
function qPgTable(table: string): string {
  const idx = table.indexOf('.')
  if (idx > 0) return qDq(table.slice(0, idx)) + '.' + qDq(table.slice(idx + 1))
  return qDq(table)
}
function qIdent(engine: DbEngine, name: string): string {
  return engine === 'mysql' ? qMy(name) : qDq(name)
}
function qTable(engine: DbEngine, table: string): string {
  if (engine === 'postgres') return qPgTable(table)
  return qIdent(engine, table)
}
/** MySQL string literal (backslash is an escape char in MySQL strings). */
function myStr(v: string): string {
  return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0') + "'"
}
/** Standard SQL string literal (PostgreSQL with standard_conforming_strings, SQLite). */
function sqlStr(v: string): string {
  return "'" + v.replace(/'/g, "''").replace(/\0/g, '') + "'"
}
function lit(engine: DbEngine, v: string | null): string {
  if (v === null) return 'NULL'
  return engine === 'mysql' ? myStr(v) : sqlStr(v)
}
/** MySQL account literal 'user'@'host'. */
function myAccount(user: string, host: string): string {
  return `${myStr(assertIdent(user, 'user name'))}@${myStr(assertHost(host))}`
}
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}
/** Strip statement separators from a WHERE expression so it stays a single statement. */
function cleanWhere(w: unknown): string | undefined {
  if (typeof w !== 'string') return undefined
  const s = w.replace(/;/g, ' ').trim()
  return s || undefined
}

/* ------------------------------------------------------------------ */
/* Output parsing                                                      */
/* ------------------------------------------------------------------ */

const US = '\x1f'

interface Grid {
  columns: string[]
  rows: (string | null)[][]
}

function mysqlUnescape(s: string): string {
  if (!s.includes('\\')) return s
  return s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '\0' : c === '\\' ? '\\' : c))
}

function splitLines(out: string): string[] {
  const text = out.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Parse delimited output (header line first). */
function parseGrid(lines: string[], sep: string, nullToken: string | null, unescape: (s: string) => string = (s) => s): Grid {
  if (lines.length === 0) return { columns: [], rows: [] }
  const columns = lines[0].split(sep).map(unescape)
  const rows = lines.slice(1).map((l) => l.split(sep).map((c) => (nullToken !== null && c === nullToken ? null : unescape(c))))
  return { columns, rows }
}

function num(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/* ------------------------------------------------------------------ */
/* Engine drivers                                                      */
/* ------------------------------------------------------------------ */

const MYSQL_BIN = '"$(command -v mysql 2>/dev/null || command -v mariadb 2>/dev/null || echo mysql)"'
const MYSQLDUMP_BIN = '"$(command -v mysqldump 2>/dev/null || command -v mariadb-dump 2>/dev/null || echo mysqldump)"'
const MONGOSH_BIN = '"$(command -v mongosh 2>/dev/null || command -v mongo 2>/dev/null || echo mongosh)"'

interface DriverOpts {
  db?: string
  timeoutMs?: number
  maxBuffer?: number
  skipHeader?: boolean
  onStdout?: (c: string) => void
  onStderr?: (c: string) => void
  signal?: AbortSignal
}

// ---- MySQL / MariaDB ----

function mysqlCmd(serverId: string, extra: string): { cmd: string; env?: Record<string, string> } {
  const cred = getCred(serverId, 'mysql')
  const auth = cred ? ` -u ${shq(cred.user)} --protocol=socket` : ''
  return { cmd: `${MYSQL_BIN}${auth} ${extra}`, env: cred ? { MYSQL_PWD: cred.password } : undefined }
}

async function myExec(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<ExecResult> {
  const { cmd, env } = mysqlCmd(serverId, `--batch ${o.skipHeader ? '--skip-column-names' : '--column-names'} --default-character-set=utf8mb4${o.db ? ' ' + shq(assertIdent(o.db, 'database name')) : ''}`)
  return ssh.exec(cmd, { sudo: true, stdin: sql, env, timeoutMs: o.timeoutMs ?? 60000, maxBuffer: o.maxBuffer, onStdout: o.onStdout, onStderr: o.onStderr, signal: o.signal })
}

async function myQuery(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<Grid> {
  const r = await myExec(ssh, serverId, sql, o)
  if (r.code !== 0) throwExec('mysql', r, 'mysql failed')
  const lines = splitLines(r.stdout)
  if (o.skipHeader) return { columns: [], rows: lines.map((l) => l.split('\t').map((c) => (c === 'NULL' ? null : mysqlUnescape(c)))) }
  return parseGrid(lines, '\t', 'NULL', mysqlUnescape)
}

// ---- PostgreSQL ----

/** Run a command as the postgres OS user (requires root). */
function asPostgres(inner: string): string {
  const script = `if command -v runuser >/dev/null 2>&1; then exec runuser -u postgres -- ${inner}; else exec su postgres -s /bin/sh -c ${shq(inner)}; fi`
  return `sh -c ${shq(script)}`
}

const PSQL_BASE = `psql -X -A -v ON_ERROR_STOP=1 -P footer=off -P null='\\N' -F "$(printf '\\037')"`

function psqlCmd(serverId: string, extra: string, base = PSQL_BASE): { cmd: string; env?: Record<string, string>; sudo: boolean } {
  const cred = getCred(serverId, 'postgres')
  if (cred) return { cmd: `${base} -h 127.0.0.1 -U ${shq(cred.user)} ${extra}`, env: { PGPASSWORD: cred.password }, sudo: false }
  return { cmd: asPostgres(`${base} ${extra}`), sudo: true }
}

async function pgExec(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<ExecResult> {
  const { cmd, env, sudo } = psqlCmd(serverId, `${o.skipHeader ? '-t ' : ''}-d ${shq(o.db ? assertIdent(o.db, 'database name') : 'postgres')}`)
  return ssh.exec(cmd, { sudo, stdin: sql, env, timeoutMs: o.timeoutMs ?? 60000, maxBuffer: o.maxBuffer, onStdout: o.onStdout, onStderr: o.onStderr, signal: o.signal })
}

async function pgQuery(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<Grid> {
  const r = await pgExec(ssh, serverId, sql, o)
  if (r.code !== 0) throwExec('postgres', r, 'psql failed')
  const lines = splitLines(r.stdout).filter((l) => !isPgTag(l))
  if (o.skipHeader) return { columns: [], rows: lines.map((l) => l.split(US).map((c) => (c === '\\N' ? null : c))) }
  return parseGrid(lines, US, '\\N')
}

const PG_TAG_RE =
  /^(INSERT \d+ \d+|UPDATE \d+|DELETE \d+|MERGE \d+|COPY \d+|SELECT \d+|CREATE [A-Z ]+|DROP [A-Z ]+|ALTER [A-Z ]+|TRUNCATE TABLE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SET|RESET|COMMENT|ANALYZE|VACUUM|REINDEX|DO|CALL|NOTIFY|PREPARE|DEALLOCATE|LOCK TABLE|DISCARD [A-Z]+|REFRESH MATERIALIZED VIEW|SAVEPOINT|RELEASE|CLUSTER|CHECKPOINT|LISTEN|UNLISTEN|START TRANSACTION|END|CREATE ROLE|DROP ROLE)$/
function isPgTag(line: string): boolean {
  return !line.includes(US) && PG_TAG_RE.test(line)
}

// ---- MongoDB ----

function mongoCmd(serverId: string, js: string): string {
  const cred = getCred(serverId, 'mongo')
  // The password has to be an argument for mongosh (no env var support); it is visible in the
  // process list for the duration of the call. Credentials are only kept in memory.
  const auth = cred ? ` -u ${shq(cred.user)} -p ${shq(cred.password)} --authenticationDatabase admin` : ''
  return `${MONGOSH_BIN} --quiet --norc${auth} --eval ${shq(js)}`
}

/** JS prelude giving `EJ(x, indent)` and `PARSE(s)` that work on mongosh and the legacy mongo shell. */
const MONGO_PRELUDE = `var EJ = function (x, i) { try { return typeof EJSON !== 'undefined' ? EJSON.stringify(x, null, i) : (i ? tojson(x) : JSON.stringify(x)); } catch (e) { return JSON.stringify(String(x)); } };
var PARSE = function (s) { if (!s || !String(s).trim()) return {}; return typeof EJSON !== 'undefined' ? EJSON.parse(s) : JSON.parse(s); };
`

async function mongoEval<T>(ssh: SshClient, serverId: string, js: string, o: DriverOpts = {}): Promise<T> {
  const script = `${MONGO_PRELUDE}\n(function(){\n${js}\n})();`
  const r = await ssh.exec(mongoCmd(serverId, script), { timeoutMs: o.timeoutMs ?? 60000, maxBuffer: o.maxBuffer, signal: o.signal })
  if (r.code !== 0) throwExec('mongo', r, 'mongosh failed')
  const line = splitLines(r.stdout)
    .reverse()
    .find((l) => l.startsWith('__SM__'))
  if (!line) {
    const err = (r.stderr || r.stdout).trim()
    if (AUTH_RE.test(err)) throw new DbError('DB_AUTH', err.split('\n').slice(-3).join('\n'))
    throw new DbError('DB_ERROR', err ? err.split('\n').slice(-6).join('\n') : 'No result from mongosh')
  }
  return JSON.parse(line.slice(6)) as T
}

function assertMongoName(s: unknown, what = 'name'): string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_\-]{1,63}$/.test(s)) throw new Error(`Invalid ${what}: ${String(s)}`)
  return s
}
function assertMongoColl(s: unknown): string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_.\-]{1,120}$/.test(s) || s.startsWith('system.')) throw new Error(`Invalid collection name: ${String(s)}`)
  return s
}

// ---- SQLite ----

async function sqliteExec(ssh: SshClient, path: string, sql: string, o: DriverOpts = {}): Promise<ExecResult> {
  assertAbsPath(path)
  const cmd = `sqlite3 -batch -bail ${o.skipHeader ? '-noheader' : '-header'} -nullvalue '\\N' -separator "$(printf '\\037')" ${shq(path)}`
  return ssh.exec(cmd, { sudo: true, stdin: sql, timeoutMs: o.timeoutMs ?? 60000, maxBuffer: o.maxBuffer, signal: o.signal })
}

async function sqliteQuery(ssh: SshClient, path: string, sql: string, o: DriverOpts = {}): Promise<Grid> {
  const r = await sqliteExec(ssh, path, sql, o)
  if (r.code !== 0) throwExec('sqlite', r, 'sqlite3 failed')
  const lines = splitLines(r.stdout)
  if (o.skipHeader) return { columns: [], rows: lines.map((l) => l.split(US).map((c) => (c === '\\N' ? null : c))) }
  return parseGrid(lines, US, '\\N')
}

/** Dispatch a plain query (header + rows) to the right engine. `db` is the file path for sqlite. */
async function query(engine: DbEngine, ssh: SshClient, serverId: string, db: string | undefined, sql: string, o: DriverOpts = {}): Promise<Grid> {
  switch (engine) {
    case 'mysql':
      return myQuery(ssh, serverId, sql, { ...o, db })
    case 'postgres':
      return pgQuery(ssh, serverId, sql, { ...o, db })
    case 'sqlite':
      if (!db) throw new Error('SQLite database path is required')
      return sqliteQuery(ssh, db, sql, o)
    default:
      throw new Error('SQL is not supported for MongoDB; use the Mongo shell')
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function writeRootFile(ssh: SshClient, path: string, content: string, mode = '644'): Promise<void> {
  await ssh.sudoRun(`mkdir -p "$(dirname ${shq(path)})" && ${b64Echo(content)} > ${shq(path)} && chmod ${mode} ${shq(path)}`)
}

function taskIo(h: TaskHandle): Pick<ExecOptions, 'onStdout' | 'onStderr' | 'signal'> {
  return { onStdout: (c) => h.append(c), onStderr: (c) => h.append(c), signal: h.signal }
}

function pipefail(cmd: string): string {
  const q = shq(cmd)
  return `if command -v bash >/dev/null 2>&1; then exec bash -o pipefail -c ${q}; else exec ash -o pipefail -c ${q}; fi`
}

function requireSystemd(ssh: SshClient): void {
  if (!ssh.os?.hasSystemd) throw new Error('This feature needs systemd on the server')
}

async function unitFor(ssh: SshClient, engine: DbEngine): Promise<string> {
  const candidates = engine === 'mysql' ? ['mariadb', 'mysql', 'mysqld'] : engine === 'postgres' ? ['postgresql'] : engine === 'mongo' ? ['mongod', 'mongodb'] : []
  if (engine === 'postgres') {
    const r = await ssh.exec(
      `if systemctl cat postgresql.service >/dev/null 2>&1; then echo postgresql; else systemctl list-unit-files --no-legend 'postgresql*.service' 2>/dev/null | awk '{print $1}' | grep -v '@\\.service$' | head -1 | sed 's/\\.service$//'; fi`
    )
    const u = r.stdout.trim().split('\n')[0]
    if (u) return u
    throw new Error('PostgreSQL systemd unit not found')
  }
  const r = await ssh.exec(`for u in ${candidates.join(' ')}; do if systemctl cat "$u.service" >/dev/null 2>&1; then echo "$u"; break; fi; done`)
  const u = r.stdout.trim()
  if (!u) throw new Error(`${engineLabel(engine)} systemd unit not found`)
  return u
}

function ts(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const BACKUP_RE = /^(.+)-(\d{8}-\d{6})\.(mysql|pg|mongo)\.(sql\.gz|archive\.gz)$/

function backupPath(engine: DbEngine, db: string): string {
  const tag = engine === 'mysql' ? 'mysql' : engine === 'postgres' ? 'pg' : 'mongo'
  const ext = engine === 'mongo' ? 'archive.gz' : 'sql.gz'
  return `${DB_BACKUPS_DIR}/${db}-${ts()}.${tag}.${ext}`
}

function assertBackupFile(file: unknown): string {
  if (typeof file !== 'string' || !file.startsWith(DB_BACKUPS_DIR + '/') || file.includes('..') || file.includes('\0') || file.slice(DB_BACKUPS_DIR.length + 1).includes('/')) {
    throw new Error('Backup file must be inside ' + DB_BACKUPS_DIR)
  }
  return file
}

function csvEscape(v: string | null): string {
  if (v === null) return ''
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

function toCsv(g: Grid): string {
  const lines = [g.columns.map(csvEscape).join(',')]
  for (const r of g.rows) lines.push(r.map(csvEscape).join(','))
  return lines.join('\r\n') + '\r\n'
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

const STATUS_SCRIPT = `
echo __MYSQLD; for b in mariadbd mysqld /usr/sbin/mariadbd /usr/sbin/mysqld /usr/libexec/mysqld /usr/libexec/mariadbd; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; "$b" --version 2>/dev/null | head -1; break; fi; done
echo __MYSQLCLI; if command -v mysql >/dev/null 2>&1; then echo mysql; elif command -v mariadb >/dev/null 2>&1; then echo mariadb; fi
echo __MYSQLDUMP; (command -v mysqldump >/dev/null 2>&1 || command -v mariadb-dump >/dev/null 2>&1) && echo yes
MU=$(for u in mariadb mysql mysqld; do if systemctl cat "$u.service" >/dev/null 2>&1; then echo "$u"; break; fi; done)
echo __MYSQLUNIT; echo "$MU"
echo __MYSQLACTIVE; [ -n "$MU" ] && systemctl is-active "$MU" 2>/dev/null
echo __MYSQLENABLED; [ -n "$MU" ] && systemctl is-enabled "$MU" 2>/dev/null
echo __PSQL; command -v psql >/dev/null 2>&1 && echo yes
echo __PGDUMP; command -v pg_dump >/dev/null 2>&1 && echo yes
echo __PGVER; psql --version 2>/dev/null | head -1
echo __PGSERVER; (ls /usr/lib/postgresql/*/bin/postgres /usr/pgsql-*/bin/postgres /usr/bin/postgres /usr/libexec/postgresql*/postgres /usr/lib/postgresql*/bin/postgres 2>/dev/null; command -v postgres pg_ctlcluster 2>/dev/null) | head -1
if systemctl cat postgresql.service >/dev/null 2>&1; then PU=postgresql; else PU=$(systemctl list-unit-files --no-legend 'postgresql*.service' 2>/dev/null | awk '{print $1}' | grep -v '@\\.service$' | head -1 | sed 's/\\.service$//'); fi
echo __PGUNIT; echo "$PU"
echo __PGACTIVE; [ -n "$PU" ] && systemctl is-active "$PU" 2>/dev/null
echo __PGENABLED; [ -n "$PU" ] && systemctl is-enabled "$PU" 2>/dev/null
echo __PGREADY; command -v pg_isready >/dev/null 2>&1 && pg_isready -q 2>/dev/null && echo yes
echo __PGDATA; ls /var/lib/pgsql/data/PG_VERSION /var/lib/pgsql/*/data/PG_VERSION /var/lib/postgresql/*/main/PG_VERSION /var/lib/postgres/data/PG_VERSION 2>/dev/null | head -1
echo __MONGOD; command -v mongod >/dev/null 2>&1 && echo yes
echo __MONGOVER; mongod --version 2>/dev/null | head -1
echo __MONGOSH; if command -v mongosh >/dev/null 2>&1; then echo mongosh; elif command -v mongo >/dev/null 2>&1; then echo mongo; fi
echo __MONGODUMP; command -v mongodump >/dev/null 2>&1 && echo yes
MO=$(for u in mongod mongodb; do if systemctl cat "$u.service" >/dev/null 2>&1; then echo "$u"; break; fi; done)
echo __MONGOUNIT; echo "$MO"
echo __MONGOACTIVE; [ -n "$MO" ] && systemctl is-active "$MO" 2>/dev/null
echo __MONGOENABLED; [ -n "$MO" ] && systemctl is-enabled "$MO" 2>/dev/null
echo __MONGOCONF; grep -E '^\\s*(dbPath|port|bindIp):' /etc/mongod.conf 2>/dev/null
echo __SQLITE; sqlite3 --version 2>/dev/null | head -1
echo __BACKUPS; ls -1 ${DB_BACKUPS_DIR} 2>/dev/null | wc -l
echo __END`

function parseSections(out: string): Record<string, string[]> {
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.split('\n')) {
    const m = line.match(/^__([A-Z]+)$/)
    if (m) {
      cur = m[1]
      sec[cur] = []
    } else if (cur) sec[cur].push(line.replace(/\r$/, ''))
  }
  return sec
}

function first(sec: Record<string, string[]>, key: string): string {
  return (sec[key] ?? []).map((l) => l.trim()).find(Boolean) ?? ''
}

async function diskSize(ssh: SshClient, dir: string | undefined): Promise<number | undefined> {
  if (!dir || !dir.startsWith('/')) return undefined
  const r = await ssh.sudo(`du -sb ${shq(dir)} 2>/dev/null | awk '{print $1}'`, { timeoutMs: 30000 })
  return num(r.stdout.trim())
}

async function status(ssh: SshClient, serverId: string): Promise<DbStatusSummary> {
  const r = await ssh.sudo(STATUS_SCRIPT, { timeoutMs: 40000 })
  const sec = parseSections(r.stdout)

  // ---- MySQL / MariaDB ----
  const mysqldLines = (sec.MYSQLD ?? []).filter(Boolean)
  const mysqldVersion = mysqldLines[1] ?? ''
  const myClient = first(sec, 'MYSQLCLI')
  const myUnit = first(sec, 'MYSQLUNIT')
  const mysql: DbEngineStatus = {
    engine: 'mysql',
    installed: mysqldLines.length > 0 || !!myUnit,
    flavor: /mariadb/i.test(mysqldVersion + mysqldLines[0] + myUnit) ? 'mariadb' : mysqldLines.length || myUnit ? 'mysql' : undefined,
    version: mysqldVersion.replace(/^.*?Ver\s+/i, '').split(' for ')[0].trim() || undefined,
    unit: myUnit || undefined,
    running: first(sec, 'MYSQLACTIVE') === 'active',
    enabled: first(sec, 'MYSQLENABLED') === 'enabled',
    clientAvailable: !!myClient,
    dumpToolAvailable: first(sec, 'MYSQLDUMP') === 'yes',
    usingCredentials: !!getCred(serverId, 'mysql')
  }
  if (mysql.installed && mysql.running && mysql.clientAvailable) {
    try {
      const g = await myQuery(ssh, serverId, "SHOW VARIABLES WHERE Variable_name IN ('datadir','port','bind_address','version','version_comment','socket','skip_networking','character_set_server','max_connections')", { skipHeader: true, timeoutMs: 20000 })
      const vars: Record<string, string> = {}
      for (const row of g.rows) if (row[0]) vars[row[0]] = row[1] ?? ''
      mysql.authOk = true
      mysql.dataDir = vars.datadir
      mysql.port = vars.skip_networking === 'ON' ? undefined : num(vars.port)
      mysql.bindAddress = vars.skip_networking === 'ON' ? 'disabled (skip_networking)' : vars.bind_address || '*'
      if (vars.version) mysql.version = vars.version
      if (/mariadb/i.test(vars.version_comment ?? '') || /mariadb/i.test(vars.version ?? '')) mysql.flavor = 'mariadb'
      mysql.details = { socket: vars.socket ?? '', charset: vars.character_set_server ?? '', maxConnections: vars.max_connections ?? '', comment: vars.version_comment ?? '' }
      mysql.sizeBytes = await diskSize(ssh, mysql.dataDir)
    } catch (e) {
      mysql.authOk = false
      mysql.authError = e instanceof Error ? e.message : String(e)
    }
  }

  // ---- PostgreSQL ----
  const pgUnit = first(sec, 'PGUNIT')
  const pgServer = first(sec, 'PGSERVER')
  const postgres: DbEngineStatus = {
    engine: 'postgres',
    installed: !!pgServer || !!pgUnit,
    version: first(sec, 'PGVER').replace(/^psql\s*\(PostgreSQL\)\s*/i, '').trim() || undefined,
    unit: pgUnit || undefined,
    running: first(sec, 'PGREADY') === 'yes' || first(sec, 'PGACTIVE') === 'active',
    enabled: first(sec, 'PGENABLED') === 'enabled',
    clientAvailable: first(sec, 'PSQL') === 'yes',
    dumpToolAvailable: first(sec, 'PGDUMP') === 'yes',
    usingCredentials: !!getCred(serverId, 'postgres'),
    needsInitdb: (!!pgServer || !!pgUnit) && !first(sec, 'PGDATA') && (ssh.os?.pkgManager === 'dnf' || ssh.os?.pkgManager === 'yum' || ssh.os?.pkgManager === 'pacman')
  }
  if (postgres.installed && postgres.running && postgres.clientAvailable) {
    try {
      const g = await pgQuery(
        ssh,
        serverId,
        "SELECT current_setting('data_directory'), current_setting('port'), current_setting('listen_addresses'), version(), (SELECT sum(pg_database_size(datname)) FROM pg_database)::bigint, current_setting('max_connections'), current_setting('server_encoding')",
        { skipHeader: true, timeoutMs: 20000 }
      )
      const row = g.rows[0] ?? []
      postgres.authOk = true
      postgres.dataDir = row[0] ?? undefined
      postgres.port = num(row[1])
      postgres.bindAddress = row[2] ?? undefined
      const vm = (row[3] ?? '').match(/PostgreSQL\s+([\d.]+)/)
      if (vm) postgres.version = vm[1]
      postgres.sizeBytes = num(row[4])
      postgres.details = { maxConnections: row[5] ?? '', encoding: row[6] ?? '', fullVersion: row[3] ?? '' }
    } catch (e) {
      postgres.authOk = false
      postgres.authError = e instanceof Error ? e.message : String(e)
    }
  }

  // ---- MongoDB ----
  const mongoUnit = first(sec, 'MONGOUNIT')
  const mongoConf: Record<string, string> = {}
  for (const l of sec.MONGOCONF ?? []) {
    const m = l.match(/^\s*(dbPath|port|bindIp):\s*(.*)$/)
    if (m) mongoConf[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  const mongo: DbEngineStatus = {
    engine: 'mongo',
    installed: first(sec, 'MONGOD') === 'yes' || !!mongoUnit,
    version: first(sec, 'MONGOVER').replace(/^db version v?/i, '').trim() || undefined,
    unit: mongoUnit || undefined,
    running: first(sec, 'MONGOACTIVE') === 'active',
    enabled: first(sec, 'MONGOENABLED') === 'enabled',
    clientAvailable: !!first(sec, 'MONGOSH'),
    dumpToolAvailable: first(sec, 'MONGODUMP') === 'yes',
    usingCredentials: !!getCred(serverId, 'mongo'),
    dataDir: mongoConf.dbPath || undefined,
    port: num(mongoConf.port) ?? (mongoUnit ? 27017 : undefined),
    bindAddress: mongoConf.bindIp || undefined
  }
  if (mongo.installed && mongo.running && mongo.clientAvailable) {
    try {
      const info = await mongoEval<{ version: string; totalSize: number; dbs: number }>(
        ssh,
        serverId,
        `var ad = db.getSiblingDB('admin'); var ld = ad.adminCommand({ listDatabases: 1 }); var bi = ad.serverBuildInfo ? ad.serverBuildInfo() : ad.runCommand({ buildInfo: 1 }); print('__SM__' + JSON.stringify({ version: bi.version, totalSize: ld.totalSize || 0, dbs: (ld.databases || []).length }));`,
        { timeoutMs: 20000 }
      )
      mongo.authOk = true
      mongo.version = info.version || mongo.version
      mongo.sizeBytes = info.totalSize
      mongo.details = { databases: String(info.dbs) }
    } catch (e) {
      mongo.authOk = false
      mongo.authError = e instanceof Error ? e.message : String(e)
    }
    if (mongo.sizeBytes === undefined) mongo.sizeBytes = await diskSize(ssh, mongo.dataDir)
  }

  const sqliteVer = first(sec, 'SQLITE')
  return {
    mysql,
    postgres,
    mongo,
    sqlite: { installed: !!sqliteVer, version: sqliteVer.split(' ')[0] || undefined },
    backupsDir: DB_BACKUPS_DIR,
    backupsCount: Number(first(sec, 'BACKUPS')) || 0,
    os: { pkgManager: ssh.os?.pkgManager ?? 'unknown', id: ssh.os?.id ?? 'linux', prettyName: ssh.os?.prettyName ?? 'Linux' }
  }
}

/* ------------------------------------------------------------------ */
/* Installation                                                        */
/* ------------------------------------------------------------------ */

async function installMysqlFamily(ssh: SshClient, h: TaskHandle, variant: 'mysql' | 'mariadb'): Promise<void> {
  requireSystemd(ssh)
  const pm = ssh.os?.pkgManager
  let v = variant
  if (v === 'mysql' && (ssh.os?.id === 'debian' || pm === 'zypper' || pm === 'pacman' || pm === 'apk')) {
    h.log(`${ssh.os?.prettyName} does not ship MySQL server packages; installing MariaDB (drop-in compatible) instead.`)
    v = 'mariadb'
  }
  const pkgs = v === 'mysql' ? ['mysql-server'] : pm === 'pacman' ? ['mariadb'] : pm === 'apk' ? ['mariadb', 'mariadb-client'] : ['mariadb-server']
  h.log(`Installing ${pkgs.join(' ')} …`)
  await runPkg(ssh, installCmd(ssh, pkgs), taskIo(h))
  if (pm === 'pacman') {
    h.log('Initialising the data directory …')
    await ssh.sudoRun('[ -d /var/lib/mysql/mysql ] || mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql', { timeoutMs: 300000 })
  }
  h.log('Enabling and starting the service …')
  await ssh.sudoRun(v === 'mysql' ? 'systemctl enable --now mysql 2>/dev/null || systemctl enable --now mysqld' : 'systemctl enable --now mariadb', { timeoutMs: 180000 })
  h.log('Health check …')
  const r = await ssh.sudo(`${MYSQL_BIN} --batch --skip-column-names -e 'SELECT VERSION()'`, { timeoutMs: 30000 })
  if (r.code !== 0) throw new Error('Server installed but the health check failed: ' + (r.stderr || r.stdout).trim())
  h.log(`Server is up: ${r.stdout.trim()}`)
  h.log('Tip: run "Secure installation" to set a root password and remove anonymous users / the test database.')
}

async function installPostgres(ssh: SshClient, h: TaskHandle): Promise<void> {
  requireSystemd(ssh)
  const pm = ssh.os?.pkgManager
  const pkgs = pm === 'apt' ? ['postgresql', 'postgresql-contrib'] : pm === 'dnf' || pm === 'yum' ? ['postgresql-server', 'postgresql-contrib'] : pm === 'zypper' ? ['postgresql-server', 'postgresql-contrib'] : pm === 'pacman' ? ['postgresql'] : null
  if (!pkgs) throw new Error(`PostgreSQL installation is not supported on ${ssh.os?.prettyName}`)
  h.log(`Installing ${pkgs.join(' ')} …`)
  await runPkg(ssh, installCmd(ssh, pkgs), taskIo(h))
  if (pm === 'dnf' || pm === 'yum') {
    h.log('Initialising the database cluster (postgresql-setup --initdb) …')
    await ssh.sudoRun('[ -f /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb', { timeoutMs: 300000 })
  } else if (pm === 'pacman') {
    h.log('Initialising the database cluster (initdb) …')
    await ssh.sudoRun(`[ -f /var/lib/postgres/data/PG_VERSION ] || ${asPostgres("initdb --locale=C.UTF-8 -E UTF8 -D /var/lib/postgres/data")}`, { timeoutMs: 300000 })
  }
  h.log('Enabling and starting the service …')
  await ssh.sudoRun('systemctl enable --now postgresql', { timeoutMs: 180000 })
  h.log('Health check …')
  await new Promise((r) => setTimeout(r, 1500))
  const r = await ssh.sudo(asPostgres(`psql -X -A -t -c 'SELECT version()'`), { timeoutMs: 30000 })
  if (r.code !== 0) throw new Error('Server installed but the health check failed: ' + (r.stderr || r.stdout).trim())
  h.log(`Server is up: ${r.stdout.trim()}`)
}

async function installMongo(ssh: SshClient, h: TaskHandle): Promise<void> {
  requireSystemd(ssh)
  const os = ssh.os
  const pm = os?.pkgManager
  if (pm === 'apt') {
    const cn = await ssh.exec('. /etc/os-release; echo "${VERSION_CODENAME:-$UBUNTU_CODENAME}"')
    const codename = cn.stdout.trim()
    if (!codename) throw new Error('Could not determine the distribution codename from /etc/os-release')
    const isUbuntu = os?.id === 'ubuntu' || /ubuntu/.test(os?.idLike ?? '')
    h.log('Installing prerequisites (curl, gnupg) …')
    await runPkg(ssh, installCmd(ssh, ['curl', 'gnupg', 'ca-certificates']), taskIo(h))
    h.log('Adding the MongoDB 8.0 signing key and repository …')
    await ssh.sudoRun('curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg', { timeoutMs: 120000 })
    const line = isUbuntu
      ? `deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${codename}/mongodb-org/8.0 multiverse\n`
      : `deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/debian ${codename}/mongodb-org/8.0 main\n`
    await writeRootFile(ssh, '/etc/apt/sources.list.d/mongodb-org-8.0.list', line)
  } else if (pm === 'dnf' || pm === 'yum') {
    if (os?.id === 'fedora') throw new Error('MongoDB does not publish packages for Fedora. Use RHEL / Rocky / Alma or run MongoDB in Docker.')
    const major = (os?.versionId ?? '').split('.')[0]
    if (!/^\d+$/.test(major)) throw new Error('Could not determine the RHEL major version')
    h.log(`Adding the MongoDB 8.0 repository for RHEL ${major} …`)
    await writeRootFile(ssh, '/etc/yum.repos.d/mongodb-org-8.0.repo', `[mongodb-org-8.0]\nname=MongoDB Repository\nbaseurl=https://repo.mongodb.org/yum/redhat/${major}/mongodb-org/8.0/$basearch/\ngpgcheck=1\nenabled=1\ngpgkey=https://pgp.mongodb.com/server-8.0.asc\n`)
  } else {
    throw new Error(`MongoDB installation is supported on apt and dnf/yum based systems only (${os?.prettyName}). Consider running MongoDB in Docker.`)
  }
  h.log('Installing mongodb-org …')
  await runPkg(ssh, installCmd(ssh, ['mongodb-org']), taskIo(h))
  h.log('Enabling and starting mongod …')
  await ssh.sudoRun('systemctl daemon-reload; systemctl enable --now mongod', { timeoutMs: 180000 })
  await new Promise((r) => setTimeout(r, 2000))
  h.log('Health check …')
  const r = await ssh.exec(`${MONGOSH_BIN} --quiet --norc --eval 'print(db.runCommand({ping:1}).ok)'`, { timeoutMs: 30000 })
  if (r.code !== 0 || !r.stdout.includes('1')) throw new Error('mongod installed but the health check failed: ' + (r.stderr || r.stdout).trim())
  h.log('mongod is up (listening on 127.0.0.1:27017, no authentication by default).')
}

async function installSqlite(ssh: SshClient, h: TaskHandle): Promise<void> {
  const pm = ssh.os?.pkgManager
  const pkg = pm === 'apt' ? 'sqlite3' : 'sqlite'
  h.log(`Installing ${pkg} …`)
  await runPkg(ssh, installCmd(ssh, [pkg]), taskIo(h))
  const r = await ssh.exec('sqlite3 --version')
  h.log(r.stdout.trim() || 'sqlite3 installed')
}

/* ------------------------------------------------------------------ */
/* Databases / users per engine                                        */
/* ------------------------------------------------------------------ */

async function listDatabases(engine: DbEngine, ssh: SshClient, serverId: string): Promise<DbDatabase[]> {
  if (engine === 'mysql') {
    const g = await myQuery(
      ssh,
      serverId,
      'SELECT s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME, IFNULL(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0), COUNT(t.TABLE_NAME) FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME ORDER BY s.SCHEMA_NAME',
      { skipHeader: true }
    )
    return g.rows.map((r) => ({ name: r[0] ?? '', charset: r[1] ?? undefined, collation: r[2] ?? undefined, sizeBytes: num(r[3]), tables: num(r[4]), system: SYSTEM_MYSQL_DBS.has(r[0] ?? '') }))
  }
  if (engine === 'postgres') {
    const g = await pgQuery(
      ssh,
      serverId,
      "SELECT d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding), d.datcollate, CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) ELSE 0 END FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname",
      { skipHeader: true }
    )
    return g.rows.map((r) => ({ name: r[0] ?? '', owner: r[1] ?? undefined, charset: r[2] ?? undefined, collation: r[3] ?? undefined, sizeBytes: num(r[4]), system: SYSTEM_PG_DBS.has(r[0] ?? '') }))
  }
  if (engine === 'mongo') {
    const res = await mongoEval<{ databases: { name: string; sizeOnDisk: number; empty: boolean }[] }>(ssh, serverId, "print('__SM__' + JSON.stringify(db.getSiblingDB('admin').adminCommand({ listDatabases: 1 })));")
    const dbs = res.databases ?? []
    const counts = await mongoEval<Record<string, number>>(
      ssh,
      serverId,
      `var names = ${JSON.stringify(dbs.map((d) => d.name))}; var out = {}; names.forEach(function (n) { try { out[n] = db.getSiblingDB(n).getCollectionNames().length; } catch (e) { out[n] = -1; } }); print('__SM__' + JSON.stringify(out));`
    ).catch(() => ({}) as Record<string, number>)
    return dbs.map((d) => ({ name: d.name, sizeBytes: d.sizeOnDisk, tables: counts[d.name] >= 0 ? counts[d.name] : undefined, system: SYSTEM_MONGO_DBS.has(d.name) }))
  }
  throw new Error('Not applicable for SQLite')
}

function summarizeMysqlPrivs(global: string | null, perDb: string | null): string {
  const g = (global ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const parts: string[] = []
  if (g.length) {
    if (g.includes('SUPER') || g.length >= 25) parts.push('ALL (global)')
    else if (g.length === 1 && g[0] === 'USAGE') parts.push('USAGE')
    else parts.push(`global: ${g.join(', ')}`)
  }
  const byDb = new Map<string, string[]>()
  for (const item of (perDb ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':')
    if (i < 0) continue
    const d = item.slice(0, i)
    byDb.set(d, [...(byDb.get(d) ?? []), item.slice(i + 1)])
  }
  for (const [d, privs] of byDb) {
    const set = new Set(privs)
    if (set.has('INSERT') && set.has('UPDATE') && set.has('DELETE') && set.has('DROP')) parts.push(`${d}: ALL`)
    else if (set.size === 1 && set.has('SELECT')) parts.push(`${d}: read-only`)
    else parts.push(`${d}: ${privs.join(', ')}`)
  }
  return parts.join(' · ') || 'none'
}

async function listUsers(engine: DbEngine, ssh: SshClient, serverId: string): Promise<DbUser[]> {
  if (engine === 'mysql') {
    const g = await myQuery(
      ssh,
      serverId,
      `SELECT u.User, u.Host, (SELECT GROUP_CONCAT(DISTINCT p.PRIVILEGE_TYPE) FROM information_schema.USER_PRIVILEGES p WHERE p.GRANTEE = CONCAT("'", u.User, "'@'", u.Host, "'")), (SELECT GROUP_CONCAT(DISTINCT CONCAT(p.TABLE_SCHEMA, ':', p.PRIVILEGE_TYPE)) FROM information_schema.SCHEMA_PRIVILEGES p WHERE p.GRANTEE = CONCAT("'", u.User, "'@'", u.Host, "'")), u.plugin FROM mysql.user u ORDER BY u.User, u.Host`,
      { skipHeader: true }
    )
    return g.rows.map((r) => {
      const user = r[0] ?? ''
      return {
        user,
        host: r[1] ?? '',
        privileges: summarizeMysqlPrivs(r[2], r[3]),
        plugin: r[4] ?? undefined,
        superuser: (r[2] ?? '').includes('SUPER'),
        system: user === '' || ['mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint'].includes(user)
      }
    })
  }
  if (engine === 'postgres') {
    const g = await pgQuery(
      ssh,
      serverId,
      "SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolcanlogin, r.rolreplication, (SELECT string_agg(d.datname, ', ' ORDER BY d.datname) FROM pg_database d WHERE d.datdba = r.oid AND NOT d.datistemplate), (SELECT string_agg(d.datname, ', ' ORDER BY d.datname) FROM pg_database d WHERE NOT d.datistemplate AND d.datdba <> r.oid AND d.datacl::text LIKE '%' || r.rolname || '=%'), (SELECT string_agg(m.rolname, ', ') FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.roleid WHERE am.member = r.oid) FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' ORDER BY r.rolname",
      { skipHeader: true }
    )
    return g.rows.map((r) => {
      const parts: string[] = []
      if (r[1] === 't') parts.push('SUPERUSER')
      if (r[2] === 't') parts.push('CREATEDB')
      if (r[3] === 't') parts.push('CREATEROLE')
      if (r[5] === 't') parts.push('REPLICATION')
      if (r[6]) parts.push(`owner of ${r[6]}`)
      if (r[7]) parts.push(`granted on ${r[7]}`)
      if (r[8]) parts.push(`member of ${r[8]}`)
      if (r[4] !== 't') parts.push('NOLOGIN')
      return { user: r[0] ?? '', privileges: parts.join(' · ') || 'none', superuser: r[1] === 't', canLogin: r[4] === 't', roles: r[8] ? r[8].split(', ') : undefined, system: r[0] === 'postgres' }
    })
  }
  if (engine === 'mongo') {
    const res = await mongoEval<{ users: { user: string; db: string; roles: { role: string; db: string }[] }[] }>(
      ssh,
      serverId,
      "var u = db.getSiblingDB('admin').getSiblingDB('admin').system.users.find({}, { user: 1, db: 1, roles: 1 }).toArray(); print('__SM__' + JSON.stringify({ users: u }));"
    )
    return (res.users ?? []).map((u) => ({
      user: u.user,
      host: u.db,
      roles: (u.roles ?? []).map((r) => `${r.role}@${r.db}`),
      privileges: (u.roles ?? []).map((r) => `${r.role} on ${r.db}`).join(', ') || 'none',
      superuser: (u.roles ?? []).some((r) => r.role === 'root'),
      canLogin: true
    }))
  }
  throw new Error('Not applicable for SQLite')
}

function mysqlGrantSql(privs: DbPrivileges, db: string | undefined, account: string): string[] {
  if (privs === 'none' || !db) return []
  const target = `${qMy(assertIdent(db, 'database name'))}.*`
  if (privs === 'all') return [`GRANT ALL PRIVILEGES ON ${target} TO ${account}`]
  return [`GRANT SELECT, SHOW VIEW ON ${target} TO ${account}`]
}

async function pgGrant(ssh: SshClient, serverId: string, user: string, db: string, privs: DbPrivileges): Promise<void> {
  if (privs === 'none') return
  const u = qDq(assertIdent(user, 'user name'))
  const d = assertIdent(db, 'database name')
  if (privs === 'all') {
    await pgQuery(ssh, serverId, `GRANT ALL PRIVILEGES ON DATABASE ${qDq(d)} TO ${u};`)
    await pgQuery(
      ssh,
      serverId,
      `GRANT ALL ON SCHEMA public TO ${u};\nGRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${u};\nGRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${u};\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${u};\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${u};`,
      { db: d }
    )
  } else {
    await pgQuery(ssh, serverId, `GRANT CONNECT ON DATABASE ${qDq(d)} TO ${u};`)
    await pgQuery(
      ssh,
      serverId,
      `GRANT USAGE ON SCHEMA public TO ${u};\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO ${u};\nGRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${u};\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${u};`,
      { db: d }
    )
  }
}

function mongoRoles(privs: DbPrivileges, db: string | undefined): { role: string; db: string }[] {
  if (privs === 'none') return []
  if (!db) return privs === 'all' ? [{ role: 'root', db: 'admin' }] : [{ role: 'readAnyDatabase', db: 'admin' }]
  return [{ role: privs === 'all' ? 'dbOwner' : 'read', db: assertMongoName(db, 'database name') }]
}

/* ------------------------------------------------------------------ */
/* Tables / rows                                                       */
/* ------------------------------------------------------------------ */

async function listTables(engine: DbEngine, ssh: SshClient, serverId: string, db: string): Promise<DbTable[]> {
  if (engine === 'mysql') {
    const g = await myQuery(ssh, serverId, `SELECT TABLE_NAME, TABLE_ROWS, IFNULL(DATA_LENGTH + INDEX_LENGTH, 0), ENGINE, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${myStr(assertIdent(db, 'database name'))} ORDER BY TABLE_NAME`, { skipHeader: true })
    return g.rows.map((r) => ({ name: r[0] ?? '', rows: num(r[1]), sizeBytes: num(r[2]), engine: r[3] ?? undefined, type: r[4] === 'VIEW' ? 'view' : 'table' }))
  }
  if (engine === 'postgres') {
    const g = await pgQuery(
      ssh,
      serverId,
      "SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END, GREATEST(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid), CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY 1",
      { db: assertIdent(db, 'database name'), skipHeader: true }
    )
    return g.rows.map((r) => ({ name: r[0] ?? '', rows: num(r[1]), sizeBytes: num(r[2]), type: r[3] === 'view' ? 'view' : 'table' }))
  }
  if (engine === 'sqlite') {
    const names = await sqliteQuery(ssh, db, "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name", { skipHeader: true })
    const tables: DbTable[] = names.rows.map((r) => ({ name: r[0] ?? '', type: r[1] === 'view' ? 'view' : 'table' }))
    const real = tables.filter((t) => t.type === 'table')
    if (real.length) {
      const sql = real.map((t) => `SELECT ${sqlStr(t.name)}, COUNT(*) FROM ${qDq(t.name)}`).join(' UNION ALL ') + ';'
      const counts = await sqliteQuery(ssh, db, sql, { skipHeader: true }).catch(() => ({ columns: [], rows: [] }) as Grid)
      const m = new Map(counts.rows.map((r) => [r[0] ?? '', num(r[1])]))
      for (const t of tables) if (m.has(t.name)) t.rows = m.get(t.name)
    }
    return tables
  }
  throw new Error('Use the Mongo collections handler for MongoDB')
}

async function columnsAndPk(engine: DbEngine, ssh: SshClient, serverId: string, db: string, table: string): Promise<{ columns: string[]; pk: string[] }> {
  if (engine === 'mysql') {
    const g = await myQuery(ssh, serverId, `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${myStr(db)} AND TABLE_NAME = ${myStr(table)} ORDER BY ORDINAL_POSITION`, { skipHeader: true })
    return { columns: g.rows.map((r) => r[0] ?? ''), pk: g.rows.filter((r) => r[1] === 'PRI').map((r) => r[0] ?? '') }
  }
  if (engine === 'postgres') {
    const g = await pgQuery(
      ssh,
      serverId,
      `SELECT a.attname, COALESCE(i.indisprimary, false) FROM pg_attribute a LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey) WHERE a.attrelid = ${sqlStr(qPgTable(table))}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      { db, skipHeader: true }
    )
    return { columns: g.rows.map((r) => r[0] ?? ''), pk: g.rows.filter((r) => r[1] === 't').map((r) => r[0] ?? '') }
  }
  if (engine === 'sqlite') {
    const g = await sqliteQuery(ssh, db, `PRAGMA table_info(${qDq(table)});`)
    const ni = g.columns.indexOf('name')
    const pi = g.columns.indexOf('pk')
    const cols = g.rows.map((r) => r[ni] ?? '')
    const pk = g.rows.filter((r) => Number(r[pi]) > 0).sort((a, b) => Number(a[pi]) - Number(b[pi])).map((r) => r[ni] ?? '')
    return { columns: cols, pk }
  }
  throw new Error('Not applicable')
}

async function browseRows(engine: DbEngine, ssh: SshClient, serverId: string, db: string, table: string, opts: DbRowsOptions): Promise<DbRowsResult> {
  assertLooseIdent(table, 'table name')
  const limit = clampInt(opts?.limit, 100, 1, DB_ROWS_MAX_LIMIT)
  const offset = clampInt(opts?.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const where = cleanWhere(opts?.where)
  const dir = opts?.orderDir === 'desc' ? 'DESC' : 'ASC'
  const t = qTable(engine, table)
  const meta = await columnsAndPk(engine, ssh, serverId, db, table)
  const orderBy = opts?.orderBy && meta.columns.includes(opts.orderBy) ? ` ORDER BY ${qIdent(engine, opts.orderBy)} ${dir}` : ''
  const whereSql = where ? ` WHERE (${where})` : ''
  const sql = `SELECT * FROM ${t}${whereSql}${orderBy} LIMIT ${limit} OFFSET ${offset};`
  const countSql = `SELECT COUNT(*) FROM ${t}${whereSql};`

  let total: number | undefined
  let totalIsEstimate = false
  const [grid, countRes] = await Promise.all([
    query(engine, ssh, serverId, db, sql, { maxBuffer: 16 * 1024 * 1024 }),
    (async (): Promise<number | undefined> => {
      if (!where && engine === 'mysql') {
        const e = await myQuery(ssh, serverId, `SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${myStr(db)} AND TABLE_NAME = ${myStr(table)}`, { skipHeader: true })
        const est = num(e.rows[0]?.[0])
        if (est !== undefined && est > 200000) {
          totalIsEstimate = true
          return est
        }
      }
      if (!where && engine === 'postgres') {
        const e = await pgQuery(ssh, serverId, `SELECT reltuples::bigint FROM pg_class WHERE oid = ${sqlStr(qPgTable(table))}::regclass`, { db, skipHeader: true })
        const est = num(e.rows[0]?.[0])
        if (est !== undefined && est > 200000) {
          totalIsEstimate = true
          return est
        }
      }
      const c = await query(engine, ssh, serverId, db, countSql, { skipHeader: true, timeoutMs: 30000 }).catch(() => undefined)
      return c ? num(c.rows[0]?.[0]) : undefined
    })()
  ])
  total = countRes
  const columns = grid.columns.length ? grid.columns : meta.columns
  return { columns, rows: grid.rows, total, totalIsEstimate, pk: meta.pk }
}

function pkWhere(engine: DbEngine, pkValues: Record<string, string | null>): string {
  const entries = Object.entries(pkValues ?? {})
  if (!entries.length) throw new Error('This table has no primary key; rows cannot be edited')
  return entries.map(([k, v]) => (v === null ? `${qIdent(engine, k)} IS NULL` : `${qIdent(engine, k)} = ${lit(engine, v)}`)).join(' AND ')
}

async function runSql(engine: DbEngine, ssh: SshClient, serverId: string, db: string | undefined, sqlRaw: string, maxBuffer = 8 * 1024 * 1024): Promise<DbQueryResult> {
  if (typeof sqlRaw !== 'string' || !sqlRaw.trim()) throw new Error('Empty SQL')
  const sql = sqlRaw.trim()
  const t0 = Date.now()
  const isRead = /^\s*(select|show|describe|desc|explain|with|values|table|pragma)\b/i.test(sql)
  const MARK = '__SM_AFFECTED__'

  if (engine === 'postgres') {
    const r = await pgExec(ssh, serverId, sql, { db, maxBuffer, timeoutMs: 300000 })
    if (r.code !== 0) throwExec('postgres', r, 'psql failed')
    const lines = splitLines(r.stdout)
    const tags = lines.filter(isPgTag)
    const data = lines.filter((l) => !isPgTag(l))
    let affected: number | undefined
    for (const t of tags) {
      const m = t.match(/^(?:INSERT \d+|UPDATE|DELETE|MERGE|COPY) (\d+)$/)
      if (m) affected = (affected ?? 0) + Number(m[1])
    }
    const grid = data.length ? parseGrid(data, US, '\\N') : { columns: [], rows: [] }
    const msg = [...tags, r.stderr.trim()].filter(Boolean).join('\n')
    return { ...grid, affected, ms: Date.now() - t0, message: msg || undefined, truncated: r.stdout.length >= maxBuffer }
  }

  // MySQL and SQLite: append a marker query so we learn the affected row count of write statements.
  const body = sql.replace(/;\s*$/, '')
  const text = isRead ? body + ';' : engine === 'mysql' ? `${body};\nSELECT CONCAT('${MARK}', ROW_COUNT()) AS __sm;` : `${body};\nSELECT '${MARK}' || changes() AS __sm;`
  const r = engine === 'mysql' ? await myExec(ssh, serverId, text, { db, maxBuffer, timeoutMs: 300000 }) : await sqliteExec(ssh, db ?? '', text, { maxBuffer, timeoutMs: 300000 })
  if (r.code !== 0) throwExec(engine, r, `${engine} failed`)
  let lines = splitLines(r.stdout)
  let affected: number | undefined
  const mi = lines.findIndex((l) => l.startsWith(MARK))
  if (mi >= 0) {
    affected = Number(lines[mi].slice(MARK.length))
    if (affected < 0) affected = undefined
    lines = lines.slice(0, mi - 1 >= 0 && lines[mi - 1] === '__sm' ? mi - 1 : mi)
  }
  const grid = engine === 'mysql' ? parseGrid(lines, '\t', 'NULL', mysqlUnescape) : parseGrid(lines, US, '\\N')
  return { ...grid, affected, ms: Date.now() - t0, message: r.stderr.trim() || undefined, truncated: r.stdout.length >= maxBuffer }
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  // ---------------- status / install / service ----------------
  ctx.handle('db:status', async (serverId: string): Promise<DbStatusSummary> => status(ctx.ssh(serverId), serverId))

  ctx.handle('db:setCredentials', async (serverId: string, engineRaw: unknown, user: string, password: string) => {
    const engine = assertEngine(engineRaw)
    const map = creds.get(serverId) ?? {}
    if (!user) delete map[engine]
    else map[engine] = { user: String(user), password: String(password ?? '') }
    creds.set(serverId, map)
    // Verify immediately so the UI can tell the user.
    const ssh = ctx.ssh(serverId)
    if (user) {
      if (engine === 'mysql') await myQuery(ssh, serverId, 'SELECT 1', { skipHeader: true, timeoutMs: 20000 })
      else if (engine === 'postgres') await pgQuery(ssh, serverId, 'SELECT 1', { skipHeader: true, timeoutMs: 20000 })
      else if (engine === 'mongo') await mongoEval(ssh, serverId, "print('__SM__' + JSON.stringify(db.getSiblingDB('admin').runCommand({ ping: 1 })));", { timeoutMs: 20000 })
    }
    return { stored: !!user }
  })

  ctx.handle('db:install', async (serverId: string, engineRaw: unknown, variant?: 'mysql' | 'mariadb') => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    const title = engine === 'mysql' ? `Install ${variant === 'mariadb' ? 'MariaDB' : 'MySQL'}` : engine === 'postgres' ? 'Install PostgreSQL' : engine === 'mongo' ? 'Install MongoDB 8.0' : 'Install sqlite3'
    const { id } = ctx.tasks.start(title, serverId, async (h) => {
      if (engine === 'mysql') await installMysqlFamily(ssh, h, variant === 'mariadb' ? 'mariadb' : 'mysql')
      else if (engine === 'postgres') await installPostgres(ssh, h)
      else if (engine === 'mongo') await installMongo(ssh, h)
      else await installSqlite(ssh, h)
      ctx.audit(serverId, 'db.install', `${engine}${variant ? ' ' + variant : ''}`)
    })
    return id
  })

  ctx.handle('db:service', async (serverId: string, engineRaw: unknown, action: DbServiceAction) => {
    const engine = assertEngine(engineRaw)
    if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error('Invalid action')
    const ssh = ctx.ssh(serverId)
    requireSystemd(ssh)
    const unit = await unitFor(ssh, engine)
    const cmd = action === 'enable' ? `systemctl enable --now ${shq(unit)}` : action === 'disable' ? `systemctl disable ${shq(unit)}` : `systemctl ${action} ${shq(unit)}`
    await ssh.sudoRun(cmd, { timeoutMs: 180000 })
    ctx.audit(serverId, 'db.service', `${engine} ${action} (${unit})`)
  })

  ctx.handle('db:secure', async (serverId: string, engineRaw: unknown, opts: { rootPassword?: string; removeAnonymous?: boolean; removeTestDb?: boolean; disallowRemoteRoot?: boolean }) => {
    const engine = assertEngine(engineRaw)
    if (engine !== 'mysql') throw new Error('Secure installation is only available for MySQL / MariaDB')
    const ssh = ctx.ssh(serverId)
    const o = { removeAnonymous: true, removeTestDb: true, disallowRemoteRoot: true, ...(opts ?? {}) }
    const log: string[] = []
    const ver = await myQuery(ssh, serverId, 'SELECT VERSION()', { skipHeader: true })
    const isMaria = /mariadb/i.test(ver.rows[0]?.[0] ?? '')
    const drops = await myQuery(
      ssh,
      serverId,
      `SELECT User, Host FROM mysql.user WHERE ${[o.removeAnonymous ? "User = ''" : null, o.disallowRemoteRoot ? "(User = 'root' AND Host NOT IN ('localhost','127.0.0.1','::1'))" : null].filter(Boolean).join(' OR ') || '1 = 0'}`,
      { skipHeader: true }
    )
    const stmts: string[] = []
    for (const r of drops.rows) {
      const acc = `${myStr(r[0] ?? '')}@${myStr(r[1] ?? '')}`
      stmts.push(`DROP USER IF EXISTS ${acc};`)
      log.push(`Dropped ${acc}`)
    }
    if (o.removeTestDb) {
      stmts.push('DROP DATABASE IF EXISTS test;', "DELETE FROM mysql.db WHERE Db = 'test' OR Db = 'test\\_%';")
      log.push('Removed test database')
    }
    if (o.rootPassword) {
      if (o.rootPassword.length < 8) throw new Error('Root password must be at least 8 characters')
      // MariaDB: keep unix_socket auth for root (so local root admin keeps working) AND set a password.
      // MySQL 8: switching root@localhost to a password disables auth_socket, so remember the credential in memory.
      stmts.push(isMaria ? `ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD(${myStr(o.rootPassword)});` : `ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY ${myStr(o.rootPassword)};`)
      log.push('Set root password')
    }
    stmts.push('FLUSH PRIVILEGES;')
    await myQuery(ssh, serverId, stmts.join('\n'))
    if (o.rootPassword && !isMaria) {
      const map = creds.get(serverId) ?? {}
      map.mysql = { user: 'root', password: o.rootPassword }
      creds.set(serverId, map)
      log.push('Stored root credentials in memory for this session (MySQL no longer uses socket authentication for root).')
    }
    ctx.audit(serverId, 'db.secure', 'mysql')
    return log
  })

  // ---------------- databases ----------------
  ctx.handle('db:databases', async (serverId: string, engineRaw: unknown): Promise<DbDatabase[]> => listDatabases(assertEngine(engineRaw), ctx.ssh(serverId), serverId))

  ctx.handle('db:createDatabase', async (serverId: string, engineRaw: unknown, nameRaw: string, opts?: { owner?: string; charset?: string; collation?: string }) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    if (engine === 'mysql') {
      const name = assertIdent(nameRaw, 'database name')
      const cs = opts?.charset ? ` CHARACTER SET ${assertIdent(opts.charset, 'charset')}` : ''
      const co = opts?.collation ? ` COLLATE ${assertIdent(opts.collation, 'collation')}` : ''
      await myQuery(ssh, serverId, `CREATE DATABASE ${qMy(name)}${cs}${co};`)
    } else if (engine === 'postgres') {
      const name = assertIdent(nameRaw, 'database name')
      const owner = opts?.owner ? ` OWNER ${qDq(assertIdent(opts.owner, 'owner'))}` : ''
      const enc = opts?.charset ? ` ENCODING ${sqlStr(assertIdent(opts.charset, 'encoding'))}` : ''
      await pgQuery(ssh, serverId, `CREATE DATABASE ${qDq(name)}${owner}${enc};`)
    } else if (engine === 'mongo') {
      const name = assertMongoName(nameRaw, 'database name')
      // MongoDB creates databases lazily; create a placeholder collection so it shows up.
      await mongoEval(ssh, serverId, `var d = db.getSiblingDB(${JSON.stringify(name)}); d.createCollection('_servermate_init'); d.getCollection('_servermate_init').drop(); d.createCollection('default'); print('__SM__' + JSON.stringify({ ok: 1 }));`)
    } else throw new Error('Not applicable for SQLite')
    ctx.audit(serverId, 'db.createDatabase', `${engine} ${nameRaw}`)
  })

  ctx.handle('db:dropDatabase', async (serverId: string, engineRaw: unknown, nameRaw: string) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    if (engine === 'mysql') {
      const name = assertIdent(nameRaw, 'database name')
      if (SYSTEM_MYSQL_DBS.has(name)) throw new Error('Refusing to drop a system database')
      await myQuery(ssh, serverId, `DROP DATABASE ${qMy(name)};`)
    } else if (engine === 'postgres') {
      const name = assertIdent(nameRaw, 'database name')
      if (SYSTEM_PG_DBS.has(name)) throw new Error('Refusing to drop a system database')
      const r = await pgExec(ssh, serverId, `DROP DATABASE ${qDq(name)} WITH (FORCE);`)
      if (r.code !== 0) {
        // PostgreSQL < 13 has no FORCE: terminate connections, then drop.
        await pgQuery(ssh, serverId, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlStr(name)} AND pid <> pg_backend_pid();`, { skipHeader: true })
        await pgQuery(ssh, serverId, `DROP DATABASE ${qDq(name)};`)
      }
    } else if (engine === 'mongo') {
      const name = assertMongoName(nameRaw, 'database name')
      if (SYSTEM_MONGO_DBS.has(name)) throw new Error('Refusing to drop a system database')
      await mongoEval(ssh, serverId, `print('__SM__' + JSON.stringify(db.getSiblingDB(${JSON.stringify(name)}).dropDatabase()));`)
    } else throw new Error('Not applicable for SQLite')
    ctx.audit(serverId, 'db.dropDatabase', `${engine} ${nameRaw}`)
  })

  // ---------------- users ----------------
  ctx.handle('db:users', async (serverId: string, engineRaw: unknown): Promise<DbUser[]> => listUsers(assertEngine(engineRaw), ctx.ssh(serverId), serverId))

  ctx.handle('db:createUser', async (serverId: string, engineRaw: unknown, input: DbCreateUserInput) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    if (!input?.password || input.password.length < 1) throw new Error('A password is required')
    const privs: DbPrivileges = input.privileges === 'all' || input.privileges === 'readonly' ? input.privileges : 'none'
    if (engine === 'mysql') {
      const account = myAccount(input.user, input.host ?? '%')
      const stmts = [`CREATE USER ${account} IDENTIFIED BY ${myStr(input.password)};`, ...mysqlGrantSql(privs, input.database, account).map((s) => s + ';'), 'FLUSH PRIVILEGES;']
      await myQuery(ssh, serverId, stmts.join('\n'))
    } else if (engine === 'postgres') {
      const u = assertIdent(input.user, 'user name')
      await pgQuery(ssh, serverId, `CREATE ROLE ${qDq(u)} LOGIN PASSWORD ${sqlStr(input.password)};`)
      if (input.database) await pgGrant(ssh, serverId, u, input.database, privs)
    } else if (engine === 'mongo') {
      const u = assertMongoName(input.user, 'user name')
      const roles = mongoRoles(privs, input.database || undefined)
      await mongoEval(ssh, serverId, `print('__SM__' + JSON.stringify(db.getSiblingDB('admin').createUser({ user: ${JSON.stringify(u)}, pwd: ${JSON.stringify(input.password)}, roles: ${JSON.stringify(roles)} })));`)
    } else throw new Error('Not applicable for SQLite')
    ctx.audit(serverId, 'db.createUser', `${engine} ${input.user}`)
  })

  ctx.handle('db:setPassword', async (serverId: string, engineRaw: unknown, user: string, host: string | undefined, password: string) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    if (!password) throw new Error('A password is required')
    if (engine === 'mysql') await myQuery(ssh, serverId, `ALTER USER ${myAccount(user, host ?? 'localhost')} IDENTIFIED BY ${myStr(password)};\nFLUSH PRIVILEGES;`)
    else if (engine === 'postgres') await pgQuery(ssh, serverId, `ALTER ROLE ${qDq(assertIdent(user, 'user name'))} PASSWORD ${sqlStr(password)};`)
    else if (engine === 'mongo') await mongoEval(ssh, serverId, `db.getSiblingDB(${JSON.stringify(assertMongoName(host || 'admin', 'auth database'))}).changeUserPassword(${JSON.stringify(assertMongoName(user, 'user name'))}, ${JSON.stringify(password)}); print('__SM__' + JSON.stringify({ ok: 1 }));`)
    else throw new Error('Not applicable for SQLite')
    // Keep the in-memory admin credential in sync when the operator changes their own password.
    const c = getCred(serverId, engine)
    if (c && c.user === user) c.password = password
    ctx.audit(serverId, 'db.setPassword', `${engine} ${user}`)
  })

  ctx.handle('db:dropUser', async (serverId: string, engineRaw: unknown, user: string, host?: string) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    if (engine === 'mysql') {
      if (user === 'root') throw new Error('Refusing to drop root')
      await myQuery(ssh, serverId, `DROP USER ${myAccount(user, host ?? 'localhost')};\nFLUSH PRIVILEGES;`)
    } else if (engine === 'postgres') {
      const u = assertIdent(user, 'user name')
      if (u === 'postgres') throw new Error('Refusing to drop the postgres superuser')
      await pgQuery(ssh, serverId, `DROP ROLE ${qDq(u)};`)
    } else if (engine === 'mongo') {
      await mongoEval(ssh, serverId, `print('__SM__' + JSON.stringify(db.getSiblingDB(${JSON.stringify(assertMongoName(host || 'admin', 'auth database'))}).dropUser(${JSON.stringify(assertMongoName(user, 'user name'))})));`)
    } else throw new Error('Not applicable for SQLite')
    ctx.audit(serverId, 'db.dropUser', `${engine} ${user}`)
  })

  ctx.handle('db:grant', async (serverId: string, engineRaw: unknown, input: DbGrantInput) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    const privs: DbPrivileges = input.privileges === 'all' || input.privileges === 'readonly' ? input.privileges : 'none'
    if (engine === 'mysql') {
      const account = myAccount(input.user, input.host ?? 'localhost')
      const target = `${qMy(assertIdent(input.database, 'database name'))}.*`
      const stmts = [`REVOKE ALL PRIVILEGES ON ${target} FROM ${account};`, ...mysqlGrantSql(privs, input.database, account).map((s) => s + ';'), 'FLUSH PRIVILEGES;']
      const r = await myExec(ssh, serverId, stmts.join('\n'))
      if (r.code !== 0) {
        // REVOKE fails when there was nothing granted; retry without it.
        await myQuery(ssh, serverId, [...mysqlGrantSql(privs, input.database, account).map((s) => s + ';'), 'FLUSH PRIVILEGES;'].join('\n'))
      }
    } else if (engine === 'postgres') {
      const u = qDq(assertIdent(input.user, 'user name'))
      const d = assertIdent(input.database, 'database name')
      await pgExec(ssh, serverId, `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${u};\nREVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${u};\nREVOKE ALL ON SCHEMA public FROM ${u};`, { db: d })
      await pgExec(ssh, serverId, `REVOKE ALL PRIVILEGES ON DATABASE ${qDq(d)} FROM ${u};`)
      await pgGrant(ssh, serverId, input.user, d, privs)
    } else if (engine === 'mongo') {
      const u = assertMongoName(input.user, 'user name')
      const d = assertMongoName(input.database, 'database name')
      const roles = mongoRoles(privs, d)
      await mongoEval(
        ssh,
        serverId,
        `var ad = db.getSiblingDB(${JSON.stringify(input.host || 'admin')}); var cur = ad.getUser(${JSON.stringify(u)}); var old = (cur && cur.roles ? cur.roles : []).filter(function (r) { return r.db === ${JSON.stringify(d)}; }); if (old.length) ad.revokeRolesFromUser(${JSON.stringify(u)}, old); if (${JSON.stringify(roles)}.length) ad.grantRolesToUser(${JSON.stringify(u)}, ${JSON.stringify(roles)}); print('__SM__' + JSON.stringify({ ok: 1 }));`
      )
    } else throw new Error('Not applicable for SQLite')
    ctx.audit(serverId, 'db.grant', `${engine} ${input.user} ${privs} on ${input.database}`)
  })

  // ---------------- backups ----------------
  ctx.handle('db:backups', async (serverId: string): Promise<DbBackup[]> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.sudo(`mkdir -p ${DB_BACKUPS_DIR} && chmod 700 ${DB_BACKUPS_DIR} && find ${DB_BACKUPS_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\t%T@\\n'`)
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not list backups')
    const out: DbBackup[] = []
    for (const line of splitLines(r.stdout)) {
      const [name, size, mtime] = line.split('\t')
      if (!name) continue
      const m = name.match(BACKUP_RE)
      out.push({
        file: `${DB_BACKUPS_DIR}/${name}`,
        name,
        engine: m ? (m[3] === 'pg' ? 'postgres' : (m[3] as DbEngine)) : undefined,
        database: m ? m[1] : undefined,
        sizeBytes: Number(size) || 0,
        mtime: Math.round((Number(mtime) || 0) * 1000)
      })
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  })

  ctx.handle('db:backup', async (serverId: string, engineRaw: unknown, dbRaw: string) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    const db = engine === 'mongo' ? assertMongoName(dbRaw, 'database name') : assertIdent(dbRaw, 'database name')
    const path = backupPath(engine, db)
    const { id } = ctx.tasks.start(`Backup ${db} (${engineLabel(engine)})`, serverId, async (h) => {
      await ssh.sudoRun(`mkdir -p ${DB_BACKUPS_DIR} && chmod 700 ${DB_BACKUPS_DIR}`)
      h.log(`Dumping ${db} to ${path} …`)
      let cmd: string
      let env: Record<string, string> | undefined
      if (engine === 'mysql') {
        const cred = getCred(serverId, 'mysql')
        env = cred ? { MYSQL_PWD: cred.password } : undefined
        cmd = pipefail(`${MYSQLDUMP_BIN}${cred ? ` -u ${shq(cred.user)}` : ''} --single-transaction --quick --routines --triggers --events ${shq(db)} | gzip -c > ${shq(path)}`)
      } else if (engine === 'postgres') {
        const cred = getCred(serverId, 'postgres')
        env = cred ? { PGPASSWORD: cred.password } : undefined
        const dump = cred ? `pg_dump -h 127.0.0.1 -U ${shq(cred.user)} ${shq(db)}` : asPostgres(`pg_dump ${shq(db)}`)
        cmd = pipefail(`${dump} | gzip -c > ${shq(path)}`)
      } else if (engine === 'mongo') {
        const cred = getCred(serverId, 'mongo')
        const auth = cred ? ` -u ${shq(cred.user)} -p ${shq(cred.password)} --authenticationDatabase admin` : ''
        cmd = `mongodump${auth} --db ${shq(db)} --archive=${shq(path)} --gzip`
      } else throw new Error('Not applicable for SQLite')
      const r = await ssh.exec(cmd, { sudo: true, env, timeoutMs: 0, ...taskIo(h) })
      if (r.code !== 0) {
        await ssh.sudo(`rm -f ${shq(path)}`)
        throw new Error(`Dump failed (exit ${r.code})`)
      }
      const sz = await ssh.sudo(`stat -c %s ${shq(path)}`)
      h.log(`Done: ${path} (${Math.round((Number(sz.stdout) || 0) / 1024)} KB). Download it from the Files module.`)
      ctx.audit(serverId, 'db.backup', `${engine} ${db} -> ${path}`)
    })
    return id
  })

  ctx.handle('db:restore', async (serverId: string, engineRaw: unknown, dbRaw: string, fileRaw: string) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    const file = assertBackupFile(fileRaw)
    const db = engine === 'mongo' ? assertMongoName(dbRaw, 'database name') : assertIdent(dbRaw, 'database name')
    const { id } = ctx.tasks.start(`Restore ${file.split('/').pop()} into ${db}`, serverId, async (h) => {
      h.log(`Restoring ${file} into ${db} …`)
      if (engine === 'mysql') {
        await myQuery(ssh, serverId, `CREATE DATABASE IF NOT EXISTS ${qMy(db)};`)
        const { cmd, env } = mysqlCmd(serverId, shq(db))
        const r = await ssh.exec(pipefail(`gunzip -c ${shq(file)} | ${cmd}`), { sudo: true, env, timeoutMs: 0, ...taskIo(h) })
        if (r.code !== 0) throw new Error(`Restore failed (exit ${r.code})`)
      } else if (engine === 'postgres') {
        const exists = await pgQuery(ssh, serverId, `SELECT 1 FROM pg_database WHERE datname = ${sqlStr(db)}`, { skipHeader: true })
        if (!exists.rows.length) {
          h.log(`Creating database ${db} …`)
          await pgQuery(ssh, serverId, `CREATE DATABASE ${qDq(db)};`)
        }
        const { cmd, env, sudo } = psqlCmd(serverId, `-d ${shq(db)}`, 'psql -X -q -v ON_ERROR_STOP=0')
        // Backups live in a root-only directory, so always read them as root.
        const r = await ssh.exec(pipefail(`gunzip -c ${shq(file)} | ${cmd}`), { sudo: true, env, timeoutMs: 0, ...taskIo(h) })
        if (r.code !== 0) throw new Error(`Restore failed (exit ${r.code})`)
      } else if (engine === 'mongo') {
        const m = file.split('/').pop()?.match(BACKUP_RE)
        const orig = m ? m[1] : undefined
        const cred = getCred(serverId, 'mongo')
        const auth = cred ? ` -u ${shq(cred.user)} -p ${shq(cred.password)} --authenticationDatabase admin` : ''
        const ns = orig ? ` --nsFrom ${shq(orig + '.*')} --nsTo ${shq(db + '.*')}` : ''
        if (!orig) h.log('Could not derive the original database name from the file name; restoring with original namespaces.')
        const r = await ssh.exec(`mongorestore${auth} --archive=${shq(file)} --gzip --drop${ns}`, { sudo: true, timeoutMs: 0, ...taskIo(h) })
        if (r.code !== 0) throw new Error(`Restore failed (exit ${r.code})`)
      } else throw new Error('Not applicable for SQLite')
      h.log('Restore finished.')
      ctx.audit(serverId, 'db.restore', `${engine} ${file} -> ${db}`)
    })
    return id
  })

  ctx.handle('db:deleteBackup', async (serverId: string, fileRaw: string) => {
    const file = assertBackupFile(fileRaw)
    await ctx.ssh(serverId).sudoRun(`rm -f ${shq(file)}`)
    ctx.audit(serverId, 'db.deleteBackup', file)
  })

  // ---------------- tables / rows / queries ----------------
  ctx.handle('db:tables', async (serverId: string, engineRaw: unknown, db: string): Promise<DbTable[]> => {
    const engine = assertEngine(engineRaw)
    if (engine === 'sqlite') assertAbsPath(db)
    else assertIdent(db, 'database name')
    return listTables(engine, ctx.ssh(serverId), serverId, db)
  })

  ctx.handle('db:rows', async (serverId: string, engineRaw: unknown, db: string, table: string, opts: DbRowsOptions): Promise<DbRowsResult> => {
    const engine = assertEngine(engineRaw)
    if (engine === 'sqlite') assertAbsPath(db)
    else assertIdent(db, 'database name')
    return browseRows(engine, ctx.ssh(serverId), serverId, db, table, opts ?? {})
  })

  ctx.handle('db:updateCell', async (serverId: string, engineRaw: unknown, db: string, table: string, pkValues: Record<string, string | null>, column: string, value: string | null) => {
    const engine = assertEngine(engineRaw)
    if (engine === 'sqlite') assertAbsPath(db)
    else assertIdent(db, 'database name')
    const ssh = ctx.ssh(serverId)
    const meta = await columnsAndPk(engine, ssh, serverId, db, assertLooseIdent(table, 'table name'))
    if (!meta.pk.length) throw new Error('This table has no primary key; rows are read-only')
    if (!meta.columns.includes(column)) throw new Error(`Unknown column: ${column}`)
    for (const k of Object.keys(pkValues ?? {})) if (!meta.pk.includes(k)) throw new Error(`Not a primary key column: ${k}`)
    const sql = `UPDATE ${qTable(engine, table)} SET ${qIdent(engine, column)} = ${lit(engine, value === null ? null : String(value))} WHERE ${pkWhere(engine, pkValues)};`
    const res = await runSql(engine, ssh, serverId, db, sql)
    ctx.audit(serverId, 'db.updateCell', `${engine} ${db}.${table}.${column}`)
    return res.affected
  })

  ctx.handle('db:deleteRow', async (serverId: string, engineRaw: unknown, db: string, table: string, pkValues: Record<string, string | null>) => {
    const engine = assertEngine(engineRaw)
    if (engine === 'sqlite') assertAbsPath(db)
    else assertIdent(db, 'database name')
    const ssh = ctx.ssh(serverId)
    const meta = await columnsAndPk(engine, ssh, serverId, db, assertLooseIdent(table, 'table name'))
    if (!meta.pk.length) throw new Error('This table has no primary key; rows are read-only')
    for (const k of Object.keys(pkValues ?? {})) if (!meta.pk.includes(k)) throw new Error(`Not a primary key column: ${k}`)
    const res = await runSql(engine, ssh, serverId, db, `DELETE FROM ${qTable(engine, table)} WHERE ${pkWhere(engine, pkValues)};`)
    ctx.audit(serverId, 'db.deleteRow', `${engine} ${db}.${table}`)
    return res.affected
  })

  ctx.handle('db:query', async (serverId: string, engineRaw: unknown, db: string | undefined, sql: string): Promise<DbQueryResult> => {
    const engine = assertEngine(engineRaw)
    if (engine === 'sqlite') assertAbsPath(db ?? '')
    else if (db) assertIdent(db, 'database name')
    const res = await runSql(engine, ctx.ssh(serverId), serverId, db || undefined, sql)
    ctx.audit(serverId, 'db.query', `${engine} ${db ?? ''}: ${sql.slice(0, 120)}`)
    return res
  })

  ctx.handle('db:exportCsv', async (serverId: string, engineRaw: unknown, db: string, input: DbExportInput): Promise<string> => {
    const engine = assertEngine(engineRaw)
    if (engine === 'sqlite') assertAbsPath(db)
    else assertIdent(db, 'database name')
    const sql = input?.table ? `SELECT * FROM ${qTable(engine, assertLooseIdent(input.table, 'table name'))};` : input?.sql
    if (!sql) throw new Error('Nothing to export')
    const max = DB_EXPORT_MAX_BYTES + 512 * 1024
    const res = await runSql(engine, ctx.ssh(serverId), serverId, db, sql, max)
    if (res.truncated) throw new Error('Result is larger than 5 MB; use Backup for big data sets')
    const csv = toCsv(res)
    if (csv.length > DB_EXPORT_MAX_BYTES) throw new Error('CSV is larger than 5 MB; use Backup for big data sets')
    return csv
  })

  ctx.handle('db:importSql', async (serverId: string, engineRaw: unknown, db: string, sqlText: string, isBase64?: boolean) => {
    const engine = assertEngine(engineRaw)
    if (engine === 'sqlite') assertAbsPath(db)
    else assertIdent(db, 'database name')
    const ssh = ctx.ssh(serverId)
    const text = isBase64 ? Buffer.from(String(sqlText), 'base64').toString('utf8') : String(sqlText ?? '')
    if (!text.trim()) throw new Error('The SQL file is empty')
    if (Buffer.byteLength(text, 'utf8') > DB_IMPORT_MAX_BYTES) throw new Error('SQL files larger than 20 MB are not supported here; upload the file with the Files module and restore it from the server instead')
    const { id } = ctx.tasks.start(`Import SQL into ${db}`, serverId, async (h) => {
      h.log(`Piping ${Math.round(Buffer.byteLength(text, 'utf8') / 1024)} KB of SQL into ${engineLabel(engine)} (${db}) …`)
      const r =
        engine === 'mysql'
          ? await myExec(ssh, serverId, text, { db, timeoutMs: 0, ...taskIo(h) })
          : engine === 'postgres'
            ? await pgExec(ssh, serverId, text, { db, timeoutMs: 0, ...taskIo(h) })
            : await sqliteExec(ssh, db, text, { timeoutMs: 0, signal: h.signal })
      if (r.code !== 0) throw new Error(`Import failed (exit ${r.code}): ${r.stderr.trim().split('\n').slice(-5).join('\n')}`)
      if (engine === 'sqlite' && r.stdout) h.append(r.stdout)
      h.log('Import finished.')
      ctx.audit(serverId, 'db.importSql', `${engine} ${db}`)
    })
    return id
  })

  // ---------------- MongoDB specific ----------------
  ctx.handle('db:mongo:collections', async (serverId: string, dbRaw: string): Promise<MongoCollection[]> => {
    const db = assertMongoName(dbRaw, 'database name')
    const res = await mongoEval<{ cols: { name: string; count: number; size: number; storageSize: number; nindexes: number }[] }>(
      ctx.ssh(serverId),
      serverId,
      `var d = db.getSiblingDB(${JSON.stringify(db)}); var infos = d.getCollectionInfos({}, { nameOnly: true }); var out = []; infos.forEach(function (c) { if (c.type && c.type !== 'collection') return; var s = {}; try { var a = d.getCollection(c.name).aggregate([{ $collStats: { storageStats: {} } }]).toArray(); s = (a[0] && a[0].storageStats) || {}; } catch (e) {} var cnt = s.count; if (cnt === undefined) { try { cnt = d.getCollection(c.name).estimatedDocumentCount(); } catch (e2) { cnt = -1; } } out.push({ name: c.name, count: cnt, size: s.size || 0, storageSize: s.storageSize || 0, nindexes: s.nindexes || 0 }); }); out.sort(function (a, b) { return a.name < b.name ? -1 : 1; }); print('__SM__' + JSON.stringify({ cols: out }));`
    )
    return (res.cols ?? []).map((c) => ({ name: c.name, count: c.count, sizeBytes: c.size, storageBytes: c.storageSize, indexes: c.nindexes }))
  })

  ctx.handle('db:mongo:documents', async (serverId: string, dbRaw: string, collRaw: string, opts: MongoDocsOptions): Promise<MongoDocsResult> => {
    const db = assertMongoName(dbRaw, 'database name')
    const coll = assertMongoColl(collRaw)
    const limit = clampInt(opts?.limit, 50, 1, 500)
    const offset = clampInt(opts?.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const filter = typeof opts?.filter === 'string' ? opts.filter : ''
    const sort = typeof opts?.sort === 'string' ? opts.sort : ''
    return mongoEval<MongoDocsResult>(
      ctx.ssh(serverId),
      serverId,
      `var c = db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)}); var f = PARSE(${JSON.stringify(filter)}); var s = PARSE(${JSON.stringify(sort)}); var total = c.countDocuments(f); var cur = c.find(f); if (Object.keys(s).length) cur = cur.sort(s); var docs = cur.skip(${offset}).limit(${limit}).toArray(); print('__SM__' + JSON.stringify({ total: total, docs: docs.map(function (x) { return EJ(x, 2); }), ids: docs.map(function (x) { return EJ(x._id); }) }));`,
      { maxBuffer: 16 * 1024 * 1024 }
    )
  })

  ctx.handle('db:mongo:deleteDocument', async (serverId: string, dbRaw: string, collRaw: string, idEjson: string) => {
    const db = assertMongoName(dbRaw, 'database name')
    const coll = assertMongoColl(collRaw)
    const res = await mongoEval<{ deletedCount: number }>(
      ctx.ssh(serverId),
      serverId,
      `var c = db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)}); var r = c.deleteOne({ _id: PARSE(${JSON.stringify(String(idEjson))}) }); print('__SM__' + JSON.stringify({ deletedCount: r.deletedCount }));`
    )
    ctx.audit(serverId, 'db.mongo.deleteDocument', `${db}.${coll}`)
    return res.deletedCount
  })

  ctx.handle('db:mongo:dropCollection', async (serverId: string, dbRaw: string, collRaw: string) => {
    const db = assertMongoName(dbRaw, 'database name')
    const coll = assertMongoColl(collRaw)
    await mongoEval(ctx.ssh(serverId), serverId, `print('__SM__' + JSON.stringify({ ok: db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)}).drop() }));`)
    ctx.audit(serverId, 'db.mongo.dropCollection', `${db}.${coll}`)
  })

  ctx.handle('db:mongo:createCollection', async (serverId: string, dbRaw: string, collRaw: string) => {
    const db = assertMongoName(dbRaw, 'database name')
    const coll = assertMongoColl(collRaw)
    await mongoEval(ctx.ssh(serverId), serverId, `print('__SM__' + JSON.stringify(db.getSiblingDB(${JSON.stringify(db)}).createCollection(${JSON.stringify(coll)})));`)
    ctx.audit(serverId, 'db.mongo.createCollection', `${db}.${coll}`)
  })

  ctx.handle('db:mongo:eval', async (serverId: string, dbRaw: string | undefined, js: string): Promise<{ output: string; ms: number }> => {
    const db = dbRaw ? assertMongoName(dbRaw, 'database name') : 'test'
    if (typeof js !== 'string' || !js.trim()) throw new Error('Empty script')
    const t0 = Date.now()
    const res = await mongoEval<{ out: string }>(
      ctx.ssh(serverId),
      serverId,
      `db = db.getSiblingDB(${JSON.stringify(db)}); var __r; try { __r = eval(${JSON.stringify(js)}); } catch (e) { print('__SM__' + JSON.stringify({ out: 'Error: ' + (e && e.message ? e.message : String(e)) })); return; } if (__r && typeof __r.toArray === 'function') __r = __r.toArray(); var __o = __r === undefined ? 'undefined' : EJ(__r, 2); print('__SM__' + JSON.stringify({ out: typeof __o === 'string' ? __o : String(__o) }));`,
      { maxBuffer: 16 * 1024 * 1024, timeoutMs: 300000 }
    )
    ctx.audit(serverId, 'db.mongo.eval', `${db}: ${js.slice(0, 120)}`)
    return { output: res.out, ms: Date.now() - t0 }
  })

  // ---------------- SQLite specific ----------------
  ctx.handle('db:sqlite:open', async (serverId: string, pathRaw: string): Promise<SqliteOpenResult> => {
    const path = assertAbsPath(pathRaw)
    const ssh = ctx.ssh(serverId)
    const st = await ssh.sudo(`test -f ${shq(path)} && stat -c %s ${shq(path)} && head -c 15 ${shq(path)}`)
    if (st.code !== 0) throw new Error(`File not found: ${path}`)
    const [size, magic] = splitLines(st.stdout)
    if (Number(size) > 0 && !(magic ?? '').startsWith('SQLite format')) throw new Error('This file does not look like an SQLite database')
    const tables = await listTables('sqlite', ssh, serverId, path)
    return { path, sizeBytes: Number(size) || 0, tables }
  })
  ctx.handle('db:sqlite:tables', async (serverId: string, path: string): Promise<DbTable[]> => listTables('sqlite', ctx.ssh(serverId), serverId, assertAbsPath(path)))
  ctx.handle('db:sqlite:rows', async (serverId: string, path: string, table: string, opts: DbRowsOptions): Promise<DbRowsResult> => browseRows('sqlite', ctx.ssh(serverId), serverId, assertAbsPath(path), table, opts ?? {}))
  ctx.handle('db:sqlite:query', async (serverId: string, path: string, sql: string): Promise<DbQueryResult> => runSql('sqlite', ctx.ssh(serverId), serverId, assertAbsPath(path), sql))
}
