import type { Ctx } from '../core'
import type { SshClient, ExecOptions } from '../ssh/SshClient'
import type { TaskHandle } from '../tasks/TaskManager'
import { assertSafeName, b64Echo, shq } from '../ssh/shell'
import { installCmd, pkgEnv, removeCmd, runPkg } from './pkg'
import type {
  BunStatus,
  GoAvailableVersion,
  GoStatus,
  LoginUser,
  NodeAvailableVersion,
  NodeStatus,
  PhpFpmAction,
  PhpSettingKey,
  PhpSettings,
  PhpSettingsTarget,
  PhpStatus,
  PhpVersionInfo,
  PipxPackage,
  PythonStatus,
  PythonTool
} from '@shared/modules/runtimes'
import { PHP_SETTING_KEYS } from '@shared/modules/runtimes'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const NODE_ROOT = '/opt/centralserver/node'
const BUN_ROOT = '/opt/centralserver/bun'
const GO_ROOT = '/opt/centralserver/go'
const SHIM_MARK = 'Central Server node shim'
const NVM_FALLBACK = 'v0.40.3'
const DL_TIMEOUT = 1800000

const NODE_STATIC: { version: string; lts: string | false; date: string }[] = [
  { version: '24.11.1', lts: 'Krypton', date: '' },
  { version: '24.10.0', lts: 'Krypton', date: '' },
  { version: '22.21.1', lts: 'Jod', date: '' },
  { version: '22.20.0', lts: 'Jod', date: '' },
  { version: '22.12.0', lts: 'Jod', date: '' },
  { version: '20.19.5', lts: 'Iron', date: '' },
  { version: '20.18.3', lts: 'Iron', date: '' },
  { version: '18.20.8', lts: 'Hydrogen', date: '' }
]
const GO_STATIC = ['1.25.4', '1.25.3', '1.24.10', '1.24.9', '1.23.12']

