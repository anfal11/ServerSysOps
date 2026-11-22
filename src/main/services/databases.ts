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
  MssqlInstallInput,
  MssqlSettings,
  RedisClient,
  RedisConfigPatch,
  RedisInfo,
  RedisKey,
  RedisKeyValue,
  RedisScanResult,
  RedisSlowlogEntry,
  SqliteOpenResult
} from '@shared/modules/databases'
import { DB_BACKUPS_DIR, DB_EXPORT_MAX_BYTES, DB_IMPORT_MAX_BYTES, DB_ROWS_MAX_LIMIT, MSSQL_BACKUP_DIR, REDIS_KEY_ITEMS_MAX, REDIS_KEY_PAGE_MAX, REDIS_MAXMEMORY_POLICIES, isStrongSqlPassword } from '@shared/modules/databases'
import { assertAbsPath, assertPort, b64Echo, shq } from '../ssh/shell'
import { installCmd, pkgEnv, removeCmd, runPkg } from './pkg'

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

export interface Cred {
  user: string
  password: string
}

/** In-memory admin credentials per server+engine (never persisted). */
const creds = new Map<string, Partial<Record<DbEngine, Cred>>>()

export function getCred(serverId: string, engine: DbEngine): Cred | undefined {
  return creds.get(serverId)?.[engine]
}

const AUTH_RE = /access denied|password authentication failed|authentication failed|requires authentication|peer authentication failed|ERROR 1045|Unauthorized|not authorized|Login failed for user|credentials required|NOAUTH|WRONGPASS|AUTH failed|NOPERM|called without any password configured/i
const DOWN_RE = /can't connect to local|could not connect to server|connection refused|No such file or directory|ECONNREFUSED|is the server running|MongoNetworkError|Connection reset|TCP Provider|Could not open a connection|Unable to connect|Login timeout expired|Could not connect to Redis/i

/** mssql: TCP port learned from mssql.conf (default 1433), per server. */
const mssqlPorts = new Map<string, number>()

/** redis: how redis-cli reaches the server (learned from redis.conf), per server. */
const redisConns = new Map<string, { host: string; port: number; socket?: string }>()

function throwExec(engine: DbEngine, r: ExecResult, fallback: string): never {
  const msg = (r.stderr || r.stdout || fallback).trim()
  const short = msg.split('\n').filter(Boolean).slice(-6).join('\n') || fallback
  if (AUTH_RE.test(msg)) throw new DbError('DB_AUTH', `${engineLabel(engine)} refused the admin connection: ${short}`)
  if (DOWN_RE.test(msg)) throw new DbError('DB_DOWN', `${engineLabel(engine)} does not seem to be running: ${short}`)
  throw new DbError('DB_ERROR', short)
}

