import { isIP } from 'net'
import type { Ctx } from '../core'
import type { SshClient } from '../ssh/SshClient'
import type { ExecResult } from '@shared/types'
import type {
  TrafficConnections,
  TrafficContainer,
  TrafficContainerConn,
  TrafficContainers,
  TrafficDatabases,
  TrafficDbClient,
  TrafficDbEngine,
  TrafficDbEngineInfo,
  TrafficListener,
  TrafficProto,
  TrafficRemote,
  TrafficRemotePort,
  TrafficStatusBuckets,
  TrafficWebIp,
  TrafficWebLog,
  TrafficWebLogs,
  TrafficWebServer,
  TrafficWebSummary,
  TrafficWindow
} from '@shared/modules/traffic'
import { assertAbsPath, shq } from '../ssh/shell'
import { parseSs } from './processes'
import { getCred, mongoEval, myQuery, pgQuery, redisRun } from './databases'

/* ------------------------------------------------------------------ */
/* Validation / small helpers                                           */
/* ------------------------------------------------------------------ */

const WINDOWS: Record<TrafficWindow, number> = { '15m': 15 * 60, '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, all: 0 }
/** Lines read from the end of an access log for the summary. */
const MAX_LOG_LINES = 200000

function assertIp(ip: unknown): string {
  if (typeof ip !== 'string' || ip.length > 45 || isIP(ip) === 0) throw new Error(`Invalid IP address: ${String(ip)}`)
  return ip
}

function assertWindow(w: unknown): TrafficWindow {
  if (typeof w === 'string' && w in WINDOWS) return w as TrafficWindow
  return '1h'
}

/** Access-log paths: absolute, no traversal, no control characters. */
function assertLogPath(p: unknown): string {
  if (typeof p !== 'string') throw new Error('Invalid path')
  assertAbsPath(p)
  if (p.includes('..') || /[\n\r\0]/.test(p) || p.length > 512) throw new Error(`Invalid path: ${p}`)
  return p
}

/** Run with sudo when the server allows it, otherwise as the login user. */
async function sudoIfPossible(ssh: SshClient, cmd: string, timeoutMs = 30000, maxBuffer = 32 * 1024 * 1024): Promise<ExecResult> {
  if (ssh.os?.sudoAvailable) {
    try {
      return await ssh.sudo(cmd, { timeoutMs, maxBuffer })
    } catch {
      /* sudo refused (no password stored) – fall back to the plain user */
    }
  }
  return ssh.exec(cmd, { timeoutMs, maxBuffer })
}

function sections(stdout: string): Record<string, string[]> {
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

/** Strip brackets, zone ids and the IPv4-mapped IPv6 prefix. */
export function normalizeIp(addr: string): string {
  let a = addr.trim()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  a = a.replace(/%.*$/, '')
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) a = mapped[1]
  return a
}

/** "1.2.3.4:443" / "[::1]:443" / "*:443" → address + port. */
function splitAddr(s: string): { ip: string; port: number } | null {
  const i = s.lastIndexOf(':')
  if (i < 0) return null
  const port = Number(s.slice(i + 1))
  if (!Number.isInteger(port)) return null
  return { ip: normalizeIp(s.slice(0, i)), port }
}

function isLoopback(ip: string): boolean {
  return ip === '::1' || ip === '::' || ip === '0.0.0.0' || ip === '*' || /^127\./.test(ip)
}

export function isPrivateIp(ip: string): boolean {
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip)) return true
  const l = ip.toLowerCase()
  return l === '::1' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd')
}

interface EstablishedConn {
  proto: TrafficProto
  localIp: string
  localPort: number
  peerIp: string
  peerPort: number
}

/**
 * Parse `ss -tnH state established` / `ss -unH` lines. Depending on the ss build the State column is
 * present or not, so the row is located by the two numeric queue columns followed by the two addresses.
 */
export function parseEstablished(lines: string[], proto: TrafficProto): EstablishedConn[] {
  const out: EstablishedConn[] = []
  for (const raw of lines) {
    const parts = raw.trim().split(/\s+/)
    if (parts.length < 4) continue
    let i = -1
    for (let k = 0; k + 3 < parts.length; k++) {
      if (/^\d+$/.test(parts[k]) && /^\d+$/.test(parts[k + 1]) && parts[k + 2].includes(':') && parts[k + 3].includes(':')) {
        i = k
        break
      }
    }
    if (i < 0) continue
    const local = splitAddr(parts[i + 2])
    const peer = splitAddr(parts[i + 3])
    if (!local || !peer || !peer.port || peer.ip === '*') continue
    out.push({ proto, localIp: local.ip, localPort: local.port, peerIp: peer.ip, peerPort: peer.port })
  }
  return out
}

/** `docker ps --format '{{.Names}}\t{{.Ports}}'` → host port → container name. */
export function parseDockerPorts(lines: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const l of lines) {
    const tab = l.indexOf('\t')
    if (tab < 0) continue
    const name = l.slice(0, tab).trim()
    const ports = l.slice(tab + 1)
    for (const m of ports.matchAll(/(?:[\d.]+|\[[^\]]*\]|\*)?:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/(tcp|udp)/g)) {
      const from = Number(m[1])
      const to = m[2] ? Number(m[2]) : from
      for (let p = from; p <= to && p - from < 256; p++) map.set(`${m[3]}|${p}`, name)
    }
  }
  return map
}

function dockerPermissionDenied(out: string): boolean {
  return /permission denied|connect: no such file|Cannot connect to the Docker daemon/i.test(out)
}

/* ------------------------------------------------------------------ */
/* Section 1: live connections                                          */
/* ------------------------------------------------------------------ */