const PHP_EXTENSIONS = ['mysql', 'pgsql', 'sqlite3', 'mbstring', 'xml', 'curl', 'zip', 'gd', 'intl', 'bcmath', 'redis', 'imagick', 'opcache', 'soap', 'xdebug', 'apcu', 'ldap', 'imap', 'readline', 'mongodb']
const PHP_VERSIONS_DEB = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']
const PHP_VERSIONS_RHEL = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function assertSemver(v: string, what = 'version'): string {
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Invalid ${what}: ${v}`)
  return v
}

function assertGoVersion(v: string): string {
  if (typeof v !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(v)) throw new Error(`Invalid Go version: ${v}`)
  return v
}

function assertPhpVersion(v: string): string {
  if (typeof v !== 'string' || !/^\d+\.\d+$/.test(v)) throw new Error(`Invalid PHP version: ${v}`)
  return v
}

const NPM_SPEC_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[A-Za-z0-9-.^~<>=|* ]+)?$/
function assertNpmSpec(s: string): string {
  if (typeof s !== 'string' || s.length > 214 || !NPM_SPEC_RE.test(s)) throw new Error(`Invalid npm package: ${s}`)
  return s
}
function assertNpmName(s: string): string {
  if (typeof s !== 'string' || s.length > 214 || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(s)) throw new Error(`Invalid npm package name: ${s}`)
  return s
}
function assertPyPkg(s: string): string {
  if (typeof s !== 'string' || s.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9_,.-]+\])?([=<>!~]=?[A-Za-z0-9.*]+(,[=<>!~]=?[A-Za-z0-9.*]+)*)?$/.test(s)) throw new Error(`Invalid Python package: ${s}`)
  return s
}
function assertExt(s: string): string {
  if (typeof s !== 'string' || !/^[a-z0-9_]{1,40}$/.test(s)) throw new Error(`Invalid extension name: ${s}`)
  return s
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function stream(h: TaskHandle, timeoutMs = DL_TIMEOUT): ExecOptions {
  return { signal: h.signal, timeoutMs, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) }
}

/** Split "__NAME" delimited script output into sections. */
function sections(stdout: string): Record<string, string[]> {
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of stdout.split('\n')) {
    const m = line.match(/^__([A-Z0-9]+)$/)
    if (m) {
      cur = m[1]
      sec[cur] = []
    } else if (cur) sec[cur].push(line)
  }
  return sec
}
const nonEmpty = (a: string[] | undefined): string[] => (a ?? []).map((l) => l.trim()).filter(Boolean)

/** Run a read-only script as root when possible (falls back to the login user). */
async function execRead(ssh: SshClient, script: string, timeoutMs = 60000): Promise<string> {
  if (ssh.os?.sudoAvailable) {
    try {
      const r = await ssh.sudo(script, { timeoutMs })
      if (r.code === 0 || r.stdout) return r.stdout
    } catch {
      /* fall through */
    }
  }
  const r = await ssh.exec(script, { timeoutMs })
  return r.stdout
}

async function writeRootFile(ssh: SshClient, path: string, content: string, mode = '644'): Promise<void> {
  await ssh.sudoRun(`mkdir -p "$(dirname ${shq(path)})" && ${b64Echo(content)} > ${shq(path)} && chmod ${mode} ${shq(path)}`)
}

/** Download JSON from a URL on the server with curl. Returns null on any failure. */
async function curlJson<T>(ssh: SshClient, url: string, timeoutMs = 30000): Promise<T | null> {
  try {
    const r = await ssh.exec(`curl -fsSL --max-time 25 ${shq(url)}`, { timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    if (r.code !== 0 || !r.stdout.trim()) return null
    return JSON.parse(r.stdout) as T
  } catch {
    return null
  }
}

async function hasCommand(ssh: SshClient, bin: string): Promise<boolean> {
  const r = await ssh.exec(`command -v ${shq(bin)} >/dev/null 2>&1 && echo yes`)
  return r.stdout.includes('yes')
}

/** Make sure the given command-line tools exist, installing distro packages when missing. */
async function ensureTools(ssh: SshClient, h: TaskHandle, bins: string[]): Promise<void> {
  const pm = ssh.os?.pkgManager ?? 'unknown'
  const r = await ssh.exec(`for b in ${bins.map(shq).join(' ')}; do command -v "$b" >/dev/null 2>&1 || echo "$b"; done`)
  const missing = nonEmpty(r.stdout.split('\n'))
  if (!missing.length) return
  const pkgFor = (b: string): string | null => {
    switch (b) {
      case 'curl':
        return 'curl'
      case 'tar':
        return 'tar'
      case 'unzip':
        return 'unzip'
      case 'git':
        return 'git'
      case 'bash':
        return 'bash'
      case 'ca-certificates':
        return 'ca-certificates'
      case 'xz':
        return pm === 'apt' ? 'xz-utils' : 'xz'
      case 'gpg':
        return pm === 'apt' ? 'gnupg' : 'gnupg2'
      default:
        return null
    }
  }
  const pkgs = [...new Set(missing.map(pkgFor).filter((p): p is string => !!p))]
  if (!pkgs.length) throw new Error(`Missing tools on the server: ${missing.join(', ')}`)
  if (pm === 'unknown') throw new Error(`Missing tools on the server (${missing.join(', ')}) and no supported package manager to install them`)
  h.log(`Installing required tools: ${pkgs.join(', ')}…`)
  await runPkg(ssh, installCmd(ssh, pkgs), stream(h))
}

function parseUsers(lines: string[]): LoginUser[] {
  const out: LoginUser[] = []
  for (const l of nonEmpty(lines)) {
    const [name, home, shell] = l.split(':')
    if (name && /^[A-Za-z0-9][A-Za-z0-9_.@\-]*$/.test(name)) out.push({ name, home: home ?? '', shell: shell ?? '' })
  }
  return out.sort((a, b) => (a.name === 'root' ? -1 : b.name === 'root' ? 1 : a.name.localeCompare(b.name)))
}
const USERS_AWK = `getent passwd | awk -F: '(($3>=1000 && $3<65534) || $1=="root") {print $1":"$6":"$7}'`

function nodeArch(ssh: SshClient): 'x64' | 'arm64' {
  const a = ssh.os?.arch ?? ''
  if (a === 'x86_64' || a === 'amd64') return 'x64'
  if (a === 'aarch64' || a === 'arm64') return 'arm64'
  throw new Error(`Unsupported CPU architecture for official binaries: ${a || 'unknown'}`)
}
function goArch(ssh: SshClient): 'amd64' | 'arm64' {
  return nodeArch(ssh) === 'x64' ? 'amd64' : 'arm64'
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

async function verifyUser(ssh: SshClient, user: string): Promise<LoginUser> {
  assertSafeName(user, 'user')
  const r = await ssh.exec(`getent passwd ${shq(user)}`)
  const f = r.stdout.trim().split(':')
  if (r.code !== 0 || f.length < 7) throw new Error(`User ${user} does not exist`)
  return { name: f[0], home: f[5], shell: f[6] }
}

/* ------------------------------------------------------------------ */
/* Node.js shim                                                        */
/* ------------------------------------------------------------------ */

function nodeShim(): string {
  return `#!/bin/sh
# ${SHIM_MARK} - managed by Central Server, do not edit.
# Runs the Node.js version a project asks for in .nvmrc or .node-version (in the
# current folder or above), or in $CENTRALSERVER_NODE_VERSION, or the default version
# from ${NODE_ROOT}/default. Global npm packages live in /usr/local.
ROOT=${NODE_ROOT}
name=$(basename "$0")
want=""
src=""
dir="\${PWD:-/}"
while [ -n "$dir" ]; do
  for f in .nvmrc .node-version; do
    if [ -f "$dir/$f" ]; then
      want=$(head -n1 "$dir/$f" | tr -d ' \\t\\r')
      src="$dir/$f"
      break 2
    fi
  done
  [ "$dir" = "/" ] && break
  dir=$(dirname "$dir")
done
if [ -z "$want" ] && [ -n "$CENTRALSERVER_NODE_VERSION" ]; then
  want="$CENTRALSERVER_NODE_VERSION"
  src="CENTRALSERVER_NODE_VERSION"
fi
want=$(printf %s "$want" | sed 's/^v//')
case "$want" in
  lts/*|lts|node|latest|stable|current|system|default) want="" ;;
esac
installed() { ls -1 "$ROOT" 2>/dev/null | grep -E '^[0-9]+(\\.[0-9]+)*$' | sort -t. -k1,1n -k2,2n -k3,3n; }
ver=""
if [ -n "$want" ]; then
  case "$want" in
    *[!0-9.]*) echo "centralserver: invalid Node.js version '$want' requested by $src" >&2; exit 127 ;;
  esac
  if [ -x "$ROOT/$want/bin/node" ]; then
    ver="$want"
  else
    pat=$(printf %s "$want" | sed 's/\\./\\\\./g')
    ver=$(installed | grep -E "^$pat(\\.[0-9]+)*$" | tail -n1)
  fi
  if [ -z "$ver" ]; then
    echo "centralserver: Node.js $want (requested by $src) is not installed. Installed versions: $(installed | tr '\\n' ' ')" >&2
    echo "centralserver: install it in Central Server > Runtimes > Node.js, or change $src." >&2
    exit 127
  fi
else
  ver=$(basename "$(readlink "$ROOT/default" 2>/dev/null)" 2>/dev/null)
  if [ -z "$ver" ] || [ ! -x "$ROOT/$ver/bin/node" ]; then
    echo "centralserver: no default Node.js version is set. Installed versions: $(installed | tr '\\n' ' ')" >&2
    echo "centralserver: pick a default in Central Server > Runtimes > Node.js, or set CENTRALSERVER_NODE_VERSION." >&2
    exit 127
  fi
fi
bin="$ROOT/$ver/bin/$name"
if [ ! -x "$bin" ]; then
  echo "centralserver: $name is not part of Node.js $ver" >&2
  exit 127
fi
case "$name" in
  npm|npx|corepack) export NPM_CONFIG_PREFIX="\${NPM_CONFIG_PREFIX:-/usr/local}" ;;
esac
exec "$bin" "$@"
`
}

async function installNodeShim(ssh: SshClient, h?: TaskHandle): Promise<void> {
  h?.log('Installing node/npm/npx/corepack shim in /usr/local/bin…')
  // Move aside any real binaries we would otherwise overwrite.
  const pre = `mkdir -p /usr/local/bin; for n in node npm npx corepack; do p=/usr/local/bin/$n; if [ -e "$p" ] && ! grep -q ${shq(SHIM_MARK)} "$p" 2>/dev/null; then if [ -L "$p" ]; then t=$(readlink "$p"); case "$t" in node|/usr/local/bin/node) continue;; esac; fi; mv -f "$p" "$p.pre-centralserver" && echo "moved $p to $p.pre-centralserver"; fi; done`
  const moved = await ssh.sudoRun(pre)
  if (moved.trim() && h) h.log(moved.trim())
  await writeRootFile(ssh, '/usr/local/bin/node', nodeShim(), '755')
  await ssh.sudoRun(`cd /usr/local/bin && for n in npm npx corepack; do ln -sfn node $n; done`)
  // Shared global prefix for npm (also enforced by the shim through NPM_CONFIG_PREFIX).
  await ssh.sudoRun(`if [ -f /etc/npmrc ] && grep -qE '^prefix=' /etc/npmrc; then sed -i -E 's|^prefix=.*|prefix=/usr/local|' /etc/npmrc; else echo 'prefix=/usr/local' >> /etc/npmrc; fi`)
}

/* ------------------------------------------------------------------ */
/* Node.js                                                             */
/* ------------------------------------------------------------------ */

interface NodeDistEntry {
  version: string
  date: string
  lts: string | false
  files?: string[]
}

function buildNodeAvailable(entries: { version: string; lts: string | false; date: string }[], installed: Set<string>): NodeAvailableVersion[] {
  const clean = entries.map((e) => ({ ...e, version: e.version.replace(/^v/, '') })).filter((e) => /^\d+\.\d+\.\d+$/.test(e.version))
  clean.sort((a, b) => cmpVersion(b.version, a.version))
  const major = (v: string): number => Number(v.split('.')[0])
  const newestMajor = clean.length ? major(clean[0].version) : 0
  const ltsMajors = [...new Set(clean.filter((e) => e.lts).map((e) => major(e.version)))].sort((a, b) => b - a)
  const activeLts = ltsMajors[0]
  const picked: typeof clean = clean.slice(0, 40)
  for (const m of ltsMajors) {
    if (!picked.some((e) => major(e.version) === m)) {
      const newest = clean.find((e) => major(e.version) === m)
      if (newest) picked.push(newest)
    }
  }
  // Only versions with an LTS line or a major >= 16 are worth listing.
  return picked
    .filter((e) => e.lts || major(e.version) >= 16)
    .map((e) => {
      const m = major(e.version)
      const label = e.lts ? (m === activeLts ? 'Active LTS' : 'Maintenance LTS') : m === newestMajor ? 'Current' : ''
      return { version: e.version, lts: e.lts, date: e.date, label, installed: installed.has(e.version) }
    })
}

async function nodeStatus(ssh: SshClient): Promise<NodeStatus> {
  const arch = (() => {
    try {
      return nodeArch(ssh)
    } catch {
      return 'unsupported'
    }
  })()
  const script = `
echo __MANAGED
for d in ${NODE_ROOT}/*/; do [ -d "$d" ] || continue; v=$(basename "$d"); case "$v" in default|*.tmp) continue;; esac; [ -x "$d/bin/node" ] && echo "$v"; done
echo __DEFAULT
readlink ${NODE_ROOT}/default 2>/dev/null
echo __SHIM
grep -q ${shq(SHIM_MARK)} /usr/local/bin/node 2>/dev/null && echo yes
echo __CURL
command -v curl >/dev/null 2>&1 && echo yes
echo __OTHERS
for p in /usr/bin/node /usr/local/bin/node /snap/bin/node /usr/local/node/bin/node /opt/node/bin/node /usr/bin/nodejs; do
  [ -x "$p" ] || continue
  grep -q ${shq(SHIM_MARK)} "$p" 2>/dev/null && continue
  rp=$(readlink -f "$p" 2>/dev/null); case "$rp" in /opt/centralserver/*) continue;; esac
  echo "$p $("$p" --version 2>/dev/null | head -n1)"
done
echo __GLOBALS
d=$(readlink ${NODE_ROOT}/default 2>/dev/null); if [ -n "$d" ] && [ -x "$d/bin/npm" ]; then NPM_CONFIG_PREFIX=/usr/local PATH="$d/bin:$PATH" "$d/bin/npm" ls -g --depth=0 --json 2>/dev/null; fi
echo __USERS
${USERS_AWK}
echo __NVM
${USERS_AWK} | while IFS=: read -r u hm sh; do [ -f "$hm/.nvm/nvm.sh" ] || continue; v=$(grep -oE "nvm_echo ['\\"][0-9]+\\.[0-9]+\\.[0-9]+['\\"]" "$hm/.nvm/nvm.sh" 2>/dev/null | head -n1 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+'); echo "$u \${v:-installed}"; done
echo __END`
  const out = await execRead(ssh, script)
  const sec = sections(out)
  const managed = nonEmpty(sec.MANAGED).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => cmpVersion(b, a))
  const def = (sec.DEFAULT?.[0] ?? '').trim().split('/').filter(Boolean).pop()
  const defaultVersion = def && managed.includes(def) ? def : undefined
  const others = nonEmpty(sec.OTHERS).map((l) => {
    const [path, ...rest] = l.split(/\s+/)
    return { path, version: rest.join(' ').replace(/^v/, '') || 'unknown' }
  })
  let globals: NodeStatus['globals'] = []
  const gjson = (sec.GLOBALS ?? []).join('\n').trim()
  if (gjson.startsWith('{')) {
    try {
      const parsed = JSON.parse(gjson) as { dependencies?: Record<string, { version?: string }> }
      globals = Object.entries(parsed.dependencies ?? {})
        .filter(([name]) => name !== 'npm' && name !== 'corepack')
        .map(([name, v]) => ({ name, version: v?.version ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      globals = []
    }
  }
  const users = parseUsers(sec.USERS ?? [])
  const nvmUsers = nonEmpty(sec.NVM).map((l) => {
    const [user, ...v] = l.split(/\s+/)
    return { user, nvmVersion: v.join(' ') || 'installed' }
  })
  const curlInstalled = (sec.CURL?.[0] ?? '').includes('yes')
  const installed = new Set(managed)
  let available: NodeAvailableVersion[] = []
  let availableLive = false
  if (curlInstalled) {
    const dist = await curlJson<NodeDistEntry[]>(ssh, 'https://nodejs.org/dist/index.json')
    if (Array.isArray(dist) && dist.length) {
      const archTag = `linux-${arch}`
      available = buildNodeAvailable(
        dist.filter((e) => !e.files || arch === 'unsupported' || e.files.includes(archTag)),
        installed
      )
      availableLive = true
    }
  }
  if (!available.length) available = buildNodeAvailable(NODE_STATIC, installed)
  return {
    arch,
    versions: managed.map((v) => ({ version: v, path: `${NODE_ROOT}/${v}`, default: v === defaultVersion })),
    defaultVersion,
    others,
    available,
    availableLive,
    globals,
    shimInstalled: (sec.SHIM?.[0] ?? '').includes('yes'),
    nvmUsers,
    users,
    curlInstalled
  }
}

function registerNode(ctx: Ctx): void {
  ctx.handle('rt:node:status', async (serverId: string): Promise<NodeStatus> => nodeStatus(ctx.ssh(serverId)))

  ctx.handle('rt:node:install', async (serverId: string, versionRaw: string) => {
    const v = assertSemver(versionRaw, 'Node.js version')
    const ssh = ctx.ssh(serverId)
    const arch = nodeArch(ssh)
    const { id } = ctx.tasks.start(`Install Node.js ${v}`, serverId, async (h) => {
      await ensureTools(ssh, h, ['curl', 'tar', 'xz'])
      const file = `node-v${v}-linux-${arch}.tar.xz`
      const base = `https://nodejs.org/dist/v${v}`
      const tmp = `/tmp/centralserver-node-${v}`
      h.log(`Downloading ${base}/${file}…`)
      await ssh.sudoRun(`rm -rf ${tmp} && mkdir -p ${tmp} ${NODE_ROOT} && cd ${tmp} && curl -fSL --retry 3 -o ${file} ${base}/${file} && curl -fsSL --retry 3 -o SHASUMS256.txt ${base}/SHASUMS256.txt`, stream(h))
      h.log('Verifying SHA-256 checksum…')
      await ssh.sudoRun(`cd ${tmp} && grep -E ' ${file.replace(/\./g, '\\.')}$' SHASUMS256.txt | sha256sum -c -`, stream(h, 120000))
      h.log(`Extracting to ${NODE_ROOT}/${v}…`)
      await ssh.sudoRun(
        `rm -rf ${NODE_ROOT}/${v}.tmp && mkdir -p ${NODE_ROOT}/${v}.tmp && tar -xJf ${tmp}/${file} -C ${NODE_ROOT}/${v}.tmp --strip-components=1 && rm -rf ${NODE_ROOT}/${v} && mv ${NODE_ROOT}/${v}.tmp ${NODE_ROOT}/${v} && rm -rf ${tmp} && mkdir -p ${NODE_ROOT}/${v}/etc && echo prefix=/usr/local > ${NODE_ROOT}/${v}/etc/npmrc`,
        stream(h, 600000)
      )
      const hasDefault = await ssh.exec(`d=$(readlink ${NODE_ROOT}/default 2>/dev/null); [ -n "$d" ] && [ -x "$d/bin/node" ] && echo yes`)
      if (!hasDefault.stdout.includes('yes')) {
        h.log(`Setting ${v} as the default version…`)
        await ssh.sudoRun(`ln -sfn ${NODE_ROOT}/${v} ${NODE_ROOT}/default`)
      }
      await installNodeShim(ssh, h)
      const check = await ssh.exec(`${NODE_ROOT}/${v}/bin/node --version 2>&1`)
      h.log(`Installed Node.js ${check.stdout.trim()} (npm ${(await ssh.exec(`${NODE_ROOT}/${v}/bin/npm --version 2>/dev/null`)).stdout.trim()}).`)
      ctx.audit(serverId, 'runtimes.node.install', v)
    })
    return id
  })

  ctx.handle('rt:node:remove', async (serverId: string, versionRaw: string) => {
    const v = assertSemver(versionRaw, 'Node.js version')
    const ssh = ctx.ssh(serverId)
    await ssh.sudoRun(
      `[ -d ${NODE_ROOT}/${v} ] || { echo "Version ${v} is not installed" >&2; exit 1; }; rm -rf ${NODE_ROOT}/${v}; d=$(basename "$(readlink ${NODE_ROOT}/default 2>/dev/null)" 2>/dev/null); if [ "$d" = ${shq(v)} ]; then rm -f ${NODE_ROOT}/default; n=$(ls -1 ${NODE_ROOT} 2>/dev/null | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1); [ -n "$n" ] && ln -sfn ${NODE_ROOT}/$n ${NODE_ROOT}/default; fi`
    )
    ctx.audit(serverId, 'runtimes.node.remove', v)
  })

  ctx.handle('rt:node:setDefault', async (serverId: string, versionRaw: string) => {
    const v = assertSemver(versionRaw, 'Node.js version')
    const ssh = ctx.ssh(serverId)
    await ssh.sudoRun(`[ -x ${NODE_ROOT}/${v}/bin/node ] || { echo "Version ${v} is not installed" >&2; exit 1; }; ln -sfn ${NODE_ROOT}/${v} ${NODE_ROOT}/default`)
    await installNodeShim(ssh)
    ctx.audit(serverId, 'runtimes.node.default', v)
  })

  ctx.handle('rt:node:installShim', async (serverId: string) => {
    await installNodeShim(ctx.ssh(serverId))
    ctx.audit(serverId, 'runtimes.node.shim')
  })

  ctx.handle('rt:node:globalInstall', async (serverId: string, specRaw: string) => {
    const spec = assertNpmSpec(String(specRaw ?? '').trim())
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start(`npm install -g ${spec}`, serverId, async (h) => {
      const d = await ssh.exec(`d=$(readlink ${NODE_ROOT}/default 2>/dev/null); [ -n "$d" ] && [ -x "$d/bin/npm" ] && echo "$d"`)
      const dir = d.stdout.trim()
      if (!dir) throw new Error('No default Node.js version is set. Install a version first.')
      await ssh.sudoRun(`${dir}/bin/npm install -g ${shq(spec)}`, { ...stream(h, 1200000), env: { NPM_CONFIG_PREFIX: '/usr/local', PATH: `${dir}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` } })
      h.log('Done.')
      ctx.audit(serverId, 'runtimes.node.global.install', spec)
    })
    return id
  })

  ctx.handle('rt:node:globalRemove', async (serverId: string, nameRaw: string) => {
    const name = assertNpmName(String(nameRaw ?? '').trim())
    const ssh = ctx.ssh(serverId)
    const d = await ssh.exec(`d=$(readlink ${NODE_ROOT}/default 2>/dev/null); [ -n "$d" ] && [ -x "$d/bin/npm" ] && echo "$d"`)
    const dir = d.stdout.trim()
    if (!dir) throw new Error('No default Node.js version is set.')
    await ssh.sudoRun(`${dir}/bin/npm uninstall -g ${shq(name)}`, { timeoutMs: 300000, env: { NPM_CONFIG_PREFIX: '/usr/local', PATH: `${dir}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` } })
    ctx.audit(serverId, 'runtimes.node.global.remove', name)
  })

  ctx.handle('rt:node:installNvm', async (serverId: string, userRaw: string) => {
    const ssh = ctx.ssh(serverId)
    const user = await verifyUser(ssh, userRaw)
    const { id } = ctx.tasks.start(`Install nvm for ${user.name}`, serverId, async (h) => {
      await ensureTools(ssh, h, ['curl', 'bash'])
      h.log('Looking up the latest nvm release…')
      const rel = await curlJson<{ tag_name?: string }>(ssh, 'https://api.github.com/repos/nvm-sh/nvm/releases/latest', 20000)
      const tag = rel?.tag_name && /^v\d+\.\d+\.\d+$/.test(rel.tag_name) ? rel.tag_name : NVM_FALLBACK
      h.log(`Installing nvm ${tag} for user ${user.name} (home ${user.home})…`)
      const url = `https://raw.githubusercontent.com/nvm-sh/nvm/${tag}/install.sh`
      const inner = `cd ~ && curl -fsSL -o- ${url} | bash`
      await ssh.sudoRun(`su -s /bin/bash - ${shq(user.name)} -c ${shq(inner)}`, stream(h, 900000))
      const check = await ssh.sudo(`[ -s ${shq(user.home)}/.nvm/nvm.sh ] && echo ok`)
      if (!check.stdout.includes('ok')) throw new Error('nvm.sh was not found after the installer ran')
      h.log(`\nnvm is installed in ${user.home}/.nvm. Open a new login shell as ${user.name} and run: nvm install --lts`)
      ctx.audit(serverId, 'runtimes.node.nvm', user.name)
    })
    return id
  })
}

/* ------------------------------------------------------------------ */
/* Bun                                                                 */
/* ------------------------------------------------------------------ */

function registerBun(ctx: Ctx): void {
  ctx.handle('rt:bun:status', async (serverId: string): Promise<BunStatus> => {
    const ssh = ctx.ssh(serverId)
    const script = `
echo __SYS
[ -x ${BUN_ROOT}/bin/bun ] && ${BUN_ROOT}/bin/bun --version 2>/dev/null
echo __LINK
readlink -f /usr/local/bin/bun 2>/dev/null
echo __OTHERS
for p in /usr/bin/bun /usr/local/bin/bun /snap/bin/bun; do [ -x "$p" ] || continue; rp=$(readlink -f "$p" 2>/dev/null); case "$rp" in /opt/centralserver/*) continue;; esac; echo "$p $("$p" --version 2>/dev/null | head -n1)"; done
echo __USERS
${USERS_AWK} | while IFS=: read -r u hm sh; do [ -x "$hm/.bun/bin/bun" ] && echo "$u $hm/.bun/bin/bun"; done
echo __END`
    const sec = sections(await execRead(ssh, script))
    const version = (sec.SYS?.[0] ?? '').trim()
    const link = (sec.LINK?.[0] ?? '').trim()
    return {
      installed: !!version,
      version: version || undefined,
      path: `${BUN_ROOT}/bin/bun`,
      linked: link.startsWith(BUN_ROOT),
      others: nonEmpty(sec.OTHERS).map((l) => {
        const [path, ...rest] = l.split(/\s+/)
        return { path, version: rest.join(' ') || 'unknown' }
      }),
      users: nonEmpty(sec.USERS).map((l) => {
        const [user, ...rest] = l.split(/\s+/)
        return { user, path: rest.join(' ') }
      })
    }
  })

  const link = `ln -sfn ${BUN_ROOT}/bin/bun /usr/local/bin/bun && ln -sfn ${BUN_ROOT}/bin/bun /usr/local/bin/bunx`

  ctx.handle('rt:bun:install', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    nodeArch(ssh)
    const { id } = ctx.tasks.start('Install Bun', serverId, async (h) => {
      await ensureTools(ssh, h, ['curl', 'unzip', 'bash'])
      h.log(`Running the official installer into ${BUN_ROOT}…`)
      const inner = `export BUN_INSTALL=${BUN_ROOT}; export HOME=/root; curl -fsSL https://bun.sh/install | bash`
      await ssh.sudoRun(`mkdir -p ${BUN_ROOT} && bash -c ${shq(inner)}`, stream(h, 900000))
      h.log('Linking /usr/local/bin/bun and /usr/local/bin/bunx…')
      await ssh.sudoRun(`${link} && chmod -R a+rX ${BUN_ROOT}`)
      const v = await ssh.exec(`${BUN_ROOT}/bin/bun --version 2>&1`)
      h.log(`Bun ${v.stdout.trim()} installed.`)
      ctx.audit(serverId, 'runtimes.bun.install', v.stdout.trim())
    })
    return id
  })

  ctx.handle('rt:bun:upgrade', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Upgrade Bun', serverId, async (h) => {
      const inner = `export BUN_INSTALL=${BUN_ROOT}; export HOME=/root; ${BUN_ROOT}/bin/bun upgrade`
      await ssh.sudoRun(`[ -x ${BUN_ROOT}/bin/bun ] || { echo "Bun is not installed" >&2; exit 1; }; bash -c ${shq(inner)} && ${link} && chmod -R a+rX ${BUN_ROOT}`, stream(h, 900000))
      const v = await ssh.exec(`${BUN_ROOT}/bin/bun --version 2>&1`)
      h.log(`Bun is now ${v.stdout.trim()}.`)
      ctx.audit(serverId, 'runtimes.bun.upgrade', v.stdout.trim())
    })
    return id
  })

  ctx.handle('rt:bun:remove', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    await ssh.sudoRun(`for n in bun bunx; do p=/usr/local/bin/$n; t=$(readlink -f "$p" 2>/dev/null); case "$t" in ${BUN_ROOT}/*) rm -f "$p";; esac; done; rm -rf ${BUN_ROOT}`)
    ctx.audit(serverId, 'runtimes.bun.remove')
  })
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

