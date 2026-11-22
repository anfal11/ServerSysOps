import type { Ctx } from '../core'
import type { ExecOptions, SshClient } from '../ssh/SshClient'
import type { ExecResult } from '@shared/types'
import type {
  PhpFpmInfo,
  PhpFpmUnit,
  SslCert,
  SslStatus,
  WebAvailable,
  WebDetectResult,
  WebLogCount,
  WebLogResult,
  WebLogSummary,
  WebServerId,
  WebServerInfo,
  WebServiceAction,
  WebSite,
  WebSiteSpec,
  WebTestResult
} from '@shared/modules/webserver'
import { assertAbsPath, b64Echo, shq } from '../ssh/shell'
import { installCmd, pkgEnv, runPkg } from './pkg'
import type { TaskHandle } from '../tasks/TaskManager'

/* ------------------------------------------------------------------ */
/* Constants / validation                                              */
/* ------------------------------------------------------------------ */

const SERVER_IDS: WebServerId[] = ['nginx', 'apache', 'caddy', 'openlitespeed', 'lighttpd']
const SERVICE_ACTIONS: WebServiceAction[] = ['start', 'stop', 'restart', 'reload', 'enable', 'disable']

const WEB_PORTS = new Set<number>([80, 443, 8080, 8443, 5000, 7080])
for (let p = 3000; p <= 3010; p++) WEB_PORTS.add(p)
for (let p = 8000; p <= 8090; p++) WEB_PORTS.add(p)
const WEB_PROCS = /nginx|apache|httpd|caddy|litespeed|lshttpd|openlitespeed|lighttpd|node|java|python|gunicorn|uvicorn|php-fpm|ruby|puma|deno|bun/i

/** Directories whose files the UI may read / write as root. */
const CONFIG_ROOTS = ['/etc/nginx/', '/etc/apache2/', '/etc/httpd/', '/etc/caddy/', '/etc/lighttpd/', '/usr/local/lsws/conf/']

const AVAILABLE: Record<WebServerId, Omit<WebAvailable, 'packages'>> = {
  nginx: { id: 'nginx', name: 'Nginx', description: 'High-performance HTTP server and reverse proxy. The most common choice for static sites, PHP (via FPM) and fronting Node/Python apps.' },
  apache: { id: 'apache', name: 'Apache HTTP Server', description: 'The classic, highly configurable web server with .htaccess support and a huge module ecosystem.' },
  caddy: { id: 'caddy', name: 'Caddy', description: 'Modern web server with automatic HTTPS (Let’s Encrypt) and a very simple Caddyfile configuration.' },
  openlitespeed: { id: 'openlitespeed', name: 'OpenLiteSpeed', description: 'Event-driven server with built-in caching and a web admin console on port 7080. Apache-compatible rewrite rules.' },
  lighttpd: { id: 'lighttpd', name: 'Lighttpd', description: 'Very small footprint web server, good for low-memory systems and simple static hosting.' }
}

function assertServerId(id: string): WebServerId {
  if (!SERVER_IDS.includes(id as WebServerId)) throw new Error(`Unknown web server: ${id}`)
  return id as WebServerId
}

function assertAction(a: string): WebServiceAction {
  if (!SERVICE_ACTIONS.includes(a as WebServiceAction)) throw new Error(`Invalid action: ${a}`)
  return a as WebServiceAction
}

function assertDomain(d: string): string {
  const s = String(d).trim().toLowerCase()
  if (!s || s.length > 253 || !/^[a-z0-9.-]+$/i.test(s) || s.startsWith('.') || s.endsWith('.') || s.includes('..')) throw new Error(`Invalid domain: ${d}`)
  return s
}

function assertSiteName(n: string): string {
  const s = String(n).trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(s) || s === '.' || s === '..') throw new Error(`Invalid site name: ${n}`)
  return s
}

function assertConfigPath(p: string): string {
  assertAbsPath(p)
  if (p.includes('/../') || p.endsWith('/..') || !CONFIG_ROOTS.some((r) => p.startsWith(r))) throw new Error(`Path is outside the web server configuration directories: ${p}`)
  return p
}

function assertProxyTarget(t: string): string {
  const s = String(t).trim()
  if (!/^https?:\/\/[A-Za-z0-9.\-_[\]:]+(:\d{1,5})?(\/[A-Za-z0-9\-._~/]*)?$/.test(s)) throw new Error(`Invalid proxy target: ${t} (expected e.g. http://127.0.0.1:3000)`)
  return s
}