// docker's --format replaces the two characters "\t" with a tab itself.
const CONNECTIONS_SCRIPT = String.raw`
echo __HAVE; command -v ss >/dev/null 2>&1 && echo ss; command -v docker >/dev/null 2>&1 && echo docker
echo __TCP; ss -tnH state established 2>/dev/null
echo __UDP; ss -unH 2>/dev/null
echo __ADDR; ip -o addr 2>/dev/null | awk '{ print $4 }'; hostname -I 2>/dev/null
echo __SSH; printf '%s\n' "$SSH_CONNECTION"
echo __LISTEN; ss -tulnpH 2>/dev/null
echo __DOCKER; docker ps --format '{{.Names}}\t{{.Ports}}' 2>&1
echo __END`

const ROOT_LISTEN_SCRIPT = String.raw`
echo __LISTEN; ss -tulnpH 2>/dev/null
echo __DOCKER; docker ps --format '{{.Names}}\t{{.Ports}}' 2>&1
echo __END`

async function connections(ssh: SshClient): Promise<TrafficConnections> {
  const r = await ssh.exec(CONNECTIONS_SCRIPT, { timeoutMs: 30000, maxBuffer: 32 * 1024 * 1024 })
  const sec = sections(r.stdout)
  const hints: string[] = []
  const have = new Set((sec.HAVE ?? []).map((l) => l.trim()))
  if (!have.has('ss')) hints.push('ss (iproute2) is not installed on this server; nothing can be listed. Install the "iproute2" package.')

  let listenRaw = sec.LISTEN ?? []
  let dockerRaw = sec.DOCKER ?? []
  const dockerOut = dockerRaw.join('\n')
  const lacksName = (l: string): boolean => !!l.trim() && !l.includes('pid=')
  const needRootForNames = listenRaw.some(lacksName)
  const needRootForDocker = have.has('docker') && dockerPermissionDenied(dockerOut)
  if ((needRootForNames || needRootForDocker) && ssh.os?.sudoAvailable && !ssh.os.isRoot) {
    try {
      const rr = await ssh.sudo(ROOT_LISTEN_SCRIPT, { timeoutMs: 30000, maxBuffer: 16 * 1024 * 1024 })
      const s2 = sections(rr.stdout)
      if (s2.LISTEN && s2.LISTEN.filter(lacksName).length < listenRaw.filter(lacksName).length) listenRaw = s2.LISTEN
      if (s2.DOCKER && !dockerPermissionDenied(s2.DOCKER.join('\n'))) dockerRaw = s2.DOCKER
    } catch {
      /* no sudo password – keep the unprivileged view */
    }
  }

  const noProcessNames = listenRaw.some(lacksName)
  if (noProcessNames) hints.push('Process names of some listening ports need root (sudo). Those ports are shown without their service.')

  let docker = false
  let dockerPorts = new Map<string, string>()
  if (have.has('docker')) {
    const out = dockerRaw.join('\n')
    if (dockerPermissionDenied(out)) hints.push('docker ps failed (permission denied): add the login user to the "docker" group or allow sudo to see which container publishes a port.')
    else if (/^error|cannot|failed/i.test(out.trim()) && !out.includes('\t')) hints.push(`docker ps: ${out.trim().split('\n')[0]}`)
    else {
      docker = true
      dockerPorts = parseDockerPorts(dockerRaw)
    }
  }

  // Listeners: merge per proto|port (0.0.0.0 and [::] rows of the same service).
  const { rows } = parseSs(listenRaw.join('\n'))
  const listeners = new Map<string, TrafficListener>()
  for (const row of rows) {
    const proto: TrafficProto = row.proto.startsWith('udp') ? 'udp' : 'tcp'
    const key = `${proto}|${row.port}`
    const container = dockerPorts.get(key)
    const isProxy = row.process === 'docker-proxy'
    const cur = listeners.get(key)
    const service = container && (isProxy || !row.process) ? container : row.process
    const kind: TrafficListener['kind'] = container && (isProxy || !row.process) ? 'docker' : row.process ? 'process' : 'unknown'
    if (!cur) listeners.set(key, { port: row.port, proto, address: row.address, service, kind, pid: kind === 'process' ? row.pid : undefined, connections: 0 })
    else if (!cur.service && service) {
      cur.service = service
      cur.kind = kind
      cur.pid = kind === 'process' ? row.pid : undefined
    }
  }
  // Published container ports without a userland proxy have no listening socket at all (iptables DNAT).
  for (const [key, name] of dockerPorts) {
    if (listeners.has(key)) continue
    const [proto, port] = key.split('|')
    listeners.set(key, { port: Number(port), proto: proto as TrafficProto, address: '0.0.0.0', service: name, kind: 'docker', connections: 0 })
  }

  const own = new Set<string>()
  for (const l of sec.ADDR ?? []) for (const tok of l.trim().split(/\s+/)) if (tok) own.add(normalizeIp(tok.replace(/\/\d+$/, '')))
  const sshConn = (sec.SSH ?? []).join(' ').trim().split(/\s+/)
  const yourIp = sshConn[0] && isIP(normalizeIp(sshConn[0])) ? normalizeIp(sshConn[0]) : undefined

  const tcp = parseEstablished(sec.TCP ?? [], 'tcp')
  const udp = parseEstablished(sec.UDP ?? [], 'udp')
  const remotes = new Map<string, TrafficRemote>()
  let inboundTotal = 0
  let outboundTotal = 0
  for (const c of [...tcp, ...udp]) {
    if (isLoopback(c.peerIp) || own.has(c.peerIp)) continue
    if (isIP(c.peerIp) === 0) continue
    const lkey = `${c.proto}|${c.localPort}`
    const listener = listeners.get(lkey)
    const inbound = !!listener
    if (inbound) {
      listener!.connections++
      inboundTotal++
    } else outboundTotal++
    let rem = remotes.get(c.peerIp)
    if (!rem) {
      rem = { ip: c.peerIp, connections: 0, inbound: 0, outbound: 0, ports: [], you: c.peerIp === yourIp, v6: isIP(c.peerIp) === 6 }
      remotes.set(c.peerIp, rem)
    }
    rem.connections++
    if (inbound) rem.inbound++
    else rem.outbound++
    const port = inbound ? c.localPort : c.peerPort
    let pe: TrafficRemotePort | undefined = rem.ports.find((p) => p.port === port && p.proto === c.proto && p.inbound === inbound)
    if (!pe) {
      pe = { port, proto: c.proto, count: 0, service: inbound ? listener!.service : '', inbound }
      rem.ports.push(pe)
    }
    pe.count++
  }
  const list = [...remotes.values()]
  for (const rem of list) rem.ports.sort((a, b) => b.count - a.count || a.port - b.port)
  list.sort((a, b) => b.connections - a.connections || a.ip.localeCompare(b.ip))
  const listenerList = [...listeners.values()].sort((a, b) => b.connections - a.connections || a.port - b.port)
  return {
    remotes: list,
    listeners: listenerList,
    totals: { established: tcp.length, inbound: inboundTotal, outbound: outboundTotal, udp: udp.length, uniqueIps: list.length },
    yourIp,
    noProcessNames,
    docker,
    hints
  }
}

