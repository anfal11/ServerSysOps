import type { Ctx } from '../core'
import type { ListeningPort } from '@shared/types'
import type { AddRuleInput, BlockedPacket, ExposedPort, FirewallPreset, FirewallRuleEx, FirewallStateEx, FirewalldZone, FwBackend, FwLogLevel, FwPolicy } from '@shared/modules/firewall'
import { SshClient, type ExecOptions } from '../ssh/SshClient'
import { shq } from '../ssh/shell'
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

/* ------------------------------------------------------------------ */
/* Rule parsing / matching                                             */
/* ------------------------------------------------------------------ */

const APP_PORTS: Record<string, string> = { openssh: '22/tcp', ssh: '22/tcp', 'nginx full': '80,443/tcp', 'nginx http': '80/tcp', 'nginx https': '443/tcp', 'apache full': '80,443/tcp', apache: '80/tcp', 'apache secure': '443/tcp', 'www full': '80,443/tcp', www: '80/tcp', 'www secure': '443/tcp', 'dns': '53', 'mail': '25/tcp', 'smtp': '25/tcp', 'imaps': '993/tcp', 'pop3s': '995/tcp', 'samba': '137,138,139,445', 'nfs': '2049', 'cups': '631' }

/** Service names firewalld ships; only the common ones are needed to compute "SSH allowed" / exposure. */
const FWD_SERVICE_PORTS: Record<string, string> = { ssh: '22/tcp', http: '80/tcp', https: '443/tcp', mysql: '3306/tcp', postgresql: '5432/tcp', mongodb: '27017/tcp', redis: '6379/tcp', smtp: '25/tcp', 'smtp-submission': '587/tcp', imaps: '993/tcp', dns: '53', 'docker-swarm': '2377/tcp', wireguard: '51820/udp', openvpn: '1194/udp', minecraft: '25565/tcp', rdp: '3389/tcp', samba: '445,139/tcp', nfs: '2049', 'dhcpv6-client': '546/udp', cockpit: '9090/tcp', mdns: '5353/udp', ftp: '21/tcp', ntp: '123/udp', 'ms-wbt': '3389/tcp', 'kube-apiserver': '6443/tcp', 'etcd-client': '2379/tcp', vnc: '5900/tcp', 'smtps': '465/tcp', imap: '143/tcp', pop3: '110/tcp', pop3s: '995/tcp', ldap: '389/tcp', ldaps: '636/tcp', 'elasticsearch': '9200/tcp', 'grafana': '3000/tcp', 'prometheus': '9090/tcp', 'syslog': '514/udp', 'snmp': '161/udp' }

/** Interpret the `To` column of a rule (`22/tcp`, `80,443/tcp`, `6000:6100/udp`, `Anywhere`, `OpenSSH`, `ssh (service)`, `22/tcp on eth0`). */
function parseTo(toRaw: string): ParsedTo {
  let to = toRaw.replace(/\s*\(v6\)\s*/g, ' ').replace(/\s+on\s+\S+$/, '').replace(/\s*\(service\)\s*$/, '').trim()
  const lower = to.toLowerCase()
  if (APP_PORTS[lower]) to = APP_PORTS[lower]
  else if (FWD_SERVICE_PORTS[lower]) to = FWD_SERVICE_PORTS[lower]
  if (!to || /^anywhere$/i.test(to) || /^[0-9a-f.:]+(\/\d+)?$/i.test(to)) return { ports: [], proto: 'any', anyPort: true }
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
  return 'ufw'
}