function engineLabel(e: DbEngine): string {
  return e === 'mysql' ? 'MySQL/MariaDB' : e === 'postgres' ? 'PostgreSQL' : e === 'mongo' ? 'MongoDB' : e === 'mssql' ? 'SQL Server' : e === 'redis' ? 'Redis' : 'SQLite'
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
  if (e === 'mysql' || e === 'postgres' || e === 'mongo' || e === 'mssql' || e === 'redis' || e === 'sqlite') return e
  throw new Error(`Unknown database engine: ${String(e)}`)
}
const SYSTEM_MSSQL_DBS = new Set(['master', 'model', 'msdb', 'tempdb'])

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
/** Bracket quote (SQL Server). */
function qBr(name: string): string {
  return '[' + assertLooseIdent(name).replace(/]/g, ']]') + ']'
}
/** Quote a possibly schema-qualified SQL Server table name ("schema.table" or "table" => dbo). */
function qMsTable(table: string): string {
  const [schema, name] = splitSchema(table, 'dbo')
  return qBr(schema) + '.' + qBr(name)
}
function splitSchema(table: string, def: string): [string, string] {
  const idx = table.indexOf('.')
  if (idx > 0) return [table.slice(0, idx), table.slice(idx + 1)]
  return [def, table]
}
function qIdent(engine: DbEngine, name: string): string {
  return engine === 'mysql' ? qMy(name) : engine === 'mssql' ? qBr(name) : qDq(name)
}
function qTable(engine: DbEngine, table: string): string {
  if (engine === 'postgres') return qPgTable(table)
  if (engine === 'mssql') return qMsTable(table)
  return qIdent(engine, table)
}
/** SQL Server unicode string literal. */
function nStr(v: string): string {
  return 'N' + sqlStr(v)
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
  return engine === 'mysql' ? myStr(v) : engine === 'mssql' ? nStr(v) : sqlStr(v)
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

export interface Grid {
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

export interface DriverOpts {
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

export async function myQuery(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<Grid> {
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

export async function pgQuery(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<Grid> {
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

export async function mongoEval<T>(ssh: SshClient, serverId: string, js: string, o: DriverOpts = {}): Promise<T> {
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

// ---- SQL Server (sqlcmd) ----

/**
 * sqlcmd always needs a SQL login; the password travels in SQLCMDPASSWORD (exported by the exec
 * wrapper, never on the command line). Output: header line, dashed line, rows, blank line,
 * optional "(N rows affected)" footer; fields separated by \x1f (-s) and trimmed (-W).
 */
function mssqlCmd(serverId: string, extra: string): { cmd: string; env: Record<string, string> } {
  const cred = getCred(serverId, 'mssql')
  if (!cred) throw new DbError('DB_AUTH', 'SQL Server login credentials required (default login: sa). Set them with "Admin credentials".')
  const port = mssqlPorts.get(serverId) ?? 1433
  const inner = `B=$( { command -v sqlcmd || ls /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; } 2>/dev/null | head -1); exec "\${B:-sqlcmd}" -S ${shq(`localhost,${port}`)} -U ${shq(cred.user)} -C -b -r 1 -W -w 65535 -s "$(printf '\\037')" ${extra}`
  return { cmd: `sh -c ${shq(inner)}`, env: { SQLCMDPASSWORD: cred.password } }
}

async function mssqlExec(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<ExecResult> {
  const { cmd, env } = mssqlCmd(serverId, o.db ? `-d ${shq(assertIdent(o.db, 'database name'))}` : '')
  const text = /\n\s*GO\s*$/i.test(sql) ? sql + '\n' : sql + '\nGO\n'
  return ssh.exec(cmd, { stdin: text, env, timeoutMs: o.timeoutMs ?? 60000, maxBuffer: o.maxBuffer, onStdout: o.onStdout, onStderr: o.onStderr, signal: o.signal })
}

const MSSQL_FOOTER_RE = /^\((\d+) rows? affected\)$/

function parseSqlcmd(out: string): { grids: Grid[]; affected?: number; messages: string[] } {
  const lines = splitLines(out)
  const grids: Grid[] = []
  const messages: string[] = []
  let affected: number | undefined
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const m = line.match(MSSQL_FOOTER_RE)
    if (m) {
      affected = (affected ?? 0) + Number(m[1])
      i++
      continue
    }
    const next = lines[i + 1]
    if (next !== undefined && next.includes('-') && /^[-\x1f]+$/.test(next)) {
      const columns = line.split(US).map((c) => c.trim())
      i += 2
      const rows: (string | null)[][] = []
      while (i < lines.length && lines[i] !== '' && !MSSQL_FOOTER_RE.test(lines[i])) {
        rows.push(lines[i].split(US).map((c) => (c === 'NULL' ? null : c)))
        i++
      }
      grids.push({ columns, rows })
      continue
    }
    messages.push(line)
    i++
  }
  return { grids, affected, messages }
}

async function mssqlQuery(ssh: SshClient, serverId: string, sql: string, o: DriverOpts = {}): Promise<Grid> {
  const r = await mssqlExec(ssh, serverId, 'SET NOCOUNT ON;\n' + sql, o)
  if (r.code !== 0) throwExec('mssql', r, 'sqlcmd failed')
  const p = parseSqlcmd(r.stdout)
  return p.grids[0] ?? { columns: [], rows: [] }
}

// ---- Redis (redis-cli) ----

/** systemd unit names in detection order: Debian/Ubuntu, RHEL/Fedora/Arch, openSUSE instance template. */
const REDIS_UNITS = ['redis-server', 'redis', 'redis@default']
const REDIS_CONF_FILES = ['/etc/redis/redis.conf', '/etc/redis.conf', '/etc/redis/default.conf']
/** Error replies redis-cli prints in raw mode (the reply text without "(error)"). */
const REDIS_ERR_RE = /^(ERR|NOAUTH|WRONGPASS|WRONGTYPE|NOPERM|MISCONF|READONLY|LOADING|BUSY|NOSCRIPT|OOM|EXECABORT|NOGROUP|CROSSSLOT|TRYAGAIN|CLUSTERDOWN|MOVED|ASK|MASTERDOWN|NOREPLICAS|UNBLOCKED|UNKILLABLE)\b/

export interface RedisOpts extends Omit<DriverOpts, 'db'> {
  /** Database index 0-15 (SELECT). */
  db?: number
  /** Human-readable (interactive style) output instead of --raw. */
  noRaw?: boolean
}

function assertRedisDb(v: unknown): number {
  const n = Number(v ?? 0)
  if (!Number.isInteger(n) || n < 0 || n > 15) throw new Error('Database index must be between 0 and 15')
  return n
}

function assertRedisKey(k: unknown): string {
  if (typeof k !== 'string' || k.length === 0 || k.length > 65536 || k.includes('\0')) throw new Error('Invalid key')
  return k
}

/**
 * Build the redis-cli invocation. The password travels in REDISCLI_AUTH (exported by the exec
 * wrapper, never on the command line); ACL user names other than "default" go through --user.
 */
function redisCmd(serverId: string, args: string[], o: RedisOpts = {}): { cmd: string; env?: Record<string, string>; sudo: boolean } {
  const cred = getCred(serverId, 'redis')
  const conn = redisConns.get(serverId) ?? { host: '127.0.0.1', port: 6379 }
  const parts = ['redis-cli', o.noRaw ? '--no-raw' : '--raw']
  if (conn.socket) parts.push('-s', conn.socket)
  else parts.push('-h', conn.host, '-p', String(conn.port))
  if (o.db) parts.push('-n', String(o.db))
  if (cred && cred.user && cred.user !== 'default') parts.push('--user', cred.user)
  for (const a of args) parts.push(a)
  // A unix socket is usually owned by the redis user, so talk to it as root.
  return { cmd: parts.map(shq).join(' '), env: cred ? { REDISCLI_AUTH: cred.password } : undefined, sudo: !!conn.socket }
}

async function redisExec(ssh: SshClient, serverId: string, args: string[], o: RedisOpts = {}): Promise<ExecResult> {
  const { cmd, env, sudo } = redisCmd(serverId, args, o)
  return ssh.exec(cmd, { sudo, env, timeoutMs: o.timeoutMs ?? 30000, maxBuffer: o.maxBuffer, signal: o.signal })
}

/** Run one command in --raw mode and return stdout (without the trailing newline); throws on errors. */
export async function redisRun(ssh: SshClient, serverId: string, args: string[], o: RedisOpts = {}): Promise<string> {
  const r = await redisExec(ssh, serverId, args, o)
  const out = r.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const firstLine = out.split('\n')[0] ?? ''
  if (r.code !== 0 || REDIS_ERR_RE.test(firstLine) || /AUTH failed|Could not connect/i.test(r.stderr)) {
    throwExec('redis', { code: r.code || 1, stdout: REDIS_ERR_RE.test(firstLine) ? firstLine : '', stderr: r.stderr.replace(/^Warning:.*\n?/gm, '').trim() || firstLine }, 'redis-cli failed')
  }
  return out
}

/** Run a Lua script that returns cjson-encoded data (one round trip, no reply-format parsing). */
async function redisEval<T>(ssh: SshClient, serverId: string, lua: string, keys: string[], argv: string[], o: RedisOpts = {}): Promise<T> {
  const out = await redisRun(ssh, serverId, ['EVAL', lua, String(keys.length), ...keys, ...argv], o)
  try {
    return JSON.parse(out) as T
  } catch {
    throw new DbError('DB_ERROR', out.split('\n').slice(0, 6).join('\n') || 'No result from redis-cli')
  }
}

/** cjson encodes an empty Lua table as {}; normalise to an array. */
function luaArr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** Parse `INFO` output (section headers "# Name", "key:value" lines). */
function parseRedisInfo(text: string): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const raw of splitLines(text)) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    const i = l.indexOf(':')
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1)
  }
  return kv
}

/** Active (non-comment) directives of a redis.conf: name → value (last occurrence wins, like redis). */
function parseRedisConf(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of lines) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    const m = l.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(.*)$/)
    if (!m) continue
    const name = m[1].toLowerCase()
    const val = m[2].trim().replace(/^"(.*)"$/, '$1')
    // `save` may repeat (one line per rule); keep them all.
    out[name] = name === 'save' && out[name] !== undefined ? `${out[name]} ${val}`.trim() : val
  }
  return out
}

/** Decide how redis-cli should connect given the bind / port / unixsocket directives. */
function redisConnFrom(conf: Record<string, string>): { host: string; port: number; socket?: string } {
  const port = num(conf.port) ?? 6379
  if (port === 0 && conf.unixsocket) return { host: '127.0.0.1', port: 0, socket: conf.unixsocket }
  const binds = (conf.bind ?? '127.0.0.1 -::1')
    .split(/\s+/)
    .filter(Boolean)
    .map((b) => b.replace(/^-/, ''))
  const loop4 = binds.some((b) => b === '127.0.0.1' || b === '0.0.0.0' || b === '*' || b === 'localhost')
  const loop6 = binds.some((b) => b === '::1' || b === '::' || b === '::*')
  const host = loop4 ? '127.0.0.1' : loop6 ? '::1' : binds[0] || '127.0.0.1'
  return { host, port }
}

function redisInfoFrom(conf: Record<string, string>, configFile: string | undefined): RedisInfo {
  const conn = redisConnFrom(conf)
  return {
    configFile,
    bind: conf.bind ?? '127.0.0.1 -::1',
    port: conn.port,
    unixSocket: conf.unixsocket || undefined,
    passwordSet: !!conf.requirepass,
    protectedMode: !/^no$/i.test(conf['protected-mode'] ?? 'yes'),
    maxmemoryConfig: conf.maxmemory || '0',
    maxmemoryPolicy: conf['maxmemory-policy'] || 'noeviction',
    appendonly: /^yes$/i.test(conf.appendonly ?? 'no'),
    save: conf.save,
    dir: conf.dir,
    dbfilename: conf.dbfilename
  }
}

function applyRedisInfo(info: RedisInfo, kv: Record<string, string>): void {
  info.usedMemory = num(kv.used_memory)
  info.usedMemoryPeak = num(kv.used_memory_peak)
  info.usedMemoryRss = num(kv.used_memory_rss)
  info.maxmemory = num(kv.maxmemory)
  if (kv.maxmemory_policy) info.maxmemoryPolicy = kv.maxmemory_policy
  info.connectedClients = num(kv.connected_clients)
  info.blockedClients = num(kv.blocked_clients)
  info.uptimeSec = num(kv.uptime_in_seconds)
  info.aofEnabled = kv.aof_enabled === '1'
  info.rdbLastSaveTime = num(kv.rdb_last_save_time)
  info.rdbChangesSinceSave = num(kv.rdb_changes_since_last_save)
  info.rdbBgsaveInProgress = kv.rdb_bgsave_in_progress === '1'
  info.rdbLastBgsaveStatus = kv.rdb_last_bgsave_status
  info.aofRewriteInProgress = kv.aof_rewrite_in_progress === '1'
  info.role = kv.role
  info.opsPerSec = num(kv.instantaneous_ops_per_sec)
  info.totalCommands = num(kv.total_commands_processed)
  info.keyspaceHits = num(kv.keyspace_hits)
  info.keyspaceMisses = num(kv.keyspace_misses)
  info.evictedKeys = num(kv.evicted_keys)
  info.expiredKeys = num(kv.expired_keys)
  info.totalConnections = num(kv.total_connections_received)
  info.rejectedConnections = num(kv.rejected_connections)
  info.redisMode = kv.redis_mode
  info.executable = kv.executable
  if (kv.tcp_port && num(kv.tcp_port)) info.port = num(kv.tcp_port) ?? info.port
  const ks: RedisInfo['keyspace'] = []
  for (const [k, v] of Object.entries(kv)) {
    const m = k.match(/^db(\d+)$/)
    if (!m) continue
    const f: Record<string, string> = {}
    for (const part of v.split(',')) {
      const [a, b] = part.split('=')
      if (a) f[a] = b ?? ''
    }
    ks.push({ db: Number(m[1]), keys: num(f.keys) ?? 0, expires: num(f.expires) ?? 0, avgTtlMs: num(f.avg_ttl) })
  }
  ks.sort((a, b) => a.db - b.db)
  info.keyspace = ks
  info.totalKeys = ks.reduce((s, d) => s + d.keys, 0)
}

/** Split a command line the way redis-cli does: whitespace separated, "double" (with \n \t \xHH \\ \") and 'single' quotes. */
function splitRedisArgs(line: string): string[] {
  const out: string[] = []
  let i = 0
  const s = line
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    let cur = ''
    let any = false
    while (i < s.length && !/\s/.test(s[i])) {
      any = true
      const c = s[i]
      if (c === '"') {
        i++
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) {
            const n = s[i + 1]
            if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
              cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16))
              i += 4
              continue
            }
            cur += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === 'b' ? '\b' : n === 'a' ? '\x07' : n
            i += 2
            continue
          }
          cur += s[i++]
        }
        if (i >= s.length) throw new Error('Unbalanced double quotes in command')
        i++
      } else if (c === "'") {
        i++
        while (i < s.length && s[i] !== "'") {
          if (s[i] === '\\' && s[i + 1] === "'") {
            cur += "'"
            i += 2
            continue
          }
          cur += s[i++]
        }
        if (i >= s.length) throw new Error('Unbalanced single quotes in command')
        i++
      } else {
        cur += c
        i++
      }
    }
    if (any) out.push(cur)
  }
  return out
}

/** Lua: SCAN one page and collect type / TTL / MEMORY USAGE for every key in a single round trip. */
const REDIS_SCAN_LUA = `local r = redis.call('SCAN', ARGV[1], 'MATCH', ARGV[2], 'COUNT', ARGV[3])
local out = { cursor = r[1], dbsize = redis.call('DBSIZE'), keys = {} }
for i, k in ipairs(r[2]) do
  local t = redis.call('TYPE', k)
  if type(t) == 'table' then t = t['ok'] end
  local ok, m = pcall(redis.call, 'MEMORY', 'USAGE', k)
  if not ok or type(m) ~= 'number' then m = -1 end
  out.keys[#out.keys + 1] = { k, t, redis.call('TTL', k), m }
end
return cjson.encode(out)`