interface GoDlEntry {
  version: string
  stable: boolean
  files?: { filename: string; os: string; arch: string; sha256: string; kind: string }[]
}

const GO_PROFILE = `# Managed by Central Server - adds the default Go toolchain to PATH\ncase ":$PATH:" in\n  *:/usr/local/go/bin:*) ;;\n  *) export PATH="$PATH:/usr/local/go/bin" ;;\nesac\n`

async function goSetDefaultCmd(ssh: SshClient, v: string): Promise<void> {
  await ssh.sudoRun(
    `[ -x ${GO_ROOT}/${v}/bin/go ] || { echo "Go ${v} is not installed" >&2; exit 1; }; if [ -e /usr/local/go ] && [ ! -L /usr/local/go ]; then echo "/usr/local/go exists and is not managed by Central Server. Move it away first (e.g. mv /usr/local/go /usr/local/go.old)." >&2; exit 1; fi; ln -sfn ${GO_ROOT}/${v} /usr/local/go && ln -sfn /usr/local/go/bin/go /usr/local/bin/go && ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt`
  )
  await writeRootFile(ssh, '/etc/profile.d/centralserver-go.sh', GO_PROFILE)
}

function registerGo(ctx: Ctx): void {
  ctx.handle('rt:go:status', async (serverId: string): Promise<GoStatus> => {
    const ssh = ctx.ssh(serverId)
    const arch = (() => {
      try {
        return goArch(ssh)
      } catch {
        return 'unsupported'
      }
    })()
    const script = `
echo __MANAGED
for d in ${GO_ROOT}/*/; do [ -d "$d" ] || continue; v=$(basename "$d"); case "$v" in *.tmp) continue;; esac; [ -x "$d/bin/go" ] && echo "$v"; done
echo __DEFAULT
[ -L /usr/local/go ] && readlink -f /usr/local/go 2>/dev/null
echo __ISDIR
[ -e /usr/local/go ] && [ ! -L /usr/local/go ] && echo yes
echo __OTHERS
for p in /usr/local/go/bin/go /usr/bin/go /snap/bin/go /usr/lib/go/bin/go /usr/lib/golang/bin/go; do [ -x "$p" ] || continue; rp=$(readlink -f "$p" 2>/dev/null); case "$rp" in /opt/centralserver/*) continue;; esac; echo "$p $("$p" version 2>/dev/null | head -n1)"; done
echo __PROFILE
[ -f /etc/profile.d/centralserver-go.sh ] && echo yes
echo __CURL
command -v curl >/dev/null 2>&1 && echo yes
echo __END`
    const sec = sections(await execRead(ssh, script))
    const managed = nonEmpty(sec.MANAGED).filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v)).sort((a, b) => cmpVersion(b, a))
    const def = (sec.DEFAULT?.[0] ?? '').trim().split('/').filter(Boolean).pop()
    const defaultVersion = def && managed.includes(def) ? def : undefined
    const seen = new Set<string>()
    const others = nonEmpty(sec.OTHERS)
      .map((l) => {
        const [path, ...rest] = l.split(/\s+/)
        const m = rest.join(' ').match(/go(\d+\.\d+(?:\.\d+)?(?:[a-z]+\d+)?)/)
        return { path, version: m ? m[1] : rest.join(' ') || 'unknown' }
      })
      .filter((o) => (seen.has(o.path) ? false : (seen.add(o.path), true)))
    const installed = new Set(managed)
    let available: GoAvailableVersion[] = []
    let availableLive = false
    if ((sec.CURL?.[0] ?? '').includes('yes')) {
      const dl = await curlJson<GoDlEntry[]>(ssh, 'https://go.dev/dl/?mode=json&include=all')
      if (Array.isArray(dl) && dl.length) {
        available = dl
          .filter((e) => e.stable && /^go\d+\.\d+(\.\d+)?$/.test(e.version))
          .filter((e) => arch === 'unsupported' || !e.files || e.files.some((f) => f.os === 'linux' && f.arch === arch && f.kind === 'archive'))
          .slice(0, 15)
          .map((e) => ({ version: e.version.replace(/^go/, ''), stable: e.stable, installed: installed.has(e.version.replace(/^go/, '')) }))
        availableLive = available.length > 0
      }
    }
    if (!available.length) available = GO_STATIC.map((v) => ({ version: v, stable: true, installed: installed.has(v) }))
    return {
      arch,
      versions: managed.map((v) => ({ version: v, path: `${GO_ROOT}/${v}`, default: v === defaultVersion })),
      defaultVersion,
      usrLocalGoIsDir: (sec.ISDIR?.[0] ?? '').includes('yes'),
      others,
      available,
      availableLive,
      profileInstalled: (sec.PROFILE?.[0] ?? '').includes('yes')
    }
  })

  ctx.handle('rt:go:install', async (serverId: string, versionRaw: string) => {
    const v = assertGoVersion(versionRaw)
    const ssh = ctx.ssh(serverId)
    const arch = goArch(ssh)
    const { id } = ctx.tasks.start(`Install Go ${v}`, serverId, async (h) => {
      await ensureTools(ssh, h, ['curl', 'tar'])
      const file = `go${v}.linux-${arch}.tar.gz`
      h.log('Looking up the checksum on go.dev…')
      let sha = ''
      const dl = await curlJson<GoDlEntry[]>(ssh, 'https://go.dev/dl/?mode=json&include=all')
      const entry = Array.isArray(dl) ? dl.find((e) => e.version === `go${v}`) : undefined
      const f = entry?.files?.find((x) => x.filename === file)
      if (f && /^[0-9a-f]{64}$/.test(f.sha256)) sha = f.sha256
      if (!sha) {
        const r = await ssh.exec(`curl -fsSL --max-time 20 ${shq(`https://go.dev/dl/${file}.sha256`)}`, { timeoutMs: 30000 })
        const t = r.stdout.trim().split(/\s+/)[0] ?? ''
        if (r.code === 0 && /^[0-9a-f]{64}$/.test(t)) sha = t
      }
      if (!sha) throw new Error(`Could not obtain the SHA-256 checksum for ${file} from go.dev`)
      const tmp = `/tmp/centralserver-go-${v}`
      h.log(`Downloading https://go.dev/dl/${file}…`)
      await ssh.sudoRun(`rm -rf ${tmp} && mkdir -p ${tmp} ${GO_ROOT} && cd ${tmp} && curl -fSL --retry 3 -o ${file} https://go.dev/dl/${file}`, stream(h))
      h.log('Verifying SHA-256 checksum…')
      await ssh.sudoRun(`cd ${tmp} && echo "${sha}  ${file}" | sha256sum -c -`, stream(h, 120000))
      h.log(`Extracting to ${GO_ROOT}/${v}…`)
      await ssh.sudoRun(`rm -rf ${GO_ROOT}/${v}.tmp && mkdir -p ${GO_ROOT}/${v}.tmp && tar -xzf ${tmp}/${file} -C ${GO_ROOT}/${v}.tmp --strip-components=1 && rm -rf ${GO_ROOT}/${v} && mv ${GO_ROOT}/${v}.tmp ${GO_ROOT}/${v} && rm -rf ${tmp}`, stream(h, 600000))
      const cur = await ssh.exec(`[ -L /usr/local/go ] && readlink -f /usr/local/go; [ -e /usr/local/go ] && [ ! -L /usr/local/go ] && echo DIR`)
      if (cur.stdout.includes('DIR')) h.log('Note: /usr/local/go is an existing unmanaged installation; not changing the default. Move it away and press "Use" to switch.')
      else if (!cur.stdout.trim().startsWith(GO_ROOT)) {
        h.log(`Setting Go ${v} as default (/usr/local/go → ${GO_ROOT}/${v}) and adding /usr/local/go/bin to PATH via /etc/profile.d…`)
        await goSetDefaultCmd(ssh, v)
      }
      const chk = await ssh.exec(`${GO_ROOT}/${v}/bin/go version 2>&1`)
      h.log(chk.stdout.trim())
      ctx.audit(serverId, 'runtimes.go.install', v)
    })
    return id
  })

  ctx.handle('rt:go:setDefault', async (serverId: string, versionRaw: string) => {
    const v = assertGoVersion(versionRaw)
    await goSetDefaultCmd(ctx.ssh(serverId), v)
    ctx.audit(serverId, 'runtimes.go.default', v)
  })

  ctx.handle('rt:go:remove', async (serverId: string, versionRaw: string) => {
    const v = assertGoVersion(versionRaw)
    const ssh = ctx.ssh(serverId)
    await ssh.sudoRun(
      `[ -d ${GO_ROOT}/${v} ] || { echo "Go ${v} is not installed" >&2; exit 1; }; rm -rf ${GO_ROOT}/${v}; if [ -L /usr/local/go ] && [ "$(readlink -f /usr/local/go)" = ${shq(`${GO_ROOT}/${v}`)} ]; then rm -f /usr/local/go; n=$(ls -1 ${GO_ROOT} 2>/dev/null | grep -E '^[0-9]+\\.[0-9]+(\\.[0-9]+)?$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1); if [ -n "$n" ]; then ln -sfn ${GO_ROOT}/$n /usr/local/go; else for b in go gofmt; do t=$(readlink /usr/local/bin/$b 2>/dev/null); case "$t" in /usr/local/go/*) rm -f /usr/local/bin/$b;; esac; done; rm -f /etc/profile.d/centralserver-go.sh; fi; fi`
    )
    ctx.audit(serverId, 'runtimes.go.remove', v)
  })
}