function assertEmail(e: string): string {
  const s = String(e).trim()
  if (!/^[^\s@'"\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)) throw new Error(`Invalid e-mail address: ${e}`)
  return s
}

function isRhelFamily(ssh: SshClient): boolean {
  const os = ssh.os
  if (!os) return false
  return /rhel|fedora|centos|rocky|alma|ol\b|amzn/i.test(`${os.id} ${os.idLike}`) || os.pkgManager === 'dnf' || os.pkgManager === 'yum'
}

function isDebianFamily(ssh: SshClient): boolean {
  const os = ssh.os
  if (!os) return false
  return /debian|ubuntu/i.test(`${os.id} ${os.idLike}`) || os.pkgManager === 'apt'
}

/** Parse "__KEY" sectioned script output into a map of line arrays. */
function sections(stdout: string, prefix = '__'): Record<string, string[]> {
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of stdout.split('\n')) {
    const m = line.match(new RegExp(`^${prefix}([A-Z]+)(?:\\s+(.*))?$`))
    if (m && m[1]) {
      cur = m[2] ? `${m[1]} ${m[2]}` : m[1]
      sec[cur] = []
    } else if (cur) sec[cur].push(line)
  }
  return sec
}

function taskStream(h: TaskHandle): { onStdout: (c: string) => void; onStderr: (c: string) => void; signal: AbortSignal } {
  return { onStdout: (c) => h.append(c), onStderr: (c) => h.append(c), signal: h.signal }
}

/** Run a (possibly multi-statement) script as root. Wrapped in `sh -c` so sudo covers the whole script. Never throws on non-zero exit. */
function rootSh(ssh: SshClient, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return ssh.exec(`sh -c ${shq(script)}`, { ...opts, sudo: true })
}

/** Like rootSh but throws on non-zero exit and returns stdout. */
function rootRun(ssh: SshClient, script: string, opts: ExecOptions = {}): Promise<string> {
  return ssh.run(`sh -c ${shq(script)}`, { ...opts, sudo: true })
}

/* ------------------------------------------------------------------ */
/* Server definitions                                                  */
/* ------------------------------------------------------------------ */

interface ServerDef {
  id: WebServerId
  name: string
  unit: string
  configDir: string
  sitesDir?: string
  enabledDir?: string
  confD?: string
  logDir: string
  accessLog: string
  errorLog: string
  testCmd: string
  sitesSupported: boolean
  adminUrl?: string
}

function apacheUnit(ssh: SshClient, detected?: string): string {
  if (detected === 'apache2' || detected === 'httpd') return detected
  return isDebianFamily(ssh) ? 'apache2' : 'httpd'
}

function serverDef(ssh: SshClient, id: WebServerId, hints: { apacheUnit?: string; nginxSitesEnabled?: boolean } = {}): ServerDef {
  switch (id) {
    case 'nginx': {
      const useSites = hints.nginxSitesEnabled !== false
      return {
        id,
        name: 'Nginx',
        unit: 'nginx',
        configDir: '/etc/nginx',
        sitesDir: useSites ? '/etc/nginx/sites-available' : '/etc/nginx/conf.d',
        enabledDir: useSites ? '/etc/nginx/sites-enabled' : undefined,
        confD: '/etc/nginx/conf.d',
        logDir: '/var/log/nginx',
        accessLog: '/var/log/nginx/access.log',
        errorLog: '/var/log/nginx/error.log',
        testCmd: 'nginx -t',
        sitesSupported: true
      }
    }
    case 'apache': {
      const unit = apacheUnit(ssh, hints.apacheUnit)
      const deb = unit === 'apache2'
      return {
        id,
        name: 'Apache HTTP Server',
        unit,
        configDir: deb ? '/etc/apache2' : '/etc/httpd',
        sitesDir: deb ? '/etc/apache2/sites-available' : '/etc/httpd/conf.d',
        enabledDir: deb ? '/etc/apache2/sites-enabled' : undefined,
        confD: deb ? '/etc/apache2/conf-enabled' : '/etc/httpd/conf.d',
        logDir: deb ? '/var/log/apache2' : '/var/log/httpd',
        accessLog: deb ? '/var/log/apache2/access.log' : '/var/log/httpd/access_log',
        errorLog: deb ? '/var/log/apache2/error.log' : '/var/log/httpd/error_log',
        testCmd: deb ? 'apache2ctl configtest' : 'apachectl configtest',
        sitesSupported: true
      }
    }
    case 'caddy':
      return {
        id,
        name: 'Caddy',
        unit: 'caddy',
        configDir: '/etc/caddy',
        sitesDir: undefined,
        logDir: '/var/log/caddy',
        accessLog: 'journal',
        errorLog: 'journal',
        testCmd: 'caddy validate --config /etc/caddy/Caddyfile',
        sitesSupported: false
      }
    case 'openlitespeed':
      return {
        id,
        name: 'OpenLiteSpeed',
        unit: 'lsws',
        configDir: '/usr/local/lsws/conf',
        logDir: '/usr/local/lsws/logs',
        accessLog: '/usr/local/lsws/logs/access.log',
        errorLog: '/usr/local/lsws/logs/error.log',
        testCmd: '/usr/local/lsws/bin/lshttpd -t',
        sitesSupported: false,
        adminUrl: 'https://HOST:7080'
      }
    case 'lighttpd':
      return {
        id,
        name: 'Lighttpd',
        unit: 'lighttpd',
        configDir: '/etc/lighttpd',
        logDir: '/var/log/lighttpd',
        accessLog: '/var/log/lighttpd/access.log',
        errorLog: '/var/log/lighttpd/error.log',
        testCmd: 'lighttpd -tt -f /etc/lighttpd/lighttpd.conf',
        sitesSupported: false
      }
  }
}

/** Resolve a server definition, probing the remote for the apache unit / nginx layout. */
async function resolveDef(ssh: SshClient, id: WebServerId): Promise<ServerDef> {
  if (id === 'apache') {
    const r = await ssh.exec(`for u in apache2 httpd; do if [ -f /lib/systemd/system/$u.service ] || [ -f /usr/lib/systemd/system/$u.service ] || [ -f /etc/systemd/system/$u.service ] || [ -d /etc/$u ]; then echo $u; break; fi; done`, { timeoutMs: 15000 })
    return serverDef(ssh, id, { apacheUnit: r.stdout.trim() || undefined })
  }
  if (id === 'nginx') {
    const r = await ssh.exec(`[ -d /etc/nginx/sites-enabled ] && grep -qsE '^\\s*include\\s+/etc/nginx/sites-enabled' /etc/nginx/nginx.conf && echo yes`, { timeoutMs: 15000 })
    return serverDef(ssh, id, { nginxSitesEnabled: r.stdout.includes('yes') })
  }
  return serverDef(ssh, id)
}

function testScript(def: ServerDef): string {
  switch (def.id) {
    case 'nginx':
      return 'nginx -t 2>&1'
    case 'apache':
      return 'if command -v apache2ctl >/dev/null 2>&1; then apache2ctl configtest 2>&1; elif command -v apachectl >/dev/null 2>&1; then apachectl configtest 2>&1; else httpd -t 2>&1; fi'
    case 'caddy':
      return 'caddy validate --config /etc/caddy/Caddyfile 2>&1'
    case 'openlitespeed':
      return '/usr/local/lsws/bin/lshttpd -t 2>&1'
    case 'lighttpd':
      return 'lighttpd -tt -f /etc/lighttpd/lighttpd.conf 2>&1'
  }
}

async function runTest(ssh: SshClient, def: ServerDef): Promise<WebTestResult> {
  const r = await rootSh(ssh, testScript(def), { timeoutMs: 60000 })
  const output = (r.stdout + r.stderr).trim() || (r.code === 0 ? 'Configuration OK' : `exit code ${r.code}`)
  return { ok: r.code === 0, output }
}

async function reloadService(ssh: SshClient, def: ServerDef): Promise<void> {
  if (ssh.os?.hasSystemd) await rootRun(ssh, `systemctl reload-or-restart ${shq(def.unit)}`)
  else await rootRun(ssh, `(service ${shq(def.unit)} reload 2>/dev/null || service ${shq(def.unit)} restart || rc-service ${shq(def.unit)} restart)`)
}

/** Test the configuration and reload; throws with the test output on failure. */
async function testAndReload(ssh: SshClient, def: ServerDef): Promise<WebTestResult> {
  const t = await runTest(ssh, def)
  if (!t.ok) throw new Error(`Configuration test failed – not reloaded:\n${t.output}`)
  await reloadService(ssh, def)
  return t
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

function versionOf(s: string): string {
  const m = s.match(/(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/)
  return m ? m[1] : ''
}

function portOf(local: string): number {
  const m = local.match(/:(\d+)$/)
  return m ? Number(m[1]) : 0
}

async function detect(ssh: SshClient): Promise<WebDetectResult> {
  const script = `
echo __NGINX
command -v nginx >/dev/null 2>&1 && echo INSTALLED
nginx -v 2>&1 | head -1
systemctl is-active nginx 2>/dev/null || (pgrep -x nginx >/dev/null 2>&1 && echo active || echo inactive)
systemctl is-enabled nginx 2>/dev/null
[ -d /etc/nginx/sites-enabled ] && grep -qsE '^\\s*include\\s+/etc/nginx/sites-enabled' /etc/nginx/nginx.conf && echo SITES=yes
echo __APACHE
AU=""; for u in apache2 httpd; do if [ -f /lib/systemd/system/$u.service ] || [ -f /usr/lib/systemd/system/$u.service ] || [ -f /etc/systemd/system/$u.service ]; then AU=$u; break; fi; done
[ -z "$AU" ] && { command -v apache2 >/dev/null 2>&1 && AU=apache2; command -v httpd >/dev/null 2>&1 && AU=httpd; }
echo "UNIT=$AU"
(command -v apache2 >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1 || command -v apachectl >/dev/null 2>&1 || command -v apache2ctl >/dev/null 2>&1) && echo INSTALLED
(apache2 -v 2>/dev/null || httpd -v 2>/dev/null || apache2ctl -v 2>/dev/null || apachectl -v 2>/dev/null) | head -1
[ -n "$AU" ] && (systemctl is-active $AU 2>/dev/null || (pgrep -x "$AU" >/dev/null 2>&1 && echo active || echo inactive))
[ -n "$AU" ] && systemctl is-enabled $AU 2>/dev/null
echo __CADDY
command -v caddy >/dev/null 2>&1 && echo INSTALLED
caddy version 2>/dev/null | head -1
systemctl is-active caddy 2>/dev/null || (pgrep -x caddy >/dev/null 2>&1 && echo active || echo inactive)
systemctl is-enabled caddy 2>/dev/null
echo __OLS
[ -x /usr/local/lsws/bin/lswsctrl ] && echo INSTALLED
/usr/local/lsws/bin/lshttpd -v 2>/dev/null | head -1
systemctl is-active lsws 2>/dev/null || (pgrep -f 'lsws|litespeed|lshttpd|openlitespeed' >/dev/null 2>&1 && echo active || echo inactive)
systemctl is-enabled lsws 2>/dev/null
echo __LIGHTTPD
command -v lighttpd >/dev/null 2>&1 && echo INSTALLED
lighttpd -v 2>&1 | head -1
systemctl is-active lighttpd 2>/dev/null || (pgrep -x lighttpd >/dev/null 2>&1 && echo active || echo inactive)
systemctl is-enabled lighttpd 2>/dev/null
echo __PORTS
ss -tlnpH 2>/dev/null || ss -tlnp 2>/dev/null | tail -n +2 || netstat -tlnp 2>/dev/null | tail -n +3
echo __END`
  let r
  try {
    r = await rootSh(ssh, script, { timeoutMs: 40000 })
  } catch {
    r = await ssh.exec(script, { timeoutMs: 40000 })
  }
  const sec = sections(r.stdout)

  const parse = (lines: string[] | undefined): { installed: boolean; version: string; running: boolean; enabled: boolean; extra: Record<string, string> } => {
    const ls = (lines ?? []).map((l) => l.trim()).filter(Boolean)
    const installed = ls.includes('INSTALLED')
    const extra: Record<string, string> = {}
    let version = ''
    let running = false
    let enabled = false
    for (const l of ls) {
      if (l === 'INSTALLED') continue
      const kv = l.match(/^([A-Z]+)=(.*)$/)
      if (kv) {
        extra[kv[1]] = kv[2]
        continue
      }
      if (/^(active|inactive|failed|activating|deactivating|unknown)$/.test(l)) {
        running = l === 'active' || l === 'activating'
        continue
      }
      if (/^(enabled|disabled|static|masked|indirect|alias|generated|transient|enabled-runtime|not-found|linked)$/.test(l)) {
        enabled = l === 'enabled' || l === 'enabled-runtime' || l === 'alias' || l === 'indirect'
        continue
      }
      if (!version) version = versionOf(l)
    }
    return { installed, version, running: installed && running, enabled: installed && enabled, extra }
  }

  const nginx = parse(sec.NGINX)
  const apache = parse(sec.APACHE)
  const caddy = parse(sec.CADDY)
  const ols = parse(sec.OLS)
  const lighttpd = parse(sec.LIGHTTPD)

  const hostForAdmin = ssh.profile.host
  const mk = (id: WebServerId, p: ReturnType<typeof parse>, def: ServerDef): WebServerInfo => ({
    id,
    name: def.name,
    installed: p.installed,
    version: p.version,
    running: p.running,
    enabled: p.enabled,
    unit: def.unit,
    configTestCmd: def.testCmd,
    configDir: def.configDir,
    sitesDir: def.sitesDir,
    logDir: def.logDir,
    adminUrl: def.adminUrl?.replace('HOST', hostForAdmin),
    sitesSupported: def.sitesSupported
  })

  const all: WebServerInfo[] = [
    mk('nginx', nginx, serverDef(ssh, 'nginx', { nginxSitesEnabled: nginx.extra.SITES === 'yes' })),
    mk('apache', apache, serverDef(ssh, 'apache', { apacheUnit: apache.extra.UNIT || undefined })),
    mk('caddy', caddy, serverDef(ssh, 'caddy')),
    mk('openlitespeed', ols, serverDef(ssh, 'openlitespeed')),
    mk('lighttpd', lighttpd, serverDef(ssh, 'lighttpd'))
  ]
  const servers = all.filter((s) => s.installed)

  const ports: string[] = []
  for (const raw of sec.PORTS ?? []) {
    const line = raw.trim()
    if (!line) continue
    const f = line.split(/\s+/)
    // ss: State Recv-Q Send-Q Local:Port Peer:Port Process ; netstat: Proto Recv-Q Send-Q Local Foreign State PID/Program
    const local = f[3]
    const port = portOf(local ?? '')
    const proc = f.slice(4).join(' ')
    if (WEB_PORTS.has(port) || WEB_PROCS.test(proc)) ports.push(line.replace(/\s+/g, ' '))
  }

  const pkgFor = (id: WebServerId): string => {
    const pm = ssh.os?.pkgManager
    switch (id) {
      case 'nginx':
        return 'nginx'
      case 'apache':
        return pm === 'apt' || pm === 'zypper' || pm === 'apk' ? 'apache2' : pm === 'pacman' ? 'apache' : 'httpd'
      case 'caddy':
        return pm === 'apt' ? 'caddy (official Cloudsmith repository)' : pm === 'dnf' || pm === 'yum' ? 'caddy (EPEL / COPR @caddy/caddy)' : 'caddy'
      case 'openlitespeed':
        return 'openlitespeed (LiteSpeed repository)'
      case 'lighttpd':
        return 'lighttpd'
    }
  }
  const available: WebAvailable[] = all.filter((s) => !s.installed).map((s) => ({ ...AVAILABLE[s.id], packages: pkgFor(s.id) }))

  return { servers, ports, available, hasSystemd: !!ssh.os?.hasSystemd, pkgManager: ssh.os?.pkgManager ?? 'unknown', host: ssh.profile.host }
}

/* ------------------------------------------------------------------ */
/* Install scripts                                                     */
/* ------------------------------------------------------------------ */

function installScript(ssh: SshClient, id: WebServerId): { steps: { label: string; cmd: string }[]; unit: string; note?: string } {
  const pm = ssh.os?.pkgManager ?? 'unknown'
  const simple = (pkgs: string[], unit: string, note?: string): ReturnType<typeof installScript> => ({ steps: [{ label: `Installing ${pkgs.join(', ')}…`, cmd: installCmd(ssh, pkgs) }], unit, note })
  switch (id) {
    case 'nginx':
      return simple(['nginx'], 'nginx')
    case 'lighttpd':
      return simple(['lighttpd'], 'lighttpd')
    case 'apache': {
      if (pm === 'apt' || pm === 'zypper' || pm === 'apk') return simple(['apache2'], 'apache2')
      if (pm === 'pacman') return simple(['apache'], 'httpd')
      return simple(['httpd'], 'httpd')
    }
    case 'caddy': {
      if (pm === 'apt') {
        return {
          unit: 'caddy',
          steps: [
            { label: 'Installing prerequisites…', cmd: installCmd(ssh, ['debian-keyring', 'debian-archive-keyring', 'apt-transport-https', 'curl', 'gnupg']) },
            {
              label: 'Adding the official Caddy repository (dl.cloudsmith.io/public/caddy/stable)…',
              cmd: [
                `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg`,
                `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list`,
                'chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list'
              ].join(' && ')
            },
            { label: 'Installing caddy…', cmd: 'apt-get update -qq && apt-get install -y -qq caddy' }
          ]
        }
      }
      if (pm === 'dnf' || pm === 'yum') {
        return {
          unit: 'caddy',
          steps: [
            { label: 'Enabling EPEL (if applicable)…', cmd: `${pm} install -y epel-release 2>/dev/null || true` },
            {
              label: 'Installing caddy (EPEL, falling back to COPR @caddy/caddy)…',
              cmd: `${pm} install -y caddy || (${pm} install -y 'dnf-command(copr)' && ${pm} copr enable -y @caddy/caddy && ${pm} install -y caddy)`
            }
          ]
        }
      }
      return simple(['caddy'], 'caddy')
    }
    case 'openlitespeed': {
      const note = 'OpenLiteSpeed WebAdmin console: https://<server>:7080 (default login admin / 123456 – change it with /usr/local/lsws/admin/misc/admpass.sh). Open port 7080 in the firewall only for trusted IPs.'
      if (pm === 'apt') {
        return {
          unit: 'lsws',
          note,
          steps: [
            { label: 'Installing prerequisites…', cmd: installCmd(ssh, ['wget', 'gnupg', 'ca-certificates']) },
            {
              label: 'Adding the LiteSpeed repository (rpms.litespeedtech.com/debian)…',
              cmd: [
                `CODENAME=$(. /etc/os-release; echo "\${VERSION_CODENAME:-}"); [ -z "$CODENAME" ] && CODENAME=$(lsb_release -sc 2>/dev/null); [ -n "$CODENAME" ] || { echo "Cannot determine distribution codename"; exit 1; }`,
                'wget -qO /etc/apt/trusted.gpg.d/lst_debian_repo.gpg https://rpms.litespeedtech.com/debian/lst_debian_repo.gpg',
                'wget -qO /etc/apt/trusted.gpg.d/lst_repo.gpg https://rpms.litespeedtech.com/debian/lst_repo.gpg',
                `echo "deb http://rpms.litespeedtech.com/debian/ $CODENAME main" > /etc/apt/sources.list.d/lst_debian_repo.list`
              ].join(' && ')
            },
            { label: 'Installing openlitespeed…', cmd: 'apt-get update -qq && apt-get install -y -qq openlitespeed' }
          ]
        }
      }
      if (pm === 'dnf' || pm === 'yum') {
        return {
          unit: 'lsws',
          note,
          steps: [
            { label: 'Enabling EPEL…', cmd: `${pm} install -y epel-release 2>/dev/null || true` },
            {
              label: 'Adding the LiteSpeed repository (rpms.litespeedtech.com/centos)…',
              cmd: `REL=$(rpm -E %rhel 2>/dev/null); case "$REL" in ''|'%rhel') REL=$(. /etc/os-release; echo "\${VERSION_ID%%.*}");; esac; rpm -q litespeed-repo >/dev/null 2>&1 || rpm -Uvh "https://rpms.litespeedtech.com/centos/litespeed-repo-1.3-1.el$REL.noarch.rpm"`
            },
            { label: 'Installing openlitespeed…', cmd: `${pm} install -y openlitespeed` }
          ]
        }
      }
      throw new Error('OpenLiteSpeed packages are provided for Debian/Ubuntu (apt) and RHEL-family (dnf/yum) systems only')
    }
  }
}

/* ------------------------------------------------------------------ */
/* Site parsing                                                        */
/* ------------------------------------------------------------------ */

function stripHashComments(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n')
}

function uniq(a: string[]): string[] {
  return [...new Set(a)]
}

function parseNginxSite(content: string): Pick<WebSite, 'serverNames' | 'listen' | 'root' | 'proxy' | 'ssl'> {
  const c = stripHashComments(content)
  const names: string[] = []
  const listen: string[] = []
  let root: string | undefined
  let proxy: string | undefined
  let ssl = false
  for (const m of c.matchAll(/(^|[;{}\s])server_name\s+([^;]+);/g)) names.push(...m[2].trim().split(/\s+/))
  for (const m of c.matchAll(/(^|[;{}\s])listen\s+([^;]+);/g)) {
    const v = m[2].trim().replace(/\s+/g, ' ')
    listen.push(v)
    if (/\bssl\b/.test(v) || /(^|:)443(\s|$)/.test(v)) ssl = true
  }
  const rm = c.match(/(^|[;{}\s])root\s+([^;]+);/)
  if (rm) root = rm[2].trim().replace(/^["']|["']$/g, '')
  const pm = c.match(/(^|[;{}\s])proxy_pass\s+([^;]+);/)
  if (pm) proxy = pm[2].trim()
  if (/(^|[;{}\s])ssl_certificate\s+/.test(c)) ssl = true
  return { serverNames: uniq(names.filter((n) => n && n !== '_')), listen: uniq(listen), root, proxy, ssl }
}

function parseApacheSite(content: string): Pick<WebSite, 'serverNames' | 'listen' | 'root' | 'proxy' | 'ssl'> {
  const c = stripHashComments(content)
  const names: string[] = []
  const listen: string[] = []
  let root: string | undefined
  let proxy: string | undefined
  let ssl = false
  for (const m of c.matchAll(/<VirtualHost\s+([^>]+)>/gi)) {
    for (const addr of m[1].trim().split(/\s+/)) {
      listen.push(addr)
      if (/:443$/.test(addr)) ssl = true
    }
  }
  for (const m of c.matchAll(/^\s*ServerName\s+(\S+)/gim)) names.push(m[1].replace(/^https?:\/\//, '').replace(/:\d+$/, ''))
  for (const m of c.matchAll(/^\s*ServerAlias\s+(.+)$/gim)) names.push(...m[1].trim().split(/\s+/))
  const rm = c.match(/^\s*DocumentRoot\s+"?([^"\s]+)"?/im)
  if (rm) root = rm[1]
  const pm = c.match(/^\s*ProxyPass\s+(?:"[^"]*"|\S+)\s+"?([^"\s]+)"?/im)
  if (pm) proxy = pm[1]
  if (/^\s*SSLEngine\s+on/im.test(c) || /^\s*SSLCertificateFile\s+/im.test(c)) ssl = true
  return { serverNames: uniq(names), listen: uniq(listen), root, proxy, ssl }
}

function parseCaddyfile(content: string): WebSite[] {
  const sites: WebSite[] = []
  const lines = stripHashComments(content).split('\n')
  let depth = 0
  let cur: WebSite | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const opens = (line.match(/{/g) ?? []).length
    const closes = (line.match(/}/g) ?? []).length
    if (depth === 0 && opens > 0) {
      const head = line.replace(/\{.*$/, '').trim()
      // Skip global options block "{" and snippets "(name)"
      if (head && !head.startsWith('(')) {
        const addrs = head
          .split(/[,\s]+/)
          .map((a) => a.trim())
          .filter(Boolean)
        const first = addrs[0] ?? 'site'
        const plainHttp = addrs.every((a) => a.startsWith('http://') || /^:\d+$/.test(a) || /^localhost(:\d+)?$/.test(a) || /^(\d+\.){3}\d+(:\d+)?$/.test(a) || a.endsWith('.localhost'))
        cur = {
          server: 'caddy',
          name: first.replace(/^https?:\/\//, ''),
          path: '/etc/caddy/Caddyfile',
          enabled: true,
          serverNames: addrs.map((a) => a.replace(/^https?:\/\//, '').replace(/:\d+$/, '')).filter((a) => a && !a.startsWith(':')),
          listen: addrs.some((a) => /:\d+$/.test(a)) ? uniq(addrs.map((a) => (a.match(/:(\d+)$/) ?? [])[1]).filter((p): p is string => !!p)) : [plainHttp ? '80' : '443'],
          ssl: !plainHttp,
          editable: false
        }
        sites.push(cur)
      } else cur = null
    } else if (depth === 1 && cur) {
      const r = line.match(/^root\s+(?:\*\s+|\S+\s+)?(\S+)/)
      if (r && !cur.root) cur.root = r[1]
      const p = line.match(/^reverse_proxy\s+(?:\S+\s+)?(\S+)/)
      if (p && !cur.proxy && !p[1].startsWith('{')) cur.proxy = p[1]
      if (/^tls\s+internal/.test(line)) cur.ssl = true
    }
    depth += opens - closes
    if (depth <= 0) {
      depth = 0
      cur = null
    }
  }
  return sites
}

async function listSites(ssh: SshClient, def: ServerDef): Promise<WebSite[]> {
  if (def.id === 'caddy') {
    const r = await rootSh(ssh, 'cat /etc/caddy/Caddyfile 2>/dev/null', { timeoutMs: 20000 })
    return parseCaddyfile(r.stdout)
  }
  if (def.id !== 'nginx' && def.id !== 'apache') return []
  const dirs: string[] = []
  if (def.sitesDir) dirs.push(def.sitesDir)
  if (def.confD && def.confD !== def.sitesDir && def.id === 'nginx') dirs.push(def.confD)
  const enabledDir = def.enabledDir
  const script = `
for d in ${dirs.map(shq).join(' ')}; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.bak|*~|*.dpkg-*|*.rpmsave|*.rpmnew|*.orig) continue;; esac
    ${def.id === 'nginx' && def.confD ? `case "$d" in ${shq(def.confD)}) case "$f" in *.conf) ;; *) continue;; esac;; esac` : ''}
    ${def.id === 'apache' && !enabledDir ? `case "$f" in *.conf) ;; *) continue;; esac` : ''}
    echo "__FILE $f"
    ${enabledDir ? `b=$(basename "$f"); if [ -e ${shq(enabledDir)}/"$b" ] || [ -e ${shq(enabledDir)}/"\${b%.conf}" ] || [ -e ${shq(enabledDir)}/"$b.conf" ]; then echo "__ENABLED 1"; else echo "__ENABLED 0"; fi` : 'echo "__ENABLED 1"'}
    echo "__CONTENT"
    cat "$f"
    echo
  done
done
echo "__END"`
  const r = await rootSh(ssh, script, { timeoutMs: 30000, maxBuffer: 16 * 1024 * 1024 })
  const sites: WebSite[] = []
  let cur: { path: string; enabled: boolean; content: string[] } | null = null
  let inContent = false
  const flush = (): void => {
    if (!cur) return
    const content = cur.content.join('\n')
    const base = cur.path.split('/').pop() ?? cur.path
    const parsed = def.id === 'nginx' ? parseNginxSite(content) : parseApacheSite(content)
    sites.push({ server: def.id, name: base, path: cur.path, enabled: cur.enabled, editable: true, ...parsed })
    cur = null
  }
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('__FILE ')) {
      flush()
      cur = { path: line.slice(7).trim(), enabled: true, content: [] }
      inContent = false
    } else if (line.startsWith('__ENABLED ')) {
      if (cur) cur.enabled = line.slice(10).trim() === '1'
    } else if (line === '__CONTENT') {
      inContent = true
    } else if (line === '__END') {
      flush()
    } else if (cur && inContent) cur.content.push(line)
  }
  flush()
  return sites
}

/* ------------------------------------------------------------------ */
/* Site templates                                                      */
/* ------------------------------------------------------------------ */

function versionGte(v: string, major: number, minor: number, patch = 0): boolean {
  const p = v.split('.').map(Number)
  if (!p.length || Number.isNaN(p[0])) return false
  const [a = 0, b = 0, c = 0] = p
  if (a !== major) return a > major
  if (b !== minor) return b > minor
  return c >= patch
}

function nginxTemplate(spec: WebSiteSpec, opts: { logDir: string; phpSocket?: string; nginxVersion: string }): string {
  const names = spec.domains.join(' ')
  const lines: string[] = []
  lines.push(`# ${spec.name} – generated by Central Server (${spec.type} site)`)
  lines.push('server {')
  lines.push('    listen 80;')
  lines.push('    listen [::]:80;')
  if (spec.http2) {
    if (versionGte(opts.nginxVersion, 1, 25, 1)) lines.push('    http2 on;')
    else lines.push('    # HTTP/2: on nginx < 1.25.1 add "http2" to the "listen 443 ssl" line after enabling SSL')
  }
  lines.push(`    server_name ${names};`)
  lines.push('')
  lines.push(`    access_log ${opts.logDir}/${spec.name}.access.log;`)
  lines.push(`    error_log ${opts.logDir}/${spec.name}.error.log;`)
  lines.push('')
  if (spec.type === 'proxy') {
    lines.push('    location / {')
    lines.push(`        proxy_pass ${spec.proxyTarget};`)
    lines.push('        proxy_http_version 1.1;')
    lines.push('        proxy_set_header Host $host;')
    lines.push('        proxy_set_header X-Real-IP $remote_addr;')
    lines.push('        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;')
    lines.push('        proxy_set_header X-Forwarded-Proto $scheme;')
    lines.push('        proxy_set_header Upgrade $http_upgrade;')
    lines.push('        proxy_set_header Connection "upgrade";')
    lines.push('        proxy_read_timeout 90s;')
    lines.push('    }')
  } else {
    lines.push(`    root ${spec.root};`)
    lines.push(spec.type === 'php' ? '    index index.php index.html index.htm;' : '    index index.html index.htm;')
    lines.push('')
    lines.push('    location / {')
    lines.push(spec.type === 'php' ? '        try_files $uri $uri/ /index.php?$query_string;' : '        try_files $uri $uri/ =404;')
    lines.push('    }')
    if (spec.type === 'php') {
      lines.push('')
      lines.push('    location ~ \\.php$ {')
      lines.push('        try_files $uri =404;')
      lines.push('        include fastcgi_params;')
      lines.push('        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;')
      lines.push('        fastcgi_index index.php;')
      lines.push(`        fastcgi_pass unix:${opts.phpSocket};`)
      lines.push('    }')
    }
    lines.push('')
    lines.push('    location ~ /\\.(?!well-known) {')
    lines.push('        deny all;')
    lines.push('    }')
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}

function apacheTemplate(spec: WebSiteSpec, opts: { logDir: string; phpSocket?: string }): string {
  const [first, ...aliases] = spec.domains
  const lines: string[] = []
  lines.push(`# ${spec.name} – generated by Central Server (${spec.type} site)`)
  lines.push('<VirtualHost *:80>')
  lines.push(`    ServerName ${first}`)
  if (aliases.length) lines.push(`    ServerAlias ${aliases.join(' ')}`)
  if (spec.http2) lines.push('    Protocols h2 h2c http/1.1')
  lines.push('')
  lines.push(`    ErrorLog ${opts.logDir}/${spec.name}.error.log`)
  lines.push(`    CustomLog ${opts.logDir}/${spec.name}.access.log combined`)
  lines.push('')
  if (spec.type === 'proxy') {
    lines.push('    ProxyPreserveHost On')
    lines.push('    ProxyRequests Off')
    lines.push(`    ProxyPass / ${spec.proxyTarget!.replace(/\/?$/, '/')}`)
    lines.push(`    ProxyPassReverse / ${spec.proxyTarget!.replace(/\/?$/, '/')}`)
    lines.push('    RequestHeader set X-Forwarded-Proto "http"')
  } else {
    lines.push(`    DocumentRoot ${spec.root}`)
    lines.push(`    <Directory ${spec.root}>`)
    lines.push('        Options -Indexes +FollowSymLinks')
    lines.push('        AllowOverride All')
    lines.push('        Require all granted')
    lines.push('    </Directory>')
    if (spec.type === 'php') {
      lines.push('')
      lines.push('    DirectoryIndex index.php index.html')
      lines.push('    <FilesMatch "\\.php$">')
      lines.push(`        SetHandler "proxy:unix:${opts.phpSocket}|fcgi://localhost"`)
      lines.push('    </FilesMatch>')
    }
  }
  lines.push('</VirtualHost>')
  return lines.join('\n') + '\n'
}

function placeholderHtml(spec: WebSiteSpec): string {
  const d = spec.domains[0]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${d}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
  main{text-align:center;padding:2rem}
  h1{font-weight:600;margin:0 0 .5rem}
  p{color:#94a3b8;margin:0}
  code{background:#1e293b;padding:.15em .4em;border-radius:4px}
</style>
</head>
<body>
<main>
  <h1>${d}</h1>
  <p>This site was created with Central Server. Replace <code>${spec.root}/index.html</code> with your content.</p>
</main>
</body>
</html>
`
}

async function resolvePhpSocket(ssh: SshClient, phpVersion: string | undefined): Promise<string> {
  const r = await rootSh(ssh, 'ls -1 /run/php/*.sock /run/php-fpm/*.sock /var/run/php/*.sock /run/php*-fpm.sock 2>/dev/null', { timeoutMs: 15000 })
  const sockets = uniq(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
  const want = (phpVersion ?? '').trim()
  if (want.startsWith('/')) {
    assertAbsPath(want)
    if (!/^[A-Za-z0-9_./-]+\.sock$/.test(want)) throw new Error(`Invalid PHP-FPM socket path: ${want}`)
    return want
  }
  if (want && !/^\d+\.\d+$/.test(want)) throw new Error(`Invalid PHP version: ${want}`)
  if (want) {
    const exact = sockets.find((s) => s.includes(`php${want}-fpm`) || s.includes(`php/php${want}`) || s.includes(`php-fpm/${want}`))
    if (exact) return exact
    if (sockets.length === 0) return isRhelFamily(ssh) ? '/run/php-fpm/www.sock' : `/run/php/php${want}-fpm.sock`
  }
  if (sockets.length) return sockets.find((s) => /www\.sock$/.test(s)) ?? sockets.sort().reverse()[0]
  throw new Error('No PHP-FPM socket found (looked in /run/php and /run/php-fpm). Install php-fpm first (Runtimes page) and make sure the php-fpm service is running.')
}

/* ------------------------------------------------------------------ */
/* SSL (certbot)                                                       */
/* ------------------------------------------------------------------ */

function parseCertbotCertificates(out: string): SslCert[] {
  const certs: SslCert[] = []
  let cur: SslCert | null = null
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    let m: RegExpMatchArray | null
    if ((m = line.match(/^Certificate Name:\s*(.+)$/))) {
      cur = { name: m[1].trim(), domains: [], expiry: '', path: '' }
      certs.push(cur)
    } else if (!cur) continue
    else if ((m = line.match(/^Domains:\s*(.*)$/))) cur.domains = m[1].trim().split(/\s+/).filter(Boolean)
    else if ((m = line.match(/^Expiry Date:\s*(\S+(?:\s+\S+)?)\s*(?:\((.*)\))?/))) {
      cur.expiry = m[1].trim()
      const inner = m[2] ?? ''
      const d = inner.match(/VALID:\s*(-?\d+)\s*day/i)
      if (d) cur.daysLeft = Number(d[1])
      else if (/INVALID|EXPIRED/i.test(inner)) {
        const t = Date.parse(cur.expiry.replace(' ', 'T'))
        cur.daysLeft = Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : -1
      }
      if (cur.daysLeft === undefined) {
        const t = Date.parse(cur.expiry.replace(' ', 'T'))
        if (Number.isFinite(t)) cur.daysLeft = Math.floor((t - Date.now()) / 86400000)
      }
    } else if ((m = line.match(/^Certificate Path:\s*(.+)$/))) cur.path = m[1].trim()
    else if ((m = line.match(/^Private Key Path:\s*(.+)$/))) cur.keyPath = m[1].trim()
    else if ((m = line.match(/^Key Type:\s*(.+)$/))) cur.keyType = m[1].trim()
  }
  return certs
}

async function sslStatus(ssh: SshClient): Promise<SslStatus> {
  const script = `
echo __CERTBOT
command -v certbot >/dev/null 2>&1 && echo INSTALLED
certbot --version 2>&1 | head -1
echo __SNAP
command -v snap >/dev/null 2>&1 && echo yes
echo __TIMERS
systemctl list-timers --all --no-pager --no-legend 2>/dev/null | grep -iE 'certbot'
for t in certbot.timer snap.certbot.renew.timer certbot-renew.timer; do systemctl is-active $t 2>/dev/null | sed "s/^/$t=/"; done
[ -f /etc/cron.d/certbot ] && echo CRON=/etc/cron.d/certbot
echo __CERTS
certbot certificates 2>/dev/null
echo __END`
  const r = await rootSh(ssh, script, { timeoutMs: 60000 })
  const sec = sections(r.stdout)
  const cb = (sec.CERTBOT ?? []).map((l) => l.trim()).filter(Boolean)
  const installed = cb.includes('INSTALLED')
  const verLine = cb.find((l) => l !== 'INSTALLED' && /\d/.test(l))
  const timers = (sec.TIMERS ?? []).map((l) => l.trim()).filter(Boolean)
  const activeTimer = timers.find((l) => /\.timer=active$/.test(l))
  const cron = timers.find((l) => l.startsWith('CRON='))
  const timerLine = timers.find((l) => !/=/.test(l))
  let renewal: string | undefined
  if (activeTimer) renewal = `systemd timer ${activeTimer.replace('=active', '')}${timerLine ? ` – ${timerLine.replace(/\s+/g, ' ')}` : ''}`
  else if (cron) renewal = `cron job ${cron.slice(5)}`
  return {
    certbotInstalled: installed,
    certbotVersion: installed && verLine ? versionOf(verLine) || verLine : undefined,
    certs: installed ? parseCertbotCertificates((sec.CERTS ?? []).join('\n')) : [],
    renewal,
    renewalActive: !!(activeTimer || cron),
    snapAvailable: (sec.SNAP ?? []).some((l) => l.trim() === 'yes')
  }
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

function clampLines(n: unknown, max = 5000): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 10) return 200
  return Math.min(max, v)
}

/** Shell snippet that echoes the first existing log file among candidates. */
function logCandidates(def: ServerDef, kind: 'access' | 'error', site?: string): string[] {
  const main = kind === 'access' ? def.accessLog : def.errorLog
  if (!site) return [main]
  const base = site.replace(/\.conf$/, '')
  const list = [
    `${def.logDir}/${base}.${kind}.log`,
    `${def.logDir}/${base}-${kind}.log`,
    `${def.logDir}/${base}_${kind}.log`,
    `${def.logDir}/${base}/${kind}.log`,
    `${def.logDir}/${base}.${kind}_log`,
    `${def.logDir}/${base}-${kind}_log`
  ]
  return [...list, main]
}

function parseCountLines(lines: string[]): WebLogCount[] {
  const out: WebLogCount[] = []
  for (const l of lines) {
    const m = l.trim().match(/^(\d+)\s+(.+)$/)
    if (m) out.push({ key: m[2], count: Number(m[1]) })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  // ---------------- detect ----------------
  ctx.handle('web:detect', async (serverId: string): Promise<WebDetectResult> => detect(ctx.ssh(serverId)))

  // ---------------- install ----------------
  ctx.handle('web:install', async (serverId: string, idRaw: string) => {
    const id = assertServerId(idRaw)
    const ssh = ctx.ssh(serverId)
    const plan = installScript(ssh, id)
    const { id: taskId } = ctx.tasks.start(`Install ${AVAILABLE[id].name}`, serverId, async (h) => {
      for (const step of plan.steps) {
        h.log(step.label)
        await runPkg(ssh, `sh -c ${shq(step.cmd)}`, taskStream(h))
      }
      if (ssh.os?.hasSystemd) {
        h.log(`Enabling and starting ${plan.unit}…`)
        const r = await rootSh(ssh, `systemctl enable --now ${shq(plan.unit)} 2>&1`, { timeoutMs: 120000 })
        h.append(r.stdout + r.stderr)
        if (r.code !== 0) {
          const st = await rootSh(ssh, `systemctl status ${shq(plan.unit)} --no-pager -l 2>&1 | tail -n 20`)
          h.log(st.stdout)
          throw new Error(`${AVAILABLE[id].name} was installed but ${plan.unit} failed to start. Another web server is probably already listening on port 80/443 – stop it first, then start ${plan.unit}.`)
        }
      } else {
        h.log('No systemd detected – start the service with your init system (e.g. rc-service / service).')
      }
      if (plan.note) h.log(plan.note)
      h.log('Done.')
      ctx.audit(serverId, 'web.install', id)
    })
    return taskId
  })

  // ---------------- service control ----------------
  ctx.handle('web:service', async (serverId: string, idRaw: string, actionRaw: string): Promise<WebTestResult | void> => {
    const id = assertServerId(idRaw)
    const action = assertAction(actionRaw)
    const ssh = ctx.ssh(serverId)
    const def = await resolveDef(ssh, id)
    ctx.audit(serverId, 'web.service', `${id} ${action}`)
    if (action === 'reload') return testAndReload(ssh, def)
    if (!ssh.os?.hasSystemd) {
      if (action === 'enable' || action === 'disable') throw new Error('Enabling on boot requires systemd')
      await rootRun(ssh, `(service ${shq(def.unit)} ${action} 2>/dev/null || rc-service ${shq(def.unit)} ${action})`)
      return
    }
    if (action === 'start' || action === 'restart') {
      const t = await runTest(ssh, def)
      if (!t.ok) throw new Error(`Configuration test failed – ${action} aborted:\n${t.output}`)
    }
    const r = await rootSh(ssh, `systemctl ${action} ${shq(def.unit)} 2>&1`, { timeoutMs: 120000 })
    if (r.code !== 0) {
      const st = await rootSh(ssh, `systemctl status ${shq(def.unit)} --no-pager -l 2>&1 | tail -n 15`)
      throw new Error(((r.stdout + r.stderr).trim() || `systemctl ${action} failed`) + '\n' + st.stdout.trim())
    }
  })

  ctx.handle('web:test', async (serverId: string, idRaw: string): Promise<WebTestResult> => {
    const id = assertServerId(idRaw)
    const ssh = ctx.ssh(serverId)
    return runTest(ssh, await resolveDef(ssh, id))
  })

  // ---------------- sites ----------------
  ctx.handle('web:sites', async (serverId: string, idRaw: string): Promise<WebSite[]> => {
    const id = assertServerId(idRaw)
    const ssh = ctx.ssh(serverId)
    return listSites(ssh, await resolveDef(ssh, id))
  })

  ctx.handle('web:siteRead', async (serverId: string, _idRaw: string, path: string): Promise<string> => {
    assertConfigPath(path)
    const ssh = ctx.ssh(serverId)
    const r = await rootSh(ssh, `cat ${shq(path)}`, { timeoutMs: 20000 })
    if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot read ${path}`)
    return r.stdout
  })

  ctx.handle('web:siteWrite', async (serverId: string, idRaw: string, path: string, content: string, reload = true): Promise<WebTestResult> => {
    const id = assertServerId(idRaw)
    assertConfigPath(path)
    if (typeof content !== 'string') throw new Error('Content must be a string')
    const ssh = ctx.ssh(serverId)
    const def = await resolveDef(ssh, id)
    const existed = (await rootSh(ssh, `[ -f ${shq(path)} ] && echo yes`)).stdout.includes('yes')
    if (existed) await rootRun(ssh, `cp -a ${shq(path)} ${shq(path + '.bak')}`)
    await rootRun(ssh, `mkdir -p "$(dirname ${shq(path)})" && ${b64Echo(content)} > ${shq(path)}`)
    const t = await runTest(ssh, def)
    if (!t.ok) {
      if (existed) await rootSh(ssh, `mv -f ${shq(path + '.bak')} ${shq(path)}`)
      else await rootSh(ssh, `rm -f ${shq(path)}`)
      throw new Error(`Configuration test failed – previous version restored:\n${t.output}`)
    }
    if (reload) await reloadService(ssh, def)
    ctx.audit(serverId, 'web.siteWrite', path)
    return t
  })

  ctx.handle('web:siteEnable', async (serverId: string, idRaw: string, nameRaw: string, enabled: boolean): Promise<WebTestResult> => {
    const id = assertServerId(idRaw)
    const name = assertSiteName(nameRaw)
    const ssh = ctx.ssh(serverId)
    const def = await resolveDef(ssh, id)
    if (!def.enabledDir || !def.sitesDir) throw new Error(`${def.name} on this system has no sites-enabled directory; edit or delete the file in ${def.sitesDir ?? def.configDir} instead.`)
    const avail = `${def.sitesDir}/${name}`
    const link = `${def.enabledDir}/${name}`
    const undo = enabled ? `rm -f ${shq(link)}` : `ln -sfn ${shq(avail)} ${shq(link)}`
    if (def.id === 'apache') {
      const site = name.replace(/\.conf$/, '')
      const cmd = enabled ? `a2ensite ${shq(site)}` : `a2dissite ${shq(site)}`
      const r = await rootSh(ssh, `if command -v a2ensite >/dev/null 2>&1; then ${cmd} 2>&1; else ${enabled ? `[ -f ${shq(avail)} ] && ln -sfn ${shq(avail)} ${shq(link)}` : `rm -f ${shq(link)}`}; fi`)
      if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim() || 'a2ensite/a2dissite failed')
    } else {
      if (enabled) await rootRun(ssh, `[ -f ${shq(avail)} ] || { echo "No such site file: ${avail}" >&2; exit 1; }; ln -sfn ${shq(avail)} ${shq(link)}`)
      else await rootRun(ssh, `rm -f ${shq(link)}`)
    }
    const t = await runTest(ssh, def)
    if (!t.ok) {
      await rootSh(ssh, undo)
      throw new Error(`Configuration test failed – change reverted:\n${t.output}`)
    }
    await reloadService(ssh, def)
    ctx.audit(serverId, 'web.siteEnable', `${id} ${name} ${enabled ? 'on' : 'off'}`)
    return t
  })

  ctx.handle('web:siteDelete', async (serverId: string, idRaw: string, nameRaw: string, pathRaw?: string): Promise<void> => {
    const id = assertServerId(idRaw)
    const name = assertSiteName(nameRaw)
    const ssh = ctx.ssh(serverId)
    const def = await resolveDef(ssh, id)
    const files: string[] = []
    if (pathRaw) files.push(assertConfigPath(pathRaw))
    if (def.sitesDir) files.push(`${def.sitesDir}/${name}`)
    if (def.enabledDir) files.push(`${def.enabledDir}/${name}`, `${def.enabledDir}/${name}.conf`, `${def.enabledDir}/${name.replace(/\.conf$/, '')}`)
    if (def.confD && def.id === 'nginx') files.push(`${def.confD}/${name}`)
    for (const f of files) assertConfigPath(f)
    const PROTECTED_BASE = /^(default|000-default\.conf|default-ssl\.conf|nginx\.conf|apache2\.conf|httpd\.conf|Caddyfile|lighttpd\.conf)$/
    if (uniq(files).some((f) => PROTECTED_BASE.test(f.split('/').pop() ?? ''))) throw new Error('Refusing to delete a default/main configuration file')
    await rootRun(ssh, `rm -f ${uniq(files).map(shq).join(' ')}`)
    const t = await runTest(ssh, def)
    if (t.ok) await reloadService(ssh, def).catch(() => {})
    ctx.audit(serverId, 'web.siteDelete', `${id} ${name}`)
    if (!t.ok) throw new Error(`Site removed, but the configuration test now fails (not reloaded):\n${t.output}`)
  })

  ctx.handle('web:siteCreate', async (serverId: string, idRaw: string, specRaw: WebSiteSpec): Promise<{ path: string; test: WebTestResult }> => {
    const id = assertServerId(idRaw)
    if (id !== 'nginx' && id !== 'apache') throw new Error(`Creating sites is supported for Nginx and Apache only`)
    if (!specRaw || typeof specRaw !== 'object') throw new Error('Missing site specification')
    const name = assertSiteName(specRaw.name)
    const domains = uniq((Array.isArray(specRaw.domains) ? specRaw.domains : []).map(assertDomain))
    if (!domains.length) throw new Error('At least one domain is required')
    const type = specRaw.type
    if (type !== 'static' && type !== 'proxy' && type !== 'php') throw new Error(`Invalid site type: ${String(type)}`)
    const spec: WebSiteSpec = { name, domains, type, http2: !!specRaw.http2 }
    if (type === 'proxy') spec.proxyTarget = assertProxyTarget(specRaw.proxyTarget ?? '')
    else {
      const root = String(specRaw.root ?? '').trim().replace(/\/+$/, '') || `/var/www/${domains[0]}`
      assertAbsPath(root)
      if (root.includes('/../') || root.endsWith('/..') || root === '/' || !/^[A-Za-z0-9_.\-/]+$/.test(root)) throw new Error(`Invalid web root: ${root}`)
      spec.root = root
    }
    const ssh = ctx.ssh(serverId)
    const def = await resolveDef(ssh, id)
    if (!def.sitesDir) throw new Error('Could not determine the sites directory')

    let phpSocket: string | undefined
    if (type === 'php') phpSocket = await resolvePhpSocket(ssh, specRaw.phpVersion)

    const fileName = def.id === 'apache' || !def.enabledDir ? `${name.replace(/\.conf$/, '')}.conf` : name
    const path = `${def.sitesDir}/${fileName}`
    assertConfigPath(path)
    const exists = (await rootSh(ssh, `[ -e ${shq(path)} ] && echo yes`)).stdout.includes('yes')
    if (exists) throw new Error(`A site file already exists: ${path}`)

    let nginxVersion = ''
    if (def.id === 'nginx') {
      const nv = await ssh.exec('nginx -v 2>&1', { timeoutMs: 15000 })
      nginxVersion = versionOf(nv.stdout + nv.stderr)
    }
    const content = def.id === 'nginx' ? nginxTemplate(spec, { logDir: def.logDir, phpSocket, nginxVersion }) : apacheTemplate(spec, { logDir: def.logDir, phpSocket })

    // Web root + placeholder
    if (spec.root) {
      const owner = `$(id -u www-data >/dev/null 2>&1 && echo www-data || (id -u nginx >/dev/null 2>&1 && echo nginx || (id -u apache >/dev/null 2>&1 && echo apache || echo root)))`
      await rootRun(ssh, 
        `created=0; if [ ! -d ${shq(spec.root)} ]; then mkdir -p ${shq(spec.root)} && created=1; fi; ` +
          (type === 'static' || type === 'php' ? `if [ ! -e ${shq(spec.root + '/index.html')} ] && [ ! -e ${shq(spec.root + '/index.php')} ]; then ${b64Echo(placeholderHtml(spec))} > ${shq(spec.root + '/index.html')}; fi; ` : '') +
          `if [ "$created" = 1 ]; then chown -R ${owner}:${owner} ${shq(spec.root)} 2>/dev/null || true; fi; chmod 755 ${shq(spec.root)} 2>/dev/null || true`
      )
    }

    // Apache modules (Debian)
    if (def.id === 'apache' && def.enabledDir) {
      const mods = ['headers']
      if (type === 'proxy') mods.push('proxy', 'proxy_http')
      if (type === 'php') mods.push('proxy', 'proxy_fcgi', 'setenvif')
      if (spec.http2) mods.push('http2')
      await rootSh(ssh, `command -v a2enmod >/dev/null 2>&1 && a2enmod -q ${mods.join(' ')} 2>&1 || true`)
    }

    await rootRun(ssh, `${b64Echo(content)} > ${shq(path)} && chmod 644 ${shq(path)}`)
    const cleanup = async (): Promise<void> => {
      await rootSh(ssh, `rm -f ${shq(path)}${def.enabledDir ? ` ${shq(`${def.enabledDir}/${fileName}`)}` : ''}`)
    }
    if (def.enabledDir) {
      if (def.id === 'apache') {
        const r = await rootSh(ssh, `if command -v a2ensite >/dev/null 2>&1; then a2ensite -q ${shq(fileName.replace(/\.conf$/, ''))} 2>&1; else ln -sfn ${shq(path)} ${shq(`${def.enabledDir}/${fileName}`)}; fi`)
        if (r.code !== 0) {
          await cleanup()
          throw new Error((r.stdout + r.stderr).trim() || 'a2ensite failed')
        }
      } else await rootRun(ssh, `ln -sfn ${shq(path)} ${shq(`${def.enabledDir}/${fileName}`)}`)
    }
    const t = await runTest(ssh, def)
    if (!t.ok) {
      await cleanup()
      throw new Error(`Generated configuration failed the test – site not created:\n${t.output}`)
    }
    await reloadService(ssh, def)
    ctx.audit(serverId, 'web.siteCreate', `${id} ${name} (${type}) ${domains.join(' ')}`)
    return { path, test: t }
  })

  // ---------------- PHP-FPM ----------------
  ctx.handle('web:phpFpm', async (serverId: string): Promise<PhpFpmInfo> => {
    const ssh = ctx.ssh(serverId)
    const script = `
echo __UNITS
systemctl list-units --all --plain --no-legend --no-pager 'php*fpm*' 2>/dev/null
echo __ENABLED
systemctl list-unit-files --plain --no-legend --no-pager 'php*fpm*' 2>/dev/null
echo __SOCKS
ls -1 /run/php/*.sock /run/php-fpm/*.sock /var/run/php/*.sock 2>/dev/null
echo __PHP
php -v 2>/dev/null | head -1
echo __END`
    const r = await rootSh(ssh, script, { timeoutMs: 30000 }).catch(() => ssh.exec(script, { timeoutMs: 30000 }))
    const sec = sections(r.stdout)
    const enabledMap: Record<string, string> = {}
    for (const l of sec.ENABLED ?? []) {
      const f = l.trim().split(/\s+/)
      if (f[0]) enabledMap[f[0]] = f[1] ?? ''
    }
    const units: PhpFpmUnit[] = []
    for (const l of sec.UNITS ?? []) {
      const f = l.trim().split(/\s+/)
      if (!f[0] || !f[0].endsWith('.service')) continue
      const unit = f[0]
      const ver = unit.match(/(\d+\.\d+)/)?.[1]
      units.push({ unit, version: ver, active: f[2] === 'active', enabled: enabledMap[unit] === 'enabled' })
    }
    const sockets = uniq((sec.SOCKS ?? []).map((l) => l.trim()).filter(Boolean))
    const phpVersion = versionOf((sec.PHP ?? [])[0] ?? '') || undefined
    return { units, sockets, phpVersion }
  })

  // ---------------- SSL ----------------
  ctx.handle('web:ssl:status', async (serverId: string): Promise<SslStatus> => sslStatus(ctx.ssh(serverId)))

  ctx.handle('web:ssl:install', async (serverId: string, idRaw?: string) => {
    const ssh = ctx.ssh(serverId)
    const id = idRaw ? assertServerId(idRaw) : undefined
    const pm = ssh.os?.pkgManager
    const { id: taskId } = ctx.tasks.start('Install certbot', serverId, async (h) => {
      const plugins: string[] = []
      if (id === 'nginx' || !id) plugins.push('python3-certbot-nginx')
      if (id === 'apache' || !id) plugins.push('python3-certbot-apache')
      let ok = false
      if (pm === 'apt' || pm === 'dnf' || pm === 'yum') {
        if (pm !== 'apt') {
          h.log('Enabling EPEL (certbot lives there on RHEL-family systems)…')
          await rootSh(ssh, `${pm} install -y epel-release 2>&1 || true`, { timeoutMs: 600000, env: pkgEnv(), ...taskStream(h) })
        }
        h.log(`Installing certbot ${plugins.join(' ')}…`)
        const r = await rootSh(ssh, installCmd(ssh, ['certbot', ...plugins]), { timeoutMs: 1800000, env: pkgEnv(), ...taskStream(h) })
        ok = r.code === 0
        if (!ok) h.log('Package installation failed – trying snap…')
      } else if (pm === 'zypper' || pm === 'apk' || pm === 'pacman') {
        const pkgs = pm === 'apk' ? ['certbot', ...(id !== 'apache' ? ['certbot-nginx'] : []), ...(id !== 'nginx' ? ['certbot-apache'] : [])] : pm === 'pacman' ? ['certbot', ...(id !== 'apache' ? ['certbot-nginx'] : []), ...(id !== 'nginx' ? ['certbot-apache'] : [])] : ['certbot', ...plugins]
        h.log(`Installing ${pkgs.join(' ')}…`)
        const r = await rootSh(ssh, installCmd(ssh, pkgs), { timeoutMs: 1800000, env: pkgEnv(), ...taskStream(h) })
        ok = r.code === 0
      }
      if (!ok) {
        const snap = await ssh.exec('command -v snap >/dev/null 2>&1 && echo yes')
        if (!snap.stdout.includes('yes')) throw new Error('Could not install certbot from packages and snap is not available. Install certbot manually (https://certbot.eff.org/instructions).')
        h.log('Installing certbot via snap (includes nginx/apache plugins)…')
        await rootRun(ssh, 'snap install core 2>&1; snap refresh core 2>&1; snap install --classic certbot 2>&1 && ln -sf /snap/bin/certbot /usr/bin/certbot', { timeoutMs: 1800000, ...taskStream(h) })
      }
      const v = await ssh.exec('certbot --version 2>&1 | head -1')
      h.log(`Installed: ${v.stdout.trim() || v.stderr.trim()}`)
      ctx.audit(serverId, 'web.ssl.install')
    })
    return taskId
  })

  ctx.handle('web:ssl:obtain', async (serverId: string, idRaw: string, domainsRaw: string[], emailRaw: string, redirect: boolean) => {
    const id = assertServerId(idRaw)
    if (id === 'caddy') throw new Error('Caddy obtains and renews certificates automatically – nothing to do.')
    if (id !== 'nginx' && id !== 'apache') throw new Error(`certbot integration is available for Nginx and Apache only`)
    const domains = uniq((Array.isArray(domainsRaw) ? domainsRaw : []).map(assertDomain))
    if (!domains.length) throw new Error('At least one domain is required')
    const email = assertEmail(emailRaw)
    const ssh = ctx.ssh(serverId)
    const plugin = id === 'nginx' ? '--nginx' : '--apache'
    const cmd = `certbot ${plugin} ${domains.map((d) => `-d ${shq(d)}`).join(' ')} --non-interactive --agree-tos -m ${shq(email)} ${redirect ? '--redirect' : '--no-redirect'} --keep-until-expiring`
    const { id: taskId } = ctx.tasks.start(`Obtain certificate for ${domains[0]}${domains.length > 1 ? ` (+${domains.length - 1})` : ''}`, serverId, async (h) => {
      const has = await ssh.exec('command -v certbot >/dev/null 2>&1 && echo yes')
      if (!has.stdout.includes('yes')) throw new Error('certbot is not installed')
      h.log(`> ${cmd}`)
      await rootRun(ssh, cmd, { timeoutMs: 600000, ...taskStream(h) })
      h.log('\nCertificate obtained. The web server configuration was updated by certbot.')
      ctx.audit(serverId, 'web.ssl.obtain', domains.join(' '))
    })
    return taskId
  })

  ctx.handle('web:ssl:renew', async (serverId: string, dryRun?: boolean) => {
    const ssh = ctx.ssh(serverId)
    const { id: taskId } = ctx.tasks.start(dryRun ? 'Test certificate renewal (dry run)' : 'Renew certificates', serverId, async (h) => {
      await rootRun(ssh, `certbot renew ${dryRun ? '--dry-run ' : ''}--non-interactive 2>&1`, { timeoutMs: 900000, ...taskStream(h) })
      ctx.audit(serverId, 'web.ssl.renew', dryRun ? 'dry-run' : undefined)
    })
    return taskId
  })

  // ---------------- logs ----------------
  ctx.handle('web:logs', async (serverId: string, idRaw: string, kindRaw: string, linesRaw: number, siteRaw?: string): Promise<WebLogResult> => {
    const id = assertServerId(idRaw)
    const kind = kindRaw === 'error' ? 'error' : 'access'
    const lines = clampLines(linesRaw)
    const site = siteRaw ? assertSiteName(siteRaw) : undefined
    const ssh = ctx.ssh(serverId)
    const def = await resolveDef(ssh, id)
    if (def.id === 'caddy') {
      const r = await rootSh(ssh, `journalctl -u caddy -n ${lines} --no-pager -o short-iso ${kind === 'error' ? '-p warning' : ''} 2>&1`, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
      return { path: 'journalctl -u caddy', content: r.stdout }
    }
    const cands = logCandidates(def, kind, site)
    const script = `for f in ${cands.map(shq).join(' ')}; do if [ -f "$f" ]; then echo "__PATH $f"; tail -n ${lines} "$f"; exit 0; fi; done; echo "__NOFILE"`
    const r = await rootSh(ssh, script, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
    if (r.stdout.startsWith('__NOFILE')) {
      if (ssh.os?.hasSystemd) {
        const j = await rootSh(ssh, `journalctl -u ${shq(def.unit)} -n ${lines} --no-pager -o short-iso 2>&1`, { timeoutMs: 60000 })
        return { path: `journalctl -u ${def.unit} (no log file found: ${cands[cands.length - 1]})`, content: j.stdout }
      }
      return { path: cands[cands.length - 1], content: '' }
    }
    const nl = r.stdout.indexOf('\n')
    const path = r.stdout.slice(7, nl < 0 ? undefined : nl).trim()
    return { path, content: nl < 0 ? '' : r.stdout.slice(nl + 1) }
  })

  ctx.handle('web:logs:summary', async (serverId: string, idRaw: string, siteRaw?: string): Promise<WebLogSummary> => {
    const id = assertServerId(idRaw)
    const site = siteRaw ? assertSiteName(siteRaw) : undefined
    const ssh = ctx.ssh(serverId)
    const def = await resolveDef(ssh, id)
    if (def.id === 'caddy') throw new Error('Access-log statistics are not available for Caddy (logs go to the journal in JSON format)')
    const cands = logCandidates(def, 'access', site)
    const script = `
F=""; for f in ${cands.map(shq).join(' ')}; do if [ -f "$f" ]; then F="$f"; break; fi; done
[ -n "$F" ] || { echo "__NOFILE"; exit 0; }
T=$(mktemp /tmp/.sm_web.XXXXXX) || exit 1
tail -n 5000 "$F" > "$T"
echo "__PATH $F"
echo __COUNT; wc -l < "$T"
echo __BYTES; awk '{ if ($10 ~ /^[0-9]+$/) s+=$10 } END { print s+0 }' "$T"
echo __PATHS; awk '{ p=$7; if (p=="") next; print p }' "$T" | sort | uniq -c | sort -rn | head -10
echo __IPS; awk '{ print $1 }' "$T" | sort | uniq -c | sort -rn | head -10
echo __STATUS; awk '{ if ($9 ~ /^[0-9][0-9][0-9]$/) print $9 }' "$T" | sort | uniq -c | sort -rn
rm -f "$T"
echo __END`
    const r = await rootSh(ssh, script, { timeoutMs: 120000 })
    if (r.stdout.startsWith('__NOFILE')) throw new Error(`No access log found (${cands[cands.length - 1]})`)
    const sec = sections(r.stdout)
    const pathKey = Object.keys(sec).find((k) => k.startsWith('PATH '))
    return {
      path: pathKey ? pathKey.slice(5) : def.accessLog,
      requests: Number((sec.COUNT ?? [])[0]) || 0,
      bytes: Number((sec.BYTES ?? [])[0]) || 0,
      topPaths: parseCountLines(sec.PATHS ?? []),
      topIps: parseCountLines(sec.IPS ?? []),
      statuses: parseCountLines(sec.STATUS ?? [])
    }
  })
}
