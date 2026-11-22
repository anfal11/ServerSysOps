import type { Ctx } from '../core'
import type { SshClient } from '../ssh/SshClient'
import type { TaskHandle } from '../tasks/TaskManager'
import { assertSafeName, shJoin, shq } from '../ssh/shell'
import { pkgEnv, refreshCmd } from './pkg'
import type { PkgUpdateInput, PkgVersion } from '@shared/modules/pkg'

/**
 * Per-package version checks and one-click upgrades of single packages
 * (nginx, docker-ce, php8.3-fpm, …) from the configured distro repositories.
 */

const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/
const REFRESH_MS = 30 * 60 * 1000

/** serverId -> timestamp of the last successful package list refresh. */
const lastRefresh = new Map<string, number>()

function assertPkgs(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('No packages given')
  const out: string[] = []
  for (const p of input) {
    if (typeof p !== 'string' || p.length > 128 || !PKG_RE.test(p)) throw new Error(`Invalid package name: ${String(p)}`)
    if (!out.includes(p)) out.push(p)
  }
  return out
}

function tail(s: string, lines = 12): string {
  return s.trim().split('\n').slice(-lines).join('\n')
}

/** Refresh the package index when it is older than 30 minutes (apt/apk only; the others refresh on demand). Never throws. */
async function ensureFresh(ssh: SshClient, serverId: string, force: boolean, h?: TaskHandle): Promise<void> {
  const pm = ssh.os?.pkgManager
  if (!pm || pm === 'unknown') return
  if (!force) {
    if (pm !== 'apt' && pm !== 'apk') return
    const last = lastRefresh.get(serverId) ?? 0
    if (Date.now() - last < REFRESH_MS) return
  }
  try {
    const cmd = refreshCmd(ssh)
    const out: string[] = []
    const r = await ssh.sudo(cmd, {
      timeoutMs: 300000,
      env: pkgEnv(),
      signal: h?.signal,
      onStdout: (c) => (h ? h.append(c) : out.push(c)),
      onStderr: (c) => (h ? h.append(c) : out.push(c))
    })
    if (r.code === 0) lastRefresh.set(serverId, Date.now())
    else if (h) throw new Error(`${cmd} failed (exit ${r.code})\n${tail(r.stderr || r.stdout)}`)
    else {
      // Non-fatal: a stale list only means "no update shown". Do not retry for a while either.
      lastRefresh.set(serverId, Date.now())
    }
  } catch (e) {
    if (h) throw e
    lastRefresh.set(serverId, Date.now())
  }
}

/* ------------------------------------------------------------------ */
/* Version lookup per package manager                                  */
/* ------------------------------------------------------------------ */

type Found = Map<string, { installed?: string; candidate?: string }>

function entry(found: Found, name: string): { installed?: string; candidate?: string } {
  let e = found.get(name)
  if (!e) {
    e = {}
    found.set(name, e)
  }
  return e
}

function none(v: string | undefined): string | undefined {
  const s = (v ?? '').trim()
  return !s || s === '(none)' ? undefined : s
}

async function aptVersions(ssh: SshClient, pkgs: string[], found: Found): Promise<void> {
  const r = await ssh.exec(`LC_ALL=C apt-cache policy ${shJoin(pkgs)} 2>/dev/null`, { timeoutMs: 60000 })
  let cur: string | null = null
  for (const line of r.stdout.split('\n')) {
    const head = line.match(/^(\S+):\s*$/)
    if (head) {
      cur = pkgs.includes(head[1]) ? head[1] : null
      continue
    }
    if (!cur) continue
    const m = line.match(/^\s+(Installed|Candidate):\s*(.*)$/)
    if (!m) continue
    const e = entry(found, cur)
    if (m[1] === 'Installed') e.installed = none(m[2])
    else e.candidate = none(m[2])
  }
}

async function rpmVersions(ssh: SshClient, pkgs: string[], found: Found): Promise<void> {
  const r = await ssh.exec(`rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}\\n' ${shJoin(pkgs)} 2>/dev/null`, { timeoutMs: 60000 })
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\S+) (\S+)$/)
    if (m && pkgs.includes(m[1])) entry(found, m[1]).installed = m[2]
  }
}

