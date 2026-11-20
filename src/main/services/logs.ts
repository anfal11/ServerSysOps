import { dialog } from 'electron'
import { basename } from 'path'
import type { Ctx } from '../core'
import type { AuthEvent, AuthSummary, JournalBoot, JournalQuery, JournalResult, JournalUnits, LogEntry, LogFile } from '@shared/modules/logs'
import { assertAbsPath, shq } from '../ssh/shell'
import type { SshClient } from '../ssh/SshClient'

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const UNIT_RE = /^[A-Za-z0-9@_.:\\-]{1,256}$/
const CURSOR_RE = /^[A-Za-z0-9=;:_+\-/.]{1,512}$/
const BOOT_RE = /^(-?\d{1,3}|[0-9a-fA-F]{32})$/
const SINCE_RE = /^[A-Za-z0-9 :+\-.]{1,64}$/

function clampLines(n: unknown, def = 500, max = 5000): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v <= 0) return def
  return Math.min(max, v)
}

function safeLogPath(p: string): string {
  assertAbsPath(p)
  if (p.includes('..') || /[\n\r]/.test(p)) throw new Error(`Invalid path: ${p}`)
  return p
}

function hasJournal(ssh: SshClient): boolean {
  return ssh.os?.hasSystemd ?? true
}

/* ------------------------------------------------------------------ */
/* journalctl json parsing                                             */
/* ------------------------------------------------------------------ */

type JField = string | number | number[] | null | undefined | (string | null)[]

function fieldText(v: JField): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'number') return Buffer.from(v as number[]).toString('utf8')
    return (v as (string | null)[]).filter((x): x is string => typeof x === 'string').join(' ')
  }
  return String(v)
}

function parseJournalJson(out: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as Record<string, JField>
      const rt = Number(fieldText(o.__REALTIME_TIMESTAMP))
      const unit = fieldText(o._SYSTEMD_UNIT) || fieldText(o.SYSLOG_IDENTIFIER) || fieldText(o._COMM) || (o._TRANSPORT === 'kernel' ? 'kernel' : '')
      const pid = Number(fieldText(o._PID))
      entries.push({
        ts: Number.isFinite(rt) ? Math.floor(rt / 1000) : 0,
        unit: unit.replace(/\.service$/, ''),
        priority: Number(fieldText(o.PRIORITY)) || 6,
        pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
        msg: fieldText(o.MESSAGE),
        cursor: fieldText(o.__CURSOR),
        host: fieldText(o._HOSTNAME) || undefined
      })
    } catch {
      /* skip malformed line */
    }
  }
  return entries
}

function buildJournalCmd(q: JournalQuery, lines: number): string {
  const args: string[] = ['journalctl', '-o', 'json', '--no-pager', '-q']
  if (q.unit) {
    if (!UNIT_RE.test(q.unit)) throw new Error(`Invalid unit name: ${q.unit}`)
    if (q.unit === 'kernel') args.push('-k')
    else args.push('-u', shq(q.unit))
  }
  if (q.priority !== undefined && q.priority !== null && q.priority !== ('' as unknown)) {
    const p = Math.floor(Number(q.priority))
    if (!Number.isInteger(p) || p < 0 || p > 7) throw new Error('Invalid priority')
    args.push('-p', String(p))
  }
  if (q.boot !== undefined && q.boot !== '') {
    if (!BOOT_RE.test(String(q.boot))) throw new Error('Invalid boot id')
    args.push('-b', String(q.boot))
  }
  if (q.since) {
    if (!SINCE_RE.test(q.since)) throw new Error('Invalid --since value')
    args.push('--since', shq(q.since))
  }
  if (q.until) {
    if (!SINCE_RE.test(q.until)) throw new Error('Invalid --until value')
    args.push('--until', shq(q.until))
  }
  if (q.grep) {
    if (q.grep.length > 200) throw new Error('Search pattern too long')
    args.push('--case-sensitive=false', `--grep=${shq(q.grep)}`)
  }
  if (q.cursorAfter) {
    if (!CURSOR_RE.test(q.cursorAfter)) throw new Error('Invalid cursor')
    args.push(`--after-cursor=${shq(q.cursorAfter)}`)
    return `${args.join(' ')} 2>&1 | head -n ${lines + 1}`
  }
  args.push('-n', String(lines))
  return `${args.join(' ')} 2>&1`
}