/* ------------------------------------------------------------------ */
/* PHP                                                                 */
/* ------------------------------------------------------------------ */

function phpFamily(ssh: SshClient): PhpStatus['family'] {
  const pm = ssh.os?.pkgManager
  if (pm === 'apt') return 'debian'
  if (pm === 'dnf' || pm === 'yum') return 'rhel'
  return 'other'
}

function isUbuntuLike(ssh: SshClient): boolean {
  const id = `${ssh.os?.id ?? ''} ${ssh.os?.idLike ?? ''}`.toLowerCase()
  return /ubuntu|mint|pop/.test(id)
}
function isFedora(ssh: SshClient): boolean {
  return (ssh.os?.id ?? '').toLowerCase() === 'fedora'
}

function phpFpmUnit(family: PhpStatus['family'], v: string): string {
  return family === 'debian' ? `php${v}-fpm` : 'php-fpm'
}
function phpFpmBinary(family: PhpStatus['family'], v: string): string {
  return family === 'debian' ? `php-fpm${v}` : 'php-fpm'
}
function phpIniPaths(family: PhpStatus['family'], v: string): { fpm: string; cli: string } {
  if (family === 'debian') return { fpm: `/etc/php/${v}/fpm/php.ini`, cli: `/etc/php/${v}/cli/php.ini` }
  return { fpm: '/etc/php.ini', cli: '/etc/php.ini' }
}
function phpPkg(family: PhpStatus['family'], v: string, suffix: string): string {
  return family === 'debian' ? `php${v}-${suffix}` : `php-${suffix}`
}

