import { BrowserWindow, dialog } from 'electron'
import { randomBytes } from 'crypto'
import { createReadStream, createWriteStream, promises as fsp } from 'fs'
import { basename as lbasename, join as ljoin, posix } from 'path'
import { pipeline } from 'stream/promises'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { Ctx } from '../core'
import type { SshClient } from '../ssh/SshClient'
import { assertAbsPath, shq } from '../ssh/shell'
import type { ArchiveFormat, FileListOpts, FileReadResult, FileRow, FileStatResult, TransferInfo, UsersGroups } from '@shared/modules/files'
import { FILES_MAX_EDIT_BYTES, FILES_MAX_SEARCH_RESULTS } from '@shared/modules/files'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

class FilesError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Validate and normalise an absolute remote path (no trailing slash except for "/"). */
function normPath(p: string): string {
  assertAbsPath(p)
  let n = posix.normalize(p)
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

function normPaths(ps: unknown): string[] {
  if (!Array.isArray(ps) || ps.length === 0) throw new Error('No paths given')
  return ps.map((p) => normPath(String(p)))
}

function assertName(name: string): string {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error(`Invalid file name: ${name}`)
  return name
}

function isPermError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: unknown })?.code
  return /permission denied|EACCES|operation not permitted/i.test(msg) || code === 3 || code === 'EACCES'
}

function classify(msg: string): FilesError {
  const m = msg.trim() || 'Command failed'
  if (/permission denied/i.test(m)) return new FilesError('EACCES', m)
  if (/no such file or directory/i.test(m)) return new FilesError('ENOENT', m)
  if (/not a directory/i.test(m)) return new FilesError('ENOTDIR', m)
  return new FilesError('CMD_FAILED', m)
}

/** Run a shell snippet under `sh -c` (optionally as root). Throws a classified error on non-zero exit. */
async function sh(ssh: SshClient, script: string, opts: { sudo?: boolean; timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  const r = await ssh.exec(`sh -c ${shq(script)}`, { sudo: opts.sudo, timeoutMs: opts.timeoutMs ?? 120000, maxBuffer: opts.maxBuffer })
  if (r.code !== 0) throw classify((r.stderr || r.stdout).split('\n').filter(Boolean).slice(-6).join('\n') || `exit code ${r.code}`)
  return r.stdout
}

const TYPE_BITS: Record<string, number> = { f: 0o100000, d: 0o040000, l: 0o120000, b: 0o060000, c: 0o020000, p: 0o010000, s: 0o140000 }

function modeToString(mode: number): string {
  const ft = mode & 0o170000
  const t = ft === 0o040000 ? 'd' : ft === 0o120000 ? 'l' : ft === 0o060000 ? 'b' : ft === 0o020000 ? 'c' : ft === 0o010000 ? 'p' : ft === 0o140000 ? 's' : '-'
  const bits = 'rwxrwxrwx'
  let s = t
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-'
  if (mode & 0o4000) s = s.slice(0, 3) + (mode & 0o100 ? 's' : 'S') + s.slice(4)
  if (mode & 0o2000) s = s.slice(0, 6) + (mode & 0o010 ? 's' : 'S') + s.slice(7)
  if (mode & 0o1000) s = s.slice(0, 9) + (mode & 0o001 ? 't' : 'T')
  return s
}

/**
 * GNU find -printf format. Fields (tab separated, NUL terminated record):
 * type, target type, size, mtime, octal mode, user, group, uid, gid, link target, name/path
 */
function printfFmt(nameSpec: '%f' | '%p'): string {
  return `%y\\t%Y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%U\\t%G\\t%l\\t${nameSpec}\\0`
}

/** Parse the NUL-separated output of a find -printf listing. */
function parseFind(out: string, dirForNames: string | null): FileRow[] {
  const rows: FileRow[] = []
  for (const rec of out.split('\0')) {
    if (!rec) continue
    const f = rec.split('\t')
    if (f.length < 11) continue
    const [y, Y, size, mt, modeOct, user, group, uid, gid, link] = f
    const nameOrPath = f.slice(10).join('\t')
    const path = dirForNames === null ? nameOrPath : posix.join(dirForNames, nameOrPath)
    const name = dirForNames === null ? posix.basename(nameOrPath) || nameOrPath : nameOrPath
    const type: FileRow['type'] = y === 'f' ? 'file' : y === 'd' ? 'dir' : y === 'l' ? 'symlink' : 'other'
    const mode = (parseInt(modeOct, 8) || 0) | (TYPE_BITS[y] ?? 0)
    const row: FileRow = {
      name,
      path,
      type,
      size: Number(size) || 0,
      mtime: Math.round((parseFloat(mt) || 0) * 1000),
      mode,
      modeStr: modeToString(mode),
      owner: user || uid,
      group: group || gid,
      uid: Number(uid) || 0,
      gid: Number(gid) || 0
    }
    if (type === 'symlink') {
      row.linkTarget = link
      row.targetIsDir = Y === 'd'
    }
    rows.push(row)
  }
  return rows
}

/* ---------- sftp promisified ---------- */

function sftpStat(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return new Promise((res, rej) => sftp.stat(p, (e, s) => (e ? rej(e) : res(s))))
}
function sftpLstat(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return new Promise((res, rej) => sftp.lstat(p, (e, s) => (e ? rej(e) : res(s))))
}
function sftpReadlink(sftp: SFTPWrapper, p: string): Promise<string> {
  return new Promise((res, rej) => sftp.readlink(p, (e, t) => (e ? rej(e) : res(t))))
}
function sftpWriteFile(sftp: SFTPWrapper, p: string, data: Buffer): Promise<void> {
  return new Promise((res, rej) => sftp.writeFile(p, data, (e) => (e ? rej(e) : res())))
}
function sftpUnlink(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((res, rej) => sftp.unlink(p, (e) => (e ? rej(e) : res())))
}
function sftpReaddir(sftp: SFTPWrapper, p: string): Promise<{ filename: string; longname: string; attrs: Stats }[]> {
  return new Promise((res, rej) => sftp.readdir(p, (e, list) => (e ? rej(e) : res(list as unknown as { filename: string; longname: string; attrs: Stats }[]))))
}
/** Read at most `max` bytes from the start of a remote file. */
function sftpReadHead(sftp: SFTPWrapper, p: string, max: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    let n = 0
    const rs = sftp.createReadStream(p, { start: 0, end: Math.max(0, max - 1) })
    rs.on('data', (c: Buffer) => {
      chunks.push(c)
      n += c.length
    })
    rs.on('error', rej)
    rs.on('end', () => res(Buffer.concat(chunks, n)))
    rs.on('close', () => res(Buffer.concat(chunks, n)))
  })
}

