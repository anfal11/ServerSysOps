import type { Ctx } from '../core'
import type { ListeningPort } from '@shared/types'
import type { AddRuleInput, BlockIpInput, BlockedIp, BlockedPacket, ExposedPort, FirewallPreset, FirewallRuleEx, FirewallStateEx, FirewalldZone, FwBackend, FwLogLevel, FwPolicy, IptPolicies, UnblockIpInput } from '@shared/modules/firewall'
import { SshClient, type ExecOptions } from '../ssh/SshClient'
import { shJoin, shq } from '../ssh/shell'
import { installCmd, runPkg } from './pkg'
import { getSecrets, getServer } from '../store/servers'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ParsedTo {
  /** Port numbers covered (expanded ranges capped); empty = any port. */
  ports: number[]
  proto: 'tcp' | 'udp' | 'any'
  anyPort: boolean
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const IP_RE = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/
const PORT_LIST_RE = /^\d{1,5}(,\d{1,5})*$/
const PORT_RANGE_RE = /^\d{1,5}[:-]\d{1,5}$/
const ACTIONS = ['allow', 'deny', 'reject', 'limit'] as const
const LOG_LEVELS: FwLogLevel[] = ['off', 'low', 'medium', 'high', 'full']
const SSH_COMMENT = 'SSH (ServerSysOps)'
const BLOCK_COMMENT = 'ServerSysOps block'

function assertIp(s: string, what = 'address'): string {
  const v = String(s).trim()
  if (!IP_RE.test(v) || v.length > 48) throw new Error(`Invalid ${what}: ${v.slice(0, 48)}`)
  const [ip, mask] = v.split('/')
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
  const isV6 = ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip) && ip.split(':').length <= 8
  if (!isV4 && !isV6) throw new Error(`Invalid ${what}: ${v}`)
  if (isV4 && ip.split('.').some((o) => Number(o) > 255)) throw new Error(`Invalid ${what}: ${v}`)
  if (mask !== undefined) {
    const m = Number(mask)
    if (m < 0 || m > (isV4 ? 32 : 128)) throw new Error(`Invalid prefix length in ${v}`)
  }
  return v
}

function isV6(s: string): boolean {
  return s.includes(':')
}

/** `1.2.3.4/32` -> `1.2.3.4`, `2001:db8::1/128` -> `2001:db8::1`. */
function stripHostMask(ip: string): string {
  return ip.replace(/\/32$/, '').replace(/\/128$/, '')
}

/** Address -> 32/128-bit integer (IPv4-mapped IPv6 is treated as IPv4). Returns null when not parseable. */
function ipToBig(ipRaw: string): { v: bigint; bits: 32 | 128 } | null {
  let s = ipRaw.trim()
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const o = s.split('.').map(Number)
    if (o.some((n) => n > 255)) return null
    return { v: BigInt(o[0] * 16777216 + o[1] * 65536 + o[2] * 256 + o[3]), bits: 32 }
  }
  if (!s.includes(':')) return null
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  const halves = s.split('::')
  if (halves.length > 2) return null
  const expand = (part: string): string[] | null => {
    if (!part) return []
    const groups = part.split(':')
    const last = groups[groups.length - 1]
    if (last.includes('.')) {
      const o = last.split('.').map(Number)
      if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n > 255)) return null
      return [...groups.slice(0, -1), (o[0] * 256 + o[1]).toString(16), (o[2] * 256 + o[3]).toString(16)]
    }
    return groups
  }
  const head = expand(halves[0])
  const tail = halves.length === 2 ? expand(halves[1]) : []
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  let v = BigInt(0)
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    v = (v << BigInt(16)) | BigInt(parseInt(g, 16))
  }
  return { v, bits: 128 }
}

/** True when `ip` lies inside `cidr` (a plain address counts as a host route). */
function cidrContains(cidr: string, ip: string): boolean {
  const [base, maskStr] = cidr.split('/')
  const a = ipToBig(base)
  const b = ipToBig(ip)
  if (!a || !b || a.bits !== b.bits) return false
  const mask = maskStr === undefined ? a.bits : Number(maskStr)
  if (mask <= 0) return true
  const shift = BigInt(a.bits - Math.min(mask, a.bits))
  return a.v >> shift === b.v >> shift
}

/** Normalize a port spec: `80`, `80,443` or `6000:6100` -> validated string (ranges use ':' for ufw, '-' for firewalld). */
function normalizePort(p: string | number | undefined): { spec: string; ports: number[]; range: boolean; list: boolean } | null {
  if (p === undefined || p === null || p === '') return null
  const s = String(p).replace(/\s+/g, '')
  const check = (n: string): number => {
    const v = Number(n)
    if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`Invalid port: ${n}`)
    return v
  }
  if (PORT_RANGE_RE.test(s)) {
    const [a, b] = s.split(/[:-]/).map(check)
    if (a >= b) throw new Error(`Invalid port range: ${s}`)
    return { spec: `${a}:${b}`, ports: [a, b], range: true, list: false }
  }
  if (PORT_LIST_RE.test(s)) {
    const ports = [...new Set(s.split(',').map(check))]
    if (ports.length > 15) throw new Error('At most 15 ports per rule')
    return { spec: ports.join(','), ports, range: false, list: ports.length > 1 }
  }
  throw new Error(`Invalid port specification: ${s.slice(0, 32)} (use 80, 80,443 or 6000:6100)`)
}

function cleanComment(c: string | undefined): string {
  return (c ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/['"\\`$]/g, '')
    .trim()
    .slice(0, 60)
}

/* ------------------------------------------------------------------ */
/* Shell helpers                                                       */
/* ------------------------------------------------------------------ */

/** sudo applies to the first word only: wrap scripts in `sh -c` so the whole thing runs as root. */
function rootExec(ssh: SshClient, script: string, opts: ExecOptions = {}): ReturnType<SshClient['exec']> {
  return ssh.exec(`sh -c ${shq(script)}`, { ...opts, sudo: true })
}

async function rootRun(ssh: SshClient, script: string, opts: ExecOptions = {}): Promise<string> {
  const r = await rootExec(ssh, script, opts)
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || `exit code ${r.code}`).trim()
    throw new Error(msg.split('\n').slice(-6).join('\n'))
  }
  return r.stdout
}

function sectionize(out: string): Record<string, string[]> {
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.split('\n')) {
    const m = line.match(/^__([A-Z0-9]+)$/)
    if (m) {
      cur = m[1]
      sec[cur] = []
    } else if (cur) sec[cur].push(line)
  }
  return sec
}