async function dnfVersions(ssh: SshClient, pkgs: string[], found: Found): Promise<void> {
  await rpmVersions(ssh, pkgs, found)
  const installed = pkgs.filter((p) => found.get(p)?.installed)
  if (!installed.length) return
  const pm = ssh.os?.pkgManager === 'yum' ? 'yum' : 'dnf'
  // exit 100 = updates available, 0 = none, anything else = error (ignored: no candidate shown)
  const r = await ssh.exec(`LC_ALL=C ${pm} -q check-update ${shJoin(installed)} 2>/dev/null`, { timeoutMs: 300000 })
  if (r.code !== 100 && r.code !== 0) return
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\S+)\.(\S+)\s+(\S+)\s+\S+/)
    if (!m || /^Obsoleting|^Last metadata|^Security:/.test(line)) continue
    const name = m[1]
    if (installed.includes(name)) entry(found, name).candidate = m[3]
  }
}

async function zypperVersions(ssh: SshClient, pkgs: string[], found: Found): Promise<void> {
  const r = await ssh.exec(`LC_ALL=C zypper --non-interactive -q info ${shJoin(pkgs)} 2>/dev/null`, { timeoutMs: 300000 })
  let cur: string | null = null
  for (const line of r.stdout.split('\n')) {
    const head = line.match(/^Information for package (\S+):/)
    if (head) {
      cur = pkgs.includes(head[1]) ? head[1] : null
      continue
    }
    if (!cur) continue
    const m = line.match(/^(Version|Installed|Status)\s*:\s*(.*)$/)
    if (!m) continue
    const e = entry(found, cur)
    const val = m[2].trim()
    if (m[1] === 'Version') e.candidate = val || undefined
    else if (m[1] === 'Installed') {
      if (/^yes/i.test(val) && !e.installed) e.installed = e.candidate
    } else {
      // Status : out-of-date (version 1.2-3 installed)  |  up-to-date  |  not installed
      const o = val.match(/out-of-date \(version (\S+) installed\)/)
      if (o) e.installed = o[1]
      else if (/not installed/i.test(val)) e.installed = undefined
    }
  }
}

async function apkVersions(ssh: SshClient, pkgs: string[], found: Found): Promise<void> {
  const r = await ssh.exec(`apk version ${shJoin(pkgs)} 2>/dev/null`, { timeoutMs: 60000 })
  for (const line of r.stdout.split('\n')) {
    // nginx-1.24.0-r6    < 1.26.2-r0
    const m = line.match(/^(.*?)-(\d\S*)\s+([<=>?])\s+(\S+)\s*$/)
    if (!m || !pkgs.includes(m[1])) continue
    const e = entry(found, m[1])
    e.installed = m[2]
    e.candidate = m[3] === '?' ? undefined : m[3] === '<' ? m[4] : m[2]
  }
}

async function pacmanVersions(ssh: SshClient, pkgs: string[], found: Found): Promise<void> {
  const parse = (out: string, key: 'installed' | 'candidate'): void => {
    let cur: string | null = null
    for (const line of out.split('\n')) {
      const m = line.match(/^(Name|Version)\s*:\s*(\S+)/)
      if (!m) continue
      if (m[1] === 'Name') cur = pkgs.includes(m[2]) ? m[2] : null
      else if (cur) entry(found, cur)[key] = m[2]
    }
  }
  const q = await ssh.exec(`LC_ALL=C pacman -Qi ${shJoin(pkgs)} 2>/dev/null`, { timeoutMs: 60000 })
  parse(q.stdout, 'installed')
  const installed = pkgs.filter((p) => found.get(p)?.installed)
  if (!installed.length) return
  const s = await ssh.exec(`LC_ALL=C pacman -Si ${shJoin(installed)} 2>/dev/null`, { timeoutMs: 120000 })
  parse(s.stdout, 'candidate')
}

async function lookup(ssh: SshClient, pkgs: string[]): Promise<PkgVersion[]> {
  const found: Found = new Map()
  switch (ssh.os?.pkgManager) {
    case 'apt':
      await aptVersions(ssh, pkgs, found)
      break
    case 'dnf':
    case 'yum':
      await dnfVersions(ssh, pkgs, found)
      break
    case 'zypper':
      await zypperVersions(ssh, pkgs, found)
      break
    case 'apk':
      await apkVersions(ssh, pkgs, found)
      break
    case 'pacman':
      await pacmanVersions(ssh, pkgs, found)
      break
    default:
      throw new Error('Unsupported package manager')
  }
  return pkgs.map((name) => {
    const e = found.get(name) ?? {}
    const installed = none(e.installed)
    const candidate = none(e.candidate)
    return { name, installed, candidate, updatable: !!installed && !!candidate && candidate !== installed }
  })
}