function tmpName(prefix = 'serversysops'): string {
  return `/tmp/.${prefix}-${randomBytes(6).toString('hex')}`
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/* ---------- listing ---------- */

async function listViaFind(ssh: SshClient, dir: string, sudo: boolean): Promise<FileRow[]> {
  const q = shq(dir)
  const script = `[ -e ${q} ] || { echo ${shq('No such file or directory: ' + dir)} >&2; exit 2; }; [ -d ${q} ] || { echo ${shq('Not a directory: ' + dir)} >&2; exit 2; }; find -H ${q} -mindepth 1 -maxdepth 1 -printf ${shq(printfFmt('%f'))}`
  const r = await ssh.exec(`sh -c ${shq(script)}`, { sudo, timeoutMs: 60000, maxBuffer: 64 * 1024 * 1024 })
  if (r.code !== 0 && !r.stdout) {
    const err = (r.stderr || '').trim()
    if (/printf|unknown predicate|unrecognized|invalid|not supported/i.test(err) && !/no such file|not a directory|permission denied/i.test(err)) throw new FilesError('NO_PRINTF', err)
    throw classify(err || `find failed (exit ${r.code})`)
  }
  return parseFind(r.stdout, dir)
}

/** Fallback for systems whose find lacks -printf: plain SFTP readdir (owner names parsed from the ls-style longname). */
async function listViaSftp(ssh: SshClient, dir: string): Promise<FileRow[]> {
  const sftp = await ssh.sftp()
  const list = await sftpReaddir(sftp, dir)
  const rows: FileRow[] = []
  for (const e of list) {
    if (e.filename === '.' || e.filename === '..') continue
    const a = e.attrs
    const mode = a.mode ?? 0
    const ft = mode & 0o170000
    const type: FileRow['type'] = ft === 0o040000 ? 'dir' : ft === 0o120000 ? 'symlink' : ft === 0o100000 ? 'file' : 'other'
    const parts = e.longname.trim().split(/\s+/)
    const row: FileRow = {
      name: e.filename,
      path: posix.join(dir, e.filename),
      type,
      size: a.size ?? 0,
      mtime: (a.mtime ?? 0) * 1000,
      mode,
      modeStr: modeToString(mode),
      owner: parts[2] ?? String(a.uid ?? ''),
      group: parts[3] ?? String(a.gid ?? ''),
      uid: a.uid ?? 0,
      gid: a.gid ?? 0
    }
    if (type === 'symlink') {
      try {
        row.linkTarget = await sftpReadlink(sftp, row.path)
        const st = await sftpStat(sftp, row.path)
        row.targetIsDir = st.isDirectory()
      } catch {
        /* dangling link */
      }
    }
    rows.push(row)
  }
  return rows
}

async function listDir(ssh: SshClient, dir: string, opts: FileListOpts): Promise<FileRow[]> {
  const sudo = !!opts.sudo
  let rows: FileRow[]
  try {
    rows = await listViaFind(ssh, dir, sudo)
  } catch (e) {
    if (e instanceof FilesError && e.code === 'NO_PRINTF' && !sudo) rows = await listViaSftp(ssh, dir)
    else throw e
  }
  if (!opts.hidden) rows = rows.filter((r) => !r.name.startsWith('.'))
  rows.sort((a, b) => {
    const da = a.type === 'dir' || (a.type === 'symlink' && a.targetIsDir) ? 0 : 1
    const db = b.type === 'dir' || (b.type === 'symlink' && b.targetIsDir) ? 0 : 1
    return da - db || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return rows
}

async function statOne(ssh: SshClient, path: string, sudo: boolean, follow = false): Promise<FileRow> {
  const out = await sh(ssh, `find ${follow ? '-H ' : ''}${shq(path)} -maxdepth 0 -printf ${shq(printfFmt('%p'))}`, { sudo })
  const rows = parseFind(out, null)
  if (!rows.length) throw new FilesError('ENOENT', `No such file or directory: ${path}`)
  const row = rows[0]
  row.path = path
  row.name = posix.basename(path) || '/'
  return row
}

/* ---------- protected paths ---------- */

const PROTECTED = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var',
  '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/local', '/usr/share', '/var/lib', '/var/log', '/var/www', '/etc/ssh', '/etc/sudoers', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/fstab'
])

function assertDeletable(p: string): void {
  if (PROTECTED.has(p)) throw new Error(`Refusing to delete protected system path ${p}`)
  const base = posix.basename(p)
  if (!base || base === '.' || base === '..') throw new Error(`Refusing to delete ${p}`)
}

/* ---------- tool detection ---------- */

async function requireTool(ssh: SshClient, tool: string, sudo = false): Promise<void> {
  const r = await ssh.exec(`command -v ${shq(tool)} >/dev/null 2>&1 && echo yes`, { sudo, timeoutMs: 15000 })
  if (!r.stdout.includes('yes')) throw new FilesError('TOOL_MISSING', `${tool} is not installed on the server`)
}

/* ------------------------------------------------------------------ */
/* Transfers                                                           */
/* ------------------------------------------------------------------ */

interface Transfer extends TransferInfo {
  cancelled: boolean
  cancel?: () => void
  lastEmit: number
}

const transfers = new Map<string, Transfer>()

function newTransfer(serverId: string, name: string, direction: TransferInfo['direction'], remotePath: string, localPath: string): Transfer {
  const t: Transfer = {
    id: randomBytes(8).toString('hex'),
    serverId,
    name,
    direction,
    remotePath,
    localPath,
    done: 0,
    total: 0,
    status: 'running',
    startedAt: Date.now(),
    cancelled: false,
    lastEmit: 0
  }
  transfers.set(t.id, t)
  // Keep the list bounded.
  if (transfers.size > 200) {
    for (const [id, x] of transfers) {
      if (x.status !== 'running') transfers.delete(id)
      if (transfers.size <= 150) break
    }
  }
  return t
}

function emitTransfer(ctx: Ctx, t: Transfer, force = false): void {
  const now = Date.now()
  if (!force && now - t.lastEmit < 200) return
  t.lastEmit = now
  ctx.emit({ type: 'transfer', id: t.id, name: t.name, direction: t.direction, done: t.done, total: t.total, status: t.status, error: t.error })
}

function finishTransfer(ctx: Ctx, t: Transfer, err?: unknown): void {
  t.finishedAt = Date.now()
  t.cancel = undefined
  if (err) {
    t.status = 'failed'
    t.error = t.cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
  } else {
    t.status = 'done'
    t.done = t.total || t.done
  }
  emitTransfer(ctx, t, true)
}

function assertNotCancelled(t: Transfer): void {
  if (t.cancelled) throw new Error('Cancelled')
}

/** Stream one remote file to disk (progress via onBytes). */
async function sftpDownloadFile(sftp: SFTPWrapper, remote: string, local: string, t: Transfer, onBytes: (n: number) => void): Promise<void> {
  const rs = sftp.createReadStream(remote, { highWaterMark: 256 * 1024 })
  const ws = createWriteStream(local)
  t.cancel = () => {
    rs.destroy(new Error('Cancelled'))
    ws.destroy()
  }
  rs.on('data', (c: Buffer) => onBytes(c.length))
  try {
    await pipeline(rs, ws)
  } finally {
    t.cancel = undefined
  }
}

async function downloadFile(ssh: SshClient, remote: string, local: string, sudo: boolean, t: Transfer, onBytes: (n: number) => void): Promise<void> {
  const sftp = await ssh.sftp()
  try {
    await sftpDownloadFile(sftp, remote, local, t, onBytes)
  } catch (e) {
    if (!sudo || t.cancelled || !isPermError(e)) throw e
    // Root-only file: copy to a readable temp file as root, fetch it, remove it.
    const tmp = tmpName('serversysops-dl')
    await ssh.sudoRun(`cp -- ${shq(remote)} ${shq(tmp)} && chown ${shq(ssh.os?.user ?? ssh.profile.username)} ${shq(tmp)} && chmod 600 ${shq(tmp)}`)
    try {
      await sftpDownloadFile(sftp, tmp, local, t, onBytes)
    } finally {
      await ssh.sudo(`rm -f -- ${shq(tmp)}`).catch(() => {})
    }
  }
}

async function runDownload(ctx: Ctx, ssh: SshClient, t: Transfer, remote: string, local: string, isDir: boolean, sudo: boolean): Promise<void> {
  try {
    const bump = (n: number): void => {
      t.done += n
      emitTransfer(ctx, t)
    }
    if (!isDir) {
      const st = await statOne(ssh, remote, sudo, true).catch(() => null)
      t.total = st?.size ?? 0
      emitTransfer(ctx, t, true)
      await downloadFile(ssh, remote, local, sudo, t, bump)
    } else {
      // Enumerate directories and files (relative paths, NUL separated) in one call.
      const out = await sh(ssh, `cd ${shq(remote)} && find . -mindepth 1 -type d -printf 'd\\t%P\\0' ; find -H ${shq(remote)} -mindepth 1 -type f -printf 'f\\t%s\\t%P\\0'`, { sudo, timeoutMs: 0, maxBuffer: 64 * 1024 * 1024 })
      const dirs: string[] = []
      const files: { rel: string; size: number }[] = []
      for (const rec of out.split('\0')) {
        if (!rec) continue
        if (rec.startsWith('d\t')) dirs.push(rec.slice(2))
        else if (rec.startsWith('f\t')) {
          const i = rec.indexOf('\t', 2)
          files.push({ size: Number(rec.slice(2, i)) || 0, rel: rec.slice(i + 1) })
        }
      }
      t.total = files.reduce((a, f) => a + f.size, 0)
      emitTransfer(ctx, t, true)
      await fsp.mkdir(local, { recursive: true })
      for (const d of dirs) await fsp.mkdir(ljoin(local, ...d.split('/')), { recursive: true })
      for (const f of files) {
        assertNotCancelled(t)
        const lp = ljoin(local, ...f.rel.split('/'))
        await fsp.mkdir(ljoin(lp, '..'), { recursive: true })
        await downloadFile(ssh, posix.join(remote, f.rel), lp, sudo, t, bump)
      }
    }
    finishTransfer(ctx, t)
  } catch (e) {
    finishTransfer(ctx, t, e)
  }
}

/** Upload one local file to a remote path (progress via onBytes). In sudo mode it goes through /tmp and `mv`. */
async function uploadFile(ssh: SshClient, local: string, remote: string, sudo: boolean, t: Transfer, onBytes: (n: number) => void): Promise<void> {
  const sftp = await ssh.sftp()
  const target = sudo ? tmpName('serversysops-up') : remote
  const rs = createReadStream(local, { highWaterMark: 256 * 1024 })
  const ws = sftp.createWriteStream(target, { highWaterMark: 256 * 1024 })
  t.cancel = () => {
    rs.destroy(new Error('Cancelled'))
    ws.destroy()
  }
  rs.on('data', (c: string | Buffer) => onBytes(c.length))
  try {
    await pipeline(rs, ws)
  } catch (e) {
    if (sudo) await ssh.sudo(`rm -f -- ${shq(target)}`).catch(() => {})
    throw e
  } finally {
    t.cancel = undefined
  }
  if (sudo) {
    const dir = posix.dirname(remote)
    await ssh.sudoRun(`mkdir -p -- ${shq(dir)} && mv -f -- ${shq(target)} ${shq(remote)} && { chown --reference=${shq(dir)} ${shq(remote)} 2>/dev/null || true; }`)
  }
}

async function walkLocal(root: string): Promise<{ dirs: string[]; files: { rel: string; abs: string; size: number }[] }> {
  const dirs: string[] = []
  const files: { rel: string; abs: string; size: number }[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const ents = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of ents) {
      const abs = ljoin(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        dirs.push(r)
        await walk(abs, r)
      } else if (e.isFile()) {
        const st = await fsp.stat(abs)
        files.push({ rel: r, abs, size: st.size })
      }
    }
  }
  await walk(root, '')
  return { dirs, files }
}

