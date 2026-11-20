import type { Ctx } from '../core'
import type { ExecOptions, SshClient } from '../ssh/SshClient'
import type { ExecResult, DockerContainer, DockerImage, DockerNetwork, DockerVolume } from '@shared/types'
import type {
  ComposeAction,
  ComposeFile,
  ComposeProject,
  DockerContainerAction,
  DockerInfo,
  DockerLogsOpts,
  DockerNetworkCreate,
  DockerPruneOpts,
  DockerRunSpec,
  DockerServiceAction,
  DockerStats,
  DockerSystemDf,
  DockerTop
} from '@shared/modules/docker'
import { assertAbsPath, assertPort, assertSafeName, b64Echo, shq } from '../ssh/shell'
import { installCmd, runPkg } from './pkg'

/* ------------------------------------------------------------------ */
/* Per-server mode cache (sudo or not, compose flavour)                 */
/* ------------------------------------------------------------------ */

interface Mode {
  sudo: boolean
  compose: 'docker compose' | 'docker-compose' | null
}

const modes = new Map<string, Mode>()

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

/** Decide once per server whether docker needs sudo and which compose command exists. */
async function detectMode(ssh: SshClient): Promise<Mode> {
  const probe = await ssh.exec(
    `docker version --format '{{.Server.Version}}' 2>&1; echo "__RC=$?"; echo __COMPOSE; docker compose version --short 2>/dev/null && echo __PLUGIN; docker-compose version --short 2>/dev/null && echo __LEGACY`,
    { timeoutMs: 30000 }
  )
  const out = probe.stdout
  const rc = Number(out.match(/__RC=(\d+)/)?.[1] ?? '1')
  let sudo = false
  if (rc !== 0 && /permission denied|connect: permission|dial unix .*permission/i.test(out) && ssh.os?.sudoAvailable && !ssh.os?.isRoot) {
    const s = await ssh.sudo(`docker version --format '{{.Server.Version}}'`, { timeoutMs: 30000 }).catch((): ExecResult => ({ code: 1, stdout: '', stderr: '' }))
    sudo = s.code === 0 || !/not found/i.test(s.stderr)
  }
  const compose: Mode['compose'] = out.includes('__PLUGIN') ? 'docker compose' : out.includes('__LEGACY') ? 'docker-compose' : null
  return { sudo, compose }
}

async function mode(ctx: Ctx, serverId: string): Promise<Mode> {
  const cached = modes.get(serverId)
  if (cached) return cached
  const m = await detectMode(ctx.ssh(serverId))
  modes.set(serverId, m)
  return m
}

/**
 * Run a docker-related shell script with the detected privilege mode.
 * The script is wrapped in `sh -c` so multi-statement scripts and redirects work under sudo.
 */
async function dx(ctx: Ctx, serverId: string, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const ssh = ctx.ssh(serverId)
  const m = await mode(ctx, serverId)
  return ssh.exec(`sh -c ${shq(script)}`, { ...opts, sudo: m.sudo })
}

/** Like dx but throws on non-zero exit and returns stdout. */
async function dxRun(ctx: Ctx, serverId: string, script: string, opts: ExecOptions = {}): Promise<string> {
  const r = await dx(ctx, serverId, script, opts)
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || `exit code ${r.code}`).trim()
    throw new Error(msg.split('\n').slice(-6).join('\n'))
  }
  return r.stdout
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

/** Parse `--format '{{json .}}'` output: one JSON object per line (tolerates a JSON array). */
function jsonLines<T = Record<string, unknown>>(out: string): T[] {
  const trimmed = out.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      return Array.isArray(arr) ? (arr as T[]) : []
    } catch {
      /* fall through to per-line */
    }
  }
  const res: T[] = []
  for (const line of trimmed.split('\n')) {
    const l = line.trim()
    if (!l.startsWith('{')) continue
    try {
      res.push(JSON.parse(l) as T)
    } catch {
      /* skip malformed */
    }
  }
  return res
}

function sections(out: string): Record<string, string> {
  const res: Record<string, string> = {}
  let cur = ''
  const buf: string[] = []
  const flush = (): void => {
    if (cur) res[cur] = buf.join('\n')
    buf.length = 0
  }
  for (const line of out.split('\n')) {
    const m = line.match(/^__([A-Z]+)$/)
    if (m) {
      flush()
      cur = m[1]
      continue
    }
    if (cur) buf.push(line)
  }
  flush()
  return res
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

function pct(v: unknown): number | undefined {
  const n = parseFloat(str(v).replace('%', ''))
  return Number.isFinite(n) ? n : undefined
}

function toInt(v: unknown): number {
  const n = parseInt(str(v), 10)
  return Number.isFinite(n) ? n : 0
}

/** Container / image / volume / network reference: ids, names, image refs. */
function assertRef(s: unknown, what: string): string {
  if (typeof s !== 'string' || s.length === 0 || s.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.\-/:@+]*$/.test(s) || s.includes('..')) throw new Error(`Invalid ${what}: ${String(s)}`)
  return s
}

