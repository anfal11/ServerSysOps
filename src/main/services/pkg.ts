import type { SshClient, ExecOptions } from '../ssh/SshClient'
import { shJoin } from '../ssh/shell'

/** Package manager abstraction across apt/dnf/yum/zypper/apk/pacman. */

export function pkgEnv(): Record<string, string> {
  return { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' }
}

export function installCmd(ssh: SshClient, pkgs: string[]): string {
  const p = shJoin(pkgs)
  switch (ssh.os?.pkgManager) {
    case 'apt':
      return `apt-get update -qq && apt-get install -y -qq -o Dpkg::Options::=--force-confold ${p}`
    case 'dnf':
      return `dnf install -y ${p}`
    case 'yum':
      return `yum install -y ${p}`
    case 'zypper':
      return `zypper --non-interactive install ${p}`
    case 'apk':
      return `apk add ${p}`
    case 'pacman':
      return `pacman -Sy --noconfirm ${p}`
    default:
      throw new Error('Unsupported package manager')
  }
}

export function removeCmd(ssh: SshClient, pkgs: string[]): string {
  const p = shJoin(pkgs)
  switch (ssh.os?.pkgManager) {
    case 'apt':
      return `apt-get remove -y -qq ${p}`
    case 'dnf':
      return `dnf remove -y ${p}`
    case 'yum':
      return `yum remove -y ${p}`
    case 'zypper':
      return `zypper --non-interactive remove ${p}`
    case 'apk':
      return `apk del ${p}`
    case 'pacman':
      return `pacman -R --noconfirm ${p}`
    default:
      throw new Error('Unsupported package manager')
  }
}

export function upgradeAllCmd(ssh: SshClient): string {
  switch (ssh.os?.pkgManager) {
    case 'apt':
      return `apt-get update -qq && apt-get upgrade -y -qq --with-new-pkgs -o Dpkg::Options::=--force-confold && apt-get autoremove -y -qq`
    case 'dnf':
      return `dnf upgrade -y`
    case 'yum':
      return `yum update -y`
    case 'zypper':
      return `zypper --non-interactive update`
    case 'apk':
      return `apk update && apk upgrade`
    case 'pacman':
      return `pacman -Syu --noconfirm`
    default:
      throw new Error('Unsupported package manager')
  }
}

export function refreshCmd(ssh: SshClient): string {
  switch (ssh.os?.pkgManager) {
    case 'apt':
      return 'apt-get update -qq'
    case 'dnf':
      return 'dnf makecache -q'
    case 'yum':
      return 'yum makecache -q'
    case 'zypper':
      return 'zypper --non-interactive refresh'
    case 'apk':
      return 'apk update'
    case 'pacman':
      return 'pacman -Sy'
    default:
      throw new Error('Unsupported package manager')
  }
}

/** Returns list of upgradable packages (names with versions when available). */
export async function listUpgradable(ssh: SshClient): Promise<{ list: string[]; security: number }> {
  switch (ssh.os?.pkgManager) {
    case 'apt': {
      // Simulate the same upgrade "Install" runs, so the count matches what actually gets installed
      // (apt list --upgradable also shows phased / held-back packages that apt-get upgrade skips).
      const sim = await ssh.exec("apt-get -s -o Debug::NoLocking=1 upgrade --with-new-pkgs 2>/dev/null | grep '^Inst ' || true")
      let list = sim.stdout
        .split('\n')
        .filter((l) => l.startsWith('Inst '))
        .map((l) => {
          // Inst pkg [old] (new repo [arch]) ...
          const m = l.match(/^Inst (\S+)(?: \[([^\]]+)\])? \(([^\s)]+) ([^)]*)\)/)
          return m ? `${m[1]} ${m[2] ? m[2] + ' -> ' : ''}${m[3]} [${m[4].split(' ')[0]}]` : l.slice(5)
        })
      if (!list.length && sim.code !== 0) {
        const r = await ssh.exec('apt list --upgradable 2>/dev/null | tail -n +2')
        list = r.stdout.split('\n').filter(Boolean)
      }
      const security = list.filter((l) => /-security/i.test(l)).length
      return { list, security }
    }
    case 'dnf':
    case 'yum': {
      const r = await ssh.exec(`${ssh.os.pkgManager} -q check-update 2>/dev/null || true`)
      const list = r.stdout
        .split('\n')
        .filter((l) => /^\S+\s+\S+\s+\S+/.test(l) && !/^Obsoleting|^Last metadata/.test(l))
      const sec = await ssh.exec(`${ssh.os.pkgManager} -q updateinfo list security 2>/dev/null | grep -c . || true`)
      return { list, security: parseInt(sec.stdout) || 0 }
    }
    case 'zypper': {
      const r = await ssh.exec('zypper --non-interactive -q list-updates 2>/dev/null | grep "^v " || true')
      return { list: r.stdout.split('\n').filter(Boolean), security: 0 }
    }
    case 'apk': {
      const r = await ssh.exec('apk version -l "<" 2>/dev/null | tail -n +2 || true')
      return { list: r.stdout.split('\n').filter(Boolean), security: 0 }
    }
    case 'pacman': {
      const r = await ssh.exec('pacman -Qu 2>/dev/null || true')
      return { list: r.stdout.split('\n').filter(Boolean), security: 0 }
    }
    default:
      return { list: [], security: 0 }
  }
}

export async function isInstalled(ssh: SshClient, pkg: string): Promise<boolean> {
  switch (ssh.os?.pkgManager) {
    case 'apt': {
      const r = await ssh.exec(`dpkg-query -W -f='\${Status}' ${shJoin([pkg])} 2>/dev/null`)
      return /install ok installed/.test(r.stdout)
    }
    case 'dnf':
    case 'yum':
    case 'zypper': {
      const r = await ssh.exec(`rpm -q ${shJoin([pkg])} >/dev/null 2>&1 && echo yes`)
      return r.stdout.includes('yes')
    }
    case 'apk': {
      const r = await ssh.exec(`apk info -e ${shJoin([pkg])} >/dev/null 2>&1 && echo yes`)
      return r.stdout.includes('yes')
    }
    case 'pacman': {
      const r = await ssh.exec(`pacman -Q ${shJoin([pkg])} >/dev/null 2>&1 && echo yes`)
      return r.stdout.includes('yes')
    }
    default:
      return false
  }
}

/** Run a package manager command with streaming output as root. */
export async function runPkg(ssh: SshClient, cmd: string, opts: ExecOptions = {}): Promise<string> {
  return ssh.sudoRun(cmd, { timeoutMs: 1800000, env: pkgEnv(), ...opts })
}