async function phpStatus(ssh: SshClient): Promise<PhpStatus> {
  const family = phpFamily(ssh)
  const settingsPhp = `foreach(array(${PHP_SETTING_KEYS.map((k) => `'${k}'`).join(',')}) as $k){echo $k,"=",ini_get($k),"\\n";}`
  const script1 = `
echo __BINS
for b in /usr/bin/php[0-9].[0-9] /usr/bin/php[0-9][0-9].[0-9] /usr/bin/php /usr/local/bin/php /opt/remi/php*/root/usr/bin/php; do
  [ -x "$b" ] || continue
  rp=$(readlink -f "$b" 2>/dev/null)
  echo "__BIN $b $rp"
  echo "V=$("$b" -n -r 'echo PHP_VERSION;' 2>/dev/null)"
  echo "I=$("$b" -r 'echo php_ini_loaded_file();' 2>/dev/null)"
  "$b" -m 2>/dev/null | grep -vE '^\\[|^$' | sed 's/^/M=/'
  echo "__BINEND"
done
echo __DEFAULT
php -n -r 'echo PHP_VERSION;' 2>/dev/null
echo __REPO
${family === 'debian' ? `grep -rlsE 'ondrej/php|packages.sury.org' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -n1` : family === 'rhel' ? `rpm -q remi-release >/dev/null 2>&1 && echo remi` : 'true'}
echo __COMPOSER
command -v composer 2>/dev/null; composer --version --no-ansi 2>/dev/null | head -n1
echo __END`
  const out1 = await execRead(ssh, script1)
  // Parse binaries manually (nested markers).
  type Bin = { binary: string; real: string; fullVersion: string; iniPath: string; mods: string[] }
  const bins: Bin[] = []
  {
    const lines = out1.split('\n')
    let i = 0
    while (i < lines.length) {
      const l = lines[i]
      if (l.startsWith('__BIN ')) {
        const [, binary, real] = l.split(/\s+/)
        let fullVersion = ''
        let iniPath = ''
        const mods: string[] = []
        let j = i + 1
        while (j < lines.length && lines[j].trim() !== '__BINEND') {
          const m = lines[j].trim()
          if (m.startsWith('V=')) fullVersion = m.slice(2)
          else if (m.startsWith('I=')) iniPath = m.slice(2)
          else if (m.startsWith('M=') && m.length > 2) mods.push(m.slice(2))
          j++
        }
        if (/^\d+\.\d+\.\d+/.test(fullVersion)) bins.push({ binary, real: real || binary, fullVersion, iniPath, mods })
        i = j + 1
      } else i++
    }
  }
  const rest = sections(out1.slice(out1.indexOf('__DEFAULT') >= 0 ? out1.indexOf('__DEFAULT') : out1.length))
  const defaultFull = (rest.DEFAULT?.[0] ?? '').trim()
  const defaultVersion = /^\d+\.\d+/.test(defaultFull) ? defaultFull.split('.').slice(0, 2).join('.') : undefined
  // Dedupe by real path, preferring versioned binaries over /usr/bin/php.
  const byReal = new Map<string, Bin>()
  for (const b of bins) {
    const prev = byReal.get(b.real)
    if (!prev || (/php\d/.test(b.binary) && !/php\d/.test(prev.binary))) byReal.set(b.real, b)
  }
  const unique = [...byReal.values()]
  // Second pass: FPM state and settings per version.
  const script2 = unique
    .map((b, idx) => {
      const v = b.fullVersion.split('.').slice(0, 2).join('.')
      const unit = phpFpmUnit(family, v)
      const ini = phpIniPaths(family, v)
      return `echo __V${idx}
echo "A=$(systemctl is-active ${unit} 2>/dev/null)"
echo "E=$(systemctl is-enabled ${unit} 2>/dev/null)"
echo "U=$(if systemctl cat ${unit} >/dev/null 2>&1 || [ -f /usr/lib/systemd/system/${unit}.service ] || [ -f /etc/systemd/system/${unit}.service ]; then echo ok; fi)"
echo "F=$([ -f ${ini.fpm} ] && echo ${ini.fpm})"
if [ -f ${ini.fpm} ]; then ${shq(b.binary)} -n -c ${ini.fpm} -r ${shq(settingsPhp)} 2>/dev/null; else ${shq(b.binary)} -r ${shq(settingsPhp)} 2>/dev/null; fi`
    })
    .join('\n')
  const sec2 = unique.length ? sections(await execRead(ssh, script2 + '\necho __END')) : {}
  const versions: PhpVersionInfo[] = unique.map((b, idx) => {
    const v = b.fullVersion.split('.').slice(0, 2).join('.')
    const s = nonEmpty(sec2[`V${idx}`])
    const field = (p: string): string => (s.find((l) => l.startsWith(p + '=')) ?? '').slice(p.length + 1).trim()
    const active = field('A')
    const enabled = field('E')
    const unitOk = field('U') === 'ok'
    const fpmIni = field('F')
    const settings: PhpSettings = {}
    for (const line of s) {
      const m = line.match(/^([a-z_]+)=(.*)$/)
      if (m && (PHP_SETTING_KEYS as string[]).includes(m[1])) settings[m[1] as PhpSettingKey] = m[2].trim()
    }
    if (settings.display_errors !== undefined) settings.display_errors = settings.display_errors === '' || settings.display_errors === '0' || /^off$/i.test(settings.display_errors) ? 'Off' : 'On'
    return {
      version: v,
      fullVersion: b.fullVersion,
      binary: b.binary,
      fpmUnit: unitOk || active === 'active' ? phpFpmUnit(family, v) : undefined,
      fpmActive: active === 'active',
      fpmEnabled: enabled === 'enabled',
      iniPath: b.iniPath || '(none)',
      fpmIniPath: fpmIni || undefined,
      extensions: b.mods.sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())),
      settings,
      settingsSource: fpmIni ? 'fpm' : 'cli',
      isDefault: v === defaultVersion
    }
  })
  versions.sort((a, b) => cmpVersion(b.fullVersion, a.fullVersion))
  const composerPath = nonEmpty(rest.COMPOSER).find((l) => l.startsWith('/'))
  const composerVer = nonEmpty(rest.COMPOSER).map((l) => l.match(/Composer(?: version)? (\d+\.\d+\.\d+)/)?.[1]).find(Boolean)
  const repo = nonEmpty(rest.REPO)[0] ?? ''
  return {
    family,
    pkgManager: ssh.os?.pkgManager ?? 'unknown',
    versions,
    defaultVersion,
    availableVersions: family === 'debian' ? PHP_VERSIONS_DEB : family === 'rhel' ? PHP_VERSIONS_RHEL : [],
    repoReady: !!repo,
    repoName: family === 'debian' ? (isUbuntuLike(ssh) ? 'ppa:ondrej/php' : 'packages.sury.org') : family === 'rhel' ? 'remi' : '',
    availableExtensions: PHP_EXTENSIONS,
    composer: { installed: !!composerPath, version: composerVer, path: composerPath }
  }
}