async function runUpload(ctx: Ctx, ssh: SshClient, t: Transfer, local: string, remote: string, isDir: boolean, sudo: boolean): Promise<void> {
  try {
    const bump = (n: number): void => {
      t.done += n
      emitTransfer(ctx, t)
    }
    if (!isDir) {
      t.total = (await fsp.stat(local)).size
      emitTransfer(ctx, t, true)
      await uploadFile(ssh, local, remote, sudo, t, bump)
    } else {
      const { dirs, files } = await walkLocal(local)
      t.total = files.reduce((a, f) => a + f.size, 0)
      emitTransfer(ctx, t, true)
      const mk = [remote, ...dirs.map((d) => posix.join(remote, d))]
      // mkdir in batches to keep the command short.
      for (let i = 0; i < mk.length; i += 200) await sh(ssh, `mkdir -p -- ${mk.slice(i, i + 200).map(shq).join(' ')}`, { sudo })
      for (const f of files) {
        assertNotCancelled(t)
        await uploadFile(ssh, f.abs, posix.join(remote, f.rel), sudo, t, bump)
      }
    }
    finishTransfer(ctx, t)
  } catch (e) {
    finishTransfer(ctx, t, e)
  }
}

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  throw new Error('Unsupported upload payload')
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  // ---------------- listing / reading ----------------
  ctx.handle('files:home', async (serverId: string): Promise<string> => {
    const ssh = ctx.ssh(serverId)
    return ssh.os?.homeDir || '/'
  })

  ctx.handle('files:list', async (serverId: string, path: string, opts: FileListOpts = {}): Promise<FileRow[]> => {
    const dir = normPath(path)
    return listDir(ctx.ssh(serverId), dir, opts ?? {})
  })

  ctx.handle('files:stat', async (serverId: string, path: string, opts: { sudo?: boolean; du?: boolean } = {}): Promise<FileStatResult> => {
    const p = normPath(path)
    const ssh = ctx.ssh(serverId)
    const row: FileStatResult = await statOne(ssh, p, !!opts?.sudo)
    if (opts?.du && (row.type === 'dir' || (row.type === 'symlink' && row.targetIsDir))) {
      const r = await ssh.exec(`du -sk -- ${shq(p)} 2>/dev/null | awk '{print $1}'`, { sudo: !!opts.sudo, timeoutMs: 120000 })
      const kb = Number(r.stdout.trim().split(/\s+/)[0])
      if (Number.isFinite(kb)) row.duBytes = kb * 1024
    }
    return row
  })

  ctx.handle('files:read', async (serverId: string, path: string, sudo?: boolean): Promise<FileReadResult> => {
    const p = normPath(path)
    const ssh = ctx.ssh(serverId)
    const MAX = FILES_MAX_EDIT_BYTES
    if (sudo) {
      const out = await sh(ssh, `stat -c '%a %s' -- ${shq(p)} && echo __SM_DATA__ && head -c ${MAX} -- ${shq(p)} | base64`, { sudo: true, maxBuffer: 8 * 1024 * 1024 })
      const sep = out.indexOf('__SM_DATA__')
      const head = (sep >= 0 ? out.slice(0, sep) : out).trim().split(/\s+/)
      const mode = parseInt(head[0] ?? '644', 8) || 0o644
      const size = Number(head[1]) || 0
      const buf = Buffer.from((sep >= 0 ? out.slice(sep + 11) : '').replace(/\s+/g, ''), 'base64')
      return { content: buf.toString('utf8'), size, truncated: size > buf.length, binary: isBinary(buf), mode }
    }
    const sftp = await ssh.sftp()
    let st: Stats
    try {
      st = await sftpStat(sftp, p)
    } catch (e) {
      throw isPermError(e) ? new FilesError('EACCES', `Permission denied: ${p}`) : e
    }
    if (st.isDirectory()) throw new FilesError('EISDIR', `${p} is a directory`)
    let buf: Buffer
    try {
      buf = await sftpReadHead(sftp, p, MAX)
    } catch (e) {
      throw isPermError(e) ? new FilesError('EACCES', `Permission denied: ${p}`) : e
    }
    return { content: buf.toString('utf8'), size: st.size, truncated: st.size > buf.length, binary: isBinary(buf), mode: st.mode & 0o7777 }
  })

  // ---------------- writing ----------------
  ctx.handle('files:write', async (serverId: string, path: string, content: string, sudo?: boolean): Promise<FileRow> => {
    const p = normPath(path)
    const ssh = ctx.ssh(serverId)
    const data = Buffer.from(String(content ?? ''), 'utf8')
    const sftp = await ssh.sftp()
    if (!sudo) {
      try {
        await sftpWriteFile(sftp, p, data)
      } catch (e) {
        throw isPermError(e) ? new FilesError('EACCES', `Permission denied: ${p}`) : e
      }
    } else {
      const tmp = tmpName('serversysops-w')
      await sftpWriteFile(sftp, tmp, data)
      try {
        // Existing file: overwrite in place (keeps inode, mode and owner). New file: create with 0644.
        await sh(ssh, `if [ -e ${shq(p)} ]; then cat ${shq(tmp)} > ${shq(p)}; else cp -- ${shq(tmp)} ${shq(p)} && chmod 644 ${shq(p)}; fi`, { sudo: true })
      } finally {
        await sftpUnlink(sftp, tmp).catch(() => ssh.sudo(`rm -f -- ${shq(tmp)}`).catch(() => {}))
      }
    }
    ctx.audit(serverId, 'files.write', p)
    return statOne(ssh, p, !!sudo, true)
  })

  ctx.handle('files:mkdir', async (serverId: string, path: string, sudo?: boolean): Promise<void> => {
    const p = normPath(path)
    await sh(ctx.ssh(serverId), `mkdir -- ${shq(p)}`, { sudo: !!sudo })
    ctx.audit(serverId, 'files.mkdir', p)
  })

  ctx.handle('files:touch', async (serverId: string, path: string, sudo?: boolean): Promise<void> => {
    const p = normPath(path)
    await sh(ctx.ssh(serverId), `if [ -e ${shq(p)} ]; then echo ${shq('File exists: ' + p)} >&2; exit 1; fi; touch -- ${shq(p)}`, { sudo: !!sudo })
    ctx.audit(serverId, 'files.touch', p)
  })

  ctx.handle('files:rename', async (serverId: string, from: string, to: string, sudo?: boolean): Promise<void> => {
    const a = normPath(from)
    const b = normPath(to)
    if (a === b) return
    await sh(ctx.ssh(serverId), `if [ -e ${shq(b)} ]; then echo ${shq('Target already exists: ' + b)} >&2; exit 1; fi; mv -- ${shq(a)} ${shq(b)}`, { sudo: !!sudo })
    ctx.audit(serverId, 'files.rename', `${a} -> ${b}`)
  })

  ctx.handle('files:delete', async (serverId: string, paths: string[], sudo?: boolean): Promise<void> => {
    const ps = normPaths(paths)
    ps.forEach(assertDeletable)
    await sh(ctx.ssh(serverId), `rm -rf -- ${ps.map(shq).join(' ')}`, { sudo: !!sudo, timeoutMs: 600000 })
    ctx.audit(serverId, 'files.delete', ps.join(' '))
  })

  ctx.handle('files:copy', async (serverId: string, paths: string[], destDir: string, sudo?: boolean): Promise<void> => {
    const ps = normPaths(paths)
    const d = normPath(destDir)
    for (const p of ps) if (d === p || d.startsWith(p + '/')) throw new Error(`Cannot copy ${p} into itself`)
    await sh(ctx.ssh(serverId), `[ -d ${shq(d)} ] || { echo ${shq('Destination is not a directory: ' + d)} >&2; exit 1; }; cp -a -- ${ps.map(shq).join(' ')} ${shq(d)}/`, { sudo: !!sudo, timeoutMs: 0 })
    ctx.audit(serverId, 'files.copy', `${ps.join(' ')} -> ${d}`)
  })

  ctx.handle('files:move', async (serverId: string, paths: string[], destDir: string, sudo?: boolean): Promise<void> => {
    const ps = normPaths(paths)
    const d = normPath(destDir)
    for (const p of ps) {
      if (d === p || d.startsWith(p + '/')) throw new Error(`Cannot move ${p} into itself`)
      if (posix.dirname(p) === d) throw new Error(`${posix.basename(p)} is already in ${d}`)
    }
    await sh(ctx.ssh(serverId), `[ -d ${shq(d)} ] || { echo ${shq('Destination is not a directory: ' + d)} >&2; exit 1; }; mv -- ${ps.map(shq).join(' ')} ${shq(d)}/`, { sudo: !!sudo, timeoutMs: 0 })
    ctx.audit(serverId, 'files.move', `${ps.join(' ')} -> ${d}`)
  })

  ctx.handle('files:chmod', async (serverId: string, paths: string[], mode: string, recursive?: boolean, sudo?: boolean): Promise<void> => {
    const ps = normPaths(paths)
    const m = String(mode).trim()
    if (!/^[0-7]{3,4}$/.test(m)) throw new Error(`Invalid mode: ${mode}`)
    await sh(ctx.ssh(serverId), `chmod ${recursive ? '-R ' : ''}${m} -- ${ps.map(shq).join(' ')}`, { sudo: !!sudo, timeoutMs: 600000 })
    ctx.audit(serverId, 'files.chmod', `${m}${recursive ? ' -R' : ''} ${ps.join(' ')}`)
  })

  ctx.handle('files:chown', async (serverId: string, paths: string[], owner: string, group: string, recursive?: boolean, sudo?: boolean): Promise<void> => {
    const ps = normPaths(paths)
    const o = String(owner ?? '').trim()
    const g = String(group ?? '').trim()
    const ok = (s: string): boolean => s === '' || /^[A-Za-z0-9_][A-Za-z0-9_.@$\-]*$/.test(s)
    if (!ok(o) || !ok(g)) throw new Error('Invalid owner or group')
    if (!o && !g) throw new Error('Owner or group required')
    const spec = g ? `${o}:${g}` : o
    await sh(ctx.ssh(serverId), `chown ${recursive ? '-R ' : ''}${shq(spec)} -- ${ps.map(shq).join(' ')}`, { sudo: !!sudo, timeoutMs: 600000 })
    ctx.audit(serverId, 'files.chown', `${spec}${recursive ? ' -R' : ''} ${ps.join(' ')}`)
  })

  ctx.handle('files:symlink', async (serverId: string, target: string, linkPath: string, sudo?: boolean): Promise<void> => {
    const l = normPath(linkPath)
    const t = String(target ?? '')
    if (!t || t.includes('\0')) throw new Error('Invalid link target')
    await sh(ctx.ssh(serverId), `ln -s -- ${shq(t)} ${shq(l)}`, { sudo: !!sudo })
    ctx.audit(serverId, 'files.symlink', `${l} -> ${t}`)
  })

  // ---------------- archives (background tasks) ----------------
  ctx.handle('files:compress', async (serverId: string, paths: string[], archivePath: string, format: ArchiveFormat, sudo?: boolean): Promise<string> => {
    const ps = normPaths(paths)
    const archive = normPath(archivePath)
    const parent = posix.dirname(ps[0])
    if (ps.some((p) => posix.dirname(p) !== parent)) throw new Error('Select items from a single folder to compress them together')
    const names = ps.map((p) => posix.basename(p))
    const ssh = ctx.ssh(serverId)
    let cmd: string
    if (format === 'zip') {
      await requireTool(ssh, 'zip')
      cmd = `cd ${shq(parent)} && zip -r -q -y ${shq(archive)} ${names.map((n) => shq('./' + n)).join(' ')}`
    } else if (format === 'tar.xz') {
      await requireTool(ssh, 'xz')
      cmd = `tar -C ${shq(parent)} -cJf ${shq(archive)} -- ${names.map(shq).join(' ')}`
    } else if (format === 'tar.gz') {
      cmd = `tar -C ${shq(parent)} -czf ${shq(archive)} -- ${names.map(shq).join(' ')}`
    } else throw new Error(`Unsupported format: ${format}`)
    const { id } = ctx.tasks.start(`Compress ${names.length === 1 ? names[0] : `${names.length} items`} → ${posix.basename(archive)}`, serverId, async (h) => {
      h.log(`> ${cmd}`)
      await ssh.run(`sh -c ${shq(cmd)}`, { sudo: !!sudo, timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      h.log('Done.')
      ctx.audit(serverId, 'files.compress', archive)
    })
    return id
  })

  ctx.handle('files:extract', async (serverId: string, archivePath: string, destDir: string, sudo?: boolean): Promise<string> => {
    const a = normPath(archivePath)
    const d = normPath(destDir)
    const ssh = ctx.ssh(serverId)
    const lower = a.toLowerCase()
    let cmd: string
    if (/\.(tar\.gz|tgz)$/.test(lower)) cmd = `tar -xzf ${shq(a)} -C ${shq(d)}`
    else if (/\.(tar\.xz|txz)$/.test(lower)) {
      await requireTool(ssh, 'xz')
      cmd = `tar -xJf ${shq(a)} -C ${shq(d)}`
    } else if (/\.(tar\.bz2|tbz2?)$/.test(lower)) {
      await requireTool(ssh, 'bzip2')
      cmd = `tar -xjf ${shq(a)} -C ${shq(d)}`
    } else if (/\.(tar\.zst|tzst)$/.test(lower)) {
      await requireTool(ssh, 'zstd')
      cmd = `tar --zstd -xf ${shq(a)} -C ${shq(d)}`
    } else if (lower.endsWith('.tar')) cmd = `tar -xf ${shq(a)} -C ${shq(d)}`
    else if (lower.endsWith('.zip')) {
      await requireTool(ssh, 'unzip')
      cmd = `unzip -o -q ${shq(a)} -d ${shq(d)}`
    } else if (lower.endsWith('.7z')) {
      await requireTool(ssh, '7z')
      cmd = `7z x -y -o${shq(d)} ${shq(a)}`
    } else if (lower.endsWith('.gz')) cmd = `gzip -dc ${shq(a)} > ${shq(posix.join(d, posix.basename(a).replace(/\.gz$/i, '')))}`
    else if (lower.endsWith('.xz')) {
      await requireTool(ssh, 'xz')
      cmd = `xz -dc ${shq(a)} > ${shq(posix.join(d, posix.basename(a).replace(/\.xz$/i, '')))}`
    } else if (lower.endsWith('.bz2')) {
      await requireTool(ssh, 'bzip2')
      cmd = `bzip2 -dc ${shq(a)} > ${shq(posix.join(d, posix.basename(a).replace(/\.bz2$/i, '')))}`
    } else throw new Error('Unknown archive format')
    const { id } = ctx.tasks.start(`Extract ${posix.basename(a)}`, serverId, async (h) => {
      h.log(`> ${cmd}`)
      await ssh.run(`sh -c ${shq(`mkdir -p -- ${shq(d)} && ${cmd}`)}`, { sudo: !!sudo, timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      h.log('Done.')
      ctx.audit(serverId, 'files.extract', `${a} -> ${d}`)
    })
    return id
  })

  // ---------------- lookups ----------------
  ctx.handle('files:usersGroups', async (serverId: string): Promise<UsersGroups> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(`(getent passwd 2>/dev/null || cat /etc/passwd) | cut -d: -f1,3; echo __SM_GROUPS__; (getent group 2>/dev/null || cat /etc/group) | cut -d: -f1,3`, { timeoutMs: 20000 })
    const [u, g] = r.stdout.split('__SM_GROUPS__')
    const parse = (s: string | undefined): string[] => {
      const seen = new Set<string>()
      const list: { name: string; id: number }[] = []
      for (const line of (s ?? '').split('\n')) {
        const [name, id] = line.trim().split(':')
        if (!name || seen.has(name)) continue
        seen.add(name)
        list.push({ name, id: Number(id) || 0 })
      }
      // Regular accounts first (uid >= 1000, root at top), then system accounts.
      list.sort((a, b) => {
        const ra = a.id === 0 ? 0 : a.id >= 1000 && a.id < 65534 ? 1 : 2
        const rb = b.id === 0 ? 0 : b.id >= 1000 && b.id < 65534 ? 1 : 2
        return ra - rb || a.name.localeCompare(b.name)
      })
      return list.map((x) => x.name)
    }
    return { users: parse(u), groups: parse(g) }
  })

  ctx.handle('files:search', async (serverId: string, dir: string, pattern: string, sudo?: boolean): Promise<FileRow[]> => {
    const d = normPath(dir)
    const pat = String(pattern ?? '').trim()
    if (!pat || pat.includes('\0')) throw new Error('Enter something to search for')
    const glob = /[*?[]/.test(pat) ? pat : `*${pat}*`
    const r = await ctx.ssh(serverId).exec(`find -H ${shq(d)} -mindepth 1 -iname ${shq(glob)} -printf ${shq(printfFmt('%p'))} 2>/dev/null`, { sudo: !!sudo, timeoutMs: 120000, maxBuffer: 32 * 1024 * 1024 })
    return parseFind(r.stdout, null).slice(0, FILES_MAX_SEARCH_RESULTS)
  })

  // ---------------- transfers ----------------
  ctx.handle('files:download', async (serverId: string, remotePaths: string[], sudo?: boolean): Promise<string[]> => {
    const ps = normPaths(remotePaths)
    const ssh = ctx.ssh(serverId)
    // Determine which of the paths are directories (following symlinks).
    const kinds = await sh(ssh, ps.map((p) => `if [ -d ${shq(p)} ]; then echo d; elif [ -e ${shq(p)} ]; then echo f; else echo x; fi`).join('; '), { sudo: !!sudo })
    const kindList = kinds.trim().split('\n')
    const missing = ps.filter((_, i) => kindList[i] === 'x')
    if (missing.length) throw new FilesError('ENOENT', `No such file: ${missing[0]}`)
    const win = parentWindow()
    const jobs: { remote: string; local: string; isDir: boolean }[] = []
    if (ps.length === 1 && kindList[0] === 'f') {
      const r = win ? await dialog.showSaveDialog(win, { title: 'Save file', defaultPath: posix.basename(ps[0]) }) : await dialog.showSaveDialog({ title: 'Save file', defaultPath: posix.basename(ps[0]) })
      if (r.canceled || !r.filePath) return []
      jobs.push({ remote: ps[0], local: r.filePath, isDir: false })
    } else {
      const r = win ? await dialog.showOpenDialog(win, { title: 'Choose download folder', properties: ['openDirectory', 'createDirectory'] }) : await dialog.showOpenDialog({ title: 'Choose download folder', properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return []
      const dest = r.filePaths[0]
      ps.forEach((p, i) => jobs.push({ remote: p, local: ljoin(dest, posix.basename(p) || 'root'), isDir: kindList[i] === 'd' }))
    }
    const ids: string[] = []
    const ts = jobs.map((j) => {
      const t = newTransfer(serverId, posix.basename(j.remote) || j.remote, 'download', j.remote, j.local)
      ids.push(t.id)
      emitTransfer(ctx, t, true)
      return t
    })
    void (async () => {
      for (let i = 0; i < jobs.length; i++) await runDownload(ctx, ssh, ts[i], jobs[i].remote, jobs[i].local, jobs[i].isDir, !!sudo)
    })()
    ctx.audit(serverId, 'files.download', ps.join(' '))
    return ids
  })

  ctx.handle('files:upload', async (serverId: string, destDir: string, sudo?: boolean): Promise<string[]> => {
    const d = normPath(destDir)
    const ssh = ctx.ssh(serverId)
    const win = parentWindow()
    const opts: Electron.OpenDialogOptions = { title: 'Choose files to upload', properties: ['openFile', 'multiSelections', 'showHiddenFiles'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return []
    return startUploads(ctx, ssh, serverId, d, r.filePaths, !!sudo)
  })

  ctx.handle('files:uploadPaths', async (serverId: string, destDir: string, localPaths: string[], sudo?: boolean): Promise<string[]> => {
    const d = normPath(destDir)
    if (!Array.isArray(localPaths) || !localPaths.length) return []
    return startUploads(ctx, ctx.ssh(serverId), serverId, d, localPaths.map(String), !!sudo)
  })

  ctx.handle('files:uploadBuffer', async (serverId: string, destDir: string, name: string, data: unknown, sudo?: boolean): Promise<FileRow> => {
    const d = normPath(destDir)
    assertName(name)
    const ssh = ctx.ssh(serverId)
    const buf = toBuffer(data)
    const remote = posix.join(d, name)
    const t = newTransfer(serverId, name, 'upload', remote, '')
    t.total = buf.length
    emitTransfer(ctx, t, true)
    try {
      const sftp = await ssh.sftp()
      if (!sudo) {
        try {
          await sftpWriteFile(sftp, remote, buf)
        } catch (e) {
          throw isPermError(e) ? new FilesError('EACCES', `Permission denied: ${remote}`) : e
        }
      } else {
        const tmp = tmpName('serversysops-up')
        await sftpWriteFile(sftp, tmp, buf)
        try {
          await ssh.sudoRun(`mv -f -- ${shq(tmp)} ${shq(remote)} && { chown --reference=${shq(d)} ${shq(remote)} 2>/dev/null || true; }`)
        } catch (e) {
          await ssh.sudo(`rm -f -- ${shq(tmp)}`).catch(() => {})
          throw e
        }
      }
      t.done = buf.length
      finishTransfer(ctx, t)
    } catch (e) {
      finishTransfer(ctx, t, e)
      throw e
    }
    ctx.audit(serverId, 'files.upload', remote)
    return statOne(ssh, remote, !!sudo, true)
  })

  ctx.handle('files:transfers', async (_serverId: string): Promise<TransferInfo[]> => {
    return [...transfers.values()]
      .map((t) => {
        const { cancelled: _c, cancel: _f, lastEmit: _l, ...info } = t
        return info
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 100)
  })

  ctx.handle('files:cancelTransfer', async (_serverId: string, id: string): Promise<void> => {
    const t = transfers.get(String(id))
    if (!t || t.status !== 'running') return
    t.cancelled = true
    try {
      t.cancel?.()
    } catch {
      /* ignore */
    }
  })

  ctx.handle('files:clearTransfers', async (_serverId: string): Promise<void> => {
    for (const [id, t] of transfers) if (t.status !== 'running') transfers.delete(id)
  })
}

function startUploads(ctx: Ctx, ssh: SshClient, serverId: string, destDir: string, localPaths: string[], sudo: boolean): string[] {
  const ids: string[] = []
  const jobs: { t: Transfer; local: string; remote: string }[] = []
  for (const lp of localPaths) {
    const name = lbasename(lp)
    if (!name || name === '.' || name === '..') continue
    const t = newTransfer(serverId, name, 'upload', posix.join(destDir, name), lp)
    ids.push(t.id)
    emitTransfer(ctx, t, true)
    jobs.push({ t, local: lp, remote: posix.join(destDir, name) })
  }
  void (async () => {
    for (const j of jobs) {
      let isDir = false
      try {
        isDir = (await fsp.stat(j.local)).isDirectory()
      } catch (e) {
        finishTransfer(ctx, j.t, e)
        continue
      }
      await runUpload(ctx, ssh, j.t, j.local, j.remote, isDir, sudo)
    }
  })()
  ctx.audit(serverId, 'files.upload', `${localPaths.length} item(s) -> ${destDir}`)
  return ids
}