/* ------------------------------------------------------------------ */
/* Section 2: web server access logs                                    */
/* ------------------------------------------------------------------ */

// Literal "${APACHE_LOG_DIR}" for the awk program below (String.raw would otherwise interpolate it).
const APACHE_LOG_DIR_VAR = '$' + '{APACHE_LOG_DIR}'

const WEBLOGS_SCRIPT = String.raw`
st() { srv="$1"; shift; for f in "$@"; do [ -f "$f" ] || continue; c=$(head -c 1 "$f" 2>/dev/null); if [ "$c" = "{" ]; then fmt=json; else fmt=text; fi; printf '%s\t%s\t%s\t%s\n' "$srv" "$(stat -c '%s %Y %i' "$f" 2>/dev/null)" "$fmt" "$f"; done; }
echo __HAVE
command -v nginx >/dev/null 2>&1 && echo nginx
{ command -v apache2ctl || command -v apachectl || command -v httpd || command -v apache2; } >/dev/null 2>&1 && echo apache
command -v caddy >/dev/null 2>&1 && echo caddy
echo __LOGS
st nginx /var/log/nginx/access.log /var/log/nginx/*access*.log $(nginx -T 2>/dev/null | awk '$1 == "access_log" { p = $2; sub(/;$/, "", p); if (p ~ /^\//) print p }' | sort -u)
st apache /var/log/apache2/*access*.log /var/log/httpd/*access*log $(grep -rhoE '^[[:space:]]*CustomLog[[:space:]]+"?[^[:space:]"]+' /etc/apache2 /etc/httpd 2>/dev/null | awk '{ p = $2; gsub(/"/, "", p); if (substr(p, 1, 17) == "${APACHE_LOG_DIR_VAR}") p = "/var/log/apache2" substr(p, 18); if (p ~ /^\|/ || p ~ /^syslog/ || p == "off") next; if (p !~ /^\//) p = "/etc/httpd/" p; print p }' | sort -u)
st caddy /var/log/caddy/*.log $(awk '$1 == "output" && $2 == "file" { print $3 }' /etc/caddy/Caddyfile 2>/dev/null | sort -u)
echo __CADDYLOG
grep -cE '^[[:space:]]*log([[:space:]]|$)' /etc/caddy/Caddyfile 2>/dev/null
echo __END`

async function webLogs(ssh: SshClient): Promise<TrafficWebLogs> {
  const r = await sudoIfPossible(ssh, WEBLOGS_SCRIPT, 60000)
  const sec = sections(r.stdout)
  const servers = (sec.HAVE ?? []).map((l) => l.trim()).filter((l): l is TrafficWebServer => l === 'nginx' || l === 'apache' || l === 'caddy')
  const logs: TrafficWebLog[] = []
  const seenPath = new Set<string>()
  const seenInode = new Set<string>()
  for (const l of sec.LOGS ?? []) {
    const parts = l.split('\t')
    if (parts.length < 4) continue
    const [srv, statStr, fmt] = parts
    const path = parts.slice(3).join('\t')
    const st = statStr.trim().split(/\s+/)
    if (!path.startsWith('/') || seenPath.has(path)) continue
    const inode = st[2] ?? ''
    if (inode && seenInode.has(inode)) continue
    seenPath.add(path)
    if (inode) seenInode.add(inode)
    const server = (srv === 'nginx' || srv === 'apache' || srv === 'caddy' ? srv : 'nginx') as TrafficWebServer
    logs.push({ server, path, sizeBytes: Number(st[0]) || 0, mtime: (Number(st[1]) || 0) * 1000, format: fmt === 'json' ? 'caddy-json' : 'combined' })
  }
  logs.sort((a, b) => a.server.localeCompare(b.server) || b.mtime - a.mtime)
  const caddyNoAccessLog = servers.includes('caddy') && !logs.some((l) => l.server === 'caddy')
  return { logs, servers, caddyNoAccessLog }
}