/** Open a second SSH connection with the stored credentials to verify we are not locked out. */
async function probeLogin(ctx: Ctx, serverId: string): Promise<boolean> {
  const profile = getServer(serverId)
  if (!profile) return false
  let jump: SshClient | undefined
  if (profile.jumpHostId) {
    try {
      jump = ctx.sessions.get(profile.jumpHostId)
    } catch {
      jump = undefined
    }
  }
  const c = new SshClient({ ...profile }, getSecrets(serverId), jump)
  try {
    await c.connect()
    const r = await c.exec('echo ok', { timeoutMs: 10000 })
    c.disconnect()
    return r.stdout.includes('ok')
  } catch {
    try {
      c.disconnect()
    } catch {
      /* ignore */
    }
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Client address of the SSH session this app uses (`$SSH_CONNECTION` / `$SSH_CLIENT` of the login shell). */
async function sshClientIp(ssh: SshClient): Promise<string | undefined> {
  const r = await ssh.exec(`printf %s "\${SSH_CONNECTION:-$SSH_CLIENT}" | cut -d' ' -f1`, { timeoutMs: 10000 }).catch(() => ({ stdout: '' }))
  const ip = r.stdout.trim().replace(/^::ffff:/i, '')
  return ip && IP_RE.test(ip) && !ip.includes('/') ? ip : undefined
}

/* ------------------------------------------------------------------ */
/* Rule parsing / matching                                             */
/* ------------------------------------------------------------------ */

const APP_PORTS: Record<string, string> = { openssh: '22/tcp', ssh: '22/tcp', 'nginx full': '80,443/tcp', 'nginx http': '80/tcp', 'nginx https': '443/tcp', 'apache full': '80,443/tcp', apache: '80/tcp', 'apache secure': '443/tcp', 'www full': '80,443/tcp', www: '80/tcp', 'www secure': '443/tcp', 'dns': '53', 'mail': '25/tcp', 'smtp': '25/tcp', 'imaps': '993/tcp', 'pop3s': '995/tcp', 'samba': '137,138,139,445', 'nfs': '2049', 'cups': '631' }

/** Service names firewalld ships; only the common ones are needed to compute "SSH allowed" / exposure. */
const FWD_SERVICE_PORTS: Record<string, string> = { ssh: '22/tcp', http: '80/tcp', https: '443/tcp', mysql: '3306/tcp', postgresql: '5432/tcp', mongodb: '27017/tcp', redis: '6379/tcp', smtp: '25/tcp', 'smtp-submission': '587/tcp', imaps: '993/tcp', dns: '53', 'docker-swarm': '2377/tcp', wireguard: '51820/udp', openvpn: '1194/udp', minecraft: '25565/tcp', rdp: '3389/tcp', samba: '445,139/tcp', nfs: '2049', 'dhcpv6-client': '546/udp', cockpit: '9090/tcp', mdns: '5353/udp', ftp: '21/tcp', ntp: '123/udp', 'ms-wbt': '3389/tcp', 'kube-apiserver': '6443/tcp', 'etcd-client': '2379/tcp', vnc: '5900/tcp', 'smtps': '465/tcp', imap: '143/tcp', pop3: '110/tcp', pop3s: '995/tcp', ldap: '389/tcp', ldaps: '636/tcp', 'elasticsearch': '9200/tcp', 'grafana': '3000/tcp', 'prometheus': '9090/tcp', 'syslog': '514/udp', 'snmp': '161/udp' }

/** Interpret the `To` column of a rule (`22/tcp`, `80,443/tcp`, `6000:6100/udp`, `Anywhere`, `Anywhere/tcp`, `OpenSSH`, `ssh (service)`, `22/tcp on eth0`). */
function parseTo(toRaw: string): ParsedTo {
  let to = toRaw.replace(/\s*\(v6\)\s*/g, ' ').replace(/\s+on\s+\S+$/, '').replace(/\s*\(service\)\s*$/, '').trim()
  const lower = to.toLowerCase()
  if (APP_PORTS[lower]) to = APP_PORTS[lower]
  else if (FWD_SERVICE_PORTS[lower]) to = FWD_SERVICE_PORTS[lower]
  if (!to || /^anywhere$/i.test(to) || /^[0-9a-f.:]+(\/\d+)?$/i.test(to)) return { ports: [], proto: 'any', anyPort: true }
  const anyProto = to.match(/^anywhere\/(tcp|udp)$/i)
  if (anyProto) return { ports: [], proto: anyProto[1].toLowerCase() as 'tcp' | 'udp', anyPort: true }
  const m = to.match(/^([\d,:-]+)(?:\/(tcp|udp))?$/i)
  if (!m) return { ports: [], proto: 'any', anyPort: false }
  const proto = (m[2]?.toLowerCase() as 'tcp' | 'udp' | undefined) ?? 'any'
  const ports: number[] = []
  for (const part of m[1].split(',')) {
    const r = part.match(/^(\d+)[:-](\d+)$/)
    if (r) {
      const a = Number(r[1])
      const b = Number(r[2])
      for (let p = a; p <= Math.min(b, a + 20000); p++) ports.push(p)
    } else if (/^\d+$/.test(part)) ports.push(Number(part))
  }
  return { ports, proto, anyPort: false }
}

function ruleCovers(rule: FirewallRuleEx, port: number, proto: 'tcp' | 'udp'): boolean {
  if (rule.direction !== 'in') return false
  if (!/^(ALLOW|LIMIT)/i.test(rule.action)) return false
  const t = parseTo(rule.to)
  if (t.proto !== 'any' && t.proto !== proto) return false
  if (t.anyPort) return true
  return t.ports.includes(port)
}

/** Does a rule allow the port from any source (not restricted to a specific IP)? */
function ruleAllowsFromAnywhere(rule: FirewallRuleEx, port: number, proto: 'tcp' | 'udp'): boolean {
  return ruleCovers(rule, port, proto) && /^anywhere$/i.test(rule.from.replace(/\s*\(v6\)\s*/g, '').trim())
}

/* ------------------------------------------------------------------ */
/* ufw parsing                                                         */
/* ------------------------------------------------------------------ */

const UFW_ACTION_RE = /\s(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?(?=\s|$)/

/** Parse rows of `ufw status numbered` (`[ 1] 22/tcp   ALLOW IN   Anywhere   # comment`). */
function parseUfwNumbered(lines: string[]): FirewallRuleEx[] {
  const out: FirewallRuleEx[] = []
  for (const raw of lines) {
    const m = raw.match(/^\[\s*(\d+)\]\s+(.*)$/)
    if (!m) continue
    const rest = m[2]
    const a = rest.match(UFW_ACTION_RE)
    if (!a || a.index === undefined) continue
    const to = rest.slice(0, a.index).trim()
    let from = rest.slice(a.index + a[0].length).trim()
    let comment: string | undefined
    const c = from.indexOf('#')
    if (c >= 0) {
      comment = from.slice(c + 1).trim() || undefined
      from = from.slice(0, c).trim()
    }
    const dir = (a[2] ?? 'IN').toLowerCase() as 'in' | 'out' | 'fwd'
    const iface = to.match(/\son\s+(\S+)$/)?.[1] ?? from.match(/\son\s+(\S+)$/)?.[1]
    out.push({ index: Number(m[1]), to, action: a[1], from: from || 'Anywhere', comment, raw: rest.trim(), v6: /\(v6\)/.test(to) || /\(v6\)/.test(from), direction: dir, iface })
  }
  return out
}

/** Parse `ufw show added` lines (`ufw allow from 10.0.0.0/8 to any port 3306 proto tcp comment 'x'`) used while ufw is inactive. */
function parseUfwAdded(lines: string[]): FirewallRuleEx[] {
  const out: FirewallRuleEx[] = []
  let i = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('ufw ')) continue
    const spec = line.slice(4)
    const commentM = spec.match(/\scomment\s+'((?:[^']|'\\'')*)'\s*$/)
    const comment = commentM ? commentM[1].replace(/'\\''/g, "'") : undefined
    const body = commentM ? spec.slice(0, commentM.index).trim() : spec
    const tokens = body.split(/\s+/)
    let k = 0
    if (tokens[k] === 'route') k++
    const action = (tokens[k++] ?? '').toUpperCase()
    if (!['ALLOW', 'DENY', 'REJECT', 'LIMIT'].includes(action)) continue
    let direction: 'in' | 'out' | 'fwd' = 'in'
    if (tokens[k] === 'in' || tokens[k] === 'out') direction = tokens[k++] as 'in' | 'out'
    let iface: string | undefined
    if (tokens[k] === 'on') {
      iface = tokens[k + 1]
      k += 2
    }
    let proto = ''
    let from = 'Anywhere'
    let toAddr = ''
    let port = ''
    let simple = ''
    while (k < tokens.length) {
      const t = tokens[k]
      if (t === 'proto') {
        proto = tokens[k + 1] ?? ''
        k += 2
      } else if (t === 'from') {
        from = tokens[k + 1] === 'any' ? 'Anywhere' : tokens[k + 1] ?? 'Anywhere'
        k += 2
        if (tokens[k] === 'port') {
          k += 2 // source port: ignored in the summary
        }
      } else if (t === 'to') {
        toAddr = tokens[k + 1] === 'any' ? '' : tokens[k + 1] ?? ''
        k += 2
        if (tokens[k] === 'port') {
          port = tokens[k + 1] ?? ''
          k += 2
        }
      } else if (t === 'log' || t === 'log-all') k++
      else {
        simple = t
        k++
      }
    }
    let to: string
    if (simple) to = simple
    else if (port) to = proto && proto !== 'any' ? `${port}/${proto}` : port
    else to = toAddr || 'Anywhere'
    if (toAddr && port) to = `${toAddr} ${to}`
    if (iface) to += ` on ${iface}`
    out.push({ index: ++i, to, action, from, comment, raw: spec, v6: isV6(from) || isV6(toAddr), direction, iface })
  }
  return out
}

function policyWord(s: string): FwPolicy {
  const v = s.trim().toLowerCase().replace(/"/g, '')
  if (v === 'accept' || v === 'allow') return 'allow'
  if (v === 'reject') return 'reject'
  return 'deny'
}

/* ------------------------------------------------------------------ */
/* firewalld parsing                                                   */
/* ------------------------------------------------------------------ */

function parseZones(lines: string[]): FirewalldZone[] {
  const zones: FirewalldZone[] = []
  let cur: FirewalldZone | null = null
  let inRich = false
  for (const raw of lines) {
    if (!raw.trim()) continue
    const head = raw.match(/^(\S+)(?:\s+\((active|default)[^)]*\))?\s*$/)
    if (head && !/^\s/.test(raw)) {
      cur = { name: head[1], interfaces: [], sources: [], services: [], ports: [], richRules: [], target: 'default' }
      zones.push(cur)
      inRich = false
      continue
    }
    if (!cur) continue
    const kv = raw.match(/^\s+([a-z -]+):\s?(.*)$/)
    if (kv && !raw.trimStart().startsWith('rule ')) {
      const key = kv[1].trim()
      const val = kv[2].trim()
      inRich = key === 'rich rules'
      const list = val ? val.split(/\s+/) : []
      if (key === 'target') cur.target = val
      else if (key === 'interfaces') cur.interfaces = list
      else if (key === 'sources') cur.sources = list
      else if (key === 'services') cur.services = list
      else if (key === 'ports') cur.ports = list
      else if (key === 'rich rules' && val) cur.richRules.push(val)
      continue
    }
    if (inRich && raw.trimStart().startsWith('rule ')) cur.richRules.push(raw.trim())
  }
  return zones
}

function richRuleToRule(rich: string, index: number): FirewallRuleEx {
  const q = (k: string): string | undefined => rich.match(new RegExp(`${k}="([^"]*)"`))?.[1]
  const family = rich.match(/family="(ipv4|ipv6)"/)?.[1]
  const src = q('source address') ?? (rich.match(/source(?: NOT)? address="([^"]*)"/)?.[1] ?? '')
  const port = q('port port') ?? rich.match(/port port="([^"]*)"/)?.[1]
  const proto = rich.match(/port port="[^"]*" protocol="(tcp|udp)"/)?.[1]
  const service = rich.match(/service name="([^"]*)"/)?.[1]
  const act = /\baccept\b/.test(rich) ? (/limit value/.test(rich) ? 'LIMIT' : 'ALLOW') : /\breject\b/.test(rich) ? 'REJECT' : /\bdrop\b/.test(rich) ? 'DENY' : 'MARK'
  const to = port ? (proto ? `${port.replace('-', ':')}/${proto}` : port) : service ? `${service} (service)` : 'Anywhere'
  return { index, to, action: act, from: src || 'Anywhere', comment: undefined, raw: `rich:${rich}`, v6: family === 'ipv6' || isV6(src), direction: 'in' }
}

/* ------------------------------------------------------------------ */
/* iptables parsing                                                    */
/* ------------------------------------------------------------------ */

const IPT_TAG = 'ServerSysOps'
const IPT_LOG_PREFIX = '[SSO-FW] '
const IPT_LOG_COMMENT = `${IPT_TAG}: log`
const IPT_REJECT_COMMENT = `${IPT_TAG}: default reject`
const IPT_TARGET_ACTION: Record<string, string> = { ACCEPT: 'ALLOW', DROP: 'DENY', REJECT: 'REJECT', LOG: 'LOG', RETURN: 'RETURN' }
/** Options that take a value and are not interesting for the summary. */
const IPT_SKIP_WITH_VALUE = new Set(['--limit-burst', '--hashlimit-upto', '--hashlimit-above', '--hashlimit-burst', '--hashlimit-mode', '--hashlimit-name', '--hashlimit-htable-expire', '--reject-with', '--log-level', '--icmp-type', '--icmpv6-type', '--tcp-flags', '--mark', '--set-xmark', '--to-ports', '--to-destination', '--to-source', '--uid-owner', '--gid-owner', '--match-set', '--pkt-type', '--src-type', '--dst-type', '--seconds', '--hitcount', '--name', '--length', '--ttl-eq', '--ttl-lt', '--ttl-gt', '--string', '--algo', '--nflog-prefix', '--nflog-group'])

interface IptParsed {
  chain: string
  src?: string
  dst?: string
  inIf?: string
  outIf?: string
  proto?: string
  dports?: string
  sports?: string
  ctstate?: string
  comment?: string
  limit?: string
  hashlimit: boolean
  logPrefix?: string
  target: string
  negated: boolean
  unknown: string[]
  /** `-A CHAIN ...` as printed by `iptables -S`. */
  line: string
}

/** Split an `iptables -S` line into tokens, honouring the double-quoted comment / log prefix. */
function iptTokens(line: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2])
  return out
}

function parseIptLine(lineRaw: string): IptParsed | null {
  const line = lineRaw.replace(/^\[v6\]\s*/, '').trim()
  const t = iptTokens(line)
  if (t[0] !== '-A' || !t[1]) return null
  const p: IptParsed = { chain: t[1], target: '', hashlimit: false, negated: false, unknown: [], line }
  let i = 2
  while (i < t.length) {
    const k = t[i]
    const v = t[i + 1]
    if (k === '!') {
      p.negated = true
      i++
      continue
    }
    switch (k) {
      case '-s':
      case '--source':
        p.src = v
        i += 2
        break
      case '-d':
      case '--destination':
        p.dst = v
        i += 2
        break
      case '-i':
      case '--in-interface':
        p.inIf = v
        i += 2
        break
      case '-o':
      case '--out-interface':
        p.outIf = v
        i += 2
        break
      case '-p':
      case '--protocol':
        p.proto = v
        i += 2
        break
      case '-m':
      case '--match':
        if (v === 'hashlimit') p.hashlimit = true
        i += 2
        break
      case '--dport':
      case '--dports':
      case '--destination-port':
      case '--destination-ports':
        p.dports = v
        i += 2
        break
      case '--sport':
      case '--sports':
      case '--source-port':
      case '--source-ports':
        p.sports = v
        i += 2
        break
      case '--ctstate':
      case '--state':
        p.ctstate = v
        i += 2
        break
      case '--comment':
        p.comment = v
        i += 2
        break
      case '--limit':
        p.limit = v
        i += 2
        break
      case '--log-prefix':
        p.logPrefix = v
        i += 2
        break
      case '-j':
      case '-g':
      case '--jump':
      case '--goto':
        p.target = v ?? ''
        i += 2
        break
      case '-f':
      case '--fragment':
      case '--syn':
        p.unknown.push(k)
        i++
        break
      default:
        if (IPT_SKIP_WITH_VALUE.has(k)) i += 2
        else {
          p.unknown.push(k)
          // consume a value when the next token is not another option
          i += v !== undefined && !v.startsWith('-') && v !== '!' ? 2 : 1
        }
    }
  }
  return p
}

/** The rule has match criteria (as opposed to a bare `-j TARGET` catch-all). */
function iptHasMatch(p: IptParsed): boolean {
  return !!(p.src || p.dst || p.inIf || p.outIf || p.proto || p.dports || p.sports || p.ctstate || p.limit || p.hashlimit || p.negated || p.unknown.length)
}

