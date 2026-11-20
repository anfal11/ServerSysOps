import type { Ctx } from '../core'
import type { ListeningPort, ProcessInfo, ServiceInfo } from '@shared/types'
import type { ProcDetail, ProcListResult, ProcSignal, SvcAction, SvcListResult, SvcStatusResult } from '@shared/modules/processes'
import type { SshClient } from '../ssh/SshClient'
import { shq } from '../ssh/shell'

const SIGNALS: ProcSignal[] = ['TERM', 'KILL', 'STOP', 'CONT', 'HUP', 'INT']
const SVC_ACTIONS: SvcAction[] = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask']
const UNIT_SUFFIXES = ['.service', '.socket', '.timer', '.target', '.mount', '.path', '.slice', '.scope']

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function assertPid(pid: unknown): number {
  const n = Number(pid)
  if (!Number.isInteger(n) || n < 1 || n > 4194304) throw new Error(`Invalid pid: ${pid}`)
  return n
}

function assertKillablePid(pid: unknown): number {
  const n = assertPid(pid)
  if (n === 1) throw new Error('Refusing to signal PID 1 (init)')
  return n
}

/** Validate a systemd unit name; appends ".service" when no unit suffix is given. */
export function assertUnitName(unit: string): string {
  if (typeof unit !== 'string') throw new Error('Invalid unit name')
  let u = unit.trim()
  if (!u || u.length > 256 || !/^[A-Za-z0-9_.@:\\\-]+$/.test(u) || u.includes('..')) throw new Error(`Invalid unit name: ${unit}`)
  if (!UNIT_SUFFIXES.some((s) => u.endsWith(s))) u += '.service'
  return u
}

export function fmtElapsed(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function parseSections(stdout: string): Record<string, string[]> {
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of stdout.split('\n')) {
    const m = line.match(/^__([A-Z]+)$/)
    if (m) {
      cur = m[1]
      sec[cur] = []
    } else if (cur) sec[cur].push(line)
  }
  return sec
}

/* ------------------------------------------------------------------ */
/* ps parsing                                                           */
/* ------------------------------------------------------------------ */

const PS_CMD = 'ps -eo pid=,ppid=,user:32=,pcpu=,pmem=,rss=,stat=,etimes=,args= --sort=-pcpu'

export function parsePsLine(line: string): ProcessInfo | null {
  const t = line.trim()
  if (!t) return null
  // First 8 columns never contain spaces; args is the remainder of the line.
  const m = t.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\d+)\s*(.*)$/)
  if (!m) return null
  const args = m[9] ?? ''
  let command: string
  let rest: string
  if (args.startsWith('[') && args.endsWith(']')) {
    command = args
    rest = ''
  } else {
    const sp = args.search(/\s/)
    const first = sp >= 0 ? args.slice(0, sp) : args
    rest = sp >= 0 ? args.slice(sp + 1).trim() : ''
    command = basename(first).replace(/:$/, '') || first
  }
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    user: m[3],
    cpu: Number(m[4]) || 0,
    mem: Number(m[5]) || 0,
    rss: (Number(m[6]) || 0) * 1024,
    stat: m[7],
    elapsed: fmtElapsed(Number(m[8])),
    command,
    args: rest
  }
}

/* ------------------------------------------------------------------ */
/* systemctl parsing                                                    */
/* ------------------------------------------------------------------ */

function parseUnits(out: string): { unit: string; load: string; active: string; sub: string; description: string }[] {
  const t = out.trim()
  if (!t) return []
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as Record<string, unknown>[]
      return arr.map((u) => ({ unit: String(u.unit ?? ''), load: String(u.load ?? ''), active: String(u.active ?? ''), sub: String(u.sub ?? ''), description: String(u.description ?? '') }))
    } catch {
      /* fall through */
    }
  }
  return t
    .split('\n')
    .map((l) => l.replace(/^[●*]\s*/, '').trim())
    .filter((l) => l && !/^UNIT\s+LOAD/.test(l) && !/^\d+ loaded units listed/.test(l) && !/^(LOAD|ACTIVE|SUB)\s+=/.test(l) && !/^To show all/.test(l))
    .map((l) => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/)
      return m ? { unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5] ?? '' } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

function parseUnitFiles(out: string): Map<string, string> {
  const map = new Map<string, string>()
  const t = out.trim()
  if (!t) return map
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as Record<string, unknown>[]
      for (const u of arr) map.set(String(u.unit_file ?? ''), String(u.state ?? ''))
      return map
    } catch {
      /* fall through */
    }
  }
  for (const l of t.split('\n')) {
    const m = l.trim().match(/^(\S+\.service)\s+(\S+)/)
    if (m && m[1] !== 'UNIT') map.set(m[1], m[2])
  }
  return map
}