const PRE_COMBINED_AWK = String.raw`
function dfc(y, m, d,   era, yoe, doy, doe) {
  if (m <= 2) y--
  era = int((y >= 0 ? y : y - 399) / 400)
  yoe = y - era * 400
  doy = int((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return era * 146097 + doe - 719468
}
function tzoff(tz,   s, h, m) {
  if (length(tz) < 5) return 0
  s = (substr(tz, 1, 1) == "-") ? -1 : 1
  h = substr(tz, 2, 2) + 0; m = substr(tz, 4, 2) + 0
  return s * (h * 3600 + m * 60)
}
BEGIN { months = "JanFebMarAprMayJunJulAugSepOctNovDec" }
{
  n = split($0, q, "\"")
  if (n < 3) { bad++; next }
  split(q[1], h, " ")
  ip = h[1]
  t = h[4]; sub(/^\[/, "", t)
  tz = h[5]; sub(/\]$/, "", tz)
  if (split(t, dt, "[/:]") != 6) { bad++; next }
  mi = index(months, dt[2]); if (mi == 0) { bad++; next }
  mon = (mi - 1) / 3 + 1
  ep = dfc(dt[3] + 0, mon, dt[1] + 0) * 86400 + dt[4] * 3600 + dt[5] * 60 + dt[6] - tzoff(tz)
  if (ep < since) next
  req = q[2]
  split(req, rq, " "); path = rq[2]; if (path == "") path = req
  split(q[3], sb, " "); status = sb[1]; bytes = sb[2]
  if (status !~ /^[0-9][0-9][0-9]$/) { bad++; next }
  if (bytes !~ /^[0-9]+$/) bytes = 0
  ua = (n >= 6) ? q[6] : ""
  if (n >= 8 && q[8] != "-" && q[8] != "" && ip ~ /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/) {
    x = q[8]; sub(/,.*$/, "", x); gsub(/ /, "", x)
    if (x ~ /^[0-9a-fA-F.:]+$/) ip = x
  }
  gsub(/\t/, " ", path); gsub(/\t/, " ", ua)
  print ip "\t" ep "\t" status "\t" bytes "\t" path "\t" substr(ua, 1, 160)
}
END { print "__BAD\t" bad + 0 "\t" NR }`

const PRE_CADDY_AWK = String.raw`
function jstr(s, key,   re) {
  re = "\"" key "\":\"[^\"]*\""
  if (match(s, re)) return substr(s, RSTART + length(key) + 4, RLENGTH - length(key) - 5)
  return ""
}
function jnum(s, key,   re) {
  re = "\"" key "\":[0-9.eE+-]+"
  if (match(s, re)) return substr(s, RSTART + length(key) + 3, RLENGTH - length(key) - 3) + 0
  return -1
}
{
  ep = jnum($0, "ts"); if (ep < 0) { bad++; next }
  ep = int(ep)
  if (ep < since) next
  ip = jstr($0, "client_ip"); if (ip == "") ip = jstr($0, "remote_ip")
  if (ip == "") { ip = jstr($0, "remote_addr"); sub(/:[0-9]+$/, "", ip); gsub(/[\[\]]/, "", ip) }
  if (ip == "") { bad++; next }
  status = jnum($0, "status"); if (status < 0) status = 0
  bytes = jnum($0, "size"); if (bytes < 0) bytes = 0
  path = jstr($0, "uri")
  ua = ""
  if (match($0, /"User-Agent":\["[^"]*"/)) ua = substr($0, RSTART + 15, RLENGTH - 16)
  gsub(/\t/, " ", path); gsub(/\t/, " ", ua)
  print ip "\t" ep "\t" status "\t" bytes "\t" path "\t" substr(ua, 1, 160)
}
END { print "__BAD\t" bad + 0 "\t" NR }`

const AGG_AWK = String.raw`
BEGIN { FS = "\t" }
$1 == "__BAD" { bad = $2; scanned = $3; next }
{
  ip = $1; ep = $2 + 0; st = $3 + 0; by = $4 + 0; ua = $6
  total++; bytes += by
  b = int(st / 100)
  if (b == 2) s2++; else if (b == 3) s3++; else if (b == 4) s4++; else if (b == 5) s5++
  if (first == 0 || ep < first) first = ep
  if (ep > last) last = ep
  mcount[ep - ep % 60]++
  if (!(ip in req)) nip++
  req[ip]++; ibytes[ip] += by
  if (ep > ilast[ip]) ilast[ip] = ep
  if (b == 2) i2[ip]++; else if (b == 3) i3[ip]++; else if (b == 4) i4[ip]++; else if (b == 5) i5[ip]++
  k = ip SUBSEP ua; cu[k]++
  if (cu[k] > best[ip]) { best[ip] = cu[k]; bua[ip] = ua }
}
END {
  print "__TOTAL\t" total + 0 "\t" nip + 0 "\t" bytes + 0 "\t" s2 + 0 "\t" s3 + 0 "\t" s4 + 0 "\t" s5 + 0 "\t" first + 0 "\t" last + 0 "\t" bad + 0 "\t" scanned + 0
  print "__MIN"
  for (m in mcount) print m "\t" mcount[m]
  print "__IP"
  for (ip in req) print ip "\t" req[ip] "\t" ibytes[ip] + 0 "\t" ilast[ip] "\t" i2[ip] + 0 "\t" i3[ip] + 0 "\t" i4[ip] + 0 "\t" i5[ip] + 0 "\t" bua[ip]
}`

const PATHS_AWK = String.raw`NR == FNR { top[$1] = 1; next } ($1 in top) { c[$1 "\t" $5]++ } END { for (k in c) print k "\t" c[k] }`

function buckets(a: string[], i: number): TrafficStatusBuckets {
  return { s2xx: Number(a[i]) || 0, s3xx: Number(a[i + 1]) || 0, s4xx: Number(a[i + 2]) || 0, s5xx: Number(a[i + 3]) || 0 }
}