function iptIsCatchAll(p: IptParsed): boolean {
  return !iptHasMatch(p) && (p.target === 'DROP' || p.target === 'REJECT')
}

function iptIsAppLog(p: IptParsed): boolean {
  return p.target === 'LOG' && (p.logPrefix ?? '').includes(IPT_LOG_PREFIX.trim())
}

function iptToRule(p: IptParsed, index: number, v6: boolean): FirewallRuleEx {
  const known = IPT_TARGET_ACTION[p.target]
  let action = known ?? 'OTHER'
  if (p.target === 'ACCEPT' && (p.limit || p.hashlimit)) action = 'LIMIT'
  const portProto = p.proto && ['tcp', 'udp'].includes(p.proto) ? p.proto : undefined
  let to: string
  if (p.negated || p.unknown.length) {
    // Not representable in the simple To/From columns: show the matcher text so nothing is hidden.
    to = p.line.replace(/^-A\s+\S+\s*/, '').replace(/\s+-j\s+.*$/, '') || 'Anywhere'
  } else if (p.dports) to = portProto ? `${p.dports}/${portProto}` : p.dports
  else if (p.ctstate) to = `${p.ctstate} (state)`
  else if (p.proto && p.proto !== 'all') to = portProto ? `Anywhere/${portProto}` : p.proto
  else to = 'Anywhere'
  if (p.dst && !(p.negated || p.unknown.length)) to = `${stripHostMask(p.dst)} ${to}`.trim()
  if (p.inIf || p.outIf) to += ` on ${p.inIf ?? p.outIf}`
  const from = p.src ? stripHostMask(p.src) : 'Anywhere'
  let comment = p.comment
  if (!comment && !known) comment = `jump to ${p.target || '?'}`
  else if (!comment && p.target === 'LOG' && p.logPrefix) comment = `log prefix ${p.logPrefix.trim()}`
  const direction: FirewallRuleEx['direction'] = p.chain === 'OUTPUT' ? 'out' : p.chain === 'FORWARD' ? 'fwd' : 'in'
  return { index, to, action, from, comment, raw: `${v6 ? '[v6] ' : ''}${p.line}`, v6, direction, iface: p.inIf ?? p.outIf }
}

/** Parse the `-A CHAIN …` lines of `iptables -S CHAIN`; `index` is the position usable with `-D CHAIN n`. */
function parseIptChain(lines: string[], chain: string, v6: boolean): FirewallRuleEx[] {
  const out: FirewallRuleEx[] = []
  let n = 0
  for (const l of lines) {
    const p = parseIptLine(l)
    if (!p || p.chain !== chain) continue
    out.push(iptToRule(p, ++n, v6))
  }
  return out
}

function iptMeta(rule: FirewallRuleEx): IptParsed | null {
  return parseIptLine(rule.raw)
}

function iptChainOf(rule: FirewallRuleEx): string {
  return iptMeta(rule)?.chain ?? (rule.direction === 'out' ? 'OUTPUT' : rule.direction === 'fwd' ? 'FORWARD' : 'INPUT')
}

/** Position of the first catch-all rule (DROP/REJECT, optionally the app's LOG rule) in a chain: new allow rules go before it. */
function iptCatchAllIndex(rules: FirewallRuleEx[], v6: boolean, chain: string, includeLog: boolean): number | undefined {
  for (const r of rules) {
    if (r.v6 !== v6) continue
    const m = iptMeta(r)
    if (!m || m.chain !== chain) continue
    if (iptIsCatchAll(m) || (includeLog && iptIsAppLog(m))) return r.index
  }
  return undefined
}

function parseIptPolicies(lines: string[]): IptPolicies {
  const pol: IptPolicies = { input: 'allow', forward: 'allow', output: 'allow' }
  for (const l of lines) {
    const m = l.trim().match(/^-P\s+(INPUT|FORWARD|OUTPUT)\s+(\w+)/)
    if (!m) continue
    const v = policyWord(m[2])
    if (m[1] === 'INPUT') pol.input = v
    else if (m[1] === 'FORWARD') pol.forward = v
    else pol.output = v
  }
  return pol
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

async function detectSshPorts(ssh: SshClient): Promise<number[]> {
  const r = await rootExec(ssh, `(sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null) | awk '/^port /{print $2}'; grep -ihE '^\\s*Port\\s' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '{print $2}'; (ss -tlnpH 2>/dev/null | grep -E 'users:\\(\\("sshd' | awk '{print $4}' | sed 's/.*://')`).catch(() => ({ code: 1, stdout: '', stderr: '' }))
  const ports = [...new Set(r.stdout.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))]
  return ports.length ? ports : [ssh.profile.port || 22]
}

function recommendedBackend(ssh: SshClient): FwBackend {
  const id = `${ssh.os?.id ?? ''} ${ssh.os?.idLike ?? ''}`.toLowerCase()
  if (/rhel|fedora|centos|rocky|alma|suse|opensuse/.test(id)) return 'firewalld'
  if (/alpine/.test(id) || ssh.os?.pkgManager === 'apk') return 'iptables'
  return 'ufw'
}

/** Which persistence mechanism the distro uses and whether it is enabled, from the __PERSIST probe lines. */
function iptPersistence(lines: string[]): { persistent: boolean; method?: string } {
  const has = (k: string): boolean => lines.some((l) => l.trim() === k)
  if (has('nfp')) return { persistent: has('nfp-on'), method: 'netfilter-persistent' }
  if (has('rhel-init')) return { persistent: has('svc-on'), method: 'iptables-services' }
  if (has('rc-init')) return { persistent: has('rc-on'), method: 'OpenRC iptables service' }
  if (has('arch-unit')) return { persistent: has('svc-on'), method: 'iptables.service' }
  return { persistent: false }
}