async function sudoIfPossible(ssh: SshClient, cmd: string, timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  if (ssh.os?.sudoAvailable) {
    try {
      return await ssh.sudo(cmd, { timeoutMs })
    } catch {
      /* sudo refused (no password) – fall back to the plain user */
    }
  }
  return ssh.exec(cmd, { timeoutMs })
}

/* ------------------------------------------------------------------ */
/* ss / netstat parsing                                                 */
/* ------------------------------------------------------------------ */

function splitHostPort(local: string): { address: string; port: number } {
  const i = local.lastIndexOf(':')
  if (i < 0) return { address: local, port: 0 }
  let address = local.slice(0, i)
  const port = Number(local.slice(i + 1)) || 0
  address = address.replace(/%[^\]]*$/, '').replace(/\]%.*$/, ']')
  return { address, port }
}

export function parseSs(out: string): { rows: ListeningPort[]; pids: Set<number> } {
  const rows: ListeningPort[] = []
  const pids = new Set<number>()
  const seen = new Set<string>()
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t || /^Netid\s/.test(t)) continue
    const parts = t.split(/\s+/)
    if (parts.length < 5) continue
    const netid = parts[0].toLowerCase()
    if (!/^(tcp|udp)6?$/.test(netid)) continue
    // Columns: Netid State Recv-Q Send-Q Local Peer [Process]
    let local = parts[4]
    let procIdx = 6
    // Some ss builds omit the State column for UDP without -a; detect by numeric Recv-Q position.
    if (!/^\d+$/.test(parts[2]) && /^\d+$/.test(parts[1])) {
      local = parts[3]
      procIdx = 5
    }
    const { address, port } = splitHostPort(local)
    const proto = netid.endsWith('6') ? netid : address.startsWith('[') ? `${netid}6` : netid
    const procField = parts.slice(procIdx).join(' ')
    const procs = [...procField.matchAll(/\("([^"]*)",pid=(\d+)/g)].map((m) => ({ name: m[1], pid: Number(m[2]) }))
    if (procs.length === 0) {
      const key = `${proto}|${address}|${port}|-`
      if (!seen.has(key)) {
        seen.add(key)
        rows.push({ proto, address, port, process: '' })
      }
      continue
    }
    for (const p of procs) {
      const key = `${proto}|${address}|${port}|${p.pid}`
      if (seen.has(key)) continue
      seen.add(key)
      pids.add(p.pid)
      rows.push({ proto, address, port, process: p.name, pid: p.pid })
    }
  }
  return { rows, pids }
}