async function webSummary(ssh: SshClient, path: string, window: TrafficWindow, limit: number): Promise<TrafficWebSummary> {
  const since = WINDOWS[window]
  // The format is decided by the first byte of the file: Caddy writes one JSON object per line.
  const script = String.raw`
F=${shq(path)}
[ -f "$F" ] || { echo __NOFILE; exit 0; }
[ -r "$F" ] || { echo __NOREAD; exit 0; }
NOW=$(date +%s); SINCE=0; [ ${since} -gt 0 ] && SINCE=$((NOW - ${since}))
T=$(mktemp /tmp/.sso_tr.XXXXXX) || exit 1; A="$T.a"; TOP="$T.t"
trap 'rm -f "$T" "$A" "$TOP"' EXIT
C=$(head -c 1 "$F" 2>/dev/null)
if [ "$C" = "{" ]; then tail -n ${MAX_LOG_LINES} "$F" | awk -v since="$SINCE" '${PRE_CADDY_AWK}' > "$T"
else tail -n ${MAX_LOG_LINES} "$F" | awk -v since="$SINCE" '${PRE_COMBINED_AWK}' > "$T"; fi
echo __NOW; echo "$NOW"
awk '${AGG_AWK}' "$T" > "$A"
sed -n '1,/^__IP$/p' "$A"
TAB=$(printf '\t')
sed '1,/^__IP$/d' "$A" | sort -t "$TAB" -k2,2nr | head -n ${limit} > "$TOP"
cat "$TOP"
echo __PATHS
[ -s "$TOP" ] && awk -F '\t' '${PATHS_AWK}' "$TOP" "$T" | sort -t "$TAB" -k3,3nr | head -n 20000
echo __END`
  const r = await sudoIfPossible(ssh, script, 180000, 64 * 1024 * 1024)
  if (r.stdout.startsWith('__NOFILE')) throw new Error(`${path} does not exist (rotated or removed?)`)
  if (r.stdout.startsWith('__NOREAD')) throw new Error(`${path} is not readable by the login user and sudo is not available`)
  if (!r.stdout.includes('__TOTAL')) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n') || 'Log analysis produced no output (awk missing?)')
  const sec = sections(r.stdout)
  const now = Number((sec.NOW ?? [])[0]) || Math.floor(Date.now() / 1000)
  // __TOTAL carries its values on the same line, so it is not a section marker: read the raw line.
  const totalLine = r.stdout.split('\n').find((l) => l.startsWith('__TOTAL\t'))?.split('\t') ?? []
  const first = Number(totalLine[8]) || 0
  const last = Number(totalLine[9]) || 0
  const minutes = new Map<number, number>()
  for (const l of sec.MIN ?? []) {
    const [m, c] = l.split('\t')
    if (m) minutes.set(Number(m), Number(c) || 0)
  }
  const end = window === 'all' && last ? last - (last % 60) : now - (now % 60)
  const perMinute: { t: number; count: number }[] = []
  for (let i = 59; i >= 0; i--) {
    const t = end - i * 60
    perMinute.push({ t: t * 1000, count: minutes.get(t) ?? 0 })
  }
  const pathsByIp = new Map<string, { path: string; count: number }[]>()
  for (const l of sec.PATHS ?? []) {
    const parts = l.split('\t')
    if (parts.length < 3) continue
    const ip = parts[0]
    const count = Number(parts[parts.length - 1]) || 0
    const p = parts.slice(1, -1).join('\t')
    let arr = pathsByIp.get(ip)
    if (!arr) {
      arr = []
      pathsByIp.set(ip, arr)
    }
    if (arr.length < 5) arr.push({ path: p, count })
  }
  const topIps: TrafficWebIp[] = []
  for (const l of sec.IP ?? []) {
    if (!l.trim() || l.startsWith('__')) continue
    const a = l.split('\t')
    if (a.length < 8) continue
    topIps.push({
      ip: a[0],
      requests: Number(a[1]) || 0,
      bytes: Number(a[2]) || 0,
      lastSeen: (Number(a[3]) || 0) * 1000,
      statuses: buckets(a, 4),
      topPaths: (pathsByIp.get(a[0]) ?? []).sort((x, y) => y.count - x.count),
      userAgent: a.slice(8).join('\t')
    })
  }
  topIps.sort((x, y) => y.requests - x.requests)
  return {
    path,
    window,
    total: Number(totalLine[1]) || 0,
    uniqueIps: Number(totalLine[2]) || 0,
    bytes: Number(totalLine[3]) || 0,
    statuses: buckets(totalLine, 4),
    perMinute,
    topIps,
    linesScanned: Number(totalLine[11]) || 0,
    truncated: (Number(totalLine[11]) || 0) >= MAX_LOG_LINES,
    from: first ? first * 1000 : undefined,
    to: last ? last * 1000 : undefined,
    unparsed: Number(totalLine[10]) || 0
  }
}

/* ------------------------------------------------------------------ */
/* Section 3: containers                                                */
/* ------------------------------------------------------------------ */