/** Lua: describe one key and fetch (the first N elements of) its value. */
const REDIS_GET_LUA = `local k = KEYS[1]
local n = tonumber(ARGV[1])
local t = redis.call('TYPE', k)
if type(t) == 'table' then t = t['ok'] end
local out = { type = t, ttl = redis.call('TTL', k) }
if t == 'none' then return cjson.encode(out) end
local ok, m = pcall(redis.call, 'MEMORY', 'USAGE', k)
if ok and type(m) == 'number' then out.size = m end
if t == 'string' then
  out.len = redis.call('STRLEN', k)
  if out.len > 65536 then out.value = redis.call('GETRANGE', k, 0, 65535); out.truncated = true else out.value = redis.call('GET', k) end
elseif t == 'hash' then
  out.len = redis.call('HLEN', k)
  if out.len <= n then out.items = redis.call('HGETALL', k) else out.items = redis.call('HSCAN', k, '0', 'COUNT', n)[2]; out.truncated = true end
elseif t == 'list' then
  out.len = redis.call('LLEN', k)
  out.items = redis.call('LRANGE', k, 0, n - 1)
  out.truncated = out.len > n
elseif t == 'set' then
  out.len = redis.call('SCARD', k)
  if out.len <= n then out.items = redis.call('SMEMBERS', k) else out.items = redis.call('SSCAN', k, '0', 'COUNT', n)[2]; out.truncated = true end
elseif t == 'zset' then
  out.len = redis.call('ZCARD', k)
  out.items = redis.call('ZRANGE', k, 0, n - 1, 'WITHSCORES')
  out.truncated = out.len > n
elseif t == 'stream' then
  out.len = redis.call('XLEN', k)
  local items = {}
  for _, e in ipairs(redis.call('XRANGE', k, '-', '+', 'COUNT', n)) do
    items[#items + 1] = e[1]
    items[#items + 1] = table.concat(e[2], ' ')
  end
  out.items = items
  out.truncated = out.len > n
end
return cjson.encode(out)`

const REDIS_SLOWLOG_LUA = `return cjson.encode({ entries = redis.call('SLOWLOG', 'GET', tonumber(ARGV[1])) })`