/* ------------------------------------------------------------------ */
/* auth log parsing                                                    */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

function parseSyslogTs(s: string): number {
  // ISO (journalctl -o short-iso): 2024-05-01T12:00:00+0200
  const iso = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2})(\d{2})?/)
  if (iso) {
    const d = new Date(`${iso[1]}${iso[2]}:${iso[3] ?? '00'}`)
    if (!Number.isNaN(d.getTime())) return d.getTime()
  }
  // rfc3339 (rsyslog high precision): 2024-05-01T12:00:00.123456+02:00
  const rfc = s.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})/)
  if (rfc) {
    const d = new Date(rfc[0])
    if (!Number.isNaN(d.getTime())) return d.getTime()
  }
  // classic: May  1 12:00:00
  const cl = s.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (cl) {
    const now = new Date()
    const d = new Date(now.getFullYear(), MONTHS[cl[1]] ?? 0, Number(cl[2]), Number(cl[3]), Number(cl[4]), Number(cl[5]))
    if (d.getTime() > now.getTime() + 86400000) d.setFullYear(now.getFullYear() - 1)
    return d.getTime()
  }
  return 0
}

function parseAuthLine(line: string): AuthEvent | null {
  const ts = parseSyslogTs(line)
  // strip "ts host proc[pid]: "
  const m = line.match(/^\S+(?:\s+\d{1,2}\s+[\d:]+)?\s+\S+\s+([\w./-]+)(?:\[\d+\])?:\s+(.*)$/)
  if (!m) return null
  const proc = m[1]
  const msg = m[2]
  if (/^sudo$/.test(proc)) {
    const sm = msg.match(/^\s*(\S+)\s*:.*COMMAND=(.*)$/)
    if (sm) return { ts, kind: 'sudo', user: sm[1], msg: `sudo: ${sm[1]} ran ${sm[2].trim()}` }
    if (/authentication failure|incorrect password/i.test(msg)) {
      const um = msg.match(/^\s*(\S+)\s*:/)
      return { ts, kind: 'sudo', user: um?.[1], msg: `sudo: ${msg}` }
    }
    return null
  }
  if (!/sshd/.test(proc)) return null
  let r: RegExpMatchArray | null
  if ((r = msg.match(/^Accepted (\w+) for (\S+) from (\S+) port \d+/))) return { ts, kind: 'accepted', method: r[1], user: r[2], ip: r[3], msg }
  if ((r = msg.match(/^Failed (\w+) for invalid user (\S+) from (\S+)/))) return { ts, kind: 'invalid', method: r[1], user: r[2], ip: r[3], msg }
  if ((r = msg.match(/^Failed (\w+) for (\S+) from (\S+)/))) return { ts, kind: 'failed', method: r[1], user: r[2], ip: r[3], msg }
  if ((r = msg.match(/^Invalid user (\S*) from (\S+)/))) return { ts, kind: 'invalid', user: r[1] || '(empty)', ip: r[2], msg }
  if ((r = msg.match(/^(?:Disconnected from|Connection closed by|Received disconnect from) (?:invalid user |authenticating user )?(\S+)?\s*(\d+\.\d+\.\d+\.\d+|[0-9a-fA-F:]+) port/))) {
    const user = r[1] && !/^\d+\.\d+\.\d+\.\d+$/.test(r[1]) && !/^[0-9a-fA-F:]+$/.test(r[1]) ? r[1] : undefined
    return { ts, kind: 'disconnect', user, ip: r[2], msg }
  }
  if ((r = msg.match(/^(?:Disconnected from|Connection closed by|Received disconnect from) (\S+) port/))) return { ts, kind: 'disconnect', ip: r[1], msg }
  if (/maximum authentication attempts exceeded/i.test(msg)) {
    const mm = msg.match(/for (?:invalid user )?(\S+) from (\S+)/)
    return { ts, kind: 'failed', user: mm?.[1], ip: mm?.[2], msg }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  ctx.handle('logs:units', async (serverId: string): Promise<JournalUnits> => {
    const ssh = ctx.ssh(serverId)
    if (!hasJournal(ssh)) return { units: [], boots: [] }
    const r = await ssh.sudo(`echo __UNITS; journalctl --field _SYSTEMD_UNIT 2>/dev/null | sort -u; echo __BOOTS; journalctl --list-boots --no-pager 2>/dev/null`, { timeoutMs: 60000 })
    const units: string[] = []
    const boots: JournalBoot[] = []
    let cur = ''
    for (const line of r.stdout.split('\n')) {
      if (line === '__UNITS' || line === '__BOOTS') {
        cur = line
        continue
      }
      const t = line.trim()
      if (!t) continue
      if (cur === '__UNITS') {
        if (UNIT_RE.test(t)) units.push(t)
      } else if (cur === '__BOOTS') {
        if (t.startsWith('[')) {
          try {
            for (const b of JSON.parse(t) as { index: number; boot_id: string; first_entry: number; last_entry: number }[]) {
              boots.push({ index: b.index, id: b.boot_id, from: new Date(b.first_entry / 1000).toISOString(), to: new Date(b.last_entry / 1000).toISOString() })
            }
          } catch {
            /* ignore */
          }
          continue
        }
        const m = t.match(/^(-?\d+)\s+([0-9a-f]{32})\s+(.+?)\s+(?:—|–|-{2,})\s+(.+)$/)
        if (m) boots.push({ index: Number(m[1]), id: m[2], from: m[3].trim(), to: m[4].trim() })
      }
    }
    return { units, boots }
  })

  ctx.handle('logs:journal', async (serverId: string, q: JournalQuery): Promise<JournalResult> => {
    const ssh = ctx.ssh(serverId)
    if (!hasJournal(ssh)) throw new Error('This server does not use systemd-journald. Use the Files tab to read /var/log.')
    const lines = clampLines(q?.lines, 500, 5000)
    const query: JournalQuery = { ...(q ?? { lines }), lines }
    const r = await ssh.sudo(buildJournalCmd(query, lines), { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
    let out = r.stdout
    if (/Compiled without pattern matching support|unrecognized option '--grep'/i.test(out) && query.grep) {
      // Fallback for journalctl builds without PCRE2: grep over the JSON message field (case-insensitive, fixed string).
      const r2 = await ssh.sudo(`${buildJournalCmd({ ...query, grep: undefined }, Math.min(5000, lines * 5))} | grep -i -F -- ${shq(query.grep)}`, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
      out = r2.stdout
    }
    if (r.code !== 0 && !out.trim().startsWith('{')) {
      const err = (r.stderr || out).trim()
      if (err && !/No entries|No journal files/i.test(err)) throw new Error(err.split('\n').slice(0, 3).join('\n'))
    }
    let entries = parseJournalJson(out)
    let truncated = false
    if (query.cursorAfter && entries.length > lines) {
      entries = entries.slice(0, lines)
      truncated = true
    }
    return { entries, nextCursor: entries.length ? entries[entries.length - 1].cursor : query.cursorAfter, truncated }
  })

  ctx.handle('logs:files', async (serverId: string): Promise<LogFile[]> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.sudo(`find /var/log -maxdepth 3 -type f -printf '%p\\t%s\\t%T@\\n' 2>/dev/null | sort`, { timeoutMs: 30000 })
    const files: LogFile[] = []
    for (const line of r.stdout.split('\n')) {
      const [path, size, mtime] = line.split('\t')
      if (!path || !path.startsWith('/var/log/')) continue
      const name = basename(path)
      const compressed = /\.(gz|xz|zst|bz2|lz4)$/.test(name)
      const binary = /^(wtmp|btmp|lastlog|utmp|faillog|tallylog)/.test(name) || /\.(journal|db|bin|sqlite|pcap)$/.test(name) || /\/journal\//.test(path)
      files.push({ name, path, dir: path.slice('/var/log/'.length).split('/').slice(0, -1).join('/'), size: Number(size) || 0, mtime: Math.floor((Number(mtime) || 0) * 1000), binary, compressed })
    }
    return files
  })

  ctx.handle('logs:tail', async (serverId: string, opts: { path: string; lines?: number; grep?: string }): Promise<string> => {
    const ssh = ctx.ssh(serverId)
    const path = safeLogPath(opts.path)
    const lines = clampLines(opts.lines, 500, 10000)
    const reader = /\.gz$/.test(path) ? `zcat ${shq(path)}` : /\.xz$/.test(path) ? `xzcat ${shq(path)}` : /\.zst$/.test(path) ? `zstdcat ${shq(path)}` : /\.bz2$/.test(path) ? `bzcat ${shq(path)}` : `cat ${shq(path)}`
    let cmd = reader
    if (opts.grep) {
      if (opts.grep.length > 200) throw new Error('Search pattern too long')
      cmd += ` | grep -i -F -- ${shq(opts.grep)}`
    }
    cmd += ` | tail -n ${lines}`
    const r = await ssh.sudo(`test -r ${shq(path)} || { printf 'cannot read %s\n' ${shq(path)} >&2; exit 2; }; ${cmd}`, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
    if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || `exit ${r.code}`)
    return r.stdout
  })

  ctx.handle('logs:download', async (serverId: string, path: string): Promise<string | null> => {
    const ssh = ctx.ssh(serverId)
    const remote = safeLogPath(path)
    const r = await dialog.showSaveDialog({ defaultPath: basename(remote), title: 'Save log file' })
    if (r.canceled || !r.filePath) return null
    const local = r.filePath
    const id = `log-${Date.now()}`
    const name = basename(remote)
    ctx.emit({ type: 'transfer', id, name, direction: 'download', done: 0, total: 0, status: 'running' })
    const sftp = await ssh.sftp()
    let tmp: string | null = null
    try {
      let src = remote
      if (!ssh.os?.isRoot) {
        // Copy to a temp file owned by the login user so sftp (which runs as that user) can read it.
        const t = await ssh.sudoRun(`t=$(mktemp /tmp/.sm-log-XXXXXX) && cp ${shq(remote)} "$t" && chown ${shq(ssh.profile.username)} "$t" && chmod 600 "$t" && echo "$t"`)
        tmp = t.trim().split('\n').pop() || null
        if (!tmp || !tmp.startsWith('/tmp/.sm-log-')) throw new Error('Could not stage the file for download')
        src = tmp
      }
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(src, local, { step: (done, _chunk, total) => ctx.emit({ type: 'transfer', id, name, direction: 'download', done, total, status: 'running' }) }, (err) => (err ? reject(err) : resolve()))
      })
      ctx.emit({ type: 'transfer', id, name, direction: 'download', done: 1, total: 1, status: 'done' })
      ctx.audit(serverId, 'logs.download', remote)
      return local
    } catch (e) {
      ctx.emit({ type: 'transfer', id, name, direction: 'download', done: 0, total: 0, status: 'failed', error: (e as Error).message })
      throw e
    } finally {
      if (tmp) await ssh.sudo(`rm -f ${shq(tmp)}`).catch(() => {})
    }
  })

  ctx.handle('logs:dmesg', async (serverId: string, lines?: number): Promise<string> => {
    const ssh = ctx.ssh(serverId)
    const n = clampLines(lines, 500, 5000)
    const r = await ssh.sudo(`dmesg -T 2>/dev/null | tail -n ${n} || dmesg 2>/dev/null | tail -n ${n} || journalctl -k --no-pager -q -n ${n} 2>/dev/null`, { timeoutMs: 30000, maxBuffer: 16 * 1024 * 1024 })
    if (!r.stdout && hasJournal(ssh)) {
      const r2 = await ssh.sudo(`journalctl -k --no-pager -q -n ${n} 2>&1`, { timeoutMs: 30000 })
      return r2.stdout
    }
    return r.stdout || r.stderr
  })

  ctx.handle('logs:auth', async (serverId: string, opts?: { lines?: number }): Promise<AuthSummary> => {
    const ssh = ctx.ssh(serverId)
    const n = clampLines(opts?.lines, 1000, 5000)
    const script = hasJournal(ssh)
      ? `if command -v journalctl >/dev/null 2>&1; then echo __SRC journal; echo __EVENTS; journalctl -q --no-pager -o short-iso -n ${n} _COMM=sshd _COMM=sshd-session _COMM=sudo 2>/dev/null; echo __F24; journalctl -q --no-pager --since -24h _COMM=sshd _COMM=sshd-session 2>/dev/null | grep -cE 'Failed password|Invalid user|Failed publickey'; echo __A24; journalctl -q --no-pager --since -24h _COMM=sshd _COMM=sshd-session 2>/dev/null | grep -c 'Accepted '; echo __TOP; journalctl -q --no-pager --since -24h _COMM=sshd _COMM=sshd-session 2>/dev/null | grep -E 'Failed|Invalid user' | grep -oE 'from [0-9a-fA-F.:]+' | awk '{print $2}' | sort | uniq -c | sort -rn | head -10; else echo __SRC file; fi`
      : 'echo __SRC file'
    const r = await ssh.sudo(script, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
    const sec: Record<string, string[]> = {}
    let cur = ''
    let source: AuthSummary['source'] = 'none'
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('__SRC')) {
        source = line.includes('journal') ? 'journal' : 'file'
        continue
      }
      const m = line.match(/^__([A-Z0-9]+)$/)
      if (m) {
        cur = m[1]
        sec[cur] = []
        continue
      }
      if (cur) sec[cur].push(line)
    }
    let eventLines = sec.EVENTS ?? []
    let failed24 = Number((sec.F24 ?? [])[0]) || 0
    let accepted24 = Number((sec.A24 ?? [])[0]) || 0
    let top: { ip: string; count: number }[] = (sec.TOP ?? [])
      .map((l) => l.trim().match(/^(\d+)\s+(\S+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ ip: m[2], count: Number(m[1]) }))

    if (source === 'file' || (source === 'journal' && eventLines.filter(Boolean).length === 0)) {
      const f = await ssh.sudo(`for f in /var/log/auth.log /var/log/secure; do [ -r "$f" ] && { grep -hE 'sshd|sudo' "$f" | tail -n ${n}; break; }; done`, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
      if (f.stdout.trim()) {
        source = 'file'
        eventLines = f.stdout.split('\n')
      } else if (source === 'journal') source = 'journal'
      else source = 'none'
    }
    const events: AuthEvent[] = []
    for (const l of eventLines) {
      if (!l.trim()) continue
      const e = parseAuthLine(l)
      if (e) events.push(e)
    }
    if (source === 'file') {
      const dayAgo = Date.now() - 86400000
      const recent = events.filter((e) => e.ts >= dayAgo)
      failed24 = recent.filter((e) => e.kind === 'failed' || e.kind === 'invalid').length
      accepted24 = recent.filter((e) => e.kind === 'accepted').length
      const counts = new Map<string, number>()
      for (const e of recent) if ((e.kind === 'failed' || e.kind === 'invalid') && e.ip) counts.set(e.ip, (counts.get(e.ip) ?? 0) + 1)
      top = [...counts.entries()].map(([ip, count]) => ({ ip, count })).sort((a, b) => b.count - a.count).slice(0, 10)
    }
    events.reverse()
    return { events, accepted24h: accepted24, failed24h: failed24, topIps: top, source }
  })
}