async function phpEnsureRepo(ssh: SshClient, h: TaskHandle, family: PhpStatus['family']): Promise<void> {
  if (family === 'debian') {
    const have = await ssh.exec(`grep -rlsE 'ondrej/php|packages.sury.org' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -n1`)
    if (have.stdout.trim()) return
    if (isUbuntuLike(ssh)) {
      h.log('Adding the ppa:ondrej/php repository…')
      await runPkg(ssh, installCmd(ssh, ['software-properties-common', 'ca-certificates', 'apt-transport-https']), stream(h))
      await runPkg(ssh, 'add-apt-repository -y ppa:ondrej/php', stream(h, 600000))
    } else {
      h.log('Adding the packages.sury.org PHP repository…')
      await runPkg(ssh, installCmd(ssh, ['apt-transport-https', 'ca-certificates', 'curl', 'lsb-release']), stream(h))
      await ssh.sudoRun(
        `curl -fsSLo /usr/share/keyrings/deb.sury.org-php.gpg https://packages.sury.org/php/apt.gpg && echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" > /etc/apt/sources.list.d/centralserver-php.list`,
        stream(h, 120000)
      )
    }
    await runPkg(ssh, 'apt-get update -qq', stream(h, 600000))
  } else if (family === 'rhel') {
    const have = await ssh.exec('rpm -q remi-release >/dev/null 2>&1 && echo yes')
    if (have.stdout.includes('yes')) return
    h.log('Installing the Remi repository…')
    const url = isFedora(ssh) ? 'https://rpms.remirepo.net/fedora/remi-release-$(rpm -E %fedora).rpm' : 'https://rpms.remirepo.net/enterprise/remi-release-$(rpm -E %rhel).rpm'
    const pm = ssh.os?.pkgManager === 'yum' ? 'yum' : 'dnf'
    await runPkg(ssh, `${pm} install -y ${url}`, stream(h, 600000))
    if (!isFedora(ssh)) await runPkg(ssh, `${pm} install -y epel-release || true`, stream(h, 600000))
  } else throw new Error('PHP installation is supported on apt (Debian/Ubuntu) and dnf/yum (RHEL family) systems only')
}

async function phpRestartFpm(ssh: SshClient, family: PhpStatus['family'], v: string, h?: TaskHandle): Promise<void> {
  const unit = phpFpmUnit(family, v)
  const r = await ssh.sudo(`systemctl cat ${unit} >/dev/null 2>&1 && systemctl restart ${unit} 2>&1 && echo restarted`)
  if (r.stdout.includes('restarted')) h?.log(`Restarted ${unit}.`)
}

function validatePhpSettings(settings: PhpSettings): [PhpSettingKey, string][] {
  const out: [PhpSettingKey, string][] = []
  for (const [k, raw] of Object.entries(settings ?? {})) {
    if (!(PHP_SETTING_KEYS as string[]).includes(k)) throw new Error(`Unknown PHP setting: ${k}`)
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const v = String(raw).trim()
    switch (k as PhpSettingKey) {
      case 'upload_max_filesize':
      case 'post_max_size':
        if (!/^\d+[KMG]?$/.test(v)) throw new Error(`${k}: use a number with optional K/M/G suffix (e.g. 64M)`)
        break
      case 'memory_limit':
        if (!/^(-1|\d+[KMG]?)$/.test(v)) throw new Error(`${k}: use a number with optional K/M/G suffix, or -1`)
        break
      case 'max_execution_time':
      case 'max_input_vars':
        if (!/^\d+$/.test(v)) throw new Error(`${k}: must be a whole number`)
        break
      case 'display_errors':
        if (!/^(On|Off)$/.test(v)) throw new Error(`${k}: must be On or Off`)
        break
    }
    out.push([k as PhpSettingKey, v])
  }
  if (!out.length) throw new Error('No settings to apply')
  return out
}