/* ------------------------------------------------------------------ */
/* Upgrade command per package manager                                 */
/* ------------------------------------------------------------------ */

function upgradeCmd(ssh: SshClient, pkgs: string[]): string {
  const p = shJoin(pkgs)
  switch (ssh.os?.pkgManager) {
    case 'apt':
      return `apt-get install --only-upgrade -y -qq -o Dpkg::Options::=--force-confold ${p}`
    case 'dnf':
      return `dnf -y upgrade ${p}`
    case 'yum':
      return `yum -y update ${p}`
    case 'zypper':
      return `zypper --non-interactive update ${p}`
    case 'apk':
      return `apk upgrade ${p}`
    case 'pacman':
      return `pacman -S --noconfirm ${p}`
    default:
      throw new Error('Unsupported package manager')
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  ctx.handle('pkg:versions', async (serverId: string, packages: string[]): Promise<PkgVersion[]> => {
    const pkgs = assertPkgs(packages)
    const ssh = ctx.ssh(serverId)
    await ensureFresh(ssh, serverId, false)
    return lookup(ssh, pkgs)
  })

  ctx.handle('pkg:update', async (serverId: string, input: PkgUpdateInput): Promise<string> => {
    const pkgs = assertPkgs(input?.packages)
    const restart = (input?.restart ?? []).map((s) => assertSafeName(s, 'service name'))
    const ssh = ctx.ssh(serverId)
    const cmd = upgradeCmd(ssh, pkgs)
    const title = `Update ${pkgs.join(', ')}`
    const { id } = ctx.tasks.start(title, serverId, async (h) => {
      h.log(`$ ${cmd}`)
      let out = ''
      const collect = (c: string): void => {
        out = (out + c).slice(-64 * 1024)
        h.append(c)
      }
      const r = await ssh.sudo(cmd, { timeoutMs: 1800000, env: pkgEnv(), signal: h.signal, onStdout: collect, onStderr: collect })
      if (r.code !== 0) {
        ctx.audit(serverId, 'pkg.update', pkgs.join(' '), false)
        throw new Error(`Upgrade failed (exit code ${r.code}):\n${tail(out || r.stderr || r.stdout) || 'no output'}`)
      }
      ctx.audit(serverId, 'pkg.update', pkgs.join(' '))
      for (const svc of restart) {
        if (ssh.os?.hasSystemd) {
          h.log(`$ systemctl restart ${svc}`)
          const rs = await ssh.sudo(`systemctl restart ${shq(svc)}`, { timeoutMs: 180000, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
          const st = await ssh.sudo(`systemctl is-active ${shq(svc)}`, { timeoutMs: 30000, signal: h.signal })
          const state = st.stdout.trim() || 'unknown'
          h.log(`${svc}: ${state}`)
          ctx.audit(serverId, 'service.restart', svc, rs.code === 0 && state === 'active')
          if (rs.code !== 0 || state !== 'active') throw new Error(`${svc} is ${state} after the update – check "journalctl -u ${svc}"`)
        } else {
          h.log(`$ service ${svc} restart`)
          const rs = await ssh.sudo(`(service ${shq(svc)} restart 2>/dev/null || rc-service ${shq(svc)} restart)`, { timeoutMs: 180000, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
          ctx.audit(serverId, 'service.restart', svc, rs.code === 0)
          if (rs.code !== 0) throw new Error(`Restart of ${svc} failed (exit code ${rs.code})`)
        }
      }
      // Show the new version(s) at the end of the log.
      try {
        const after = await lookup(ssh, pkgs)
        for (const v of after) h.log(`${v.name}: ${v.installed ?? 'not installed'}${v.updatable ? ` (candidate ${v.candidate})` : ''}`)
      } catch {
        /* cosmetic */
      }
      h.log('Done')
    })
    return id
  })

  ctx.handle('pkg:refresh', async (serverId: string): Promise<string> => {
    const ssh = ctx.ssh(serverId)
    lastRefresh.delete(serverId)
    const cmd = refreshCmd(ssh)
    const { id } = ctx.tasks.start('Refresh package lists', serverId, async (h) => {
      h.log(`$ ${cmd}`)
      await ensureFresh(ssh, serverId, true, h)
      ctx.audit(serverId, 'pkg.refresh')
      h.log('Done')
    })
    return id
  })
}