function assertImageRef(s: unknown): string {
  // registry/ns/name:tag or name@sha256:digest
  if (typeof s !== 'string' || !s.trim()) throw new Error('Image is required')
  const v = s.trim()
  if (v.length > 255 || !/^[a-z0-9][a-z0-9._\-]*(:\d{1,5})?(\/[a-z0-9][a-z0-9._\-]*)*(:[A-Za-z0-9_.\-]+)?(@sha256:[a-f0-9]{64})?$/i.test(v)) throw new Error(`Invalid image reference: ${v}`)
  return v
}

/** Split a command line into words honouring single/double quotes, then shell-quote each. */
function splitWords(s: string): string[] {
  const words: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) words.push(cur)
      cur = ''
      has = false
    } else if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i]
    } else cur += ch
  }
  if (quote) throw new Error('Unbalanced quotes in command')
  if (cur || has) words.push(cur)
  return words
}

function sumReclaimed(out: string): number {
  let total = 0
  for (const m of out.matchAll(/Total reclaimed space:\s*([\d.]+)\s*([KMGT]?i?B)/gi)) {
    const n = parseFloat(m[1])
    const u = m[2].toUpperCase()
    const mult = u.startsWith('K') ? 1024 : u.startsWith('M') ? 1024 ** 2 : u.startsWith('G') ? 1024 ** 3 : u.startsWith('T') ? 1024 ** 4 : 1
    if (Number.isFinite(n)) total += n * mult
  }
  return total
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/* ------------------------------------------------------------------ */
/* File helpers (compose files may be root-owned)                      */
/* ------------------------------------------------------------------ */

async function execSmart(ssh: SshClient, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const r = await ssh.exec(`sh -c ${shq(script)}`, opts)
  if (r.code !== 0 && /permission denied/i.test(r.stderr + r.stdout) && ssh.os?.sudoAvailable && !ssh.os?.isRoot) {
    return ssh.exec(`sh -c ${shq(script)}`, { ...opts, sudo: true })
  }
  return r
}

async function runSmart(ssh: SshClient, script: string, opts: ExecOptions = {}): Promise<string> {
  const r = await execSmart(ssh, script, opts)
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit code ${r.code}`).trim().split('\n').slice(-6).join('\n'))
  return r.stdout
}

const findComposeFile = (dir: string): string =>
  `for f in ${COMPOSE_FILES.join(' ')}; do if [ -f ${shq(dir)}/"$f" ]; then echo "$f"; exit 0; fi; done; exit 3`

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  // Forget the cached mode when a server disconnects (permissions may change after reconnect).
  ctx.sessions.on('state', (s: { serverId: string; status: string }) => {
    if (s.status !== 'connected') modes.delete(s.serverId)
  })

  // ---------------- info ----------------
  ctx.handle('docker:info', async (serverId: string): Promise<DockerInfo> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(
      [
        'echo __BIN; command -v docker 2>/dev/null',
        'echo __GROUP; id -nG 2>/dev/null',
        `echo __CLIENT; docker version --format '{{.Client.Version}}' 2>/dev/null`,
        'echo __COMPOSE; docker compose version --short 2>/dev/null || docker-compose version --short 2>/dev/null',
        'echo __SVC; systemctl is-active docker 2>/dev/null; echo; systemctl is-enabled docker 2>/dev/null',
        'echo __ROOTLESS; [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock" ] && echo yes',
        'echo __END'
      ].join('; '),
      { timeoutMs: 30000 }
    )
    const s = sections(r.stdout)
    const installed = Boolean(s.BIN?.trim())
    const groups = (s.GROUP ?? '').trim().split(/\s+/)
    const userInGroup = Boolean(ssh.os?.isRoot) || groups.includes('docker')
    const svc = (s.SVC ?? '').split('\n').map((l) => l.trim())
    const base: DockerInfo = {
      installed,
      running: false,
      version: s.CLIENT?.trim() || undefined,
      composeVersion: s.COMPOSE?.trim().split('\n')[0] || undefined,
      userInGroup,
      needsSudo: false,
      rootless: (s.ROOTLESS ?? '').includes('yes') || undefined,
      serviceActive: svc[0] || undefined,
      serviceEnabled: svc.filter(Boolean)[1] || undefined,
      hasSystemd: Boolean(ssh.os?.hasSystemd)
    }
    if (!installed) return base
    modes.delete(serverId)
    const m = await mode(ctx, serverId)
    base.needsSudo = m.sudo
    const info = await dx(ctx, serverId, `docker info --format '{{json .}}'`, { timeoutMs: 30000 })
    if (info.code === 0) {
      const j = jsonLines<Record<string, unknown>>(info.stdout)[0]
      if (j && j.ServerVersion) {
        base.running = true
        base.version = str(j.ServerVersion) || base.version
        base.info = {
          containers: toInt(j.Containers),
          running: toInt(j.ContainersRunning),
          paused: toInt(j.ContainersPaused),
          stopped: toInt(j.ContainersStopped),
          images: toInt(j.Images),
          serverVersion: str(j.ServerVersion),
          storageDriver: str(j.Driver),
          cgroupVersion: str(j.CgroupVersion)
        }
        if (j.SecurityOptions && Array.isArray(j.SecurityOptions) && (j.SecurityOptions as unknown[]).some((o) => String(o).includes('rootless'))) base.rootless = true
      }
    }
    return base
  })

  // ---------------- install ----------------
  ctx.handle('docker:install', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const pm = ssh.os?.pkgManager ?? 'unknown'
    const { id } = ctx.tasks.start('Install Docker', serverId, async (h) => {
      const stream: ExecOptions = { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) }
      if (pm === 'apt' || pm === 'dnf' || pm === 'yum') {
        h.log('Installing prerequisites…')
        await runPkg(ssh, installCmd(ssh, pm === 'apt' ? ['curl', 'ca-certificates'] : ['curl', 'ca-certificates']), stream).catch((e) => h.log(`(prerequisites: ${String(e)})`))
        h.log('Running the official convenience script (get.docker.com)…')
        await ssh.sudoRun('curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh; rc=$?; rm -f /tmp/get-docker.sh; exit $rc', { ...stream, env: { DEBIAN_FRONTEND: 'noninteractive' } })
      } else if (pm === 'apk') {
        h.log('Installing docker and docker-cli-compose from the Alpine repositories…')
        await runPkg(ssh, installCmd(ssh, ['docker', 'docker-cli-compose']), stream)
      } else if (pm === 'pacman') {
        h.log('Installing docker and docker-compose from the Arch repositories…')
        await runPkg(ssh, installCmd(ssh, ['docker', 'docker-compose']), stream)
      } else if (pm === 'zypper') {
        h.log('Installing docker and docker-compose from the openSUSE repositories…')
        await runPkg(ssh, installCmd(ssh, ['docker', 'docker-compose']), stream)
      } else {
        throw new Error('Unsupported package manager: cannot install Docker automatically')
      }
      if (ssh.os?.hasSystemd) {
        h.log('Enabling and starting the docker service…')
        await ssh.sudoRun('systemctl enable --now docker', stream)
      } else if (pm === 'apk') {
        h.log('Enabling docker with OpenRC…')
        await ssh.sudoRun('rc-update add docker default; rc-service docker start', stream).catch((e) => h.log(String(e)))
      }
      const user = ssh.os?.user
      if (user && !ssh.os?.isRoot) {
        h.log(`Adding ${user} to the docker group…`)
        await ssh.sudoRun(`groupadd -f docker; usermod -aG docker ${shq(user)}`, stream).catch((e) => h.log(String(e)))
        h.log('NOTE: group membership takes effect after you disconnect and reconnect. Until then docker runs through sudo.')
      }
      modes.delete(serverId)
      const v = await ssh.exec(`sudo -n docker --version 2>/dev/null || docker --version 2>/dev/null`)
      h.log(`Done. ${v.stdout.trim()}`)
      ctx.audit(serverId, 'docker.install')
    })
    return id
  })

  // ---------------- daemon service ----------------
  ctx.handle('docker:serviceToggle', async (serverId: string, action: DockerServiceAction) => {
    const ssh = ctx.ssh(serverId)
    if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error('Invalid action')
    if (!ssh.os?.hasSystemd) {
      if (action === 'enable' || action === 'disable') throw new Error('Enabling/disabling the daemon requires systemd')
      await ssh.sudoRun(`service docker ${action} 2>/dev/null || rc-service docker ${action}`)
    } else if (action === 'stop') {
      await ssh.sudoRun('systemctl stop docker.socket docker.service 2>/dev/null || systemctl stop docker')
    } else if (action === 'enable') {
      await ssh.sudoRun('systemctl enable docker')
    } else {
      await ssh.sudoRun(`systemctl ${action} docker`)
    }
    modes.delete(serverId)
    ctx.audit(serverId, `docker.service.${action}`)
  })

  // ---------------- containers ----------------
  ctx.handle('docker:containers', async (serverId: string): Promise<DockerContainer[]> => {
    const r = await dx(ctx, serverId, `echo __PS; docker ps -a --format '{{json .}}'; echo "__PSRC=$?"; echo __STATS; docker stats --no-stream --format '{{json .}}' 2>/dev/null; echo __END`, { timeoutMs: 45000 })
    if (Number(r.stdout.match(/__PSRC=(\d+)/)?.[1] ?? 0) !== 0) throw new Error(r.stderr.trim() || 'docker ps failed (is the daemon running?)')
    const s = sections(r.stdout)
    if (!s.PS && r.code !== 0) throw new Error(r.stderr.trim() || 'docker ps failed')
    const ps = jsonLines<Record<string, unknown>>(s.PS ?? '')
    const stats = jsonLines<Record<string, unknown>>(s.STATS ?? '')
    const byName = new Map<string, Record<string, unknown>>()
    const byId = new Map<string, Record<string, unknown>>()
    for (const st of stats) {
      if (st.Name) byName.set(str(st.Name), st)
      if (st.ID) byId.set(str(st.ID).slice(0, 12), st)
    }
    return ps.map((c) => {
      const id = str(c.ID)
      const name = str(c.Names).split(',')[0]
      const st = byName.get(name) ?? byId.get(id.slice(0, 12))
      return {
        id,
        name,
        image: str(c.Image),
        state: str(c.State),
        status: str(c.Status),
        ports: str(c.Ports),
        created: str(c.CreatedAt || c.RunningFor),
        cpuPct: st ? pct(st.CPUPerc) : undefined,
        memUsage: st ? str(st.MemUsage) : undefined,
        memPct: st ? pct(st.MemPerc) : undefined
      }
    })
  })

  ctx.handle('docker:containerAction', async (serverId: string, id: string, action: DockerContainerAction) => {
    assertRef(id, 'container')
    const map: Record<DockerContainerAction, string> = {
      start: 'start',
      stop: 'stop',
      restart: 'restart',
      pause: 'pause',
      unpause: 'unpause',
      kill: 'kill',
      remove: 'rm',
      removeForce: 'rm -f'
    }
    const sub = map[action]
    if (!sub) throw new Error(`Invalid action: ${String(action)}`)
    await dxRun(ctx, serverId, `docker ${sub} ${shq(id)}`, { timeoutMs: 180000 })
    ctx.audit(serverId, `docker.container.${action}`, id)
  })

  ctx.handle('docker:logs', async (serverId: string, id: string, opts: DockerLogsOpts): Promise<string> => {
    assertRef(id, 'container')
    const tail = Math.max(1, Math.min(20000, Math.floor(Number(opts?.tail) || 200)))
    const args = [`--tail ${tail}`]
    if (opts?.since && /^[A-Za-z0-9:.\-TZ+]+$/.test(opts.since)) args.push(`--since ${shq(opts.since)}`)
    if (opts?.timestamps) args.push('-t')
    const r = await dx(ctx, serverId, `docker logs ${args.join(' ')} ${shq(id)} 2>&1`, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
    if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || r.stdout.trim() || 'docker logs failed')
    return r.stdout
  })

  ctx.handle('docker:logsFollow', async (serverId: string, id: string) => {
    assertRef(id, 'container')
    const { id: taskId } = ctx.tasks.start(`Logs: ${id.slice(0, 24)}`, serverId, async (h) => {
      h.log(`Following logs of ${id} (cancel the task to stop)…`)
      await dx(ctx, serverId, `docker logs -f --tail 200 ${shq(id)} 2>&1`, { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c), maxBuffer: 1024 })
    })
    return taskId
  })

  ctx.handle('docker:inspect', async (serverId: string, id: string): Promise<unknown> => {
    assertRef(id, 'object')
    const out = await dxRun(ctx, serverId, `docker inspect ${shq(id)}`, { timeoutMs: 30000 })
    const arr = JSON.parse(out) as unknown[]
    return Array.isArray(arr) ? arr[0] ?? null : arr
  })

  ctx.handle('docker:top', async (serverId: string, id: string): Promise<DockerTop> => {
    assertRef(id, 'container')
    const out = await dxRun(ctx, serverId, `docker top ${shq(id)}`, { timeoutMs: 30000 })
    const lines = out.split('\n').filter((l) => l.trim())
    if (!lines.length) return { titles: [], processes: [] }
    const titles = lines[0].trim().split(/\s+/)
    const processes = lines.slice(1).map((l) => {
      const parts = l.trim().split(/\s+/)
      if (parts.length <= titles.length) return parts
      return [...parts.slice(0, titles.length - 1), parts.slice(titles.length - 1).join(' ')]
    })
    return { titles, processes }
  })

  ctx.handle('docker:stats', async (serverId: string): Promise<DockerStats[]> => {
    const out = await dxRun(ctx, serverId, `docker stats --no-stream --format '{{json .}}'`, { timeoutMs: 45000 })
    return jsonLines<Record<string, unknown>>(out).map((s) => ({
      id: str(s.ID),
      name: str(s.Name),
      cpuPct: pct(s.CPUPerc) ?? 0,
      memUsage: str(s.MemUsage),
      memPct: pct(s.MemPerc) ?? 0,
      netIO: str(s.NetIO),
      blockIO: str(s.BlockIO),
      pids: toInt(s.PIDs)
    }))
  })

  // ---------------- images ----------------
  ctx.handle('docker:images', async (serverId: string): Promise<DockerImage[]> => {
    const out = await dxRun(ctx, serverId, `docker images --format '{{json .}}'`, { timeoutMs: 30000 })
    return jsonLines<Record<string, unknown>>(out).map((i) => ({
      id: str(i.ID),
      repository: str(i.Repository),
      tag: str(i.Tag),
      size: str(i.Size),
      created: str(i.CreatedAt || i.CreatedSince),
      dangling: str(i.Repository) === '<none>' || str(i.Tag) === '<none>'
    }))
  })

  ctx.handle('docker:pull', async (serverId: string, image: string) => {
    const ref = assertImageRef(image)
    const { id } = ctx.tasks.start(`Pull ${ref}`, serverId, async (h) => {
      await dxRun(ctx, serverId, `docker pull ${shq(ref)}`, { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      ctx.audit(serverId, 'docker.pull', ref)
    })
    return id
  })

  ctx.handle('docker:removeImage', async (serverId: string, id: string, force?: boolean) => {
    assertRef(id, 'image')
    await dxRun(ctx, serverId, `docker rmi ${force ? '-f ' : ''}${shq(id)}`, { timeoutMs: 120000 })
    ctx.audit(serverId, 'docker.image.remove', id)
  })

  ctx.handle('docker:pruneImages', async (serverId: string, all?: boolean): Promise<string> => {
    const out = await dxRun(ctx, serverId, `docker image prune -f ${all ? '-a' : ''}`, { timeoutMs: 300000 })
    ctx.audit(serverId, 'docker.image.prune', all ? 'all unused' : 'dangling')
    return out.match(/Total reclaimed space:.*/)?.[0] ?? out.trim()
  })

  ctx.handle('docker:imageHistory', async (serverId: string, id: string) => {
    assertRef(id, 'image')
    const out = await dxRun(ctx, serverId, `docker history --no-trunc --format '{{json .}}' ${shq(id)}`, { timeoutMs: 30000 })
    return jsonLines<Record<string, unknown>>(out).map((h) => ({ id: str(h.ID), created: str(h.CreatedSince || h.CreatedAt), createdBy: str(h.CreatedBy), size: str(h.Size), comment: str(h.Comment) }))
  })

  // ---------------- volumes ----------------
  ctx.handle('docker:volumes', async (serverId: string): Promise<DockerVolume[]> => {
    const r = await dx(ctx, serverId, `echo __VOL; docker volume ls --format '{{json .}}'; echo "__PSRC=$?"; echo __DF; timeout 20 docker system df -v --format '{{json .}}' 2>/dev/null; echo __END`, { timeoutMs: 45000 })
    if (Number(r.stdout.match(/__PSRC=(\d+)/)?.[1] ?? 0) !== 0) throw new Error(r.stderr.trim() || 'docker volume ls failed (is the daemon running?)')
    const s = sections(r.stdout)
    if (!s.VOL?.trim() && r.code !== 0) throw new Error(r.stderr.trim() || 'docker volume ls failed')
    const sizes = new Map<string, string>()
    const df = jsonLines<Record<string, unknown>>(s.DF ?? '')[0]
    if (df && Array.isArray(df.Volumes)) {
      for (const v of df.Volumes as Record<string, unknown>[]) if (v.Name) sizes.set(str(v.Name), str(v.Size))
    }
    return jsonLines<Record<string, unknown>>(s.VOL ?? '').map((v) => ({
      name: str(v.Name),
      driver: str(v.Driver),
      mountpoint: str(v.Mountpoint),
      size: sizes.get(str(v.Name)) ?? (str(v.Size) && str(v.Size) !== 'N/A' ? str(v.Size) : undefined)
    }))
  })

  ctx.handle('docker:createVolume', async (serverId: string, name: string, driver?: string) => {
    assertSafeName(name, 'volume name')
    const drv = driver ? assertSafeName(driver, 'driver') : 'local'
    await dxRun(ctx, serverId, `docker volume create --driver ${shq(drv)} ${shq(name)}`)
    ctx.audit(serverId, 'docker.volume.create', name)
  })

  ctx.handle('docker:removeVolume', async (serverId: string, name: string, force?: boolean) => {
    assertRef(name, 'volume')
    await dxRun(ctx, serverId, `docker volume rm ${force ? '-f ' : ''}${shq(name)}`)
    ctx.audit(serverId, 'docker.volume.remove', name)
  })

  ctx.handle('docker:pruneVolumes', async (serverId: string): Promise<string> => {
    const out = await dxRun(ctx, serverId, 'docker volume prune -f', { timeoutMs: 300000 })
    ctx.audit(serverId, 'docker.volume.prune')
    return out.match(/Total reclaimed space:.*/)?.[0] ?? out.trim()
  })

  // ---------------- networks ----------------
  ctx.handle('docker:networks', async (serverId: string): Promise<DockerNetwork[]> => {
    const out = await dxRun(ctx, serverId, `docker network ls --format '{{json .}}'`, { timeoutMs: 30000 })
    return jsonLines<Record<string, unknown>>(out).map((n) => ({ id: str(n.ID), name: str(n.Name), driver: str(n.Driver), scope: str(n.Scope) }))
  })

  ctx.handle('docker:createNetwork', async (serverId: string, spec: DockerNetworkCreate) => {
    assertSafeName(spec?.name, 'network name')
    if (!['bridge', 'overlay', 'macvlan'].includes(spec.driver)) throw new Error('Invalid network driver')
    const args = [`--driver ${spec.driver}`]
    if (spec.subnet) {
      if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$|^[0-9a-fA-F:]+\/\d{1,3}$/.test(spec.subnet.trim())) throw new Error('Invalid subnet (expected CIDR, e.g. 172.30.0.0/16)')
      args.push(`--subnet ${shq(spec.subnet.trim())}`)
    }
    await dxRun(ctx, serverId, `docker network create ${args.join(' ')} ${shq(spec.name)}`)
    ctx.audit(serverId, 'docker.network.create', spec.name)
  })

  ctx.handle('docker:removeNetwork', async (serverId: string, id: string) => {
    assertRef(id, 'network')
    await dxRun(ctx, serverId, `docker network rm ${shq(id)}`)
    ctx.audit(serverId, 'docker.network.remove', id)
  })

  ctx.handle('docker:pruneNetworks', async (serverId: string): Promise<string> => {
    const out = await dxRun(ctx, serverId, 'docker network prune -f', { timeoutMs: 120000 })
    ctx.audit(serverId, 'docker.network.prune')
    return out.trim()
  })

  ctx.handle('docker:networkInspect', async (serverId: string, id: string): Promise<unknown> => {
    assertRef(id, 'network')
    const out = await dxRun(ctx, serverId, `docker network inspect ${shq(id)}`, { timeoutMs: 30000 })
    const arr = JSON.parse(out) as unknown[]
    return Array.isArray(arr) ? arr[0] ?? null : arr
  })

  // ---------------- run ----------------
  ctx.handle('docker:run', async (serverId: string, spec: DockerRunSpec) => {
    const image = assertImageRef(spec?.image)
    const args: string[] = ['run']
    if (spec.detach !== false) args.push('-d')
    if (spec.name?.trim()) args.push('--name', shq(assertSafeName(spec.name.trim(), 'container name')))
    for (const p of spec.ports ?? []) {
      const host = assertPort(Number(p.host))
      const cont = assertPort(Number(p.container))
      const proto = p.proto === 'udp' ? 'udp' : 'tcp'
      args.push('-p', `${host}:${cont}/${proto}`)
    }
    for (const e of spec.env ?? []) {
      const k = String(e.k ?? '').trim()
      if (!k) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable name: ${k}`)
      args.push('-e', shq(`${k}=${String(e.v ?? '')}`))
    }
    for (const v of spec.volumes ?? []) {
      const host = String(v.host ?? '').trim()
      const cont = String(v.container ?? '').trim()
      if (!host || !cont) continue
      if (host.startsWith('/')) assertAbsPath(host)
      else assertSafeName(host, 'volume name')
      assertAbsPath(cont)
      args.push('-v', shq(`${host}:${cont}${v.ro ? ':ro' : ''}`))
    }
    const restart = spec.restart ?? 'no'
    if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(restart)) throw new Error('Invalid restart policy')
    if (restart !== 'no') args.push('--restart', restart)
    if (spec.network?.trim()) args.push('--network', shq(assertSafeName(spec.network.trim(), 'network')))
    if (spec.extraArgs?.trim()) {
      for (const tok of splitWords(spec.extraArgs.trim())) {
        if (/^(--privileged|--pid|--userns|--ipc|--cap-add|--security-opt|--device|-v|--volume|--mount)(=|$)/.test(tok)) throw new Error(`Refusing extra argument ${tok}; use the form fields instead`)
        args.push(shq(tok))
      }
    }
    args.push(shq(image))
    if (spec.command?.trim()) for (const tok of splitWords(spec.command.trim())) args.push(shq(tok))
    const cmd = `docker ${args.join(' ')}`
    const { id } = ctx.tasks.start(`Run ${spec.name?.trim() || image}`, serverId, async (h) => {
      const stream: ExecOptions = { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) }
      if (spec.pull) {
        h.log(`$ docker pull ${image}`)
        await dxRun(ctx, serverId, `docker pull ${shq(image)}`, stream)
      }
      h.log(`$ ${cmd}`)
      const out = await dxRun(ctx, serverId, cmd, stream)
      h.log(`Container started: ${out.trim().slice(0, 12)}`)
      ctx.audit(serverId, 'docker.run', `${spec.name ?? ''} ${image}`.trim())
    })
    return id
  })

  // ---------------- system / prune ----------------
  ctx.handle('docker:systemDf', async (serverId: string): Promise<DockerSystemDf> => {
    const r = await dx(ctx, serverId, `echo __DF; docker system df --format '{{json .}}'; echo __DFV; timeout 25 docker system df -v --format '{{json .}}' 2>/dev/null; echo __END`, { timeoutMs: 60000 })
    const s = sections(r.stdout)
    if (!s.DF?.trim()) throw new Error(r.stderr.trim() || 'docker system df failed')
    const rows = jsonLines<Record<string, unknown>>(s.DF).map((row) => ({
      type: str(row.Type),
      totalCount: toInt(row.TotalCount),
      active: toInt(row.Active),
      size: str(row.Size),
      reclaimable: str(row.Reclaimable)
    }))
    const res: DockerSystemDf = { rows }
    const v = jsonLines<Record<string, unknown>>(s.DFV ?? '')[0]
    if (v) {
      res.verbose = {
        volumes: Array.isArray(v.Volumes) ? (v.Volumes as Record<string, unknown>[]).map((x) => ({ name: str(x.Name), size: str(x.Size), links: toInt(x.Links) })) : [],
        containers: Array.isArray(v.Containers)
          ? (v.Containers as Record<string, unknown>[]).map((x) => ({ id: str(x.ID), name: str(x.Names), size: str(x.Size), status: str(x.Status) }))
          : []
      }
    }
    return res
  })

  ctx.handle('docker:prune', async (serverId: string, opts: DockerPruneOpts) => {
    const steps: { label: string; cmd: string }[] = []
    if (opts?.containers) steps.push({ label: 'stopped containers', cmd: 'docker container prune -f' })
    if (opts?.images) steps.push({ label: opts.allImages ? 'all unused images' : 'dangling images', cmd: `docker image prune -f${opts.allImages ? ' -a' : ''}` })
    if (opts?.volumes) steps.push({ label: 'unused anonymous volumes', cmd: 'docker volume prune -f' })
    if (opts?.networks) steps.push({ label: 'unused networks', cmd: 'docker network prune -f' })
    if (opts?.buildCache) steps.push({ label: 'build cache', cmd: `docker builder prune -f${opts.allImages ? ' -a' : ''}` })
    if (!steps.length) throw new Error('Nothing selected to prune')
    const { id } = ctx.tasks.start('Docker prune', serverId, async (h) => {
      let all = ''
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i]
        h.log(`\n== Pruning ${st.label} ==`)
        h.log(`$ ${st.cmd}`)
        const out = await dxRun(ctx, serverId, st.cmd, { timeoutMs: 600000, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
        all += out + '\n'
        h.progress(((i + 1) / steps.length) * 100)
      }
      h.log(`\nTotal reclaimed: ${fmtBytes(sumReclaimed(all))}`)
      ctx.audit(serverId, 'docker.prune', steps.map((s) => s.label).join(', '))
    })
    return id
  })

  // ---------------- compose ----------------
  ctx.handle('docker:compose:projects', async (serverId: string): Promise<ComposeProject[]> => {
    const m = await mode(ctx, serverId)
    const lsCmd = m.compose === 'docker compose' ? 'docker compose ls -a --format json 2>/dev/null' : m.compose === 'docker-compose' ? 'docker-compose ls -a --format json 2>/dev/null' : 'true'
    const r = await dx(
      ctx,
      serverId,
      `echo __LS; ${lsCmd}; echo __LABELS; docker ps -a --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.State}}' 2>/dev/null; echo __END`,
      { timeoutMs: 45000 }
    )
    const s = sections(r.stdout)
    const byName = new Map<string, ComposeProject>()
    for (const p of jsonLines<Record<string, unknown>>(s.LS ?? '')) {
      const files = str(p.ConfigFiles)
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
      const dir = files[0] ? files[0].replace(/\/[^/]*$/, '') || '/' : ''
      byName.set(str(p.Name), { name: str(p.Name), status: str(p.Status), configFiles: files, dir })
    }
    // Fallback / enrichment from container labels.
    const counts = new Map<string, { running: number; total: number; dir: string; files: string[] }>()
    for (const line of (s.LABELS ?? '').split('\n')) {
      const [name, dir, files, state] = line.split('|')
      if (!name) continue
      const c = counts.get(name) ?? { running: 0, total: 0, dir: dir ?? '', files: (files ?? '').split(',').filter(Boolean) }
      c.total++
      if (state === 'running') c.running++
      counts.set(name, c)
    }
    for (const [name, c] of counts) {
      const existing = byName.get(name)
      if (existing) {
        existing.running = c.running
        existing.total = c.total
        if (!existing.dir && c.dir) existing.dir = c.dir
        if (!existing.configFiles.length) existing.configFiles = c.files
      } else {
        byName.set(name, { name, status: c.running === c.total ? `running(${c.total})` : c.running === 0 ? `exited(${c.total})` : `running(${c.running}), exited(${c.total - c.running})`, configFiles: c.files, dir: c.dir, running: c.running, total: c.total })
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

  ctx.handle('docker:compose:action', async (serverId: string, projectDir: string, action: ComposeAction) => {
    assertAbsPath(projectDir)
    const m = await mode(ctx, serverId)
    if (!m.compose) throw new Error('Docker Compose is not installed (neither the compose plugin nor docker-compose)')
    const sub: Record<ComposeAction, string> = {
      up: 'up -d --remove-orphans',
      down: 'down',
      restart: 'restart',
      pull: 'pull',
      ps: 'ps',
      logs: 'logs --tail 300 --no-color'
    }
    if (!sub[action]) throw new Error(`Invalid compose action: ${String(action)}`)
    const cmd = `cd ${shq(projectDir)} && ${m.compose} ${sub[action]}`
    const { id } = ctx.tasks.start(`compose ${action}: ${projectDir}`, serverId, async (h) => {
      h.log(`$ ${cmd}`)
      await dxRun(ctx, serverId, cmd, { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c), env: { COMPOSE_ANSI: 'never' } })
      ctx.audit(serverId, `docker.compose.${action}`, projectDir)
    })
    return id
  })

  ctx.handle('docker:compose:readFile', async (serverId: string, dir: string): Promise<ComposeFile> => {
    assertAbsPath(dir)
    const ssh = ctx.ssh(serverId)
    const found = await execSmart(ssh, findComposeFile(dir), { timeoutMs: 15000 })
    if (found.code !== 0) throw new Error(`No compose file found in ${dir} (looked for ${COMPOSE_FILES.join(', ')})`)
    const file = found.stdout.trim().split('\n')[0]
    const path = `${dir.replace(/\/+$/, '')}/${file}`
    const content = await runSmart(ssh, `cat ${shq(path)}`, { timeoutMs: 15000, maxBuffer: 4 * 1024 * 1024 })
    return { path, content }
  })

  ctx.handle('docker:compose:writeFile', async (serverId: string, dir: string, content: string) => {
    assertAbsPath(dir)
    if (typeof content !== 'string') throw new Error('Content must be a string')
    const ssh = ctx.ssh(serverId)
    const found = await execSmart(ssh, findComposeFile(dir), { timeoutMs: 15000 })
    const file = found.code === 0 ? found.stdout.trim().split('\n')[0] : 'compose.yaml'
    const path = `${dir.replace(/\/+$/, '')}/${file}`
    await runSmart(ssh, `cp -f ${shq(path)} ${shq(path + '.bak')} 2>/dev/null; ${b64Echo(content)} > ${shq(path)}`, { timeoutMs: 30000 })
    ctx.audit(serverId, 'docker.compose.write', path)
    return path
  })

  ctx.handle('docker:compose:create', async (serverId: string, dir: string, content: string) => {
    assertAbsPath(dir)
    if (typeof content !== 'string' || !content.trim()) throw new Error('Compose file content is required')
    const ssh = ctx.ssh(serverId)
    const clean = dir.replace(/\/+$/, '')
    const exists = await execSmart(ssh, findComposeFile(clean), { timeoutMs: 15000 })
    if (exists.code === 0) throw new Error(`${clean} already contains ${exists.stdout.trim()}`)
    const path = `${clean}/compose.yaml`
    await runSmart(ssh, `mkdir -p ${shq(clean)} && ${b64Echo(content)} > ${shq(path)}`, { timeoutMs: 30000 })
    ctx.audit(serverId, 'docker.compose.create', path)
    return path
  })
}