async function getState(ssh: SshClient): Promise<FirewallStateEx> {
  const script = `
echo __UFW; command -v ufw >/dev/null 2>&1 && echo yes
echo __FWD; command -v firewall-cmd >/dev/null 2>&1 && echo yes
echo __IPT; command -v iptables >/dev/null 2>&1 && echo yes
echo __IPTV; iptables -V 2>/dev/null
echo __NFT; command -v nft >/dev/null 2>&1 && echo yes
echo __SSHD; (sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null) | awk '/^port /{print $2}'; grep -ihE '^\\s*Port\\s' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '{print $2}'; (ss -tlnpH 2>/dev/null | grep -E 'users:\\(\\("sshd' | awk '{print $4}' | sed 's/.*://')
UFWA=0; FWDA=0
if command -v ufw >/dev/null 2>&1; then
echo __UFWVERBOSE; ufw status verbose 2>&1
echo __UFWNUM; ufw status numbered 2>&1
echo __UFWADDED; ufw show added 2>&1
echo __UFWCONF; grep -E '^(ENABLED|LOGLEVEL)=' /etc/ufw/ufw.conf 2>/dev/null; grep -E '^DEFAULT_(INPUT|OUTPUT)_POLICY=' /etc/default/ufw 2>/dev/null
echo __UFWVER; ufw version 2>/dev/null | head -1
ufw status 2>/dev/null | grep -q '^Status: active' && UFWA=1
fi
if command -v firewall-cmd >/dev/null 2>&1; then
echo __FWDSTATE; firewall-cmd --state 2>&1
echo __FWDENABLED; systemctl is-enabled firewalld 2>/dev/null
echo __FWDZONE; firewall-cmd --get-default-zone 2>/dev/null
echo __FWDZONES; firewall-cmd --list-all-zones 2>/dev/null
echo __FWDLOG; firewall-cmd --get-log-denied 2>/dev/null
echo __FWDVER; firewall-cmd --version 2>/dev/null
[ "$(firewall-cmd --state 2>/dev/null)" = running ] && FWDA=1
fi
if [ "$UFWA" = 0 ] && [ "$FWDA" = 0 ]; then
if command -v iptables >/dev/null 2>&1; then
echo __IPTP; iptables -S 2>/dev/null | grep '^-P'
echo __IPTS; iptables -S INPUT 2>/dev/null | grep '^-A'
echo __IPTO; iptables -S OUTPUT 2>/dev/null | grep '^-A'
echo __IPTCH; iptables -S 2>/dev/null | grep '^-N' | awk '{print $2}'
echo __IPTRAW; iptables-save 2>/dev/null | head -n 1500
if command -v ip6tables >/dev/null 2>&1 && ip6tables -S INPUT >/dev/null 2>&1; then
echo __IP6OK; echo yes
echo __IP6TP; ip6tables -S 2>/dev/null | grep '^-P'
echo __IP6TS; ip6tables -S INPUT 2>/dev/null | grep '^-A'
echo __IP6TO; ip6tables -S OUTPUT 2>/dev/null | grep '^-A'
echo __IP6TRAW; ip6tables-save 2>/dev/null | head -n 1000
fi
elif command -v nft >/dev/null 2>&1; then
echo __NFTRAW; nft list ruleset 2>/dev/null | head -n 1500
fi
echo __PERSIST
command -v netfilter-persistent >/dev/null 2>&1 && echo nfp
systemctl is-enabled netfilter-persistent >/dev/null 2>&1 && echo nfp-on
systemctl is-enabled iptables >/dev/null 2>&1 && echo svc-on
[ -f /usr/libexec/iptables/iptables.init ] && echo rhel-init
[ -f /etc/init.d/iptables ] && command -v rc-update >/dev/null 2>&1 && echo rc-init
rc-update show 2>/dev/null | grep -qE '^[[:space:]]*iptables[[:space:]]' && echo rc-on
[ -f /usr/lib/systemd/system/iptables.service ] && [ ! -f /usr/libexec/iptables/iptables.init ] && echo arch-unit
fi
echo __END`
  const r = await rootExec(ssh, script, { timeoutMs: 60000 })
  const sec = sectionize(r.stdout)
  const hasUfw = (sec.UFW?.[0] ?? '').includes('yes')
  const hasFwd = (sec.FWD?.[0] ?? '').includes('yes')
  const hasIpt = (sec.IPT?.[0] ?? '').includes('yes')
  const hasNft = (sec.NFT?.[0] ?? '').includes('yes')
  const iptVersion = (sec.IPTV?.[0] ?? '').trim()
  const sshPorts = [...new Set((sec.SSHD ?? []).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))]
  if (!sshPorts.length) sshPorts.push(ssh.profile.port || 22)
  const sshPort = sshPorts.includes(ssh.profile.port) ? ssh.profile.port : sshPorts[0]
  const backendAvailable: FwBackend[] = []
  if (hasUfw) backendAvailable.push('ufw')
  if (hasFwd) backendAvailable.push('firewalld')
  if (hasIpt) backendAvailable.push('iptables')
  const installable = (ssh.os?.pkgManager ?? 'unknown') !== 'unknown'
  const base = { installed: backendAvailable.length > 0, backendAvailable, installable, sshPort, sshPorts, recommended: recommendedBackend(ssh) }

  const fwdActive = (sec.FWDSTATE?.[0] ?? '').trim() === 'running'
  const ufwActive = (sec.UFWVERBOSE ?? []).some((l) => /^Status:\s*active/i.test(l))
  // Prefer the backend that is active; otherwise the one that is installed (ufw first unless only firewalld exists);
  // iptables (or an nft-only kernel ruleset, read-only) when neither front end exists.
  const backend: FirewallStateEx['backend'] = ufwActive ? 'ufw' : fwdActive ? 'firewalld' : hasUfw ? 'ufw' : hasFwd ? 'firewalld' : hasIpt || hasNft ? 'iptables' : 'none'

  if (backend === 'ufw') {
    const verbose = sec.UFWVERBOSE ?? []
    const conf: Record<string, string> = {}
    for (const l of sec.UFWCONF ?? []) {
      const m = l.match(/^([A-Z_]+)=(.*)$/)
      if (m) conf[m[1]] = m[2].replace(/"/g, '').trim()
    }
    let incoming: FwPolicy = policyWord(conf.DEFAULT_INPUT_POLICY ?? 'DROP')
    let outgoing: FwPolicy = policyWord(conf.DEFAULT_OUTPUT_POLICY ?? 'ACCEPT')
    let logging = (conf.LOGLEVEL ?? 'low').toLowerCase()
    for (const l of verbose) {
      const d = l.match(/^Default:\s*(\w+)\s*\(incoming\),\s*(\w+)\s*\(outgoing\)/i)
      if (d) {
        incoming = policyWord(d[1])
        outgoing = policyWord(d[2])
      }
      const lg = l.match(/^Logging:\s*(\w+)(?:\s*\((\w+)\))?/i)
      if (lg) logging = lg[1].toLowerCase() === 'off' ? 'off' : (lg[2] ?? 'low').toLowerCase()
    }
    const rules = ufwActive ? parseUfwNumbered(sec.UFWNUM ?? []) : parseUfwAdded(sec.UFWADDED ?? [])
    const sshAllowed = rules.some((rl) => ruleCovers(rl, sshPort, 'tcp'))
    return { ...base, backend: 'ufw', active: ufwActive, enabledAtBoot: (conf.ENABLED ?? '').toLowerCase() === 'yes', defaultIncoming: incoming, defaultOutgoing: outgoing, rules, logging, sshAllowed, version: (sec.UFWVER?.[0] ?? '').trim() || undefined }
  }

  if (backend === 'firewalld') {
    const zones = parseZones(sec.FWDZONES ?? [])
    const defaultZone = (sec.FWDZONE?.[0] ?? '').trim() || 'public'
    const zone = zones.find((z) => z.name === defaultZone) ?? zones[0]
    const rules: FirewallRuleEx[] = []
    let idx = 0
    if (zone) {
      for (const s of zone.services) rules.push({ index: ++idx, to: `${s} (service)`, action: 'ALLOW', from: 'Anywhere', raw: `service:${s}`, v6: false, direction: 'in' })
      for (const p of zone.ports) rules.push({ index: ++idx, to: p.replace('-', ':'), action: 'ALLOW', from: 'Anywhere', raw: `port:${p}`, v6: false, direction: 'in' })
      for (const rr of zone.richRules) rules.push(richRuleToRule(rr, ++idx))
    }
    const target = (zone?.target ?? 'default').toUpperCase()
    const incoming: FwPolicy = target === 'ACCEPT' ? 'allow' : target === 'DROP' ? 'deny' : 'reject'
    const logDenied = (sec.FWDLOG?.[0] ?? 'off').trim()
    const sshAllowed = rules.some((rl) => ruleCovers(rl, sshPort, 'tcp'))
    return { ...base, backend: 'firewalld', active: fwdActive, enabledAtBoot: (sec.FWDENABLED?.[0] ?? '').trim() === 'enabled', defaultIncoming: incoming, defaultOutgoing: 'allow', rules, logging: logDenied === 'off' ? 'off' : logDenied, defaultZone, zones, sshAllowed, version: (sec.FWDVER?.[0] ?? '').trim() || undefined }
  }

  if (backend === 'iptables') {
    const nftOnly = !hasIpt
    const nftBackend = nftOnly || /nf_tables/i.test(iptVersion)
    const persist = iptPersistence(sec.PERSIST ?? [])
    if (nftOnly) {
      const raw = (sec.NFTRAW ?? []).join('\n').trim()
      return { ...base, installed: false, backend: 'iptables', active: /\b(drop|reject)\b/.test(raw), enabledAtBoot: false, defaultIncoming: /policy drop/.test(raw) ? 'deny' : 'allow', defaultOutgoing: 'allow', rules: [], logging: 'off', sshAllowed: false, nftBackend: true, nftOnly: true, ip6: false, ruleCount: 0, persistent: false, docker: /DOCKER/.test(raw), raw, version: undefined }
    }
    const ip6 = (sec.IP6OK?.[0] ?? '').includes('yes')
    const policies = parseIptPolicies(sec.IPTP ?? [])
    const policies6 = parseIptPolicies(sec.IP6TP ?? [])
    const rules: FirewallRuleEx[] = [...parseIptChain(sec.IPTS ?? [], 'INPUT', false), ...(ip6 ? parseIptChain(sec.IP6TS ?? [], 'INPUT', true) : []), ...parseIptChain(sec.IPTO ?? [], 'OUTPUT', false), ...(ip6 ? parseIptChain(sec.IP6TO ?? [], 'OUTPUT', true) : [])]
    const input = rules.filter((r) => r.direction === 'in')
    const metas = input.map((r) => iptMeta(r)).filter((m): m is IptParsed => !!m)
    const hasRejectCatchAll = (chain: string): boolean => rules.some((r) => !r.v6 && iptChainOf(r) === chain && (() => { const m = iptMeta(r); return !!m && iptIsCatchAll(m) && m.target === 'REJECT' })())
    const defaultIncoming: FwPolicy = policies.input === 'allow' && !hasRejectCatchAll('INPUT') ? 'allow' : hasRejectCatchAll('INPUT') ? 'reject' : 'deny'
    const defaultOutgoing: FwPolicy = policies.output === 'allow' && !hasRejectCatchAll('OUTPUT') ? 'allow' : hasRejectCatchAll('OUTPUT') ? 'reject' : 'deny'
    const logRule = metas.find((m) => iptIsAppLog(m))
    const logging = !logRule ? 'off' : logRule.limit?.startsWith('3/') ? 'low' : logRule.limit?.startsWith('10/') ? 'medium' : 'high'
    const active = policies.input !== 'allow' || policies6.input !== 'allow' || input.length > 0
    const chains = (sec.IPTCH ?? []).map((l) => l.trim())
    const docker = chains.some((c) => /^DOCKER/.test(c))
    const raw = [(sec.IPTRAW ?? []).join('\n').trim(), ip6 ? (sec.IP6TRAW ?? []).join('\n').trim() : ''].filter(Boolean).join('\n\n')
    const sshAllowed = input.some((rl) => !rl.v6 && ruleCovers(rl, sshPort, 'tcp'))
    return { ...base, backend: 'iptables', active, enabledAtBoot: persist.persistent, defaultIncoming, defaultOutgoing, rules, logging, sshAllowed, version: iptVersion.replace(/^iptables\s*/i, '') || undefined, nftBackend, nftOnly: false, ip6, policies, ruleCount: input.length, persistent: persist.persistent, persistMethod: persist.method, docker, raw }
  }

  return { ...base, backend: 'none', active: false, enabledAtBoot: false, defaultIncoming: 'allow', defaultOutgoing: 'allow', rules: [], logging: 'off', sshAllowed: false }
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

async function ufwAllowSsh(ssh: SshClient, port: number): Promise<void> {
  await rootRun(ssh, `ufw allow ${port}/tcp comment ${shq(SSH_COMMENT)}`)
}

async function fwdAllowSsh(ssh: SshClient, port: number, running: boolean): Promise<void> {
  if (running) await rootRun(ssh, `firewall-cmd --permanent --add-port=${port}/tcp >/dev/null && firewall-cmd --reload >/dev/null`)
  else await rootRun(ssh, `firewall-offline-cmd --add-port=${port}/tcp >/dev/null 2>&1 || true`)
}

function buildUfwCommand(input: AddRuleInput, port: ReturnType<typeof normalizePort>): string {
  const action = input.action
  const dir = input.direction === 'out' ? 'out' : 'in'
  const proto = input.proto ?? (port ? 'tcp' : 'any')
  const from = input.from ? assertIp(input.from, 'source') : undefined
  const to = input.to ? assertIp(input.to, 'destination') : undefined
  if (from && to && isV6(from) !== isV6(to)) throw new Error('Source and destination must both be IPv4 or both IPv6')
  if (port && (port.list || port.range) && proto === 'any') throw new Error('Port lists and ranges need a protocol (tcp or udp)')
  if (!port && !from && !to) throw new Error('Specify at least a port or a source address')
  const parts = ['ufw', action, dir]
  if (proto !== 'any') parts.push('proto', proto)
  let fromSpec = from ?? 'any'
  let toSpec = to ?? 'any'
  if (input.v6 && !from && !to) {
    fromSpec = '::/0'
    toSpec = '::/0'
  }
  parts.push('from', fromSpec, 'to', toSpec)
  if (port) parts.push('port', port.spec)
  const comment = cleanComment(input.comment)
  if (comment) parts.push('comment', shq(comment))
  return parts.join(' ')
}

function buildFirewalldCommands(input: AddRuleInput, port: ReturnType<typeof normalizePort>, zone: string): string[] {
  if (input.direction === 'out') throw new Error('firewalld zones filter incoming traffic only; outbound rules are not supported here')
  const proto = input.proto && input.proto !== 'any' ? input.proto : port ? 'tcp' : undefined
  const from = input.from ? assertIp(input.from, 'source') : undefined
  if (!port && !from) throw new Error('Specify at least a port or a source address')
  const z = `--zone=${shq(zone)}`
  const cmds: string[] = []
  const portSpecs = port ? (port.range ? [port.spec.replace(':', '-')] : port.ports.map(String)) : []
  if (input.action === 'allow' && !from && port && proto) {
    for (const p of portSpecs) cmds.push(`firewall-cmd --permanent ${z} --add-port=${p}/${proto} >/dev/null`)
    return cmds
  }
  const family = from ? (isV6(from) ? 'ipv6' : 'ipv4') : input.v6 ? 'ipv6' : 'ipv4'
  const act = input.action === 'allow' ? 'accept' : input.action === 'limit' ? 'accept limit value="10/m"' : input.action === 'deny' ? 'drop' : 'reject'
  const src = from ? ` source address="${from}"` : ''
  if (!portSpecs.length) {
    cmds.push(`firewall-cmd --permanent ${z} --add-rich-rule=${shq(`rule family="${family}"${src} ${act}`)} >/dev/null`)
    return cmds
  }
  for (const p of portSpecs) {
    const rich = `rule family="${family}"${src} port port="${p}" protocol="${proto ?? 'tcp'}" ${act}`
    cmds.push(`firewall-cmd --permanent ${z} --add-rich-rule=${shq(rich)} >/dev/null`)
  }
  return cmds
}

/* ---------------- iptables ---------------- */

function iptBin(v6: boolean): string {
  return v6 ? 'ip6tables' : 'iptables'
}

/**
 * POSIX script that saves the running rule set with whatever persistence mechanism the distro has.
 * Prints `saved:<method>`; `saved:file-only` means the file is written but nothing restores it at boot.
 */
export function iptPersistScript(): string {
  return [
    'if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 && echo saved:netfilter-persistent',
    'elif [ -f /usr/libexec/iptables/iptables.init ] || [ -f /etc/sysconfig/iptables ]; then mkdir -p /etc/sysconfig && iptables-save > /etc/sysconfig/iptables && { ip6tables-save > /etc/sysconfig/ip6tables 2>/dev/null || true; } && echo saved:iptables-services',
    'elif [ -f /etc/init.d/iptables ] && command -v rc-update >/dev/null 2>&1; then { /etc/init.d/iptables save >/dev/null 2>&1 || { mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules-save; }; } && { [ ! -f /etc/init.d/ip6tables ] || /etc/init.d/ip6tables save >/dev/null 2>&1 || true; } && echo saved:openrc',
    'elif [ -f /usr/lib/systemd/system/iptables.service ] && [ -d /etc/iptables ]; then iptables-save > /etc/iptables/iptables.rules && { ip6tables-save > /etc/iptables/ip6tables.rules 2>/dev/null || true; } && echo saved:iptables.service',
    'else mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 && { ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true; } && echo saved:file-only',
    'fi'
  ].join('\n')
}

/** Save the rules (best effort). Returns a warning when they will not survive a reboot. */
export async function iptPersist(ssh: SshClient): Promise<string | undefined> {
  const r = await rootExec(ssh, iptPersistScript(), { timeoutMs: 60000 }).catch(() => ({ code: 1, stdout: '', stderr: 'save failed' }))
  const m = r.stdout.match(/saved:(\S+)/)
  if (!m) return `Rules could not be saved (${(r.stderr || 'unknown error').trim().split('\n').pop()}); they will be lost at reboot.`
  if (m[1] === 'file-only') return 'Rules were written to /etc/iptables/rules.v4 but no service restores them at boot. Install the persistence package (iptables-persistent / iptables-services) from the Firewall page.'
  return undefined
}

/** Shell words for `-C`/`-I`/`-A` of the SSH allow rule. */
function iptSshRuleArgs(port: number): string[] {
  return ['-p', 'tcp', '--dport', String(port), '-m', 'comment', '--comment', SSH_COMMENT, '-j', 'ACCEPT']
}

/** `iptables [-I CHAIN pos | -A CHAIN] <args>` with allow rules placed before the first catch-all rule. */
function iptInsertCmd(bin: string, chain: string, rules: FirewallRuleEx[], v6: boolean, args: string[], where: 'before-catchall' | 'top' | 'end'): string {
  if (where === 'top') return shJoin([bin, '-I', chain, 1, ...args])
  if (where === 'before-catchall') {
    const pos = iptCatchAllIndex(rules, v6, chain, true)
    if (pos !== undefined) return shJoin([bin, '-I', chain, pos, ...args])
  }
  return shJoin([bin, '-A', chain, ...args])
}

/**
 * Delete rules by position, verifying first that the rule at that position is still the one we saw
 * (`iptables -S CHAIN n`), so a concurrent change cannot make us delete the wrong rule.
 * Deletes from the highest index down so lower positions stay valid.
 */
async function iptDeleteRules(ssh: SshClient, targets: FirewallRuleEx[]): Promise<void> {
  const groups = new Map<string, FirewallRuleEx[]>()
  for (const r of targets) {
    const key = `${r.v6 ? '6' : '4'}:${iptChainOf(r)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const lines: string[] = []
  for (const [key, rs] of groups) {
    const v6 = key.startsWith('6')
    const chain = key.slice(2)
    for (const r of [...rs].sort((a, b) => b.index - a.index)) {
      const line = r.raw.replace(/^\[v6\]\s*/, '')
      lines.push(`[ "$(${iptBin(v6)} -S ${chain} ${r.index} 2>/dev/null)" = ${shq(line)} ] || { echo "rule ${r.index} in ${chain} changed; reload and try again" >&2; exit 1; }; ${iptBin(v6)} -D ${chain} ${r.index}`)
    }
  }
  if (lines.length) await rootRun(ssh, lines.join('\n'))
}

function iptRuleArgs(input: AddRuleInput, port: ReturnType<typeof normalizePort>): string[] {
  const proto = input.proto ?? (port ? 'tcp' : 'any')
  const from = input.from ? assertIp(input.from, 'source') : undefined
  const to = input.to ? assertIp(input.to, 'destination') : undefined
  if (from && to && isV6(from) !== isV6(to)) throw new Error('Source and destination must both be IPv4 or both IPv6')
  if (port && proto === 'any') throw new Error('iptables needs a protocol (tcp or udp) for port rules')
  if (!port && !from && !to) throw new Error('Specify at least a port or a source address')
  const args: string[] = []
  if (from) args.push('-s', from)
  if (to) args.push('-d', to)
  if (proto !== 'any') args.push('-p', proto)
  if (port) {
    if (port.list) args.push('-m', 'multiport', '--dports', port.spec)
    else args.push('--dport', port.spec)
  }
  if (input.action === 'limit') {
    // ufw-like: accept up to 6 new connections per minute per source; the rest fall through to the default policy.
    args.push('-m', 'conntrack', '--ctstate', 'NEW', '-m', 'hashlimit', '--hashlimit-upto', '6/minute', '--hashlimit-burst', '6', '--hashlimit-mode', 'srcip', '--hashlimit-name', `sso_${port ? port.ports[0] : 'any'}`)
  }
  const comment = cleanComment(input.comment)
  args.push('-m', 'comment', '--comment', comment ? `${IPT_TAG}: ${comment}` : IPT_TAG)
  args.push('-j', input.action === 'deny' ? 'DROP' : input.action === 'reject' ? 'REJECT' : 'ACCEPT')
  return args
}

/** Rules of the app's own kind (comment starts with the tag) in a chain, e.g. to remove the default-reject or log rules. */
function iptAppRules(rules: FirewallRuleEx[], chain: string, pred: (m: IptParsed) => boolean): FirewallRuleEx[] {
  return rules.filter((r) => {
    const m = iptMeta(r)
    return !!m && m.chain === chain && pred(m)
  })
}

/**
 * Safe baseline for one address family: accept loopback, established/related, ICMP and the SSH port(s),
 * then INPUT policy DROP as the very last statement. Runs as ONE sh -c script with `set -e`, so a failure
 * before the policy change leaves INPUT at ACCEPT (never a half-closed firewall). No iptables-restore,
 * nothing is flushed: existing rules (fail2ban, Docker, custom) are preserved.
 */
function iptEnableScript(v6: boolean, sshPorts: number[]): string {
  const bin = iptBin(v6)
  const lines = [
    `set -e`,
    `IPT=${bin}`,
    `$IPT -P INPUT ACCEPT`,
    `sso_rule() { pos=$1; shift; while $IPT -D INPUT "$@" 2>/dev/null; do :; done; $IPT -I INPUT "$pos" "$@"; }`,
    `sso_rule 1 -i lo -m comment --comment ${shq(`${IPT_TAG}: loopback`)} -j ACCEPT`,
    `sso_rule 2 -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment ${shq(`${IPT_TAG}: established`)} -j ACCEPT`,
    `sso_rule 3 -p ${v6 ? 'ipv6-icmp' : 'icmp'} -m comment --comment ${shq(`${IPT_TAG}: icmp`)} -j ACCEPT`
  ]
  sshPorts.forEach((p, i) => lines.push(`sso_rule ${4 + i} ${shJoin(iptSshRuleArgs(p))}`))
  lines.push(`$IPT -P INPUT DROP`)
  return lines.join('\n')
}

/**
 * Policies back to ACCEPT and every rule the app created (comment contains the tag: baseline, SSH, presets,
 * blocks, log, default-reject) removed from INPUT and OUTPUT. Rules of other tools (fail2ban, Docker,
 * hand-written) are never touched; FORWARD / DOCKER* / nat are left alone on Docker hosts.
 */
async function iptDisable(ssh: SshClient, st: FirewallStateEx): Promise<void> {
  const bins = ['iptables', ...(st.ip6 ? ['ip6tables'] : [])]
  const lines: string[] = []
  for (const b of bins) {
    lines.push(`${b} -P INPUT ACCEPT`, `${b} -P OUTPUT ACCEPT`)
    if (!st.docker) lines.push(`${b} -P FORWARD ACCEPT`)
  }
  await rootRun(ssh, lines.join('\n'))
  const own = st.rules.filter((r) => {
    const m = iptMeta(r)
    return !!m && (m.chain === 'INPUT' || m.chain === 'OUTPUT') && (m.comment ?? '').includes(IPT_TAG)
  })
  if (own.length) await iptDeleteRules(ssh, own)
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

type PresetDef = Omit<FirewallPreset, 'allowed'>

function presetDefs(sshPort: number): PresetDef[] {
  return [
    { id: 'ssh', label: `SSH (${sshPort})`, description: 'Current SSH port', ports: [{ port: String(sshPort), proto: 'tcp' }], service: sshPort === 22 ? 'ssh' : undefined },
    { id: 'http', label: 'HTTP', description: 'Port 80', ports: [{ port: '80', proto: 'tcp' }], service: 'http' },
    { id: 'https', label: 'HTTPS', description: 'Port 443', ports: [{ port: '443', proto: 'tcp' }], service: 'https' },
    { id: 'web', label: 'HTTP + HTTPS', description: 'Ports 80 and 443', ports: [{ port: '80', proto: 'tcp' }, { port: '443', proto: 'tcp' }] },
    { id: 'mysql', label: 'MySQL / MariaDB', description: 'Port 3306', ports: [{ port: '3306', proto: 'tcp' }], service: 'mysql' },
    { id: 'postgres', label: 'PostgreSQL', description: 'Port 5432', ports: [{ port: '5432', proto: 'tcp' }], service: 'postgresql' },
    { id: 'mongodb', label: 'MongoDB', description: 'Port 27017', ports: [{ port: '27017', proto: 'tcp' }], service: 'mongodb' },
    { id: 'redis', label: 'Redis', description: 'Port 6379', ports: [{ port: '6379', proto: 'tcp' }], service: 'redis' },
    { id: 'smtp', label: 'SMTP', description: 'Ports 25 and 587', ports: [{ port: '25', proto: 'tcp' }, { port: '587', proto: 'tcp' }] },
    { id: 'imaps', label: 'IMAPS', description: 'Port 993', ports: [{ port: '993', proto: 'tcp' }], service: 'imaps' },
    { id: 'dns', label: 'DNS', description: 'Port 53 tcp + udp', ports: [{ port: '53', proto: 'tcp' }, { port: '53', proto: 'udp' }], service: 'dns' },
    { id: 'swarm', label: 'Docker Swarm', description: '2377/tcp, 7946 tcp+udp, 4789/udp', ports: [{ port: '2377', proto: 'tcp' }, { port: '7946', proto: 'tcp' }, { port: '7946', proto: 'udp' }, { port: '4789', proto: 'udp' }] },
    { id: 'wireguard', label: 'WireGuard', description: 'Port 51820/udp', ports: [{ port: '51820', proto: 'udp' }], service: 'wireguard' },
    { id: 'openvpn', label: 'OpenVPN', description: 'Port 1194/udp', ports: [{ port: '1194', proto: 'udp' }], service: 'openvpn' },
    { id: 'minecraft', label: 'Minecraft', description: 'Port 25565', ports: [{ port: '25565', proto: 'tcp' }] },
    { id: 'rdp', label: 'RDP', description: 'Port 3389', ports: [{ port: '3389', proto: 'tcp' }] },
    { id: 'samba', label: 'Samba', description: 'Ports 445 and 139', ports: [{ port: '445', proto: 'tcp' }, { port: '139', proto: 'tcp' }], service: 'samba' },
    { id: 'nfs', label: 'NFS', description: 'Port 2049', ports: [{ port: '2049', proto: 'tcp' }], service: 'nfs' },
    { id: 'node', label: 'Node dev', description: 'Port 3000', ports: [{ port: '3000', proto: 'tcp' }] },
    { id: 'custom', label: 'Custom…', description: 'Open the rule editor', ports: [], custom: true }
  ]
}

function presetAllowed(def: PresetDef, rules: FirewallRuleEx[]): boolean {
  if (def.custom || !def.ports.length) return false
  return def.ports.every((p) => rules.some((r) => ruleAllowsFromAnywhere(r, Number(p.port), p.proto)))
}

/* ------------------------------------------------------------------ */
/* Blocked addresses (all backends)                                    */
/* ------------------------------------------------------------------ */

function stripV6Marker(s: string): string {
  return s.replace(/\s*\(v6\)\s*/g, ' ').trim()
}

/** Plain "deny/reject from <ip>" rules of the current backend, whatever created them. */
function blockedFromRules(rules: FirewallRuleEx[]): BlockedIp[] {
  const out: BlockedIp[] = []
  for (const r of rules) {
    if (r.direction !== 'in' || !/^(DENY|REJECT)/i.test(r.action)) continue
    const from = stripV6Marker(r.from)
    const to = stripV6Marker(r.to)
    if (!/^anywhere$/i.test(to) || /^anywhere$/i.test(from) || !IP_RE.test(from)) continue
    let comment = r.comment?.trim()
    if (comment) {
      const m = comment.match(new RegExp(`^${BLOCK_COMMENT}:?\\s*(.*)$`, 'i'))
      if (m) comment = m[1].trim() || undefined
    }
    out.push({ ip: stripHostMask(from), comment, raw: r.raw, v6: r.v6 || isV6(from) })
  }
  return out
}

const ufwStripComment = (spec: string): string => spec.replace(/\scomment\s+'(?:[^']|'\\'')*'\s*$/, '')

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  ctx.handle('fw:state', async (serverId: string): Promise<FirewallStateEx> => getState(ctx.ssh(serverId)))

  ctx.handle('fw:presets', async (serverId: string): Promise<FirewallPreset[]> => {
    const st = await getState(ctx.ssh(serverId))
    return presetDefs(st.sshPort).map((d) => ({ ...d, allowed: presetAllowed(d, st.rules) }))
  })

  // ---------------- install ----------------
  ctx.handle('fw:install', async (serverId: string, backend: FwBackend) => {
    const ssh = ctx.ssh(serverId)
    if (backend !== 'ufw' && backend !== 'firewalld' && backend !== 'iptables') throw new Error('Unknown backend')
    const pkg = backend
    const { id } = ctx.tasks.start(`Install ${backend}`, serverId, async (h) => {
      const sshPorts = await detectSshPorts(ssh)
      if (backend === 'iptables') {
        const pm = ssh.os?.pkgManager ?? 'unknown'
        const hasIpt = (await rootExec(ssh, 'command -v iptables >/dev/null 2>&1 && echo yes')).stdout.includes('yes')
        const pkgs: string[] = []
        const stream = { signal: h.signal, onStdout: (c: string) => h.append(c), onStderr: (c: string) => h.append(c) }
        if (pm === 'apt') {
          h.log('Preseeding debconf so iptables-persistent saves the current rules without prompting…')
          await rootRun(ssh, `{ echo 'iptables-persistent iptables-persistent/autosave_v4 boolean true'; echo 'iptables-persistent iptables-persistent/autosave_v6 boolean true'; } | debconf-set-selections`)
          if (!hasIpt) pkgs.push('iptables')
          pkgs.push('iptables-persistent')
        } else if (pm === 'dnf' || pm === 'yum') {
          if (!hasIpt) pkgs.push('iptables')
          pkgs.push('iptables-services')
        } else if (pm === 'apk') pkgs.push('iptables', 'ip6tables')
        else if (pm === 'pacman' || pm === 'zypper') {
          if (!hasIpt) pkgs.push('iptables')
        } else throw new Error('Unsupported package manager')
        if (pkgs.length) {
          h.log(`Installing ${pkgs.join(', ')}…`)
          await runPkg(ssh, installCmd(ssh, pkgs), stream)
        } else h.log('iptables is already installed.')
        h.log('Setting up persistence (rules restored at boot)…')
        if (pm === 'apt') await rootExec(ssh, 'systemctl enable netfilter-persistent >/dev/null 2>&1 || true')
        else if (pm === 'dnf' || pm === 'yum') {
          // iptables-services ships a default /etc/sysconfig/iptables (22/tcp + REJECT): overwrite it with the live rules before enabling.
          await rootRun(ssh, 'mkdir -p /etc/sysconfig && iptables-save > /etc/sysconfig/iptables && { ip6tables-save > /etc/sysconfig/ip6tables 2>/dev/null || true; }; systemctl enable iptables >/dev/null 2>&1 || true; systemctl enable ip6tables >/dev/null 2>&1 || true')
        } else if (pm === 'apk') await rootExec(ssh, 'rc-update add iptables default >/dev/null 2>&1; rc-update add ip6tables default >/dev/null 2>&1; true')
        else if (pm === 'pacman') await rootRun(ssh, 'mkdir -p /etc/iptables && iptables-save > /etc/iptables/iptables.rules && { ip6tables-save > /etc/iptables/ip6tables.rules 2>/dev/null || true; }; systemctl enable iptables >/dev/null 2>&1 || true; systemctl enable ip6tables >/dev/null 2>&1 || true')
        else h.log('warning: no persistence package is known for this distribution; rules are saved to /etc/iptables/rules.v4 but nothing restores them at boot.')
        const warn = await iptPersist(ssh)
        if (warn) h.log(`warning: ${warn}`)
        h.log(`iptables is ready (SSH port(s) ${sshPorts.join(', ')}). Enable the firewall from the Firewall page: a safe baseline (loopback, established, ICMP, SSH) is applied before INPUT is set to DROP, and access is verified with a second login.`)
        ctx.audit(serverId, 'fw.install', backend)
        return
      }
      h.log(`Installing ${pkg}…`)
      await runPkg(ssh, installCmd(ssh, [pkg]), { signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      if (backend === 'ufw') {
        h.log(`Pre-adding allow rule for SSH port(s) ${sshPorts.join(', ')} (firewall stays disabled)…`)
        for (const p of sshPorts) await ufwAllowSsh(ssh, p).catch((e) => h.log(`warning: ${String(e)}`))
        h.log('ufw installed. Enable it from the Firewall page; the SSH port is protected automatically.')
      } else {
        if (!ssh.os?.hasSystemd) throw new Error('firewalld needs systemd')
        h.log(`Allowing SSH port(s) ${sshPorts.join(', ')} in the permanent configuration…`)
        for (const p of sshPorts) await fwdAllowSsh(ssh, p, false)
        h.log('Starting firewalld…')
        await rootRun(ssh, 'systemctl enable --now firewalld')
        await sleep(1500)
        h.log('Verifying that this app can still log in…')
        if (!(await probeLogin(ctx, serverId))) {
          h.log('Login probe FAILED, stopping firewalld again…')
          await rootExec(ssh, 'systemctl disable --now firewalld')
          throw new Error('firewalld blocked the SSH login probe; it has been stopped and disabled again.')
        }
        h.log('firewalld is running.')
      }
      ctx.audit(serverId, 'fw.install', backend)
    })
    return id
  })

  // ---------------- enable / disable ----------------
  ctx.handle('fw:enable', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const st = await getState(ssh)
    if (st.backend === 'none') throw new Error('No firewall backend installed')
    const log: string[] = []
    let warning: string | undefined
    if (st.backend === 'ufw') {
      for (const p of st.sshPorts) {
        await ufwAllowSsh(ssh, p)
        log.push(`allow ${p}/tcp`)
      }
      await rootRun(ssh, 'ufw --force enable', { timeoutMs: 60000 })
      await sleep(1500)
      if (!(await probeLogin(ctx, serverId))) {
        await rootExec(ssh, 'ufw --force disable')
        throw new Error('ufw blocked the SSH login probe; the firewall has been disabled again. Check cloud security groups and the SSH port.')
      }
    } else if (st.backend === 'firewalld') {
      if (!ssh.os?.hasSystemd) throw new Error('firewalld needs systemd')
      for (const p of st.sshPorts) {
        await fwdAllowSsh(ssh, p, st.active)
        log.push(`add-port ${p}/tcp`)
      }
      await rootRun(ssh, 'systemctl enable --now firewalld', { timeoutMs: 60000 })
      await sleep(1500)
      if (!(await probeLogin(ctx, serverId))) {
        await rootExec(ssh, 'systemctl disable --now firewalld')
        throw new Error('firewalld blocked the SSH login probe; it has been stopped and disabled again.')
      }
    } else {
      if (st.nftOnly) throw new Error('Only nftables is present on this server. Install iptables (nft-backed) from the Firewall page to manage rules.')
      // One script per address family; v4 first. `set -e` + policy as the last statement => never half-applied.
      await rootRun(ssh, iptEnableScript(false, st.sshPorts), { timeoutMs: 60000 })
      log.push(`iptables: lo, established, icmp, ssh ${st.sshPorts.join(',')} -> INPUT DROP`)
      if (st.ip6) {
        await rootRun(ssh, iptEnableScript(true, st.sshPorts), { timeoutMs: 60000 }).catch(async (e) => {
          await rootExec(ssh, 'iptables -P INPUT ACCEPT; ip6tables -P INPUT ACCEPT')
          throw e
        })
        log.push(`ip6tables: lo, established, icmpv6, ssh -> INPUT DROP`)
      }
      await sleep(1000)
      if (!(await probeLogin(ctx, serverId))) {
        await rootExec(ssh, `iptables -P INPUT ACCEPT${st.ip6 ? '; ip6tables -P INPUT ACCEPT' : ''}`)
        throw new Error('iptables blocked the SSH login probe; the INPUT policy has been set back to ACCEPT. Check cloud security groups and the SSH port.')
      }
      warning = await iptPersist(ssh)
    }
    ctx.audit(serverId, 'fw.enable', `${st.backend} ssh=${st.sshPorts.join(',')}`)
    return { backend: st.backend, sshPorts: st.sshPorts, log, warning }
  })

  ctx.handle('fw:disable', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const st = await getState(ssh)
    let warning: string | undefined
    if (st.backend === 'ufw') await rootRun(ssh, 'ufw --force disable')
    else if (st.backend === 'firewalld') await rootRun(ssh, 'systemctl disable --now firewalld')
    else if (st.backend === 'iptables' && !st.nftOnly) {
      await iptDisable(ssh, st)
      warning = await iptPersist(ssh)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.disable', st.backend)
    return { warning }
  })

  // ---------------- defaults ----------------
  ctx.handle('fw:setDefaults', async (serverId: string, opts: { incoming: FwPolicy; outgoing: FwPolicy }) => {
    const ssh = ctx.ssh(serverId)
    const incoming: FwPolicy = ['deny', 'allow', 'reject'].includes(opts?.incoming) ? opts.incoming : 'deny'
    const outgoing: FwPolicy = ['deny', 'allow', 'reject'].includes(opts?.outgoing) ? opts.outgoing : 'allow'
    const st = await getState(ssh)
    let addedSsh = false
    let warning: string | undefined
    if (st.backend === 'ufw') {
      if (incoming !== 'allow' && !st.sshAllowed) {
        for (const p of st.sshPorts) await ufwAllowSsh(ssh, p)
        addedSsh = true
      }
      await rootRun(ssh, `ufw default ${incoming} incoming && ufw default ${outgoing} outgoing`)
    } else if (st.backend === 'firewalld') {
      if (outgoing !== 'allow') throw new Error('firewalld does not filter outgoing traffic by zone policy; only "allow" is supported for outgoing')
      const zone = st.defaultZone ?? 'public'
      if (incoming !== 'allow' && !st.sshAllowed) {
        for (const p of st.sshPorts) await fwdAllowSsh(ssh, p, st.active)
        addedSsh = true
      }
      const target = incoming === 'allow' ? 'ACCEPT' : incoming === 'deny' ? 'DROP' : '%%REJECT%%'
      await rootRun(ssh, `firewall-cmd --permanent --zone=${shq(zone)} --set-target=${shq(target)} >/dev/null && firewall-cmd --reload >/dev/null`)
    } else if (st.backend === 'iptables' && !st.nftOnly) {
      const bins: boolean[] = [false, ...(st.ip6 ? [true] : [])]
      // Chain policies can only be ACCEPT or DROP: "reject" = DROP policy + a final REJECT rule the app owns.
      // Deleted first, while the rule indices of `st` are still valid.
      const rejectRules = iptAppRules(st.rules, 'INPUT', (m) => iptIsCatchAll(m) && m.target === 'REJECT' && (m.comment ?? '') === IPT_REJECT_COMMENT).concat(iptAppRules(st.rules, 'OUTPUT', (m) => iptIsCatchAll(m) && m.target === 'REJECT' && (m.comment ?? '') === IPT_REJECT_COMMENT))
      if (rejectRules.length) await iptDeleteRules(ssh, rejectRules)
      if (incoming !== 'allow') {
        // Same baseline as enabling (loopback, established/related, ICMP, SSH): a DROP policy with only an
        // SSH rule would cut loopback services and the replies of every outbound connection.
        for (const v6 of bins) await rootRun(ssh, iptEnableScript(v6, st.sshPorts), { timeoutMs: 60000 })
        addedSsh = !st.sshAllowed
      }
      const lines: string[] = []
      for (const v6 of bins) {
        const b = iptBin(v6)
        const rw = v6 ? 'icmp6-port-unreachable' : 'icmp-port-unreachable'
        if (outgoing !== 'allow') {
          // Replies of the SSH session must keep flowing when OUTPUT drops by default.
          lines.push(`${b} -C OUTPUT -o lo -m comment --comment ${shq(`${IPT_TAG}: loopback`)} -j ACCEPT 2>/dev/null || ${b} -I OUTPUT 1 -o lo -m comment --comment ${shq(`${IPT_TAG}: loopback`)} -j ACCEPT`)
          lines.push(`${b} -C OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment ${shq(`${IPT_TAG}: established`)} -j ACCEPT 2>/dev/null || ${b} -I OUTPUT 2 -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment ${shq(`${IPT_TAG}: established`)} -j ACCEPT`)
        }
        if (incoming === 'reject') lines.push(`${b} -A INPUT -m comment --comment ${shq(IPT_REJECT_COMMENT)} -j REJECT --reject-with ${rw}`)
        if (outgoing === 'reject') lines.push(`${b} -A OUTPUT -m comment --comment ${shq(IPT_REJECT_COMMENT)} -j REJECT --reject-with ${rw}`)
        lines.push(`${b} -P INPUT ${incoming === 'allow' ? 'ACCEPT' : 'DROP'}`)
        lines.push(`${b} -P OUTPUT ${outgoing === 'allow' ? 'ACCEPT' : 'DROP'}`)
      }
      await rootRun(ssh, `set -e\n${lines.join('\n')}`)
      if (incoming !== 'allow' || outgoing !== 'allow') {
        await sleep(1000)
        if (!(await probeLogin(ctx, serverId))) {
          await rootExec(ssh, bins.map((v6) => `${iptBin(v6)} -P INPUT ACCEPT; ${iptBin(v6)} -P OUTPUT ACCEPT`).join('; '))
          throw new Error('The new policies blocked the SSH login probe; INPUT/OUTPUT have been set back to ACCEPT.')
        }
      }
      warning = await iptPersist(ssh)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.defaults', `in=${incoming} out=${outgoing}${addedSsh ? ' (+ssh)' : ''}`)
    return { addedSsh, sshPorts: st.sshPorts, warning }
  })

  // ---------------- rules ----------------
  ctx.handle('fw:addRule', async (serverId: string, input: AddRuleInput) => {
    const ssh = ctx.ssh(serverId)
    if (!ACTIONS.includes(input?.action)) throw new Error('Invalid action')
    if (input.proto && !['tcp', 'udp', 'any'].includes(input.proto)) throw new Error('Invalid protocol')
    const port = normalizePort(input.port)
    const st = await getState(ssh)
    if (['deny', 'reject'].includes(input.action) && !input.from && port && port.ports.some((p) => st.sshPorts.includes(p)) && !input.force) {
      throw new Error(`SSH_BLOCK: this rule would block the SSH port (${st.sshPorts.join(', ')}) and could lock you out.`)
    }
    if (st.backend === 'ufw') {
      const cmd = buildUfwCommand(input, port)
      const out = await rootRun(ssh, cmd, { timeoutMs: 60000 })
      ctx.audit(serverId, 'fw.addRule', cmd.slice(4))
      return { command: cmd, output: out.trim() }
    }
    if (st.backend === 'firewalld') {
      const cmds = buildFirewalldCommands(input, port, st.defaultZone ?? 'public')
      await rootRun(ssh, `${cmds.join(' && ')} && firewall-cmd --reload >/dev/null`, { timeoutMs: 60000 })
      ctx.audit(serverId, 'fw.addRule', cmds.map((c) => c.replace(/^firewall-cmd --permanent /, '')).join('; '))
      return { command: cmds.join('\n'), output: '' }
    }
    if (st.backend === 'iptables' && !st.nftOnly) {
      const args = iptRuleArgs(input, port)
      const chain = input.direction === 'out' ? 'OUTPUT' : 'INPUT'
      const addrV6 = !!((input.from && isV6(input.from)) || (input.to && isV6(input.to)))
      if (input.v6 && ((input.from && !isV6(input.from)) || (input.to && !isV6(input.to)))) throw new Error('IPv6-only rule with an IPv4 address')
      const families: boolean[] = addrV6 || input.v6 ? [true] : input.from || input.to ? [false] : st.ip6 ? [false, true] : [false]
      if (families.includes(true) && !st.ip6) throw new Error('ip6tables is not usable on this server')
      // allow/limit go before the first catch-all (DROP/REJECT/LOG) rule so they take effect; deny/reject go to the top.
      const cmds = families.map((v6) => iptInsertCmd(iptBin(v6), chain, st.rules, v6, args, input.action === 'allow' || input.action === 'limit' ? 'before-catchall' : 'top'))
      await rootRun(ssh, `set -e\n${cmds.join('\n')}`, { timeoutMs: 60000 })
      const warning = await iptPersist(ssh)
      ctx.audit(serverId, 'fw.addRule', cmds.join('; '))
      return { command: cmds.join('\n'), output: warning ?? '' , warning }
    }
    throw new Error('No firewall backend installed')
  })

  ctx.handle('fw:deleteRule', async (serverId: string, rule: { index: number; raw: string; force?: boolean }) => {
    const ssh = ctx.ssh(serverId)
    if (!rule || typeof rule.raw !== 'string') throw new Error('Rule required')
    const st = await getState(ssh)
    const current = st.rules.find((r) => r.raw === rule.raw) ?? st.rules.find((r) => r.index === rule.index && r.raw === rule.raw)
    if (!current) throw new Error('This rule no longer exists in the current rule set. Reload and try again.')
    const protectsSsh = st.sshPorts.some((p) => ruleCovers(current, p, 'tcp'))
    if (protectsSsh && !rule.force) {
      const others = st.rules.filter((r) => r !== current && r.v6 === current.v6 && st.sshPorts.some((p) => ruleCovers(r, p, 'tcp')))
      if (!others.length) throw new Error(`This rule allows the SSH port (${st.sshPorts.join(', ')}). Deleting it could lock you out; confirm explicitly to proceed.`)
    }
    let warning: string | undefined
    if (st.backend === 'ufw') {
      if (st.active) await rootRun(ssh, `ufw --force delete ${current.index}`)
      else await rootRun(ssh, `ufw --force delete ${ufwStripComment(current.raw)}`)
    } else if (st.backend === 'firewalld') {
      const zone = `--zone=${shq(st.defaultZone ?? 'public')}`
      let cmd: string
      if (current.raw.startsWith('service:')) cmd = `--remove-service=${shq(current.raw.slice(8))}`
      else if (current.raw.startsWith('port:')) cmd = `--remove-port=${shq(current.raw.slice(5))}`
      else if (current.raw.startsWith('rich:')) cmd = `--remove-rich-rule=${shq(current.raw.slice(5))}`
      else throw new Error('Unknown firewalld rule type')
      await rootRun(ssh, `firewall-cmd --permanent ${zone} ${cmd} >/dev/null && firewall-cmd --reload >/dev/null`)
    } else if (st.backend === 'iptables' && !st.nftOnly) {
      await iptDeleteRules(ssh, [current])
      warning = await iptPersist(ssh)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.deleteRule', `${current.action} ${current.to} from ${current.from}${protectsSsh ? ' (SSH rule, forced)' : ''}`)
    return { warning }
  })

  /** One-click preset: add (enable=true) or remove (enable=false) all its ports. */
  ctx.handle('fw:applyPreset', async (serverId: string, id: string, enable: boolean, force?: boolean) => {
    const ssh = ctx.ssh(serverId)
    const st = await getState(ssh)
    if (st.backend === 'none' || st.nftOnly) throw new Error('No firewall backend installed')
    const def = presetDefs(st.sshPort).find((d) => d.id === id)
    if (!def || def.custom) throw new Error('Unknown preset')
    const zone = st.defaultZone ?? 'public'
    if (enable) {
      const cmds: string[] = []
      for (const p of def.ports) {
        if (st.rules.some((r) => ruleAllowsFromAnywhere(r, Number(p.port), p.proto))) continue
        const comment = id === 'ssh' ? SSH_COMMENT : st.backend === 'iptables' ? `${IPT_TAG}: ${def.label}` : `${def.label} (ServerSysOps)`
        if (st.backend === 'ufw') cmds.push(`ufw allow in proto ${p.proto} from any to any port ${p.port} comment ${shq(comment)}`)
        else if (st.backend === 'firewalld') cmds.push(`firewall-cmd --permanent --zone=${shq(zone)} --add-port=${p.port}/${p.proto} >/dev/null`)
        else {
          const args = ['-p', p.proto, '--dport', p.port, '-m', 'comment', '--comment', comment, '-j', 'ACCEPT']
          for (const v6 of [false, ...(st.ip6 ? [true] : [])]) cmds.push(iptInsertCmd(iptBin(v6), 'INPUT', st.rules, v6, args, 'before-catchall'))
        }
      }
      if (!cmds.length) return { changed: 0 }
      await rootRun(ssh, (st.backend === 'iptables' ? 'set -e\n' : '') + cmds.join(st.backend === 'iptables' ? '\n' : ' && ') + (st.backend === 'firewalld' ? ' && firewall-cmd --reload >/dev/null' : ''), { timeoutMs: 60000 })
      const warning = st.backend === 'iptables' ? await iptPersist(ssh) : undefined
      ctx.audit(serverId, 'fw.preset', `${id} on`)
      return { changed: cmds.length, warning }
    }
    // Remove: every rule that exactly matches one of the preset's ports (not broader rules).
    const targets = st.rules.filter((r) => {
      const t = parseTo(r.to)
      if (r.direction !== 'in' || t.anyPort || !/^(ALLOW|LIMIT)/i.test(r.action)) return false
      return def.ports.some((p) => t.ports.length === 1 && t.ports[0] === Number(p.port) && (t.proto === p.proto || t.proto === 'any'))
    })
    if (!targets.length) return { changed: 0 }
    if (id === 'ssh' && !force) throw new Error('Removing the SSH rule could lock you out; confirm explicitly to proceed.')
    let warning: string | undefined
    if (st.backend === 'ufw') {
      // Delete by index from highest to lowest so numbering stays valid.
      if (st.active) for (const r of [...targets].sort((a, b) => b.index - a.index)) await rootRun(ssh, `ufw --force delete ${r.index}`)
      else for (const r of targets) await rootRun(ssh, `ufw --force delete ${ufwStripComment(r.raw)}`)
    } else if (st.backend === 'firewalld') {
      const cmds = targets.map((r) => (r.raw.startsWith('service:') ? `--remove-service=${shq(r.raw.slice(8))}` : r.raw.startsWith('port:') ? `--remove-port=${shq(r.raw.slice(5))}` : `--remove-rich-rule=${shq(r.raw.slice(5))}`))
      await rootRun(ssh, cmds.map((c) => `firewall-cmd --permanent --zone=${shq(zone)} ${c} >/dev/null`).join(' && ') + ' && firewall-cmd --reload >/dev/null')
    } else {
      await iptDeleteRules(ssh, targets)
      warning = await iptPersist(ssh)
    }
    ctx.audit(serverId, 'fw.preset', `${id} off`)
    return { changed: targets.length, warning }
  })

  // ---------------- logging ----------------
  ctx.handle('fw:setLogging', async (serverId: string, level: FwLogLevel) => {
    const ssh = ctx.ssh(serverId)
    if (!LOG_LEVELS.includes(level)) throw new Error('Invalid log level')
    const st = await getState(ssh)
    let warning: string | undefined
    if (st.backend === 'ufw') await rootRun(ssh, `ufw logging ${level}`)
    else if (st.backend === 'firewalld') {
      const v = level === 'off' ? 'off' : level === 'low' ? 'unicast' : 'all'
      await rootRun(ssh, `firewall-cmd --set-log-denied=${v} >/dev/null`)
    } else if (st.backend === 'iptables' && !st.nftOnly) {
      // Remove the app's LOG rules, then (unless off) insert one right before the final DROP/REJECT so only
      // packets that are about to be dropped are logged. low = 3/min, medium = 10/min, high/full = unlimited.
      const existing = iptAppRules(st.rules, 'INPUT', (m) => iptIsAppLog(m))
      if (existing.length) await iptDeleteRules(ssh, existing)
      if (level !== 'off') {
        const rest = existing.length ? await getState(ssh) : st
        const limit = level === 'low' ? ['-m', 'limit', '--limit', '3/min', '--limit-burst', '10'] : level === 'medium' ? ['-m', 'limit', '--limit', '10/min', '--limit-burst', '20'] : []
        const args = [...limit, '-m', 'comment', '--comment', IPT_LOG_COMMENT, '-j', 'LOG', '--log-prefix', IPT_LOG_PREFIX, '--log-level', '4']
        const cmds: string[] = []
        for (const v6 of [false, ...(st.ip6 ? [true] : [])]) {
          const pos = iptCatchAllIndex(rest.rules, v6, 'INPUT', false)
          cmds.push(pos !== undefined ? shJoin([iptBin(v6), '-I', 'INPUT', pos, ...args]) : shJoin([iptBin(v6), '-A', 'INPUT', ...args]))
        }
        await rootRun(ssh, `set -e\n${cmds.join('\n')}`)
      }
      warning = await iptPersist(ssh)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.logging', level)
    return { warning }
  })

  // ---------------- reset ----------------
  ctx.handle('fw:reset', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const st = await getState(ssh)
    let warning: string | undefined
    if (st.backend === 'ufw') {
      await rootRun(ssh, 'ufw --force reset >/dev/null', { timeoutMs: 60000 })
      for (const p of st.sshPorts) await ufwAllowSsh(ssh, p)
    } else if (st.backend === 'firewalld') {
      await rootRun(ssh, 'systemctl disable --now firewalld; rm -f /etc/firewalld/zones/*.xml /etc/firewalld/zones/*.xml.old; true', { timeoutMs: 60000 })
      for (const p of st.sshPorts) await fwdAllowSsh(ssh, p, false)
    } else if (st.backend === 'iptables' && !st.nftOnly) {
      // Policies ACCEPT and the app's rules removed (= disabled). Enabling again recreates the baseline incl. the SSH rule.
      await iptDisable(ssh, st)
      warning = await iptPersist(ssh)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.reset', st.backend)
    return { sshPorts: st.sshPorts, warning }
  })

  // ---------------- block / unblock an address (all backends) ----------------
  ctx.handle('fw:blockIp', async (serverId: string, input: BlockIpInput): Promise<void> => {
    const ssh = ctx.ssh(serverId)
    const ip = assertIp(input?.ip ?? '', 'address')
    const comment = cleanComment(input?.comment)
    const fullComment = comment ? `${BLOCK_COMMENT}: ${comment}` : BLOCK_COMMENT
    const me = await sshClientIp(ssh)
    if (me && cidrContains(ip, me)) throw new Error(`Refusing to block ${ip}: it covers ${me}, the address this SSH session comes from. You would lock yourself out.`)
    const st = await getState(ssh)
    if (st.backend === 'none' || st.nftOnly) throw new Error('No firewall backend installed')
    if ((st.backend === 'ufw' || st.backend === 'firewalld') && !st.active) throw new Error(`${st.backend} is installed but not enabled, so a block rule would have no effect. Enable the firewall on the Firewall page first.`)
    const v6 = isV6(ip)
    if (st.backend === 'ufw') {
      const rule = `deny from ${ip} to any comment ${shq(fullComment)}`
      // prepend (ufw >= 0.36) handles the v4/v6 ordering; older versions fall back to insert 1 / plain deny.
      await rootRun(ssh, `ufw prepend ${rule} 2>/dev/null || ufw insert 1 ${rule} 2>/dev/null || ufw ${rule}`, { timeoutMs: 60000 })
    } else if (st.backend === 'firewalld') {
      const rich = `rule family="${v6 ? 'ipv6' : 'ipv4'}" source address="${ip}" drop`
      const zone = `--zone=${shq(st.defaultZone ?? 'public')}`
      if (st.active) await rootRun(ssh, `firewall-cmd --permanent ${zone} --add-rich-rule=${shq(rich)} >/dev/null && firewall-cmd --reload >/dev/null`, { timeoutMs: 60000 })
      else await rootRun(ssh, `firewall-offline-cmd ${zone} --add-rich-rule=${shq(rich)} >/dev/null`)
    } else {
      if (v6 && !st.ip6) throw new Error('ip6tables is not usable on this server')
      await rootRun(ssh, shJoin([iptBin(v6), '-I', 'INPUT', 1, '-s', ip, '-m', 'comment', '--comment', fullComment, '-j', 'DROP']))
      await iptPersist(ssh)
    }
    ctx.audit(serverId, 'fw.blockIp', `${ip}${comment ? ` (${comment})` : ''} via ${st.backend}`)
  })

  ctx.handle('fw:unblockIp', async (serverId: string, input: UnblockIpInput): Promise<void> => {
    const ssh = ctx.ssh(serverId)
    const ip = stripHostMask(assertIp(input?.ip ?? '', 'address'))
    const st = await getState(ssh)
    if (st.backend === 'none' || st.nftOnly) throw new Error('No firewall backend installed')
    const blocked = blockedFromRules(st.rules).filter((b) => b.ip === ip)
    if (!blocked.length) throw new Error(`${ip} is not blocked`)
    const rules = blocked.map((b) => st.rules.find((r) => r.raw === b.raw)).filter((r): r is FirewallRuleEx => !!r)
    if (st.backend === 'ufw') {
      if (st.active) for (const r of [...rules].sort((a, b) => b.index - a.index)) await rootRun(ssh, `ufw --force delete ${r.index}`)
      else for (const r of rules) await rootRun(ssh, `ufw --force delete ${ufwStripComment(r.raw)}`)
    } else if (st.backend === 'firewalld') {
      const zone = `--zone=${shq(st.defaultZone ?? 'public')}`
      const cmds = rules.filter((r) => r.raw.startsWith('rich:')).map((r) => `${st.active ? 'firewall-cmd --permanent' : 'firewall-offline-cmd'} ${zone} --remove-rich-rule=${shq(r.raw.slice(5))} >/dev/null`)
      if (!cmds.length) throw new Error('The block is not a rich rule; remove it from the Rules list instead')
      await rootRun(ssh, cmds.join(' && ') + (st.active ? ' && firewall-cmd --reload >/dev/null' : ''), { timeoutMs: 60000 })
    } else {
      await iptDeleteRules(ssh, rules)
      await iptPersist(ssh)
    }
    ctx.audit(serverId, 'fw.unblockIp', `${ip} via ${st.backend}`)
  })

  ctx.handle('fw:blockedIps', async (serverId: string): Promise<BlockedIp[]> => {
    const st = await getState(ctx.ssh(serverId))
    return blockedFromRules(st.rules)
  })

  // ---------------- blocked packets log ----------------
  ctx.handle('fw:log', async (serverId: string, linesRaw?: number): Promise<BlockedPacket[]> => {
    const ssh = ctx.ssh(serverId)
    const n = Math.max(10, Math.min(1000, Math.floor(Number(linesRaw) || 100)))
    const pattern = 'UFW (BLOCK|AUDIT|LIMIT|ALLOW)|SSO-FW|FINAL_REJECT|STATE_INVALID|_REJECT:|_DROP:'
    const r = await rootExec(
      ssh,
      `{ journalctl -k --no-pager -o short -n 5000 2>/dev/null; tail -n 5000 /var/log/ufw.log 2>/dev/null; tail -n 5000 /var/log/kern.log 2>/dev/null; tail -n 3000 /var/log/messages 2>/dev/null; dmesg 2>/dev/null | tail -n 2000; } | grep -E ${shq(pattern)} | tail -n ${n}`,
      { timeoutMs: 60000 }
    )
    const out: BlockedPacket[] = []
    const seen = new Set<string>()
    for (const line of r.stdout.split('\n')) {
      if (!line.trim() || seen.has(line)) continue
      seen.add(line)
      const time = line.match(/^(\w{3}\s+\d{1,2} \d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[^ ]*)/)?.[1] ?? ''
      const action = line.match(/\[UFW (\w+)\]/)?.[1] ?? (line.includes('[SSO-FW]') ? 'BLOCK' : /_REJECT|FINAL_REJECT/.test(line) ? 'REJECT' : /_DROP|STATE_INVALID/.test(line) ? 'DROP' : 'BLOCK')
      const f = (k: string): string | undefined => line.match(new RegExp(`\\b${k}=(\\S*)`))?.[1]
      const src = f('SRC')
      if (!src) continue
      out.push({ time, action, iface: f('IN') ?? '', src, dst: f('DST') ?? '', proto: f('PROTO') ?? '', spt: Number(f('SPT')) || undefined, dpt: Number(f('DPT')) || undefined, raw: line })
    }
    return out.reverse()
  })

  // ---------------- exposure ----------------
  ctx.handle('fw:listening', async (serverId: string): Promise<ExposedPort[]> => {
    const ssh = ctx.ssh(serverId)
    const [st, r] = await Promise.all([getState(ssh), rootExec(ssh, 'ss -tulpnH 2>/dev/null || ss -tulnH 2>/dev/null')])
    const out: ExposedPort[] = []
    const seen = new Set<string>()
    for (const line of r.stdout.split('\n')) {
      const t = line.trim().split(/\s+/)
      if (t.length < 5) continue
      const proto = t[0].replace(/6$/, '') as 'tcp' | 'udp'
      if (proto !== 'tcp' && proto !== 'udp') continue
      const local = t[4]
      const m = local.match(/^(.*):(\d+)$/)
      if (!m) continue
      const address = m[1].replace(/^\[|\]$/g, '')
      const port = Number(m[2])
      const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
      const key = `${proto}:${address}:${port}`
      if (seen.has(key)) continue
      seen.add(key)
      const isPublic = !/^(127\.|::1$|localhost|\[::1\])/.test(address)
      const covered = st.rules.some((rl) => ruleCovers(rl, port, proto))
      const lp: ListeningPort = { proto, address: address || '*', port, process: proc?.[1] ?? '', pid: proc ? Number(proc[2]) : undefined }
      // With an iptables INPUT policy of ACCEPT nothing is blocked even when rules exist.
      const filtering = st.active && !(st.backend === 'iptables' && st.defaultIncoming === 'allow')
      out.push({ ...lp, allowed: filtering ? covered : false, public: isPublic })
    }
    return out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
  })
}