const CONTAINERS_SCRIPT = String.raw`
command -v docker >/dev/null 2>&1 || { echo __NODOCKER; exit 0; }
command -v nsenter >/dev/null 2>&1 && echo __NSENTER
ids=$(docker ps -q 2>&1) || { echo __DOCKERERR; printf '%s\n' "$ids" | head -n 3; exit 0; }
[ -n "$ids" ] || { echo __END; exit 0; }
docker inspect --format '{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.State.Pid}}{{"\t"}}{{.HostConfig.NetworkMode}}{{"\t"}}{{range $p, $c := .NetworkSettings.Ports}}{{$p}}{{if $c}}->{{(index $c 0).HostPort}}{{end}}, {{end}}' $ids 2>/dev/null | while IFS= read -r info; do
  [ -n "$info" ] || continue
  printf '__C %s\n' "$info"
  pid=$(printf '%s' "$info" | cut -f4)
  mode=$(printf '%s' "$info" | cut -f5)
  [ "$mode" = host ] && continue
  [ "$pid" -gt 0 ] 2>/dev/null || continue
  if command -v nsenter >/dev/null 2>&1; then nsenter -t "$pid" -n ss -tnH state established 2>&1 | sed 's/^/  /'; fi
done
echo __END`

async function collectContainers(ssh: SshClient): Promise<TrafficContainers> {
  const r = await sudoIfPossible(ssh, CONTAINERS_SCRIPT, 60000)
  const out = r.stdout
  if (out.includes('__NODOCKER')) return { containers: [], docker: false, nsenter: false, hint: 'Docker is not installed on this server.' }
  const nsenter = out.includes('__NSENTER')
  if (out.includes('__DOCKERERR')) {
    const msg = out.split('__DOCKERERR')[1]?.trim().split('\n')[0] ?? ''
    const perm = dockerPermissionDenied(msg)
    return { containers: [], docker: true, nsenter, hint: perm ? 'docker ps failed: permission denied. Allow sudo for this server or add the login user to the "docker" group.' : `docker ps failed: ${msg}` }
  }
  const containers: TrafficContainer[] = []
  let cur: TrafficContainer | null = null
  let curConns: EstablishedConn[] = []
  let curErr: string[] = []
  const finish = (): void => {
    if (!cur) return
    const byIp = new Map<string, TrafficContainerConn>()
    for (const c of curConns) {
      if (isLoopback(c.peerIp) || isIP(c.peerIp) === 0) continue
      let e = byIp.get(c.peerIp)
      if (!e) {
        e = { ip: c.peerIp, count: 0, ports: [] }
        byIp.set(c.peerIp, e)
      }
      e.count++
      if (!e.ports.includes(c.localPort)) e.ports.push(c.localPort)
    }
    cur.connections = [...byIp.values()].sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip))
    for (const e of cur.connections) e.ports.sort((a, b) => a - b)
    if (curErr.length && curConns.length === 0) cur.error = curErr.join(' ').trim().slice(0, 300)
    if (cur.networkMode === 'host') cur.skipped = 'Uses the host network: its connections are listed in the Connections section.'
    else if (!nsenter) cur.skipped = 'nsenter is not installed (util-linux); connections inside the container namespace cannot be read.'
    containers.push(cur)
    cur = null
    curConns = []
    curErr = []
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('__C ')) {
      finish()
      const f = line.slice(4).split('\t')
      const ports = (f[5] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ')
      cur = { id: (f[0] ?? '').slice(0, 12), name: (f[1] ?? '').replace(/^\//, ''), image: f[2] ?? '', pid: Number(f[3]) || 0, networkMode: f[4] ?? '', ports, connections: [] }
      continue
    }
    if (line === '__END') break
    if (!cur || !line.startsWith('  ')) continue
    const parsed = parseEstablished([line], 'tcp')
    if (parsed.length) curConns.push(...parsed)
    else if (line.trim()) curErr.push(line.trim())
  }
  finish()
  containers.sort((a, b) => a.name.localeCompare(b.name))
  let hint: string | undefined
  if (!nsenter && containers.length) hint = 'nsenter is missing (package util-linux); container connections cannot be inspected.'
  else if (containers.some((c) => c.error && /permission denied|Operation not permitted/i.test(c.error))) hint = 'nsenter needs root: allow sudo for this server to see connections inside containers.'
  return { containers, docker: true, nsenter, hint }
}

/* ------------------------------------------------------------------ */
/* Section 4: databases                                                 */
/* ------------------------------------------------------------------ */

const DB_PORTS: Record<number, TrafficDbEngine> = { 3306: 'mysql', 5432: 'postgres', 27017: 'mongo', 6379: 'redis' }
const DB_IMAGE_RE = /mysql|mariadb|percona|postgres|pgvector|timescale|mongo|redis|valkey|keydb/i

function engineOfProcess(name: string): TrafficDbEngine | undefined {
  const n = name.toLowerCase()
  if (/^(mysqld|mariadbd)/.test(n)) return 'mysql'
  if (/^(postgres|postmaster)/.test(n)) return 'postgres'
  if (/^mongod/.test(n)) return 'mongo'
  if (/^(redis-server|valkey-server|keydb-server)/.test(n)) return 'redis'
  return undefined
}

function engineOfImage(image: string): TrafficDbEngine | undefined {
  const i = image.toLowerCase()
  if (/mysql|mariadb|percona/.test(i)) return 'mysql'
  if (/postgres|pgvector|timescale/.test(i)) return 'postgres'
  if (/mongo/.test(i)) return 'mongo'
  if (/redis|valkey|keydb/.test(i)) return 'redis'
  return undefined
}

const DB_HOST_SCRIPT = String.raw`
echo __LISTEN; ss -tlnpH 2>/dev/null
echo __TCP; ss -tnH state established 2>/dev/null
echo __END`

function ipOfHostField(host: string): string | undefined {
  const h = host.trim()
  if (!h || h === 'localhost' || h.startsWith('/') || h === '-') return undefined
  const m = h.match(/^(.*):\d+$/)
  const ip = normalizeIp(m ? m[1] : h)
  return isIP(ip) ? ip : undefined
}

function addClient(map: Map<string, TrafficDbClient>, ip: string, user?: string, db?: string, inc = 1): void {
  let c = map.get(ip)
  if (!c) {
    c = { ip, connections: 0 }
    map.set(ip, c)
  }
  c.connections += inc
  if (user) {
    c.users = c.users ?? []
    if (!c.users.includes(user)) c.users.push(user)
  }
  if (db) {
    c.dbs = c.dbs ?? []
    if (!c.dbs.includes(db)) c.dbs.push(db)
  }
}

function errHint(engine: TrafficDbEngine, e: unknown): string {
  const err = e as { code?: string; message?: string }
  const label = engine === 'mysql' ? 'MySQL/MariaDB' : engine === 'postgres' ? 'PostgreSQL' : engine === 'mongo' ? 'MongoDB' : 'Redis'
  if (err?.code === 'DB_AUTH') return `${label} refused the connection (authentication). Open Databases → Admin credentials to store a login; the engine's own client list is hidden until then.`
  if (err?.code === 'SUDO_FAILED') return `${label}: the client list needs sudo or stored admin credentials (open Databases → Admin credentials).`
  const msg = (err?.message ?? String(e)).split('\n')[0]
  if (/not found|No such file|command not found/i.test(msg)) return `${label} client tool is not installed on the server, so only socket-level data is shown.`
  return `${label}: ${msg.slice(0, 200)}`
}

async function enrichEngine(ssh: SshClient, serverId: string, info: TrafficDbEngineInfo, clients: Map<string, TrafficDbClient>): Promise<void> {
  try {
    if (info.engine === 'mysql') {
      const g = await myQuery(ssh, serverId, 'SELECT host, user, db, command, time, state FROM information_schema.processlist ORDER BY time DESC', { timeoutMs: 20000 })
      info.detailColumns = g.columns
      info.detail = g.rows.map((r) => r.map((c) => c ?? ''))
      for (const row of g.rows) {
        const ip = ipOfHostField(row[0] ?? '')
        if (!ip) continue
        const existing = clients.get(ip)
        addClient(clients, ip, row[1] ?? undefined, row[2] ?? undefined, existing ? 0 : 1)
      }
    } else if (info.engine === 'postgres') {
      const g = await pgQuery(
        ssh,
        serverId,
        "SELECT host(client_addr) AS client, usename AS \"user\", datname AS db, coalesce(state, '') AS state, date_trunc('second', now() - backend_start)::text AS age, left(coalesce(application_name, ''), 40) AS app FROM pg_stat_activity WHERE client_addr IS NOT NULL ORDER BY backend_start",
        { timeoutMs: 20000 }
      )
      info.detailColumns = g.columns
      info.detail = g.rows.map((r) => r.map((c) => c ?? ''))
      for (const row of g.rows) {
        const ip = ipOfHostField(row[0] ?? '')
        if (!ip) continue
        const existing = clients.get(ip)
        addClient(clients, ip, row[1] ?? undefined, row[2] ?? undefined, existing ? 0 : 1)
      }
    } else if (info.engine === 'mongo') {
      const res = await mongoEval<{ ops: { client: string; app: string; ns: string; op: string; active: boolean; user: string }[]; conns: { current?: number; available?: number } | null }>(
        ssh,
        serverId,
        "var ops = (db.currentOp(true).inprog || []).filter(function (o) { return o.client; }).map(function (o) { return { client: String(o.client), app: String(o.appName || ''), ns: String(o.ns || ''), op: String(o.op || ''), active: !!o.active, user: (o.effectiveUsers && o.effectiveUsers[0] && o.effectiveUsers[0].user) || '' }; }); var c = null; try { c = db.serverStatus().connections; } catch (e) {} print('__SM__' + JSON.stringify({ ops: ops, conns: c }));",
        { timeoutMs: 20000 }
      )
      info.detailColumns = ['client', 'user', 'namespace', 'op', 'active', 'app']
      info.detail = res.ops.map((o) => [o.client, o.user, o.ns, o.op, o.active ? 'yes' : 'idle', o.app])
      for (const o of res.ops) {
        const ip = ipOfHostField(o.client)
        if (!ip) continue
        const existing = clients.get(ip)
        addClient(clients, ip, o.user || undefined, o.ns ? o.ns.split('.')[0] : undefined, existing ? 0 : 1)
      }
      if (res.conns?.current !== undefined) info.hint = `serverStatus: ${res.conns.current} current connections${res.conns.available !== undefined ? `, ${res.conns.available} available` : ''}`
    } else if (info.engine === 'redis') {
      const out = await redisRun(ssh, serverId, ['CLIENT', 'LIST'], { timeoutMs: 20000 })
      const rows: string[][] = []
      for (const l of out.split('\n')) {
        if (!l.trim()) continue
        const f: Record<string, string> = {}
        for (const tok of l.trim().split(' ')) {
          const i = tok.indexOf('=')
          if (i > 0) f[tok.slice(0, i)] = tok.slice(i + 1)
        }
        rows.push([f.addr ?? '', f.user ?? 'default', f.name ?? '', f.db ?? '0', f.age ?? '', f.idle ?? '', f.cmd ?? ''])
        const ip = ipOfHostField(f.addr ?? '')
        if (!ip) continue
        const existing = clients.get(ip)
        addClient(clients, ip, f.user || 'default', f.db !== undefined ? `db${f.db}` : undefined, existing ? 0 : 1)
      }
      info.detailColumns = ['addr', 'user', 'name', 'db', 'age (s)', 'idle (s)', 'last cmd']
      info.detail = rows
    }
  } catch (e) {
    info.hint = errHint(info.engine, e)
  }
}

async function databases(ssh: SshClient, serverId: string): Promise<TrafficDatabases> {
  const [hostRes, containers] = await Promise.all([sudoIfPossible(ssh, DB_HOST_SCRIPT, 30000), collectContainers(ssh).catch((): TrafficContainers => ({ containers: [], docker: false, nsenter: false }))])
  const sec = sections(hostRes.stdout)
  const { rows } = parseSs((sec.LISTEN ?? []).join('\n'))
  const established = parseEstablished(sec.TCP ?? [], 'tcp')
  const engines: TrafficDbEngineInfo[] = []
  /** Socket-level clients of the host engines; the engine's own list (below) adds users / databases. */
  const hostClients = new Map<TrafficDbEngineInfo, Map<string, TrafficDbClient>>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.proto.startsWith('tcp')) continue
    const engine = engineOfProcess(row.process) ?? (row.process ? undefined : DB_PORTS[row.port])
    if (!engine) continue
    const key = `host|${engine}|${row.port}`
    if (seen.has(key)) continue
    seen.add(key)
    const clients = new Map<string, TrafficDbClient>()
    for (const c of established) {
      if (c.localPort !== row.port || isLoopback(c.peerIp)) continue
      addClient(clients, c.peerIp)
    }
    const info: TrafficDbEngineInfo = { engine, where: 'host', port: row.port, label: row.process || `port ${row.port}`, clients: [], credentials: !!getCred(serverId, engine) }
    engines.push(info)
    hostClients.set(info, clients)
  }
  for (const c of containers.containers) {
    const engine = engineOfImage(c.image)
    if (!engine) continue
    const port = Object.entries(DB_PORTS).find(([, e]) => e === engine)?.[0]
    const clients = new Map<string, TrafficDbClient>()
    for (const conn of c.connections) addClient(clients, conn.ip, undefined, undefined, conn.count)
    const info: TrafficDbEngineInfo = {
      engine,
      where: 'docker',
      container: c.name,
      port: Number(port) || 0,
      label: c.image,
      clients: [...clients.values()],
      credentials: false,
      hint: c.skipped ?? c.error ?? "Socket-level view only: the engine's own client list is not queried inside containers."
    }
    engines.push(info)
  }
  // Only one engine of each kind can be enriched (the Databases module talks to the host instance).
  const enriched = new Set<TrafficDbEngine>()
  await Promise.all(
    [...hostClients.entries()].map(async ([e, clients]) => {
      if (!enriched.has(e.engine)) {
        enriched.add(e.engine)
        await enrichEngine(ssh, serverId, e, clients)
      }
      e.clients = [...clients.values()].sort((a, b) => b.connections - a.connections || a.ip.localeCompare(b.ip))
    })
  )
  let hint: string | undefined
  if (engines.length === 0) {
    hint = rows.length === 0 ? 'No listening sockets could be read (ss missing or no permission).' : 'No database listener found (mysqld, mariadbd, postgres, mongod, redis-server) and no database container is running.'
  }
  return { engines, hint }
}