function registerPhp(ctx: Ctx): void {
  ctx.handle('rt:php:status', async (serverId: string): Promise<PhpStatus> => phpStatus(ctx.ssh(serverId)))

  ctx.handle('rt:php:install', async (serverId: string, versionRaw: string) => {
    const v = assertPhpVersion(versionRaw)
    const ssh = ctx.ssh(serverId)
    const family = phpFamily(ssh)
    if (family === 'other') throw new Error('PHP installation is supported on apt and dnf/yum based systems only')
    const { id } = ctx.tasks.start(`Install PHP ${v}`, serverId, async (h) => {
      await ensureTools(ssh, h, ['curl'])
      const base = ['fpm', 'cli', 'common', 'mbstring', 'xml', 'curl', 'zip', 'opcache']
      if (family === 'debian') {
        h.log('Refreshing package lists…')
        await runPkg(ssh, 'apt-get update -qq', stream(h, 600000))
        const native = await ssh.exec(`apt-cache show php${v}-cli >/dev/null 2>&1 && echo yes`)
        if (!native.stdout.includes('yes')) await phpEnsureRepo(ssh, h, family)
        const pkgs = base.map((s) => phpPkg(family, v, s))
        h.log(`Installing ${pkgs.join(' ')}…`)
        await runPkg(ssh, `apt-get install -y -qq -o Dpkg::Options::=--force-confold ${pkgs.map(shq).join(' ')}`, stream(h))
      } else {
        await phpEnsureRepo(ssh, h, family)
        const pm = ssh.os?.pkgManager === 'yum' ? 'yum' : 'dnf'
        h.log(`Switching the php module stream to php:remi-${v} (RHEL-family systems run one PHP version at a time)…`)
        await runPkg(ssh, `${pm} module reset php -y && ${pm} module enable php:remi-${v} -y`, stream(h, 900000))
        const pkgs = ['php', ...base.map((s) => `php-${s}`)]
        h.log(`Installing ${pkgs.join(' ')}…`)
        await runPkg(ssh, `${pm} install -y ${pkgs.join(' ')}`, stream(h))
      }
      const unit = phpFpmUnit(family, v)
      h.log(`Enabling and starting ${unit}…`)
      await ssh.sudo(`systemctl enable --now ${unit} 2>&1 || true`)
      const chk = await ssh.exec(`${family === 'debian' ? `php${v}` : 'php'} -v 2>&1 | head -n1`)
      h.log(chk.stdout.trim())
      ctx.audit(serverId, 'runtimes.php.install', v)
    })
    return id
  })

  ctx.handle('rt:php:remove', async (serverId: string, versionRaw: string) => {
    const v = assertPhpVersion(versionRaw)
    const ssh = ctx.ssh(serverId)
    const family = phpFamily(ssh)
    const { id } = ctx.tasks.start(`Remove PHP ${v}`, serverId, async (h) => {
      const unit = phpFpmUnit(family, v)
      await ssh.sudo(`systemctl disable --now ${unit} 2>/dev/null || true`)
      if (family === 'debian') {
        await runPkg(ssh, `pkgs=$(dpkg-query -W -f='\${Package}\\n' 'php${v}*' 2>/dev/null | tr '\\n' ' '); if [ -n "$pkgs" ]; then apt-get purge -y -qq $pkgs; fi; apt-get autoremove -y -qq`, stream(h))
      } else if (family === 'rhel') {
        const pm = ssh.os?.pkgManager === 'yum' ? 'yum' : 'dnf'
        await runPkg(ssh, `${pm} remove -y 'php' 'php-*' && ${pm} module reset php -y`, stream(h))
      } else throw new Error('Unsupported package manager')
      h.log('Done.')
      ctx.audit(serverId, 'runtimes.php.remove', v)
    })
    return id
  })

  ctx.handle('rt:php:setDefault', async (serverId: string, versionRaw: string) => {
    const v = assertPhpVersion(versionRaw)
    const ssh = ctx.ssh(serverId)
    if (phpFamily(ssh) !== 'debian') throw new Error('Switching the default php binary is only needed on Debian/Ubuntu (update-alternatives). RHEL-family systems run a single PHP version.')
    await ssh.sudoRun(`[ -x /usr/bin/php${v} ] || { echo "PHP ${v} is not installed" >&2; exit 1; }; update-alternatives --set php /usr/bin/php${v} && for t in phar phar.phar phpize php-config; do [ -e /usr/bin/$t${v} ] && update-alternatives --set $t /usr/bin/$t${v} >/dev/null 2>&1; done; true`)
    ctx.audit(serverId, 'runtimes.php.default', v)
  })

  ctx.handle('rt:php:extInstall', async (serverId: string, versionRaw: string, extRaw: string) => {
    const v = assertPhpVersion(versionRaw)
    const ext = assertExt(extRaw)
    const ssh = ctx.ssh(serverId)
    const family = phpFamily(ssh)
    if (family === 'other') throw new Error('Unsupported package manager')
    const pkg = phpPkg(family, v, ext)
    const { id } = ctx.tasks.start(`Install PHP ${v} extension ${ext}`, serverId, async (h) => {
      if (family === 'rhel') {
        const pm = ssh.os?.pkgManager === 'yum' ? 'yum' : 'dnf'
        // Some extensions live in the pecl namespace on Remi (php-pecl-redis6, php-pecl-imagick-im7, ...).
        const alt: Record<string, string> = { redis: 'php-pecl-redis6', imagick: 'php-pecl-imagick-im7', xdebug: 'php-pecl-xdebug3', apcu: 'php-pecl-apcu', mongodb: 'php-pecl-mongodb', mysql: 'php-mysqlnd' }
        const candidates = [pkg, alt[ext]].filter((x): x is string => !!x)
        await runPkg(ssh, candidates.map((c) => `${pm} install -y ${c}`).join(' || '), stream(h))
      } else {
        await runPkg(ssh, installCmd(ssh, [pkg]), stream(h))
      }
      await phpRestartFpm(ssh, family, v, h)
      h.log('Done.')
      ctx.audit(serverId, 'runtimes.php.ext.install', `${v} ${ext}`)
    })
    return id
  })

  ctx.handle('rt:php:extRemove', async (serverId: string, versionRaw: string, extRaw: string) => {
    const v = assertPhpVersion(versionRaw)
    const ext = assertExt(extRaw)
    const ssh = ctx.ssh(serverId)
    const family = phpFamily(ssh)
    if (family === 'other') throw new Error('Unsupported package manager')
    if (['common', 'cli', 'fpm'].includes(ext)) throw new Error(`${ext} is not a removable extension`)
    const { id } = ctx.tasks.start(`Remove PHP ${v} extension ${ext}`, serverId, async (h) => {
      await runPkg(ssh, removeCmd(ssh, [phpPkg(family, v, ext)]), stream(h))
      await phpRestartFpm(ssh, family, v, h)
      h.log('Done.')
      ctx.audit(serverId, 'runtimes.php.ext.remove', `${v} ${ext}`)
    })
    return id
  })

  ctx.handle('rt:php:setSettings', async (serverId: string, versionRaw: string, settings: PhpSettings, target: PhpSettingsTarget) => {
    const v = assertPhpVersion(versionRaw)
    const pairs = validatePhpSettings(settings)
    if (!['fpm', 'cli', 'both'].includes(target)) throw new Error('Invalid target')
    const ssh = ctx.ssh(serverId)
    const family = phpFamily(ssh)
    const ini = phpIniPaths(family, v)
    const files = [...new Set(target === 'both' ? [ini.fpm, ini.cli] : target === 'fpm' ? [ini.fpm] : [ini.cli])]
    const sedParts = pairs
      .map(([k, val]) => `if grep -qE '^[[:space:]]*;?[[:space:]]*${k}[[:space:]]*=' "$f"; then sed -i -E 's|^[[:space:]]*;?[[:space:]]*${k}[[:space:]]*=.*|${k} = ${val}|' "$f"; else printf '\\n%s\\n' '${k} = ${val}' >> "$f"; fi`)
      .join('; ')
    const fpmBin = phpFpmBinary(family, v)
    const unit = phpFpmUnit(family, v)
    const script = `set -e; for f in ${files.map(shq).join(' ')}; do [ -f "$f" ] || { echo "$f not found" >&2; exit 1; }; cp -f "$f" "$f.centralserver.bak"; ${sedParts}; echo "updated $f"; done
if ${files.includes(ini.fpm) ? 'true' : 'false'} && command -v ${fpmBin} >/dev/null 2>&1; then
  if ! ${fpmBin} -t 2>&1; then for f in ${files.map(shq).join(' ')}; do cp -f "$f.centralserver.bak" "$f"; done; echo "php-fpm config test failed; restored backups" >&2; exit 1; fi
  if systemctl cat ${unit} >/dev/null 2>&1; then systemctl restart ${unit} || { echo "restart of ${unit} failed" >&2; exit 1; }; echo "restarted ${unit}"; fi
fi
true`
    const out = await ssh.sudoRun(script, { timeoutMs: 120000 })
    ctx.audit(serverId, 'runtimes.php.settings', `${v} ${target} ${pairs.map(([k, val]) => `${k}=${val}`).join(' ')}`)
    return out.trim()
  })

  ctx.handle('rt:php:fpm', async (serverId: string, versionRaw: string, action: PhpFpmAction) => {
    const v = assertPhpVersion(versionRaw)
    if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) throw new Error('Invalid action')
    const ssh = ctx.ssh(serverId)
    const unit = phpFpmUnit(phpFamily(ssh), v)
    const cmd = action === 'enable' ? `systemctl enable --now ${unit}` : action === 'disable' ? `systemctl disable --now ${unit}` : `systemctl ${action} ${unit}`
    await ssh.sudoRun(`${cmd} 2>&1`)
    ctx.audit(serverId, 'runtimes.php.fpm', `${unit} ${action}`)
  })

  ctx.handle('rt:php:composer', async (serverId: string) => {
    const r = await ctx.ssh(serverId).exec('command -v composer 2>/dev/null; composer --version --no-ansi 2>/dev/null | head -n1')
    const lines = nonEmpty(r.stdout.split('\n'))
    const path = lines.find((l) => l.startsWith('/'))
    const version = lines.map((l) => l.match(/Composer(?: version)? (\d+\.\d+\.\d+)/)?.[1]).find(Boolean)
    return { installed: !!path, version, path }
  })

  ctx.handle('rt:php:composerInstall', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Install Composer', serverId, async (h) => {
      if (!(await hasCommand(ssh, 'php'))) throw new Error('PHP (cli) must be installed first')
      await ensureTools(ssh, h, ['curl'])
      h.log('Downloading the Composer installer and verifying its signature…')
      const script = `set -e; cd /tmp; rm -f composer-setup.php; EXPECTED=$(curl -fsSL https://composer.github.io/installer.sig); curl -fsSL -o composer-setup.php https://getcomposer.org/installer; ACTUAL=$(php -r "echo hash_file('sha384', 'composer-setup.php');"); if [ "$EXPECTED" != "$ACTUAL" ]; then rm -f composer-setup.php; echo "Installer signature mismatch" >&2; exit 1; fi; echo "Signature OK"; php composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer; rm -f composer-setup.php; /usr/local/bin/composer --version --no-ansi 2>/dev/null | head -n1`
      await ssh.sudoRun(script, { ...stream(h, 600000), env: { COMPOSER_ALLOW_SUPERUSER: '1', HOME: '/root' } })
      h.log('Composer installed to /usr/local/bin/composer.')
      ctx.audit(serverId, 'runtimes.php.composer')
    })
    return id
  })
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