/** Dispatch a plain query (header + rows) to the right engine. `db` is the file path for sqlite. */
async function query(engine: DbEngine, ssh: SshClient, serverId: string, db: string | undefined, sql: string, o: DriverOpts = {}): Promise<Grid> {
  switch (engine) {
    case 'mysql':
      return myQuery(ssh, serverId, sql, { ...o, db })
    case 'postgres':
      return pgQuery(ssh, serverId, sql, { ...o, db })
    case 'mssql':
      return mssqlQuery(ssh, serverId, sql, { ...o, db })
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
  const candidates = engine === 'mysql' ? ['mariadb', 'mysql', 'mysqld'] : engine === 'postgres' ? ['postgresql'] : engine === 'mongo' ? ['mongod', 'mongodb'] : engine === 'mssql' ? ['mssql-server'] : engine === 'redis' ? REDIS_UNITS : []
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
const MSSQL_BACKUP_RE = /^(.+)-(\d{8}-\d{6})\.bak$/

function backupPath(engine: DbEngine, db: string): string {
  if (engine === 'mssql') return `${MSSQL_BACKUP_DIR}/${db}-${ts()}.bak`
  const tag = engine === 'mysql' ? 'mysql' : engine === 'postgres' ? 'pg' : 'mongo'
  const ext = engine === 'mongo' ? 'archive.gz' : 'sql.gz'
  return `${DB_BACKUPS_DIR}/${db}-${ts()}.${tag}.${ext}`
}

function assertBackupFile(file: unknown): string {
  if (typeof file === 'string' && !file.includes('..') && !file.includes('\0')) {
    for (const dir of [DB_BACKUPS_DIR, MSSQL_BACKUP_DIR]) {
      if (file.startsWith(dir + '/') && !file.slice(dir.length + 1).includes('/') && file.length > dir.length + 1) return file
    }
  }
  throw new Error(`Backup file must be inside ${DB_BACKUPS_DIR} or ${MSSQL_BACKUP_DIR}`)
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
echo __MSSQL; [ -x /opt/mssql/bin/sqlservr ] && echo yes
echo __MSSQLVER; /opt/mssql/bin/sqlservr --version 2>/dev/null | head -1
echo __MSSQLCMD; { command -v sqlcmd || ls /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; } 2>/dev/null | head -1
echo __MSSQLUNIT; systemctl cat mssql-server.service >/dev/null 2>&1 && echo mssql-server
echo __MSSQLACTIVE; systemctl is-active mssql-server 2>/dev/null
echo __MSSQLENABLED; systemctl is-enabled mssql-server 2>/dev/null
echo __MSSQLCONF; cat /var/opt/mssql/mssql.conf 2>/dev/null
echo __MSSQLSIZE; du -sb /var/opt/mssql/data 2>/dev/null | awk '{print $1}'
echo __REDISD; command -v redis-server >/dev/null 2>&1 && { echo yes; redis-server --version 2>/dev/null | head -1; }
echo __REDISCLI; command -v redis-cli >/dev/null 2>&1 && echo yes
RU=$(for u in ${REDIS_UNITS.join(' ')}; do if systemctl cat "$u.service" >/dev/null 2>&1; then echo "$u"; break; fi; done)
echo __REDISUNIT; echo "$RU"
echo __REDISACTIVE; [ -n "$RU" ] && systemctl is-active "$RU" 2>/dev/null
echo __REDISENABLED; [ -n "$RU" ] && systemctl is-enabled "$RU" 2>/dev/null
echo __REDISCONF; for f in ${REDIS_CONF_FILES.join(' ')}; do if [ -f "$f" ]; then echo "$f"; grep -E '^[[:space:]]*(bind|port|requirepass|unixsocket|dir|dbfilename|maxmemory|maxmemory-policy|appendonly|protected-mode|save)([[:space:]]|$)' "$f" 2>/dev/null; break; fi; done
echo __REDISSIZE; D=$(for f in ${REDIS_CONF_FILES.join(' ')}; do [ -f "$f" ] && grep -E '^[[:space:]]*dir[[:space:]]' "$f" | tail -1 | awk '{print $2}' && break; done); du -sb "\${D:-/var/lib/redis}" 2>/dev/null | awk '{print $1}'
echo __MEM; awk '/^MemTotal:/{print $2 * 1024}' /proc/meminfo 2>/dev/null
echo __SQLITE; sqlite3 --version 2>/dev/null | head -1
echo __BACKUPS; (ls -1 ${DB_BACKUPS_DIR} 2>/dev/null; ls -1 ${MSSQL_BACKUP_DIR}/*.bak 2>/dev/null) | wc -l
echo __END`

/** Parse the tiny INI format of /var/opt/mssql/mssql.conf. */
function parseMssqlConf(lines: string[]): MssqlSettings {
  let section = ''
  const kv: Record<string, string> = {}
  for (const raw of lines) {
    const l = raw.trim()
    const s = l.match(/^\[(.+)]$/)
    if (s) {
      section = s[1].toLowerCase()
      continue
    }
    const m = l.match(/^([A-Za-z0-9_.]+)\s*=\s*(.*)$/)
    if (m) kv[`${section}.${m[1].toLowerCase()}`] = m[2].trim()
  }
  return {
    port: num(kv['network.tcpport']) ?? 1433,
    memoryLimitMb: num(kv['memory.memorylimitmb']),
    agentEnabled: /^true$/i.test(kv['sqlagent.enabled'] ?? '')
  }
}

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

  // ---- SQL Server ----
  const msUnit = first(sec, 'MSSQLUNIT')
  const msConf = parseMssqlConf(sec.MSSQLCONF ?? [])
  mssqlPorts.set(serverId, msConf.port)
  const mssql: DbEngineStatus = {
    engine: 'mssql',
    installed: first(sec, 'MSSQL') === 'yes' || !!msUnit,
    version: first(sec, 'MSSQLVER').replace(/^Microsoft SQL Server\s*/i, '').trim() || undefined,
    unit: msUnit || undefined,
    running: first(sec, 'MSSQLACTIVE') === 'active',
    enabled: first(sec, 'MSSQLENABLED') === 'enabled',
    clientAvailable: !!first(sec, 'MSSQLCMD'),
    dumpToolAvailable: !!first(sec, 'MSSQLCMD'),
    usingCredentials: !!getCred(serverId, 'mssql'),
    dataDir: '/var/opt/mssql/data',
    port: msConf.port,
    bindAddress: '0.0.0.0',
    sizeBytes: num(first(sec, 'MSSQLSIZE')),
    mssql: msConf
  }
  if (mssql.installed && mssql.running && mssql.clientAvailable) {
    if (!getCred(serverId, 'mssql')) {
      mssql.authOk = false
      mssql.authError = 'SQL Server needs a SQL login (sa by default). Enter the password under "Admin credentials".'
    } else {
      try {
        const g = await mssqlQuery(
          ssh,
          serverId,
          "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)), CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(32)), CAST(SERVERPROPERTY('Collation') AS nvarchar(128)), (SELECT COUNT(*) FROM sys.databases WHERE database_id > 4), CAST(SERVERPROPERTY('ProductMajorVersion') AS nvarchar(8))",
          { timeoutMs: 20000 }
        )
        const row = g.rows[0] ?? []
        mssql.authOk = true
        mssql.version = row[0] ?? mssql.version
        mssql.edition = row[1] ?? undefined
        mssql.details = { productLevel: row[2] ?? '', collation: row[3] ?? '', userDatabases: row[4] ?? '', agent: msConf.agentEnabled ? 'enabled' : 'disabled', memoryLimit: msConf.memoryLimitMb ? `${msConf.memoryLimitMb} MB` : 'default (80 % of RAM)' }
      } catch (e) {
        mssql.authOk = false
        mssql.authError = e instanceof Error ? e.message : String(e)
      }
    }
  }

  // ---- Redis ----
  const redisUnit = first(sec, 'REDISUNIT')
  const redisdLines = (sec.REDISD ?? []).map((l) => l.trim()).filter(Boolean)
  const confLines = (sec.REDISCONF ?? []).filter((l) => l.trim())
  const redisConfFile = confLines[0]?.trim().startsWith('/') ? confLines[0].trim() : undefined
  const rconf = parseRedisConf(redisConfFile ? confLines.slice(1) : [])
  const rinfo = redisInfoFrom(rconf, redisConfFile)
  redisConns.set(serverId, redisConnFrom(rconf))
  const redis: DbEngineStatus = {
    engine: 'redis',
    installed: redisdLines[0] === 'yes' || !!redisUnit,
    version: (redisdLines[1] ?? '').match(/v=([\d.]+)/)?.[1],
    unit: redisUnit || undefined,
    running: first(sec, 'REDISACTIVE') === 'active',
    enabled: first(sec, 'REDISENABLED') === 'enabled',
    clientAvailable: first(sec, 'REDISCLI') === 'yes',
    dumpToolAvailable: first(sec, 'REDISCLI') === 'yes',
    usingCredentials: !!getCred(serverId, 'redis'),
    dataDir: rconf.dir || undefined,
    port: rinfo.port || undefined,
    bindAddress: rinfo.unixSocket && rinfo.port === 0 ? `unix:${rinfo.unixSocket}` : rinfo.bind,
    sizeBytes: num(first(sec, 'REDISSIZE')),
    redis: rinfo
  }
  if (redis.installed && redis.running && redis.clientAvailable) {
    if (rinfo.passwordSet && !getCred(serverId, 'redis')) {
      redis.authOk = false
      redis.authError = 'Redis requires a password (requirepass is set). Enter it under "Admin credentials" (user: default).'
    } else {
      try {
        const kv = parseRedisInfo(await redisRun(ssh, serverId, ['INFO'], { timeoutMs: 20000 }))
        applyRedisInfo(rinfo, kv)
        redis.authOk = true
        if (kv.redis_version) redis.version = kv.redis_version
        redis.port = rinfo.port || undefined
        redis.details = { mode: kv.redis_mode ?? '', role: kv.role ?? '', persistence: [rinfo.save === '' ? 'RDB off' : 'RDB', rinfo.aofEnabled ? 'AOF' : null].filter(Boolean).join(' + '), configFile: kv.config_file || rinfo.configFile || '' }
      } catch (e) {
        redis.authOk = false
        redis.authError = e instanceof Error ? e.message : String(e)
      }
    }
  }

  const sqliteVer = first(sec, 'SQLITE')
  return {
    mysql,
    postgres,
    mongo,
    mssql,
    redis,
    sqlite: { installed: !!sqliteVer, version: sqliteVer.split(' ')[0] || undefined },
    backupsDir: DB_BACKUPS_DIR,
    backupsCount: Number(first(sec, 'BACKUPS')) || 0,
    os: { pkgManager: ssh.os?.pkgManager ?? 'unknown', id: ssh.os?.id ?? 'linux', prettyName: ssh.os?.prettyName ?? 'Linux', versionId: ssh.os?.versionId ?? '', memTotalBytes: num(first(sec, 'MEM')) }
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

function mssqlPlatform(ssh: SshClient): { kind: 'ubuntu'; ver: string } | { kind: 'rhel'; major: string } {
  const os = ssh.os
  const id = os?.id ?? ''
  const like = os?.idLike ?? ''
  const vid = os?.versionId ?? ''
  if (id === 'ubuntu') {
    if (!['20.04', '22.04', '24.04'].includes(vid)) throw new Error(`Microsoft publishes SQL Server 2022 packages for Ubuntu 20.04, 22.04 and 24.04 only (this server runs ${os?.prettyName}).`)
    return { kind: 'ubuntu', ver: vid }
  }
  if (id === 'rhel' || id === 'rocky' || id === 'almalinux' || id === 'centos' || id === 'ol' || /\brhel\b/.test(like)) {
    const major = vid.split('.')[0]
    if (!['8', '9'].includes(major)) throw new Error(`Microsoft publishes SQL Server 2022 packages for RHEL 8 and 9 (and compatible distributions) only (this server runs ${os?.prettyName}).`)
    return { kind: 'rhel', major }
  }
  throw new Error(`SQL Server on Linux is supported by Microsoft on Ubuntu 20.04/22.04/24.04 and RHEL 8/9 only, not on ${os?.prettyName}. Consider running it in Docker (mcr.microsoft.com/mssql/server).`)
}

async function installMssql(ssh: SshClient, serverId: string, h: TaskHandle, input: MssqlInstallInput): Promise<void> {
  requireSystemd(ssh)
  if (!input?.acceptEula) throw new Error('You must accept the Microsoft SQL Server EULA to install it')
  if (!isStrongSqlPassword(input.saPassword ?? '')) throw new Error('The SA password must be 8–128 characters and contain upper-case, lower-case letters, digits and symbols')
  const edition = String(input.edition ?? '').trim()
  const isKey = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/i.test(edition)
  if (!isKey && !['Express', 'Developer', 'Evaluation', 'Standard', 'Enterprise', 'Web'].includes(edition)) throw new Error('Choose an edition or enter a 25-character product key')
  const plat = mssqlPlatform(ssh)
  const mem = await ssh.exec("awk '/^MemTotal:/{print $2 * 1024}' /proc/meminfo")
  const memBytes = Number(mem.stdout.trim()) || 0
  if (memBytes && memBytes < 1.9 * 1024 * 1024 * 1024) throw new Error(`SQL Server needs at least 2 GB of RAM; this server has ${(memBytes / 1024 / 1024 / 1024).toFixed(1)} GB.`)
  h.log(`Platform: ${ssh.os?.prettyName}; RAM ${(memBytes / 1024 / 1024 / 1024).toFixed(1)} GB; edition ${isKey ? 'product key' : edition}.`)

  if (plat.kind === 'ubuntu') {
    h.log('Installing prerequisites (curl, gnupg) …')
    await runPkg(ssh, installCmd(ssh, ['curl', 'gnupg', 'ca-certificates', 'apt-transport-https']), taskIo(h))
    h.log('Adding the Microsoft signing key and repositories …')
    await ssh.sudoRun('curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /usr/share/keyrings/microsoft-prod.gpg', { timeoutMs: 120000 })
    const fix = (f: string): string => `grep -q signed-by ${f} || sed -i -E 's#^deb \\[#deb [signed-by=/usr/share/keyrings/microsoft-prod.gpg #; s#^deb https#deb [signed-by=/usr/share/keyrings/microsoft-prod.gpg] https#' ${f}`
    await ssh.sudoRun(`curl -fsSL ${shq(`https://packages.microsoft.com/config/ubuntu/${plat.ver}/mssql-server-2022.list`)} -o /etc/apt/sources.list.d/mssql-server-2022.list && ${fix('/etc/apt/sources.list.d/mssql-server-2022.list')}`, { timeoutMs: 120000 })
    await ssh.sudoRun(`curl -fsSL ${shq(`https://packages.microsoft.com/config/ubuntu/${plat.ver}/prod.list`)} -o /etc/apt/sources.list.d/mssql-release.list && ${fix('/etc/apt/sources.list.d/mssql-release.list')}`, { timeoutMs: 120000 })
    h.log('Installing mssql-server …')
    await runPkg(ssh, 'apt-get update -qq && apt-get install -y -qq mssql-server', taskIo(h))
    h.log('Installing mssql-tools18 (sqlcmd) …')
    await runPkg(ssh, 'apt-get install -y -qq mssql-tools18 unixodbc-dev', { ...taskIo(h), env: { ...pkgEnv(), ACCEPT_EULA: 'Y' } })
  } else {
    h.log('Adding the Microsoft repositories …')
    await ssh.sudoRun(`curl -fsSL ${shq(`https://packages.microsoft.com/config/rhel/${plat.major}/mssql-server-2022.repo`)} -o /etc/yum.repos.d/mssql-server.repo && curl -fsSL ${shq(`https://packages.microsoft.com/config/rhel/${plat.major}/prod.repo`)} -o /etc/yum.repos.d/msprod.repo`, { timeoutMs: 120000 })
    const pm = ssh.os?.pkgManager === 'yum' ? 'yum' : 'dnf'
    h.log('Installing mssql-server …')
    await runPkg(ssh, `${pm} install -y mssql-server`, taskIo(h))
    h.log('Installing mssql-tools18 (sqlcmd) …')
    await runPkg(ssh, `${pm} install -y mssql-tools18 unixODBC-devel`, { ...taskIo(h), env: { ...pkgEnv(), ACCEPT_EULA: 'Y' } })
  }

  h.log('Running non-interactive setup (mssql-conf setup) …')
  // Password and edition travel in environment variables exported by the exec wrapper, never on the command line.
  const setup = await ssh.exec('/opt/mssql/bin/mssql-conf -n setup accept-eula', {
    sudo: true,
    env: { MSSQL_SA_PASSWORD: input.saPassword, MSSQL_PID: isKey ? edition.toUpperCase() : edition, ACCEPT_EULA: 'Y' },
    timeoutMs: 600000,
    signal: h.signal,
    onStdout: (c) => h.append(c),
    onStderr: (c) => h.append(c)
  })
  if (setup.code !== 0) throw new Error(`mssql-conf setup failed (exit ${setup.code})`)
  await ssh.sudoRun('systemctl enable --now mssql-server', { timeoutMs: 180000 })
  await ssh.sudo(`mkdir -p ${MSSQL_BACKUP_DIR} && chown mssql:mssql ${MSSQL_BACKUP_DIR} && chmod 700 ${MSSQL_BACKUP_DIR}`)
  const map = creds.get(serverId) ?? {}
  map.mssql = { user: 'sa', password: input.saPassword }
  creds.set(serverId, map)
  mssqlPorts.set(serverId, 1433)
  h.log('Waiting for SQL Server to accept connections …')
  let ok = false
  for (let i = 0; i < 12 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const r = await mssqlExec(ssh, serverId, 'SELECT 1', { timeoutMs: 30000 }).catch(() => undefined)
    ok = !!r && r.code === 0
  }
  if (!ok) throw new Error('SQL Server installed but did not accept a connection within 60 s; check "journalctl -u mssql-server".')
  h.log('SQL Server is up (localhost:1433). SA credentials are kept in memory for this session.')
}

function redisPackages(ssh: SshClient): string[] {
  const pm = ssh.os?.pkgManager
  if (pm === 'apt') return ['redis-server']
  if (pm === 'dnf' || pm === 'yum' || pm === 'zypper' || pm === 'apk' || pm === 'pacman') return ['redis']
  throw new Error(`Redis installation is not supported on ${ssh.os?.prettyName}`)
}

async function redisUnitOrNone(ssh: SshClient): Promise<string> {
  const r = await ssh.exec(`for u in ${REDIS_UNITS.join(' ')}; do if systemctl cat "$u.service" >/dev/null 2>&1; then echo "$u"; break; fi; done`)
  return r.stdout.trim()
}

async function installRedis(ssh: SshClient, serverId: string, h: TaskHandle): Promise<void> {
  requireSystemd(ssh)
  const pkgs = redisPackages(ssh)
  h.log(`Installing ${pkgs.join(' ')} …`)
  await runPkg(ssh, installCmd(ssh, pkgs), taskIo(h))
  let unit = await redisUnitOrNone(ssh)
  if (unit === 'redis@default' || (!unit && ssh.os?.pkgManager === 'zypper')) {
    // openSUSE ships an instance template: /etc/redis/<name>.conf + redis@<name>.service.
    h.log('Creating the "default" instance from /etc/redis/default.conf.example …')
    await ssh.sudoRun('[ -f /etc/redis/default.conf ] || { cp /etc/redis/default.conf.example /etc/redis/default.conf && chown root:redis /etc/redis/default.conf && chmod 640 /etc/redis/default.conf; }')
    unit = 'redis@default'
  }
  if (!unit) throw new Error('Redis was installed but no systemd unit (redis-server / redis) was found')
  h.log(`Enabling and starting ${unit} …`)
  await ssh.sudoRun(`systemctl daemon-reload; systemctl enable --now ${shq(unit)}`, { timeoutMs: 180000 })
  // Learn the connection details from the fresh config before the health check.
  const cf = await ssh.sudo(`for f in ${REDIS_CONF_FILES.join(' ')}; do if [ -f "$f" ]; then grep -E '^[[:space:]]*(bind|port|unixsocket)([[:space:]]|$)' "$f"; break; fi; done`)
  redisConns.set(serverId, redisConnFrom(parseRedisConf(splitLines(cf.stdout))))
  h.log('Health check …')
  let pong = ''
  for (let i = 0; i < 10 && pong !== 'PONG'; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    pong = await redisRun(ssh, serverId, ['PING'], { timeoutMs: 15000 }).catch(() => '')
  }
  if (pong !== 'PONG') throw new Error('Redis installed but did not answer PING within 10 s; check "journalctl -u ' + unit + '".')
  const conn = redisConns.get(serverId)
  h.log(`Redis is up (${conn?.socket ? conn.socket : `${conn?.host}:${conn?.port}`}, no password by default; protected mode keeps remote clients out until a password is set).`)
}

async function removeRedis(ssh: SshClient, h: TaskHandle): Promise<void> {
  // Debian splits the CLI into redis-tools; take it along so redis-cli does not linger.
  const pkgs = ssh.os?.pkgManager === 'apt' ? ['redis-server', 'redis-tools'] : redisPackages(ssh)
  const unit = await redisUnitOrNone(ssh)
  if (unit && ssh.os?.hasSystemd) {
    h.log(`Stopping and disabling ${unit} …`)
    await ssh.sudo(`systemctl disable --now ${shq(unit)}`, { timeoutMs: 120000 })
  }
  h.log(`Removing ${pkgs.join(' ')} …`)
  await runPkg(ssh, removeCmd(ssh, pkgs), taskIo(h))
  h.log('Redis packages removed. The data directory (dump.rdb / appendonly files) and the config file were left in place.')
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
  if (engine === 'mssql') {
    const g = await mssqlQuery(
      ssh,
      serverId,
      'SELECT d.name, d.state_desc, d.recovery_model_desc, SUSER_SNAME(d.owner_sid), d.collation_name, ISNULL((SELECT SUM(CAST(mf.size AS bigint)) * 8192 FROM sys.master_files mf WHERE mf.database_id = d.database_id), 0) FROM sys.databases d ORDER BY d.name'
    )
    return g.rows.map((r) => ({ name: r[0] ?? '', state: r[1] ?? undefined, recoveryModel: r[2] ?? undefined, owner: r[3] ?? undefined, collation: r[4] ?? undefined, sizeBytes: num(r[5]), system: SYSTEM_MSSQL_DBS.has(r[0] ?? '') }))
  }
  throw new Error('Not applicable for SQLite')
}

/** Dynamic T-SQL that lists (database, login, role) for every online user database. */
const MSSQL_ROLE_MEMBERS_SQL = `DECLARE @s nvarchar(max) = N'';
SELECT @s = @s + N' UNION ALL SELECT N''' + REPLACE(name, '''', '''''') + N''', l.name, r.name FROM ' + QUOTENAME(name) + N'.sys.database_role_members rm JOIN ' + QUOTENAME(name) + N'.sys.database_principals u ON u.principal_id = rm.member_principal_id JOIN ' + QUOTENAME(name) + N'.sys.database_principals r ON r.principal_id = rm.role_principal_id JOIN sys.server_principals l ON l.sid = u.sid' FROM sys.databases WHERE state = 0 AND database_id > 4;
IF LEN(@s) > 0 BEGIN SET @s = STUFF(@s, 1, 11, N''); EXEC sp_executesql @s; END`

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
  if (engine === 'mssql') {
    const logins = await mssqlQuery(ssh, serverId, "SELECT l.name, l.type_desc, l.is_disabled, l.default_database_name, ISNULL(IS_SRVROLEMEMBER('sysadmin', l.name), 0) FROM sys.server_principals l WHERE l.type IN ('S','U') AND l.name NOT LIKE '##%' ORDER BY l.name")
    const members = await mssqlQuery(ssh, serverId, MSSQL_ROLE_MEMBERS_SQL).catch(() => ({ columns: [], rows: [] }) as Grid)
    const byLogin = new Map<string, string[]>()
    for (const r of members.rows) {
      const login = r[1] ?? ''
      byLogin.set(login, [...(byLogin.get(login) ?? []), `${r[0]}: ${r[2]}`])
    }
    return logins.rows.map((r) => {
      const name = r[0] ?? ''
      const parts: string[] = []
      if (r[4] === '1') parts.push('sysadmin')
      parts.push(...(byLogin.get(name) ?? []))
      if (r[2] === '1') parts.push('DISABLED')
      return { user: name, host: r[3] ?? 'master', privileges: parts.join(' · ') || 'none', superuser: r[4] === '1', canLogin: r[2] !== '1', plugin: r[1] ?? undefined, roles: byLogin.get(name), system: name === 'sa' || name.startsWith('NT ') }
    })
  }
  throw new Error('Not applicable for SQLite')
}

/** T-SQL to (re)create the database user for a login and set its role membership in one database. */
function mssqlGrantSql(user: string, db: string, privs: DbPrivileges): string {
  const u = qBr(user)
  const un = nStr(user)
  const lines = [`USE ${qBr(db)};`, `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${un}) CREATE USER ${u} FOR LOGIN ${u};`]
  for (const role of ['db_owner', 'db_datareader', 'db_datawriter', 'db_ddladmin']) lines.push(`IF IS_ROLEMEMBER('${role}', ${un}) = 1 ALTER ROLE ${role} DROP MEMBER ${u};`)
  if (privs === 'all') lines.push(`ALTER ROLE db_owner ADD MEMBER ${u};`)
  else if (privs === 'readonly') lines.push(`ALTER ROLE db_datareader ADD MEMBER ${u};`)
  else lines.push(`DROP USER ${u};`)
  return lines.join('\n')
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
  if (engine === 'mssql') {
    const g = await mssqlQuery(
      ssh,
      serverId,
      "SELECT CASE WHEN s.name = 'dbo' THEN t.name ELSE s.name + '.' + t.name END, t.type, ISNULL(p.rc, 0), ISNULL(a.bytes, 0) FROM sys.objects t JOIN sys.schemas s ON s.schema_id = t.schema_id LEFT JOIN (SELECT object_id, SUM(row_count) AS rc FROM sys.dm_db_partition_stats WHERE index_id IN (0, 1) GROUP BY object_id) p ON p.object_id = t.object_id LEFT JOIN (SELECT object_id, SUM(CAST(used_page_count AS bigint)) * 8192 AS bytes FROM sys.dm_db_partition_stats GROUP BY object_id) a ON a.object_id = t.object_id WHERE t.type IN ('U', 'V') AND t.is_ms_shipped = 0 ORDER BY 1",
      { db: assertIdent(db, 'database name') }
    )
    return g.rows.map((r) => ({ name: r[0] ?? '', type: (r[1] ?? '').trim() === 'V' ? 'view' : 'table', rows: num(r[2]), sizeBytes: num(r[3]) }))
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
  if (engine === 'mssql') {
    const [schema, name] = splitSchema(table, 'dbo')
    const g = await mssqlQuery(
      ssh,
      serverId,
      `SELECT c.COLUMN_NAME, CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END, ISNULL(k.ORDINAL_POSITION, 0) FROM INFORMATION_SCHEMA.COLUMNS c LEFT JOIN (SELECT kcu.COLUMN_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA AND kcu.TABLE_NAME = tc.TABLE_NAME WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') k ON k.COLUMN_NAME = c.COLUMN_NAME AND k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME WHERE c.TABLE_SCHEMA = ${nStr(schema)} AND c.TABLE_NAME = ${nStr(name)} ORDER BY c.ORDINAL_POSITION`,
      { db }
    )
    const pk = g.rows.filter((r) => r[1] === '1').sort((a, b) => Number(a[2]) - Number(b[2])).map((r) => r[0] ?? '')
    return { columns: g.rows.map((r) => r[0] ?? ''), pk }
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
  let orderBy = opts?.orderBy && meta.columns.includes(opts.orderBy) ? ` ORDER BY ${qIdent(engine, opts.orderBy)} ${dir}` : ''
  const whereSql = where ? ` WHERE (${where})` : ''
  if (engine === 'mssql' && !orderBy) {
    // OFFSET/FETCH needs an ORDER BY: default to the primary key, else the first column.
    const cols = meta.pk.length ? meta.pk : meta.columns.slice(0, 1)
    orderBy = cols.length ? ` ORDER BY ${cols.map((c) => qBr(c)).join(', ')}` : ''
  }
  const sql =
    engine === 'mssql'
      ? `SELECT * FROM ${t}${whereSql}${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY;`
      : `SELECT * FROM ${t}${whereSql}${orderBy} LIMIT ${limit} OFFSET ${offset};`
  const countSql = engine === 'mssql' ? `SELECT COUNT_BIG(*) FROM ${t}${whereSql};` : `SELECT COUNT(*) FROM ${t}${whereSql};`

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
      if (!where && engine === 'mssql') {
        const e = await mssqlQuery(ssh, serverId, `SELECT ISNULL(SUM(row_count), 0) FROM sys.dm_db_partition_stats WHERE object_id = OBJECT_ID(${nStr(qMsTable(table))}) AND index_id IN (0, 1)`, { db })
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

  if (engine === 'mssql') {
    const r = await mssqlExec(ssh, serverId, sql, { db, maxBuffer, timeoutMs: 300000 })
    if (r.code !== 0) throwExec('mssql', r, 'sqlcmd failed')
    const p = parseSqlcmd(r.stdout)
    const grid = p.grids[0] ?? { columns: [], rows: [] }
    const msg = [...p.messages, r.stderr.trim()].filter(Boolean).join('\n')
    // "(N rows affected)" is also printed for SELECTs; only report it when there is no result grid.
    return { ...grid, affected: grid.columns.length ? undefined : p.affected, ms: Date.now() - t0, message: msg || undefined, truncated: r.stdout.length >= maxBuffer }
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
      else if (engine === 'mssql') await mssqlQuery(ssh, serverId, 'SELECT 1', { timeoutMs: 30000 })
      else if (engine === 'redis') {
        const pong = await redisRun(ssh, serverId, ['PING'], { timeoutMs: 20000 })
        if (pong !== 'PONG') throw new DbError('DB_ERROR', `Unexpected PING reply: ${pong}`)
      }
    }
    return { stored: !!user }
  })

  ctx.handle('db:install', async (serverId: string, engineRaw: unknown, variant?: unknown) => {
    const engine = assertEngine(engineRaw)
    const ssh = ctx.ssh(serverId)
    const mysqlVariant = variant === 'mariadb' ? 'mariadb' : 'mysql'
    const title = engine === 'mysql' ? `Install ${mysqlVariant === 'mariadb' ? 'MariaDB' : 'MySQL'}` : engine === 'postgres' ? 'Install PostgreSQL' : engine === 'mongo' ? 'Install MongoDB 8.0' : engine === 'mssql' ? 'Install SQL Server 2022' : engine === 'redis' ? 'Install Redis' : 'Install sqlite3'
    if (engine === 'redis') {
      requireSystemd(ssh)
      redisPackages(ssh)
    }
    if (engine === 'mssql') {
      // Validate up-front so the dialog gets an immediate error instead of a failed task.
      const input = (variant ?? {}) as MssqlInstallInput
      if (!input.acceptEula) throw new Error('You must accept the Microsoft SQL Server EULA to install it')
      if (!isStrongSqlPassword(input.saPassword ?? '')) throw new Error('The SA password must be 8–128 characters and contain upper-case, lower-case letters, digits and symbols')
      mssqlPlatform(ssh)
    }
    const { id } = ctx.tasks.start(title, serverId, async (h) => {
      if (engine === 'mysql') await installMysqlFamily(ssh, h, mysqlVariant)
      else if (engine === 'postgres') await installPostgres(ssh, h)
      else if (engine === 'mongo') await installMongo(ssh, h)
      else if (engine === 'mssql') await installMssql(ssh, serverId, h, variant as MssqlInstallInput)
      else if (engine === 'redis') await installRedis(ssh, serverId, h)
      else await installSqlite(ssh, h)
      ctx.audit(serverId, 'db.install', `${engine}${engine === 'mysql' ? ' ' + mysqlVariant : engine === 'mssql' ? ' ' + String((variant as MssqlInstallInput).edition) : ''}`)
    })
    return id
  })

  // ---------------- SQL Server settings (mssql-conf) ----------------
  ctx.handle('db:mssql:configure', async (serverId: string, patch: { port?: number; memoryLimitMb?: number | null; agentEnabled?: boolean }) => {
    const ssh = ctx.ssh(serverId)
    requireSystemd(ssh)
    const cmds: string[] = []
    const changes: string[] = []
    if (patch?.port !== undefined) {
      const p = Math.floor(Number(patch.port))
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid port')
      cmds.push(`/opt/mssql/bin/mssql-conf set network.tcpport ${p}`)
      changes.push(`port=${p}`)
    }
    if (patch?.memoryLimitMb !== undefined) {
      if (patch.memoryLimitMb === null) {
        cmds.push('/opt/mssql/bin/mssql-conf unset memory.memorylimitmb')
        changes.push('memorylimitmb=default')
      } else {
        const mb = Math.floor(Number(patch.memoryLimitMb))
        if (!Number.isInteger(mb) || mb < 2048) throw new Error('Memory limit must be at least 2048 MB')
        cmds.push(`/opt/mssql/bin/mssql-conf set memory.memorylimitmb ${mb}`)
        changes.push(`memorylimitmb=${mb}`)
      }
    }
    if (patch?.agentEnabled !== undefined) {
      cmds.push(`/opt/mssql/bin/mssql-conf set sqlagent.enabled ${patch.agentEnabled ? 'true' : 'false'}`)
      changes.push(`sqlagent=${patch.agentEnabled}`)
    }
    if (!cmds.length) return
    for (const c of cmds) await ssh.sudoRun(c, { timeoutMs: 60000 })
    await ssh.sudoRun('systemctl restart mssql-server', { timeoutMs: 180000 })
    if (patch?.port !== undefined) mssqlPorts.set(serverId, Math.floor(Number(patch.port)))
    ctx.audit(serverId, 'db.mssql.configure', changes.join(' '))
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
      await mongoEval(ssh, serverId, `var d = db.getSiblingDB(${JSON.stringify(name)}); d.createCollection('_serversysops_init'); d.getSiblingDB(${JSON.stringify(name)}).getCollection('_serversysops_init').drop(); d.createCollection('default'); print('__SM__' + JSON.stringify({ ok: 1 }));`)
    } else if (engine === 'mssql') {
      const name = assertIdent(nameRaw, 'database name')
      const coll = opts?.collation ? ` COLLATE ${assertIdent(opts.collation, 'collation')}` : ''
      await mssqlQuery(ssh, serverId, `CREATE DATABASE ${qBr(name)}${coll};`)
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
    } else if (engine === 'mssql') {
      const name = assertIdent(nameRaw, 'database name')
      if (SYSTEM_MSSQL_DBS.has(name.toLowerCase())) throw new Error('Refusing to drop a system database')
      await mssqlQuery(ssh, serverId, `ALTER DATABASE ${qBr(name)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\nDROP DATABASE ${qBr(name)};`)
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
    } else if (engine === 'mssql') {
      const u = assertIdent(input.user, 'login name')
      if (!isStrongSqlPassword(input.password)) throw new Error('SQL Server requires a password of at least 8 characters with upper-case, lower-case letters, digits and symbols')
      const defDb = input.database ? assertIdent(input.database, 'database name') : undefined
      const stmts = [`CREATE LOGIN ${qBr(u)} WITH PASSWORD = ${nStr(input.password)}, CHECK_POLICY = ON${defDb ? `, DEFAULT_DATABASE = ${qBr(defDb)}` : ''};`]
      if (defDb && privs !== 'none') stmts.push(mssqlGrantSql(u, defDb, privs))
      await mssqlQuery(ssh, serverId, stmts.join('\n'))
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
    else if (engine === 'mssql') {
      if (!isStrongSqlPassword(password)) throw new Error('SQL Server requires a password of at least 8 characters with upper-case, lower-case letters, digits and symbols')
      await mssqlQuery(ssh, serverId, `ALTER LOGIN ${qBr(assertIdent(user, 'login name'))} WITH PASSWORD = ${nStr(password)};`)
    } else throw new Error('Not applicable for SQLite')
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
    } else if (engine === 'mssql') {
      const u = assertIdent(user, 'login name')
      if (u.toLowerCase() === 'sa') throw new Error('Refusing to drop sa')
      // Drop the database users mapped to this login in every online user database, then the login.
      const sql = `DECLARE @s nvarchar(max) = N'';
SELECT @s = @s + N'IF EXISTS (SELECT 1 FROM ' + QUOTENAME(name) + N'.sys.database_principals WHERE name = ${nStr(u).replace(/'/g, "''")}) EXEC(N''USE ' + QUOTENAME(name) + N'; DROP USER ${qBr(u).replace(/'/g, "''")};''); ' FROM sys.databases WHERE state = 0 AND database_id > 4;
IF LEN(@s) > 0 EXEC sp_executesql @s;
DROP LOGIN ${qBr(u)};`
      await mssqlQuery(ssh, serverId, sql)
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
    } else if (engine === 'mssql') {
      await mssqlQuery(ssh, serverId, mssqlGrantSql(assertIdent(input.user, 'login name'), assertIdent(input.database, 'database name'), privs))
    } else throw new Error('Not applicable for SQLite')
    ctx.audit(serverId, 'db.grant', `${engine} ${input.user} ${privs} on ${input.database}`)
  })

  // ---------------- backups ----------------
  ctx.handle('db:backups', async (serverId: string): Promise<DbBackup[]> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.sudo(
      `mkdir -p ${DB_BACKUPS_DIR} && chmod 700 ${DB_BACKUPS_DIR} && find ${DB_BACKUPS_DIR} -maxdepth 1 -type f -printf '%p\\t%s\\t%T@\\n'; [ -d ${MSSQL_BACKUP_DIR} ] && find ${MSSQL_BACKUP_DIR} -maxdepth 1 -type f -name '*.bak' -printf '%p\\t%s\\t%T@\\n'; true`
    )
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not list backups')
    const out: DbBackup[] = []
    for (const line of splitLines(r.stdout)) {
      const [file, size, mtime] = line.split('\t')
      if (!file) continue
      const name = file.slice(file.lastIndexOf('/') + 1)
      const m = name.match(BACKUP_RE)
      const ms = name.match(MSSQL_BACKUP_RE)
      out.push({
        file,
        name,
        engine: m ? (m[3] === 'pg' ? 'postgres' : (m[3] as DbEngine)) : ms ? 'mssql' : name.endsWith('.bak') ? 'mssql' : undefined,
        database: m ? m[1] : ms ? ms[1] : undefined,
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
      if (engine === 'mssql') {
        // The server process (user mssql) writes the file itself, so the directory must belong to mssql.
        await ssh.sudoRun(`mkdir -p ${MSSQL_BACKUP_DIR} && chown mssql:mssql ${MSSQL_BACKUP_DIR} && chmod 700 ${MSSQL_BACKUP_DIR}`)
        h.log(`BACKUP DATABASE ${db} TO DISK = ${path} …`)
        const sql = (compression: boolean): string => `BACKUP DATABASE ${qBr(db)} TO DISK = ${nStr(path)} WITH ${compression ? 'COMPRESSION, ' : ''}INIT, STATS = 10;`
        let r = await mssqlExec(ssh, serverId, sql(true), { timeoutMs: 0, ...taskIo(h) })
        if (r.code !== 0 && /not supported on this edition|COMPRESSION/i.test(r.stderr + r.stdout)) {
          h.log('Backup compression is not available in this edition; retrying without COMPRESSION …')
          r = await mssqlExec(ssh, serverId, sql(false), { timeoutMs: 0, ...taskIo(h) })
        }
        if (r.code !== 0) throwExec('mssql', r, 'BACKUP DATABASE failed')
        const sz = await ssh.sudo(`stat -c %s ${shq(path)}`)
        h.log(`Done: ${path} (${Math.round((Number(sz.stdout) || 0) / 1024)} KB). Download it from the Files module.`)
        ctx.audit(serverId, 'db.backup', `mssql ${db} -> ${path}`)
        return
      }
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
      } else if (engine === 'mssql') {
        if (!file.startsWith(MSSQL_BACKUP_DIR + '/')) throw new Error(`SQL Server can only restore .bak files from ${MSSQL_BACKUP_DIR}`)
        const orig = file.split('/').pop()?.match(MSSQL_BACKUP_RE)?.[1]
        h.log('Reading the file list from the backup …')
        const fl = await mssqlQuery(ssh, serverId, `RESTORE FILELISTONLY FROM DISK = ${nStr(file)};`, { timeoutMs: 300000 })
        const li = fl.columns.indexOf('LogicalName')
        const pi = fl.columns.indexOf('PhysicalName')
        const ti = fl.columns.indexOf('Type')
        const exists = await mssqlQuery(ssh, serverId, `SELECT COUNT(*) FROM sys.databases WHERE name = ${nStr(db)};`)
        const dbExists = (exists.rows[0]?.[0] ?? '0') !== '0'
        // Restoring under a different name needs new physical file names, otherwise they collide with the source database.
        let move = ''
        if (orig !== db && li >= 0 && pi >= 0) {
          move = fl.rows
            .map((r, i) => {
              const phys = r[pi] ?? ''
              const ext = (r[ti] ?? '').trim() === 'L' ? 'ldf' : phys.includes('.') ? phys.slice(phys.lastIndexOf('.') + 1).replace(/[^A-Za-z0-9]/g, '') || 'mdf' : 'mdf'
              return `, MOVE ${nStr(r[li] ?? '')} TO ${nStr(`/var/opt/mssql/data/${db}_${i}.${ext}`)}`
            })
            .join('')
        }
        const sql = [
          dbExists ? `ALTER DATABASE ${qBr(db)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;` : '',
          `RESTORE DATABASE ${qBr(db)} FROM DISK = ${nStr(file)} WITH REPLACE, RECOVERY, STATS = 10${move};`,
          `ALTER DATABASE ${qBr(db)} SET MULTI_USER;`
        ]
          .filter(Boolean)
          .join('\n')
        h.log(`RESTORE DATABASE ${db} FROM DISK = ${file}${move ? ' (files relocated)' : ''} …`)
        const r = await mssqlExec(ssh, serverId, sql, { timeoutMs: 0, ...taskIo(h) })
        if (r.code !== 0) throwExec('mssql', r, 'RESTORE DATABASE failed')
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
            : engine === 'mssql'
              ? await mssqlExec(ssh, serverId, text, { db, timeoutMs: 0, ...taskIo(h) })
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

  // ---------------- Redis specific ----------------
  ctx.handle('db:redis:remove', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    redisPackages(ssh)
    const { id } = ctx.tasks.start('Remove Redis', serverId, async (h) => {
      await removeRedis(ssh, h)
      ctx.audit(serverId, 'db.redis.remove', '')
    })
    return id
  })

  ctx.handle('db:redis:configure', async (serverId: string, patchRaw: RedisConfigPatch) => {
    const ssh = ctx.ssh(serverId)
    requireSystemd(ssh)
    const patch = patchRaw ?? {}
    // ---- validate (everything ends up inside the config file, never in a shell string) ----
    const set: Record<string, string | null> = {}
    const changes: string[] = []
    if (patch.bind !== undefined) {
      const toks = String(patch.bind).trim().split(/\s+/).filter(Boolean)
      if (!toks.length || toks.some((t) => !/^-?(\*|[0-9A-Za-z.:*]{1,64})$/.test(t))) throw new Error('Bind address must be one or more IP addresses (e.g. "127.0.0.1 -::1" or "0.0.0.0")')
      set.bind = toks.join(' ')
      changes.push(`bind=${set.bind}`)
    }
    if (patch.port !== undefined) {
      set.port = String(assertPort(Number(patch.port)))
      changes.push(`port=${set.port}`)
    }
    if (patch.requirepass !== undefined) {
      const pw = String(patch.requirepass)
      if (pw === '') {
        set.requirepass = null
        changes.push('requirepass cleared')
      } else {
        if (pw.length < 8 || pw.length > 512 || /[\s"'\\]/.test(pw)) throw new Error('The password must be 8–512 characters without spaces, quotes or backslashes')
        set.requirepass = pw
        changes.push('requirepass set')
      }
    }
    if (patch.maxmemory !== undefined) {
      const mm = String(patch.maxmemory).trim().toLowerCase() || '0'
      if (!/^\d{1,15}(b|k|kb|m|mb|g|gb)?$/.test(mm)) throw new Error('maxmemory must be a size like 256mb, 2gb or 0 (unlimited)')
      set.maxmemory = mm
      changes.push(`maxmemory=${mm}`)
    }
    if (patch.maxmemoryPolicy !== undefined) {
      const pol = String(patch.maxmemoryPolicy)
      if (!(REDIS_MAXMEMORY_POLICIES as readonly string[]).includes(pol)) throw new Error('Unknown maxmemory-policy')
      set['maxmemory-policy'] = pol
      changes.push(`maxmemory-policy=${pol}`)
    }
    if (patch.appendonly !== undefined) {
      set.appendonly = patch.appendonly ? 'yes' : 'no'
      changes.push(`appendonly=${set.appendonly}`)
    }
    if (!Object.keys(set).length) return

    // ---- locate + read the config file ----
    const loc = await ssh.sudo(`for f in ${REDIS_CONF_FILES.join(' ')}; do if [ -f "$f" ]; then echo "$f"; break; fi; done`)
    const file = loc.stdout.trim().split('\n')[0]
    if (!file) throw new Error(`No redis.conf found (looked at ${REDIS_CONF_FILES.join(', ')})`)
    const cur = await ssh.sudo(`cat ${shq(file)}`, { maxBuffer: 4 * 1024 * 1024 })
    if (cur.code !== 0) throw new Error(cur.stderr.trim() || `Could not read ${file}`)
    const original = cur.stdout
    const lines = original.replace(/\r\n/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()

    // ---- rewrite directives in TypeScript: replace the first active line, drop duplicates, append missing ----
    const pending = new Map(Object.entries(set))
    const out: string[] = []
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z][A-Za-z0-9-]*)(\s|$)/)
      const name = m ? m[1].toLowerCase() : ''
      if (name && Object.prototype.hasOwnProperty.call(set, name)) {
        if (pending.has(name)) {
          const v = pending.get(name)
          pending.delete(name)
          if (v !== null) out.push(`${name} ${v}`)
        }
        continue // drop further active occurrences (and the cleared directive)
      }
      out.push(line)
    }
    const additions = [...pending.entries()].filter(([, v]) => v !== null)
    if (additions.length) {
      out.push('', `# Added by ServerSysOps ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`)
      for (const [k, v] of additions) out.push(`${k} ${v}`)
    }
    const content = out.join('\n') + '\n'

    // ---- backup, write (the redirect keeps owner/mode), restart, verify; roll back on failure ----
    const unit = await unitFor(ssh, 'redis')
    const backup = `${file}.bak-${ts()}`
    await ssh.sudoRun(`cp -a ${shq(file)} ${shq(backup)} && ${b64Echo(content)} > ${shq(file)}`)
    const newConf = parseRedisConf(out)
    const prevConn = redisConns.get(serverId)
    redisConns.set(serverId, redisConnFrom(newConf))
    const prevCred = getCred(serverId, 'redis')
    const map = creds.get(serverId) ?? {}
    if (set.requirepass === null) delete map.redis
    else if (typeof set.requirepass === 'string') map.redis = { user: 'default', password: set.requirepass }
    creds.set(serverId, map)

    const restart = await ssh.sudo(`systemctl restart ${shq(unit)} && sleep 1 && systemctl is-active ${shq(unit)}`, { timeoutMs: 120000 })
    let pong = ''
    if (restart.code === 0 && restart.stdout.trim().endsWith('active')) {
      for (let i = 0; i < 5 && pong !== 'PONG'; i++) {
        pong = await redisRun(ssh, serverId, ['PING'], { timeoutMs: 15000 }).catch((e: Error) => `ERR ${e.message}`)
        if (pong !== 'PONG') await new Promise((r) => setTimeout(r, 1000))
      }
    }
    if (pong !== 'PONG') {
      const journal = await ssh.sudo(`journalctl -u ${shq(unit)} -n 15 --no-pager 2>/dev/null | tail -n 15`)
      // Roll back: restore the previous file, credentials and connection details, restart again.
      await ssh.sudo(`cp -a ${shq(backup)} ${shq(file)} && systemctl restart ${shq(unit)}`, { timeoutMs: 120000 })
      if (prevConn) redisConns.set(serverId, prevConn)
      if (prevCred) map.redis = prevCred
      else delete map.redis
      creds.set(serverId, map)
      const why = restart.code !== 0 || !restart.stdout.includes('active') ? 'the service did not come back' : `the server does not answer (${pong.slice(0, 160)})`
      throw new Error(`Redis configuration rolled back (${backup} restored): ${why}.\n${journal.stdout.trim().split('\n').slice(-8).join('\n')}`)
    }
    ctx.audit(serverId, 'db.redis.configure', changes.join(' '))
    return { file, backup }
  })

  ctx.handle('db:redis:scan', async (serverId: string, dbRaw: unknown, patternRaw: unknown, cursorRaw: unknown, countRaw: unknown): Promise<RedisScanResult> => {
    const db = assertRedisDb(dbRaw)
    const pattern = typeof patternRaw === 'string' && patternRaw.length && patternRaw.length <= 1024 && !patternRaw.includes('\0') ? patternRaw : '*'
    const cursor = /^\d{1,20}$/.test(String(cursorRaw ?? '0')) ? String(cursorRaw ?? '0') : '0'
    const count = clampInt(countRaw, 100, 10, REDIS_KEY_PAGE_MAX)
    const res = await redisEval<{ cursor: string | number; dbsize: number; keys: unknown }>(ctx.ssh(serverId), serverId, REDIS_SCAN_LUA, [], [cursor, pattern, String(count)], { db, maxBuffer: 32 * 1024 * 1024 })
    const keys: RedisKey[] = luaArr<[string, string, number, number]>(res.keys).map((k) => ({ key: String(k[0]), type: String(k[1]), ttl: Number(k[2]), sizeBytes: Number(k[3]) >= 0 ? Number(k[3]) : undefined }))
    return { cursor: String(res.cursor), keys, dbSize: Number(res.dbsize) || 0 }
  })

  ctx.handle('db:redis:key', async (serverId: string, dbRaw: unknown, keyRaw: unknown): Promise<RedisKeyValue> => {
    const db = assertRedisDb(dbRaw)
    const key = assertRedisKey(keyRaw)
    const r = await redisEval<{ type: string; ttl: number; size?: number; len?: number; value?: string; items?: unknown; truncated?: boolean }>(ctx.ssh(serverId), serverId, REDIS_GET_LUA, [key], [String(REDIS_KEY_ITEMS_MAX)], { db, maxBuffer: 16 * 1024 * 1024 })
    return { key, type: r.type, ttl: Number(r.ttl), sizeBytes: r.size, length: r.len, value: r.value, items: r.items === undefined ? undefined : luaArr<unknown>(r.items).map((x) => String(x)), truncated: !!r.truncated }
  })

  ctx.handle('db:redis:setKey', async (serverId: string, dbRaw: unknown, keyRaw: unknown, valueRaw: unknown, ttlRaw?: unknown) => {
    const db = assertRedisDb(dbRaw)
    const key = assertRedisKey(keyRaw)
    const value = String(valueRaw ?? '')
    if (value.includes('\0') || value.length > 512 * 1024) throw new Error('Value must be at most 512 KB')
    const args = ['SET', key, value]
    if (ttlRaw !== undefined && ttlRaw !== null && ttlRaw !== '') {
      const ttl = Math.floor(Number(ttlRaw))
      if (!Number.isInteger(ttl) || ttl < 1) throw new Error('TTL must be a positive number of seconds')
      args.push('EX', String(ttl))
    }
    const r = await redisRun(ctx.ssh(serverId), serverId, args, { db })
    if (r !== 'OK') throw new DbError('DB_ERROR', r || 'SET failed')
    ctx.audit(serverId, 'db.redis.setKey', `db${db} ${key.slice(0, 120)}`)
  })

  ctx.handle('db:redis:expire', async (serverId: string, dbRaw: unknown, keyRaw: unknown, ttlRaw: unknown) => {
    const db = assertRedisDb(dbRaw)
    const key = assertRedisKey(keyRaw)
    let r: string
    if (ttlRaw === null || ttlRaw === undefined || ttlRaw === '') r = await redisRun(ctx.ssh(serverId), serverId, ['PERSIST', key], { db })
    else {
      const ttl = Math.floor(Number(ttlRaw))
      if (!Number.isInteger(ttl) || ttl < 1) throw new Error('TTL must be a positive number of seconds')
      r = await redisRun(ctx.ssh(serverId), serverId, ['EXPIRE', key, String(ttl)], { db })
    }
    ctx.audit(serverId, 'db.redis.expire', `db${db} ${key.slice(0, 120)} -> ${ttlRaw === null || ttlRaw === undefined || ttlRaw === '' ? 'persist' : String(ttlRaw)}`)
    return r === '1'
  })

  ctx.handle('db:redis:deleteKey', async (serverId: string, dbRaw: unknown, keyRaw: unknown) => {
    const db = assertRedisDb(dbRaw)
    const key = assertRedisKey(keyRaw)
    const r = await redisRun(ctx.ssh(serverId), serverId, ['DEL', key], { db })
    ctx.audit(serverId, 'db.redis.deleteKey', `db${db} ${key.slice(0, 120)}`)
    return Number(r) || 0
  })

  ctx.handle('db:redis:command', async (serverId: string, dbRaw: unknown, lineRaw: unknown, raw?: unknown): Promise<{ output: string; ms: number }> => {
    const db = assertRedisDb(dbRaw)
    if (typeof lineRaw !== 'string' || !lineRaw.trim()) throw new Error('Empty command')
    const args = splitRedisArgs(lineRaw.trim())
    if (!args.length) throw new Error('Empty command')
    if (args.some((a) => a.includes('\0'))) throw new Error('Arguments cannot contain NUL bytes')
    const t0 = Date.now()
    const r = await redisExec(ctx.ssh(serverId), serverId, args, { db, noRaw: !raw, timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
    const err = r.stderr.replace(/^Warning:.*\n?/gm, '').trim()
    if (r.code !== 0 && !r.stdout.trim() && err && (AUTH_RE.test(err) || DOWN_RE.test(err))) throwExec('redis', r, 'redis-cli failed')
    ctx.audit(serverId, 'db.redis.command', `db${db}: ${lineRaw.trim().slice(0, 120)}`)
    const output = [r.stdout.replace(/\n$/, ''), err].filter(Boolean).join('\n')
    return { output: output || (r.code === 0 ? '(empty)' : `(exit ${r.code})`), ms: Date.now() - t0 }
  })

  ctx.handle('db:redis:slowlog', async (serverId: string, countRaw?: unknown): Promise<RedisSlowlogEntry[]> => {
    const count = clampInt(countRaw, 25, 1, 128)
    const res = await redisEval<{ entries: unknown }>(ctx.ssh(serverId), serverId, REDIS_SLOWLOG_LUA, [], [String(count)])
    return luaArr<unknown[]>(res.entries).map((e) => ({
      id: Number(e[0]),
      time: Number(e[1]) * 1000,
      durationUs: Number(e[2]),
      command: luaArr<unknown>(e[3]).map(String).join(' '),
      client: e[4] !== undefined ? String(e[4]) : undefined,
      clientName: e[5] ? String(e[5]) : undefined
    }))
  })

  ctx.handle('db:redis:clients', async (serverId: string): Promise<RedisClient[]> => {
    const out = await redisRun(ctx.ssh(serverId), serverId, ['CLIENT', 'LIST'])
    return splitLines(out)
      .filter((l) => l.trim())
      .map((l) => {
        const f: Record<string, string> = {}
        for (const tok of l.trim().split(' ')) {
          const i = tok.indexOf('=')
          if (i > 0) f[tok.slice(0, i)] = tok.slice(i + 1)
        }
        return { id: f.id ?? '', addr: f.addr ?? '', name: f.name ?? '', ageSec: Number(f.age) || 0, idleSec: Number(f.idle) || 0, db: Number(f.db) || 0, cmd: f.cmd ?? '', user: f.user, flags: f.flags ?? '' }
      })
  })

  ctx.handle('db:redis:flush', async (serverId: string, dbRaw: unknown) => {
    const all = dbRaw === null || dbRaw === undefined
    const db = all ? 0 : assertRedisDb(dbRaw)
    const r = await redisRun(ctx.ssh(serverId), serverId, [all ? 'FLUSHALL' : 'FLUSHDB'], { db, timeoutMs: 300000 })
    if (r !== 'OK') throw new DbError('DB_ERROR', r || 'FLUSH failed')
    ctx.audit(serverId, 'db.redis.flush', all ? 'FLUSHALL' : `FLUSHDB db${db}`)
  })

  ctx.handle('db:redis:bgsave', async (serverId: string): Promise<{ message: string; lastSave: number }> => {
    const ssh = ctx.ssh(serverId)
    const message = await redisRun(ssh, serverId, ['BGSAVE'])
    const last = await redisRun(ssh, serverId, ['LASTSAVE']).catch(() => '0')
    ctx.audit(serverId, 'db.redis.bgsave', '')
    return { message, lastSave: (Number(last) || 0) * 1000 }
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