function parseNetstat(out: string): { rows: ListeningPort[]; pids: Set<number> } {
  const rows: ListeningPort[] = []
  const pids = new Set<number>()
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6 || !/^(tcp|udp)6?$/.test(parts[0])) continue
    const proto = parts[0]
    const { address, port } = splitHostPort(parts[3])
    const pidProg = parts[parts.length - 1]
    const m = pidProg.match(/^(\d+)\/(.+)$/)
    const pid = m ? Number(m[1]) : undefined
    if (pid) pids.add(pid)
    rows.push({ proto, address, port, process: m ? m[2] : '', pid })
  }
  return { rows, pids }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                             */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  // ---------------- processes ----------------
  ctx.handle('proc:list', async (serverId: string, opts?: { hideKernel?: boolean }): Promise<ProcListResult> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(`cat /proc/loadavg; echo __PS; ${PS_CMD}`, { timeoutMs: 30000, maxBuffer: 32 * 1024 * 1024 })
    const [head, ...rest] = r.stdout.split('__PS\n')
    const psOut = rest.join('__PS\n')
    if (!psOut.trim()) throw new Error((r.stderr || 'ps returned no output (procps missing?)').trim())
    const la = head.trim().split(/\s+/)
    const load: [number, number, number] = [Number(la[0]) || 0, Number(la[1]) || 0, Number(la[2]) || 0]
    const all: ProcessInfo[] = []
    for (const line of psOut.split('\n')) {
      const p = parsePsLine(line)
      if (p) all.push(p)
    }
    const processes = opts?.hideKernel ? all.filter((p) => !(p.command.startsWith('[') && p.command.endsWith(']'))) : all
    return { processes, total: all.length, load }
  })

  ctx.handle('proc:signal', async (serverId: string, pidRaw: number, signal: ProcSignal) => {
    const pid = assertKillablePid(pidRaw)
    if (!SIGNALS.includes(signal)) throw new Error(`Unsupported signal: ${signal}`)
    const ssh = ctx.ssh(serverId)
    const cmd = `kill -${signal} ${pid}`
    let r = await ssh.exec(cmd, { timeoutMs: 15000 })
    if (r.code !== 0 && ssh.os?.sudoAvailable && !ssh.os.isRoot) r = await ssh.sudo(cmd, { timeoutMs: 15000 })
    if (r.code !== 0) throw new Error(r.stderr.trim() || `kill failed (exit ${r.code})`)
    ctx.audit(serverId, 'proc.signal', `SIG${signal} -> ${pid}`)
  })

  ctx.handle('proc:renice', async (serverId: string, pidRaw: number, niceRaw: number) => {
    const pid = assertKillablePid(pidRaw)
    const nice = Math.max(-20, Math.min(19, Math.trunc(Number(niceRaw) || 0)))
    const ssh = ctx.ssh(serverId)
    const cmd = `renice -n ${nice} -p ${pid}`
    let r = await ssh.exec(cmd, { timeoutMs: 15000 })
    if (r.code !== 0 && ssh.os?.sudoAvailable && !ssh.os.isRoot) r = await ssh.sudo(cmd, { timeoutMs: 15000 })
    if (r.code !== 0) throw new Error(r.stderr.trim() || `renice failed (exit ${r.code})`)
    ctx.audit(serverId, 'proc.renice', `${pid} -> ${nice}`)
  })

  ctx.handle('proc:detail', async (serverId: string, pidRaw: number): Promise<ProcDetail> => {
    const pid = assertPid(pidRaw)
    const ssh = ctx.ssh(serverId)
    const p = `/proc/${pid}`
    const script = `
[ -d ${p} ] || { echo "__GONE"; exit 0; }
echo __CMDLINE; tr '\\0' ' ' < ${p}/cmdline 2>/dev/null; echo
echo __CWD; readlink ${p}/cwd 2>/dev/null
echo __EXE; readlink ${p}/exe 2>/dev/null
echo __STATUS; grep -E '^(Name|State|PPid|Uid|Gid|Threads|VmPeak|VmSize|VmRSS|VmSwap|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):' ${p}/status 2>/dev/null
echo __FDS; ls ${p}/fd 2>/dev/null | wc -l
echo __LIMITS; grep -E '^Max (open files|processes|locked memory|address space|cpu time)' ${p}/limits 2>/dev/null
echo __CHILDREN; ps -o pid=,comm= --ppid ${pid} 2>/dev/null
echo __IO; cat ${p}/io 2>/dev/null
echo __CGROUP; head -3 ${p}/cgroup 2>/dev/null
echo __UNIT; systemctl status ${pid} --no-pager 2>/dev/null | head -1
echo __PS; ps -o nice=,lstart= -p ${pid} 2>/dev/null
echo __END`
    const r = await sudoIfPossible(ssh, script, 20000)
    if (r.stdout.includes('__GONE')) throw new Error(`Process ${pid} no longer exists`)
    const sec = parseSections(r.stdout)
    const status: Record<string, string> = {}
    for (const l of sec.STATUS ?? []) {
      const m = l.match(/^([A-Za-z_]+):\s*(.*)$/)
      if (m) status[m[1]] = m[2].trim()
    }
    const io: Record<string, number> = {}
    for (const l of sec.IO ?? []) {
      const m = l.match(/^(\w+):\s*(\d+)/)
      if (m) io[m[1]] = Number(m[2])
    }
    const children = (sec.CHILDREN ?? [])
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ pid: Number(m[1]), name: m[2] }))
    const cgroup = (sec.CGROUP ?? []).map((l) => l.trim()).filter(Boolean).join('\n')
    let unit: string | undefined
    const cgUnit = cgroup.match(/\/([^/\s]+\.(service|scope|slice))(?:\/|$)/)
    if (cgUnit) unit = cgUnit[1]
    const unitLine = (sec.UNIT?.[0] ?? '').replace(/^[●*]\s*/, '').trim()
    if (!unit && unitLine) unit = unitLine.split(/\s+/)[0]
    const ps = (sec.PS?.[0] ?? '').trim().match(/^(-?\d+)\s+(.*)$/)
    return {
      pid,
      cmdline: (sec.CMDLINE ?? []).join(' ').trim(),
      cwd: (sec.CWD?.[0] ?? '').trim(),
      exe: (sec.EXE?.[0] ?? '').trim(),
      status,
      openFiles: Number((sec.FDS?.[0] ?? '').trim()) || 0,
      limits: (sec.LIMITS ?? []).map((l) => l.replace(/\s{2,}/g, '  ').trim()).filter(Boolean),
      children,
      io,
      cgroup,
      unit,
      nice: ps ? Number(ps[1]) : undefined,
      started: ps ? ps[2] : undefined,
      threads: status.Threads ? Number(status.Threads) : undefined
    }
  })

  // ---------------- services ----------------
  ctx.handle('svc:list', async (serverId: string): Promise<SvcListResult> => {
    const ssh = ctx.ssh(serverId)
    if (ssh.os && !ssh.os.hasSystemd) {
      const r = await sudoIfPossible(ssh, 'service --status-all 2>&1 || ls /etc/init.d 2>/dev/null')
      const services: ServiceInfo[] = []
      for (const line of r.stdout.split('\n')) {
        const m = line.match(/^\s*\[\s*([+\-?])\s*\]\s+(\S+)/)
        if (m) {
          const st = m[1] === '+' ? 'active' : m[1] === '-' ? 'inactive' : 'unknown'
          services.push({ name: m[2], description: '', load: 'init.d', active: st, sub: st === 'active' ? 'running' : st === 'inactive' ? 'dead' : 'unknown', enabled: '' })
        } else if (/^[A-Za-z0-9_.-]+$/.test(line.trim()) && !line.includes(' ')) {
          services.push({ name: line.trim(), description: '', load: 'init.d', active: 'unknown', sub: 'unknown', enabled: '' })
        }
      }
      return { systemd: false, services, failed: 0 }
    }
    const script = `echo __UNITS; systemctl list-units --type=service --all --no-pager --output=json 2>/dev/null || systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null
echo __FILES; systemctl list-unit-files --type=service --no-pager --output=json 2>/dev/null || systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>/dev/null
echo __END`
    const r = await ssh.exec(script, { timeoutMs: 30000 })
    const sec = parseSections(r.stdout)
    const units = parseUnits((sec.UNITS ?? []).join('\n'))
    const files = parseUnitFiles((sec.FILES ?? []).join('\n'))
    const seen = new Set<string>()
    const services: ServiceInfo[] = units.map((u) => {
      seen.add(u.unit)
      let enabled = files.get(u.unit) ?? ''
      if (!enabled && u.unit.includes('@')) enabled = files.get(u.unit.replace(/@[^.]*\./, '@.')) ?? ''
      return { name: u.unit, description: u.description, load: u.load, active: u.active, sub: u.sub, enabled }
    })
    // Unit files that are installed but not loaded (disabled, never started) still deserve a row.
    for (const [name, state] of files) {
      if (seen.has(name) || name.includes('@.') || state === 'alias' || state === 'masked-runtime') continue
      services.push({ name, description: '', load: 'not-loaded', active: 'inactive', sub: 'dead', enabled: state })
    }
    services.sort((a, b) => a.name.localeCompare(b.name))
    return { systemd: true, services, failed: services.filter((s) => s.active === 'failed').length }
  })

  ctx.handle('svc:failed', async (serverId: string): Promise<number> => {
    const ssh = ctx.ssh(serverId)
    if (ssh.os && !ssh.os.hasSystemd) return 0
    const r = await ssh.exec('systemctl list-units --type=service --state=failed --no-pager --plain --no-legend 2>/dev/null | grep -c .', { timeoutMs: 15000 })
    return Number(r.stdout.trim()) || 0
  })

  ctx.handle('svc:action', async (serverId: string, unitRaw: string, action: SvcAction) => {
    const ssh = ctx.ssh(serverId)
    if (!SVC_ACTIONS.includes(action)) throw new Error(`Unsupported action: ${action}`)
    if (ssh.os && !ssh.os.hasSystemd) {
      const name = unitRaw.replace(/\.service$/, '')
      if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(name)) throw new Error(`Invalid service name: ${unitRaw}`)
      if (!['start', 'stop', 'restart', 'reload'].includes(action)) throw new Error('Only start/stop/restart/reload are available without systemd')
      await ssh.sudoRun(`service ${shq(name)} ${action} 2>&1`, { timeoutMs: 120000 })
      ctx.audit(serverId, 'service', `${action} ${name}`)
      return
    }
    const unit = assertUnitName(unitRaw)
    const r = await ssh.sudo(`systemctl ${action} ${shq(unit)} 2>&1`, { timeoutMs: 180000 })
    if (r.code !== 0) {
      const detail = await ssh.exec(`systemctl status ${shq(unit)} --no-pager -l 2>&1 | tail -n 15`, { timeoutMs: 15000 }).catch(() => ({ stdout: '' }))
      throw new Error(((r.stdout + r.stderr).trim() || `systemctl ${action} failed`) + (detail.stdout.trim() ? `\n\n${detail.stdout.trim()}` : ''))
    }
    ctx.audit(serverId, 'service', `${action} ${unit}`)
  })

  ctx.handle('svc:status', async (serverId: string, unitRaw: string, lines = 100): Promise<SvcStatusResult> => {
    const ssh = ctx.ssh(serverId)
    const n = Math.max(10, Math.min(2000, Math.floor(Number(lines) || 100)))
    if (ssh.os && !ssh.os.hasSystemd) {
      const name = unitRaw.replace(/\.service$/, '')
      if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(name)) throw new Error(`Invalid service name: ${unitRaw}`)
      const r = await sudoIfPossible(ssh, `service ${shq(name)} status 2>&1; echo __LOGS; tail -n ${n} /var/log/${shq(name)}.log /var/log/${shq(name)}/*.log 2>/dev/null`)
      const [status, logs] = r.stdout.split('__LOGS\n')
      return { status: status.trim(), logs: (logs ?? '').trim(), activeState: /running|started/i.test(status) ? 'active' : 'inactive' }
    }
    const unit = assertUnitName(unitRaw)
    const script = `systemctl status ${shq(unit)} --no-pager -l 2>&1; echo __LOGS; journalctl -u ${shq(unit)} -n ${n} --no-pager -o short-iso 2>&1; echo __STATE; systemctl is-active ${shq(unit)} 2>/dev/null`
    const r = await sudoIfPossible(ssh, script, 30000)
    const [status, rest] = r.stdout.split('__LOGS\n')
    const [logs, state] = (rest ?? '').split('__STATE\n')
    return { status: (status ?? '').trim(), logs: (logs ?? '').trim(), activeState: (state ?? '').trim() || 'unknown' }
  })

  ctx.handle('svc:unitFile', async (serverId: string, unitRaw: string): Promise<string> => {
    const ssh = ctx.ssh(serverId)
    if (ssh.os && !ssh.os.hasSystemd) {
      const name = unitRaw.replace(/\.service$/, '')
      if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(name)) throw new Error(`Invalid service name: ${unitRaw}`)
      const r = await sudoIfPossible(ssh, `cat /etc/init.d/${shq(name)} 2>&1`)
      return r.stdout
    }
    const unit = assertUnitName(unitRaw)
    const r = await ssh.exec(`systemctl cat ${shq(unit)} --no-pager 2>&1`, { timeoutMs: 15000 })
    if (r.code !== 0) throw new Error(r.stdout.trim() || r.stderr.trim() || `No unit file for ${unit}`)
    return r.stdout
  })

  // ---------------- listening ports ----------------
  ctx.handle('ports:list', async (serverId: string): Promise<ListeningPort[]> => {
    const ssh = ctx.ssh(serverId)
    const script = `if command -v ss >/dev/null 2>&1; then echo __SS; ss -tulpnH 2>/dev/null || ss -tulpn 2>/dev/null | tail -n +2; else echo __NETSTAT; netstat -tulpn 2>/dev/null; fi`
    const r = await sudoIfPossible(ssh, script, 30000)
    const useSs = r.stdout.includes('__SS')
    const body = r.stdout.replace(/^__(SS|NETSTAT)\n?/m, '')
    const { rows, pids } = useSs ? parseSs(body) : parseNetstat(body)
    if (pids.size) {
      const list = [...pids].slice(0, 2000).join(',')
      const u = await ssh.exec(`ps -o pid=,user= -p ${list} 2>/dev/null`, { timeoutMs: 15000 }).catch(() => ({ stdout: '' }))
      const users = new Map<number, string>()
      for (const l of u.stdout.split('\n')) {
        const m = l.trim().match(/^(\d+)\s+(\S+)/)
        if (m) users.set(Number(m[1]), m[2])
      }
      for (const row of rows) if (row.pid) row.user = users.get(row.pid)
    }
    rows.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.address.localeCompare(b.address))
    return rows
  })
}