function registerPython(ctx: Ctx): void {
  ctx.handle('rt:py:status', async (serverId: string): Promise<PythonStatus> => {
    const ssh = ctx.ssh(serverId)
    const script = `
echo __PY
command -v python3 2>/dev/null; python3 --version 2>&1
echo __PIP
python3 -m pip --version 2>/dev/null
echo __VENV
python3 -c 'import venv, ensurepip' >/dev/null 2>&1 && echo yes
echo __PIPX
command -v pipx 2>/dev/null; pipx --version 2>/dev/null
echo __UV
command -v uv 2>/dev/null; uv --version 2>/dev/null
echo __PYENV
${USERS_AWK} | while IFS=: read -r u hm sh; do [ -d "$hm/.pyenv" ] && echo "$u"; done
echo __END`
    const sec = sections(await execRead(ssh, script))
    const py = nonEmpty(sec.PY)
    const pip = nonEmpty(sec.PIP)[0]
    const pipx = nonEmpty(sec.PIPX)
    const uv = nonEmpty(sec.UV)
    return {
      python3: py.find((l) => l.startsWith('/')) ? { path: py.find((l) => l.startsWith('/')) ?? '', version: py.find((l) => /^Python \d/.test(l))?.replace(/^Python /, '') ?? 'unknown' } : undefined,
      pip: pip ? { version: pip.match(/^pip (\S+)/)?.[1] ?? pip } : undefined,
      venvAvailable: (sec.VENV?.[0] ?? '').includes('yes'),
      pipx: pipx.find((l) => l.startsWith('/')) ? { path: pipx.find((l) => l.startsWith('/')) ?? '', version: pipx.find((l) => /^\d/.test(l)) ?? 'unknown' } : undefined,
      uv: uv.find((l) => l.startsWith('/')) ? { path: uv.find((l) => l.startsWith('/')) ?? '', version: uv.find((l) => /^uv /.test(l))?.replace(/^uv /, '') ?? 'unknown' } : undefined,
      pyenvUsers: nonEmpty(sec.PYENV),
      pkgManager: ssh.os?.pkgManager ?? 'unknown'
    }
  })

  ctx.handle('rt:py:installTools', async (serverId: string, which: PythonTool) => {
    if (!['pip', 'venv', 'pipx', 'uv'].includes(which)) throw new Error('Invalid tool')
    const ssh = ctx.ssh(serverId)
    const pm = ssh.os?.pkgManager ?? 'unknown'
    const { id } = ctx.tasks.start(`Install Python tool: ${which}`, serverId, async (h) => {
      const pkgNames = (): string[] => {
        switch (which) {
          case 'pip':
            return pm === 'apk' ? ['py3-pip'] : pm === 'pacman' ? ['python-pip'] : ['python3-pip']
          case 'venv':
            return pm === 'apt' ? ['python3-venv'] : pm === 'apk' ? ['py3-virtualenv'] : pm === 'pacman' ? ['python'] : ['python3']
          case 'pipx':
            return pm === 'apk' ? ['pipx'] : pm === 'pacman' ? ['python-pipx'] : ['pipx']
          default:
            return []
        }
      }
      if (which === 'uv') {
        await ensureTools(ssh, h, ['curl'])
        h.log('Running the official uv installer into /usr/local/bin…')
        const inner = 'export UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 INSTALLER_NO_MODIFY_PATH=1 HOME=/root; curl -LsSf https://astral.sh/uv/install.sh | sh'
        await ssh.sudoRun(`sh -c ${shq(inner)}`, stream(h, 900000))
        const v = await ssh.exec('/usr/local/bin/uv --version 2>&1')
        h.log(v.stdout.trim())
      } else {
        if (pm === 'unknown') throw new Error('Unsupported package manager')
        if (!(await hasCommand(ssh, 'python3'))) {
          h.log('Installing python3…')
          await runPkg(ssh, installCmd(ssh, [pm === 'pacman' ? 'python' : 'python3']), stream(h))
        }
        const pkgs = pkgNames()
        h.log(`Installing ${pkgs.join(' ')}…`)
        const r = await ssh.sudo(installCmd(ssh, pkgs), { env: pkgEnv(), ...stream(h) })
        if (r.code !== 0) {
          if (which === 'pipx') {
            h.log('Distro package not available; falling back to pip…')
            await ssh.sudoRun('python3 -m pip install --break-system-packages pipx 2>/dev/null || python3 -m pip install pipx', stream(h, 600000))
          } else throw new Error(`Package installation failed (exit ${r.code})`)
        }
        if (which === 'pipx') await ssh.exec('pipx ensurepath >/dev/null 2>&1 || true')
      }
      h.log('Done.')
      ctx.audit(serverId, 'runtimes.py.tool', which)
    })
    return id
  })

  ctx.handle('rt:py:pipxList', async (serverId: string): Promise<PipxPackage[]> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec('pipx list --json 2>/dev/null', { timeoutMs: 60000 })
    if (r.code !== 0 || !r.stdout.trim().startsWith('{')) return []
    try {
      const j = JSON.parse(r.stdout) as { venvs?: Record<string, { metadata?: { main_package?: { package?: string; package_version?: string; apps?: string[] } } }> }
      return Object.entries(j.venvs ?? {}).map(([name, v]) => ({
        name: v.metadata?.main_package?.package ?? name,
        version: v.metadata?.main_package?.package_version ?? '',
        apps: v.metadata?.main_package?.apps ?? []
      }))
    } catch {
      return []
    }
  })

  ctx.handle('rt:py:pipxInstall', async (serverId: string, pkgRaw: string) => {
    const pkg = assertPyPkg(String(pkgRaw ?? '').trim())
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start(`pipx install ${pkg}`, serverId, async (h) => {
      if (!(await hasCommand(ssh, 'pipx'))) throw new Error('pipx is not installed')
      await ssh.run(`pipx install ${shq(pkg)}`, stream(h, 900000))
      h.log('Done.')
      ctx.audit(serverId, 'runtimes.py.pipx.install', pkg)
    })
    return id
  })

  ctx.handle('rt:py:pipxRemove', async (serverId: string, nameRaw: string) => {
    const name = assertPyPkg(String(nameRaw ?? '').trim())
    await ctx.ssh(serverId).run(`pipx uninstall ${shq(name)}`, { timeoutMs: 300000 })
    ctx.audit(serverId, 'runtimes.py.pipx.remove', name)
  })
}

/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  registerNode(ctx)
  registerBun(ctx)
  registerGo(ctx)
  registerPhp(ctx)
  registerPython(ctx)
}