async function getState(ssh: SshClient): Promise<FirewallStateEx> {
  const script = `
echo __UFW; command -v ufw >/dev/null 2>&1 && echo yes
echo __FWD; command -v firewall-cmd >/dev/null 2>&1 && echo yes
echo __SSHD; (sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null) | awk '/^port /{print $2}'; grep -ihE '^\\s*Port\\s' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '{print $2}'; (ss -tlnpH 2>/dev/null | grep -E 'users:\\(\\("sshd' | awk '{print $4}' | sed 's/.*://')
if command -v ufw >/dev/null 2>&1; then
echo __UFWVERBOSE; ufw status verbose 2>&1
echo __UFWNUM; ufw status numbered 2>&1
echo __UFWADDED; ufw show added 2>&1
echo __UFWCONF; grep -E '^(ENABLED|LOGLEVEL)=' /etc/ufw/ufw.conf 2>/dev/null; grep -E '^DEFAULT_(INPUT|OUTPUT)_POLICY=' /etc/default/ufw 2>/dev/null
echo __UFWVER; ufw version 2>/dev/null | head -1
fi
if command -v firewall-cmd >/dev/null 2>&1; then
echo __FWDSTATE; firewall-cmd --state 2>&1
echo __FWDENABLED; systemctl is-enabled firewalld 2>/dev/null
echo __FWDZONE; firewall-cmd --get-default-zone 2>/dev/null
echo __FWDZONES; firewall-cmd --list-all-zones 2>/dev/null
echo __FWDLOG; firewall-cmd --get-log-denied 2>/dev/null
echo __FWDVER; firewall-cmd --version 2>/dev/null
fi
echo __END`
  const r = await rootExec(ssh, script, { timeoutMs: 60000 })
  const sec = sectionize(r.stdout)
  const hasUfw = (sec.UFW?.[0] ?? '').includes('yes')
  const hasFwd = (sec.FWD?.[0] ?? '').includes('yes')
  const sshPorts = [...new Set((sec.SSHD ?? []).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))]
  if (!sshPorts.length) sshPorts.push(ssh.profile.port || 22)
  const sshPort = sshPorts.includes(ssh.profile.port) ? ssh.profile.port : sshPorts[0]
  const backendAvailable: FwBackend[] = []
  if (hasUfw) backendAvailable.push('ufw')
  if (hasFwd) backendAvailable.push('firewalld')
  const installable = (ssh.os?.pkgManager ?? 'unknown') !== 'unknown'
  const base = { installed: backendAvailable.length > 0, backendAvailable, installable, sshPort, sshPorts, recommended: recommendedBackend(ssh) }

  const fwdActive = (sec.FWDSTATE?.[0] ?? '').trim() === 'running'
  const ufwActive = (sec.UFWVERBOSE ?? []).some((l) => /^Status:\s*active/i.test(l))
  // Prefer the backend that is active; otherwise the one that is installed (ufw first unless only firewalld exists).
  const backend: FirewallStateEx['backend'] = ufwActive ? 'ufw' : fwdActive ? 'firewalld' : hasUfw ? 'ufw' : hasFwd ? 'firewalld' : 'none'

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
    if (backend !== 'ufw' && backend !== 'firewalld') throw new Error('Unknown backend')
    const pkg = backend
    const { id } = ctx.tasks.start(`Install ${backend}`, serverId, async (h) => {
      const sshPorts = await detectSshPorts(ssh)
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
    } else {
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
    }
    ctx.audit(serverId, 'fw.enable', `${st.backend} ssh=${st.sshPorts.join(',')}`)
    return { backend: st.backend, sshPorts: st.sshPorts, log }
  })

  ctx.handle('fw:disable', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const st = await getState(ssh)
    if (st.backend === 'ufw') await rootRun(ssh, 'ufw --force disable')
    else if (st.backend === 'firewalld') await rootRun(ssh, 'systemctl disable --now firewalld')
    else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.disable', st.backend)
  })

  // ---------------- defaults ----------------
  ctx.handle('fw:setDefaults', async (serverId: string, opts: { incoming: FwPolicy; outgoing: FwPolicy }) => {
    const ssh = ctx.ssh(serverId)
    const incoming: FwPolicy = ['deny', 'allow', 'reject'].includes(opts?.incoming) ? opts.incoming : 'deny'
    const outgoing: FwPolicy = ['deny', 'allow', 'reject'].includes(opts?.outgoing) ? opts.outgoing : 'allow'
    const st = await getState(ssh)
    let addedSsh = false
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
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.defaults', `in=${incoming} out=${outgoing}${addedSsh ? ' (+ssh)' : ''}`)
    return { addedSsh, sshPorts: st.sshPorts }
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
    if (st.backend === 'ufw') {
      if (st.active) await rootRun(ssh, `ufw --force delete ${current.index}`)
      else await rootRun(ssh, `ufw --force delete ${current.raw.replace(/\scomment\s+'(?:[^']|'\\'')*'\s*$/, '')}`)
    } else if (st.backend === 'firewalld') {
      const zone = `--zone=${shq(st.defaultZone ?? 'public')}`
      let cmd: string
      if (current.raw.startsWith('service:')) cmd = `--remove-service=${shq(current.raw.slice(8))}`
      else if (current.raw.startsWith('port:')) cmd = `--remove-port=${shq(current.raw.slice(5))}`
      else if (current.raw.startsWith('rich:')) cmd = `--remove-rich-rule=${shq(current.raw.slice(5))}`
      else throw new Error('Unknown firewalld rule type')
      await rootRun(ssh, `firewall-cmd --permanent ${zone} ${cmd} >/dev/null && firewall-cmd --reload >/dev/null`)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.deleteRule', `${current.action} ${current.to} from ${current.from}${protectsSsh ? ' (SSH rule, forced)' : ''}`)
  })

  /** One-click preset: add (enable=true) or remove (enable=false) all its ports. */
  ctx.handle('fw:applyPreset', async (serverId: string, id: string, enable: boolean, force?: boolean) => {
    const ssh = ctx.ssh(serverId)
    const st = await getState(ssh)
    if (st.backend === 'none') throw new Error('No firewall backend installed')
    const def = presetDefs(st.sshPort).find((d) => d.id === id)
    if (!def || def.custom) throw new Error('Unknown preset')
    const zone = st.defaultZone ?? 'public'
    if (enable) {
      const cmds: string[] = []
      for (const p of def.ports) {
        if (st.rules.some((r) => ruleAllowsFromAnywhere(r, Number(p.port), p.proto))) continue
        if (st.backend === 'ufw') cmds.push(`ufw allow in proto ${p.proto} from any to any port ${p.port} comment ${shq(id === 'ssh' ? SSH_COMMENT : `${def.label} (ServerSysOps)`)}`)
        else cmds.push(`firewall-cmd --permanent --zone=${shq(zone)} --add-port=${p.port}/${p.proto} >/dev/null`)
      }
      if (!cmds.length) return { changed: 0 }
      await rootRun(ssh, cmds.join(' && ') + (st.backend === 'firewalld' ? ' && firewall-cmd --reload >/dev/null' : ''), { timeoutMs: 60000 })
      ctx.audit(serverId, 'fw.preset', `${id} on`)
      return { changed: cmds.length }
    }
    // Remove: every rule that exactly matches one of the preset's ports (not broader rules).
    const targets = st.rules.filter((r) => {
      const t = parseTo(r.to)
      if (r.direction !== 'in' || t.anyPort || !/^(ALLOW|LIMIT)/i.test(r.action)) return false
      return def.ports.some((p) => t.ports.length === 1 && t.ports[0] === Number(p.port) && (t.proto === p.proto || t.proto === 'any'))
    })
    if (!targets.length) return { changed: 0 }
    if (id === 'ssh' && !force) throw new Error('Removing the SSH rule could lock you out; confirm explicitly to proceed.')
    if (st.backend === 'ufw') {
      // Delete by index from highest to lowest so numbering stays valid.
      if (st.active) for (const r of [...targets].sort((a, b) => b.index - a.index)) await rootRun(ssh, `ufw --force delete ${r.index}`)
      else for (const r of targets) await rootRun(ssh, `ufw --force delete ${r.raw.replace(/\scomment\s+'(?:[^']|'\\'')*'\s*$/, '')}`)
    } else {
      const cmds = targets.map((r) => (r.raw.startsWith('service:') ? `--remove-service=${shq(r.raw.slice(8))}` : r.raw.startsWith('port:') ? `--remove-port=${shq(r.raw.slice(5))}` : `--remove-rich-rule=${shq(r.raw.slice(5))}`))
      await rootRun(ssh, cmds.map((c) => `firewall-cmd --permanent --zone=${shq(zone)} ${c} >/dev/null`).join(' && ') + ' && firewall-cmd --reload >/dev/null')
    }
    ctx.audit(serverId, 'fw.preset', `${id} off`)
    return { changed: targets.length }
  })

  // ---------------- logging ----------------
  ctx.handle('fw:setLogging', async (serverId: string, level: FwLogLevel) => {
    const ssh = ctx.ssh(serverId)
    if (!LOG_LEVELS.includes(level)) throw new Error('Invalid log level')
    const st = await getState(ssh)
    if (st.backend === 'ufw') await rootRun(ssh, `ufw logging ${level}`)
    else if (st.backend === 'firewalld') {
      const v = level === 'off' ? 'off' : level === 'low' ? 'unicast' : 'all'
      await rootRun(ssh, `firewall-cmd --set-log-denied=${v} >/dev/null`)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.logging', level)
  })

  // ---------------- reset ----------------
  ctx.handle('fw:reset', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const st = await getState(ssh)
    if (st.backend === 'ufw') {
      await rootRun(ssh, 'ufw --force reset >/dev/null', { timeoutMs: 60000 })
      for (const p of st.sshPorts) await ufwAllowSsh(ssh, p)
    } else if (st.backend === 'firewalld') {
      await rootRun(ssh, 'systemctl disable --now firewalld; rm -f /etc/firewalld/zones/*.xml /etc/firewalld/zones/*.xml.old; true', { timeoutMs: 60000 })
      for (const p of st.sshPorts) await fwdAllowSsh(ssh, p, false)
    } else throw new Error('No firewall backend installed')
    ctx.audit(serverId, 'fw.reset', st.backend)
    return { sshPorts: st.sshPorts }
  })

  // ---------------- blocked packets log ----------------
  ctx.handle('fw:log', async (serverId: string, linesRaw?: number): Promise<BlockedPacket[]> => {
    const ssh = ctx.ssh(serverId)
    const n = Math.max(10, Math.min(1000, Math.floor(Number(linesRaw) || 100)))
    const pattern = 'UFW (BLOCK|AUDIT|LIMIT|ALLOW)|FINAL_REJECT|STATE_INVALID|_REJECT:|_DROP:'
    const r = await rootExec(
      ssh,
      `{ journalctl -k --no-pager -o short -n 5000 2>/dev/null; tail -n 5000 /var/log/ufw.log 2>/dev/null; tail -n 5000 /var/log/kern.log 2>/dev/null; tail -n 3000 /var/log/messages 2>/dev/null; } | grep -E ${shq(pattern)} | tail -n ${n}`,
      { timeoutMs: 60000 }
    )
    const out: BlockedPacket[] = []
    const seen = new Set<string>()
    for (const line of r.stdout.split('\n')) {
      if (!line.trim() || seen.has(line)) continue
      seen.add(line)
      const time = line.match(/^(\w{3}\s+\d{1,2} \d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[^ ]*)/)?.[1] ?? ''
      const action = line.match(/\[UFW (\w+)\]/)?.[1] ?? (/_REJECT|FINAL_REJECT/.test(line) ? 'REJECT' : /_DROP|STATE_INVALID/.test(line) ? 'DROP' : 'BLOCK')
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
      out.push({ ...lp, allowed: st.active ? covered : false, public: isPublic })
    }
    return out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
  })
}