/* ------------------------------------------------------------------ */
/* Register                                                             */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  ctx.handle('traffic:connections', async (serverId: string): Promise<TrafficConnections> => connections(ctx.ssh(serverId)))

  ctx.handle('traffic:rdns', async (serverId: string, ipsRaw: unknown): Promise<Record<string, string | null>> => {
    const ips = Array.isArray(ipsRaw) ? [...new Set(ipsRaw.slice(0, 50).map(assertIp))] : []
    const result: Record<string, string | null> = {}
    if (ips.length === 0) return result
    const ssh = ctx.ssh(serverId)
    const script = `for ip in ${ips.map(shq).join(' ')}; do h=$(getent hosts "$ip" 2>/dev/null | awk '{ print $2; exit }'); printf '%s\\t%s\\n' "$ip" "$h"; done`
    const r = await ssh.exec(script, { timeoutMs: 25000 })
    for (const ip of ips) result[ip] = null
    for (const l of r.stdout.split('\n')) {
      const [ip, host] = l.split('\t')
      if (ip && ip in result) result[ip] = host?.trim() || null
    }
    return result
  })

  ctx.handle('traffic:webLogs', async (serverId: string): Promise<TrafficWebLogs> => webLogs(ctx.ssh(serverId)))

  ctx.handle('traffic:webSummary', async (serverId: string, opts: { path: string; window?: TrafficWindow; limit?: number }): Promise<TrafficWebSummary> => {
    const path = assertLogPath(opts?.path)
    const window = assertWindow(opts?.window)
    const limit = Math.max(10, Math.min(500, Math.floor(Number(opts?.limit) || 100)))
    return webSummary(ctx.ssh(serverId), path, window, limit)
  })

  ctx.handle('traffic:webTail', async (serverId: string, opts: { path: string }): Promise<string> => {
    const path = assertLogPath(opts?.path)
    const ssh = ctx.ssh(serverId)
    const sudo = !!ssh.os?.sudoAvailable && !ssh.os.isRoot
    const { id } = ctx.tasks.start(`Follow ${path.split('/').pop()}`, serverId, async (h) => {
      h.log(`$ tail -n 50 -F ${path}   (cancel the task to stop)`)
      const r = await ssh.exec(`tail -n 50 -F ${shq(path)} 2>&1`, { sudo, timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c), maxBuffer: 1024 })
      if (r.code !== 0 && !h.signal.aborted) throw new Error(r.stderr.trim() || `tail exited with ${r.code}`)
    })
    return id
  })

  ctx.handle('traffic:containers', async (serverId: string): Promise<TrafficContainers> => collectContainers(ctx.ssh(serverId)))

  ctx.handle('traffic:databases', async (serverId: string): Promise<TrafficDatabases> => databases(ctx.ssh(serverId), serverId))
}
