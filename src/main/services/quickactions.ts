import type { Ctx } from '../core'
import type { CleanupScan, QuickActionsState } from '@shared/types'
import { SshClient } from '../ssh/SshClient'
import { SSHD_CONFIG_DUMP, assertPort, b64Echo, parseSshdConfig, shq, assertSafeName } from '../ssh/shell'
import { installCmd, isInstalled, listUpgradable, refreshCmd, runPkg, upgradeAllCmd, pkgEnv } from './pkg'
import { getServer } from '../store/servers'
import { probeLogin } from '../ssh/probe'

const SSHD_DROPIN = '/etc/ssh/sshd_config.d/00-servermate.conf'
const SSHD_PORT_DROPIN = '/etc/ssh/sshd_config.d/00-servermate-port.conf'
const SOCKET_DROPIN_DIR = '/etc/systemd/system/ssh.socket.d'
const SOCKET_DROPIN = `${SOCKET_DROPIN_DIR}/servermate-port.conf`

/** Write a root-owned file from content (base64 transport). */
async function writeRootFile(ssh: SshClient, path: string, content: string, mode = '644'): Promise<void> {
  await ssh.sudoRun(`mkdir -p $(dirname ${shq(path)}) && ${b64Echo(content)} > ${shq(path)} && chmod ${mode} ${shq(path)}`)
}

async function sshdSupportsInclude(ssh: SshClient): Promise<boolean> {
  const r = await ssh.exec(`grep -qiE '^\\s*Include\\s+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config && echo yes`)
  return r.stdout.includes('yes')
}

async function sshdReload(ssh: SshClient): Promise<void> {
  const test = await ssh.sudo('sshd -t 2>&1')
  if (test.code !== 0) throw new Error('sshd config test failed: ' + (test.stdout + test.stderr).trim())
  await ssh.sudoRun('systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || service sshd reload 2>/dev/null || service ssh reload')
}

async function isSocketActivated(ssh: SshClient): Promise<boolean> {
  const r = await ssh.exec('systemctl is-active ssh.socket 2>/dev/null')
  return r.stdout.trim() === 'active'
}

async function firewallBackend(ssh: SshClient): Promise<QuickActionsState['firewall']> {
  const r = await ssh.exec(
    `if command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q 'Status: active'; then echo ufw; elif systemctl is-active firewalld >/dev/null 2>&1; then echo firewalld; elif command -v ufw >/dev/null 2>&1; then echo ufw-inactive; else echo none; fi`
  )
  const v = r.stdout.trim()
  if (v === 'ufw') return 'ufw'
  if (v === 'firewalld') return 'firewalld'
  return 'none'
}

async function openFirewallPort(ssh: SshClient, port: number): Promise<void> {
  const fw = await firewallBackend(ssh)
  if (fw === 'ufw') await ssh.sudo(`ufw allow ${port}/tcp comment 'SSH (ServerMate)'`)
  if (fw === 'firewalld') await ssh.sudo(`firewall-cmd --permanent --add-port=${port}/tcp && firewall-cmd --reload`)
}

async function closeFirewallPort(ssh: SshClient, port: number): Promise<void> {
  const fw = await firewallBackend(ssh)
  if (fw === 'ufw') await ssh.sudo(`ufw --force delete allow ${port}/tcp; ufw --force delete allow ${port}`)
  if (fw === 'firewalld') await ssh.sudo(`firewall-cmd --permanent --remove-port=${port}/tcp; firewall-cmd --permanent --remove-service=ssh; firewall-cmd --reload`)
}

export function register(ctx: Ctx): void {
  // ---------------- state ----------------
  ctx.handle('qa:state', async (serverId: string): Promise<QuickActionsState> => {
    const ssh = ctx.ssh(serverId)
    const script = `
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"
echo __SSHDT; (sshd -T 2>/dev/null || sudo -n sshd -T 2>/dev/null) | grep -iE '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|challengeresponseauthentication) '
echo __SSHDCFG; ${SSHD_CONFIG_DUMP}
echo __LISTEN; (ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null) | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\\n' ' '
echo __SOCKET; systemctl is-active ssh.socket 2>/dev/null
echo __UU; if [ -f /etc/apt/apt.conf.d/20auto-upgrades ]; then grep -E 'Unattended-Upgrade' /etc/apt/apt.conf.d/20auto-upgrades | grep -oE '"[0-9]+"' | tr -d '"'; elif systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1; then echo 1; elif command -v apt-get >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1; then echo 0; else echo NA; fi
echo __F2B; if command -v fail2ban-client >/dev/null 2>&1; then echo installed; systemctl is-active fail2ban 2>/dev/null; sudo -n fail2ban-client status sshd 2>/dev/null | grep -E 'Currently banned' | awk '{print $NF}'; grep -hE '^(maxretry|findtime|bantime|ignoreip)\\s*=' /etc/fail2ban/jail.d/servermate.local /etc/fail2ban/jail.local 2>/dev/null; else echo missing; fi
echo __HOST; hostname
echo __TZ; timedatectl show -p Timezone -p NTP -p NTPSynchronized --value 2>/dev/null || cat /etc/timezone 2>/dev/null
echo __SWAP; cat /proc/swaps | tail -n +2; echo "SWAPPINESS=$(cat /proc/sys/vm/swappiness)"
echo __SWAPFILE; [ -f /swapfile ] && stat -c %s /swapfile || echo 0
echo __REBOOT; [ -f /var/run/reboot-required ] && echo yes || echo no; cat /var/run/reboot-required.pkgs 2>/dev/null | head -5
echo __SHUT; cat /run/systemd/shutdown/scheduled 2>/dev/null
echo __APTSTAMP; stat -c %y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || stat -c %y /var/lib/apt/lists 2>/dev/null || stat -c %y /var/cache/dnf 2>/dev/null
echo __END`
    // Run as root when possible so sshd -T / fail2ban-client work; fall back to the plain user.
    let r: { stdout: string }
    try {
      r = ssh.os?.sudoAvailable ? await ssh.exec(script, { timeoutMs: 30000, sudo: true }) : await ssh.exec(script, { timeoutMs: 30000 })
    } catch {
      r = await ssh.exec(script, { timeoutMs: 30000 })
    }
    const sec: Record<string, string[]> = {}
    let cur = ''
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^__([A-Z]+)$/)
      if (m) {
        cur = m[1]
        sec[cur] = []
      } else if (cur) sec[cur].push(line)
    }
    // SSH_CLIENT is reset by sudo, so read it in the login user's environment.
    const client = await ssh.exec(`echo "$SSH_CLIENT" | awk '{print $1}'`, { timeoutMs: 10000 }).catch(() => ({ stdout: '' }))
    sec.CLIENT = [client.stdout.trim()]
    const src = (sec.SSHDT?.filter((l) => l.trim()).length ? sec.SSHDT : sec.SSHDCFG) ?? []
    const effective = parseSshdConfig(src)
    const listen = (sec.LISTEN?.[0] ?? '').trim().split(/\s+/).map(Number).filter(Boolean)
    const cfgPorts = (effective.port ?? []).map(Number).filter(Boolean)
    const sshPorts = cfgPorts.length ? cfgPorts : listen.includes(22) ? [22] : []
    const uuRaw = (sec.UU?.[0] ?? '').trim()
    const f2b = sec.F2B ?? []
    const f2bInstalled = f2b[0]?.trim() === 'installed'
    const f2bConf: Record<string, string> = {}
    for (const l of f2b.slice(1)) {
      const m = l.match(/^(\w+)\s*=\s*(.*)$/)
      if (m) f2bConf[m[1]] = m[2].trim()
    }
    const bannedLine = f2b.find((l) => /^\d+$/.test(l.trim()))
    const swapLines = (sec.SWAP ?? []).filter(Boolean)
    const swappinessLine = swapLines.find((l) => l.startsWith('SWAPPINESS='))
    const swapEntries = swapLines.filter((l) => !l.startsWith('SWAPPINESS='))
    let swapTotal = 0
    const otherSwap: string[] = []
    for (const l of swapEntries) {
      const f = l.trim().split(/\s+/)
      const kb = Number(f[2]) || 0
      swapTotal += kb * 1024
      if (f[0] !== '/swapfile') otherSwap.push(`${f[0]} (${(kb / 1024 / 1024).toFixed(1)} GB)`)
    }
    const tz = (sec.TZ ?? []).map((l) => l.trim())
    const upd = await listUpgradable(ssh).catch(() => ({ list: [], security: 0 }))
    const fw = await firewallBackend(ssh)
    return {
      sshPort: sshPorts[0] ?? 22,
      sshPorts,
      sshSocketActivated: (sec.SOCKET?.[0] ?? '').trim() === 'active',
      permitRootLogin: effective.permitrootlogin?.[0] ?? 'prohibit-password',
      passwordAuth: (effective.passwordauthentication?.[0] ?? 'yes').toLowerCase() === 'yes' || ((effective.kbdinteractiveauthentication ?? effective.challengeresponseauthentication)?.[0] ?? 'yes').toLowerCase() === 'yes',
      pubkeyAuth: (effective.pubkeyauthentication?.[0] ?? 'yes') === 'yes',
      unattendedUpgrades: uuRaw === 'NA' ? 'unavailable' : uuRaw === '1' ? 'on' : 'off',
      fail2ban: {
        installed: f2bInstalled,
        running: f2bInstalled && f2b[1]?.trim() === 'active',
        maxretry: f2bConf.maxretry ? Number(f2bConf.maxretry) : undefined,
        findtime: f2bConf.findtime,
        bantime: f2bConf.bantime,
        ignoreip: f2bConf.ignoreip,
        bannedCount: bannedLine ? Number(bannedLine) : undefined
      },
      hostname: (sec.HOST?.[0] ?? '').trim(),
      timezone: tz[0] || 'unknown',
      ntp: tz[1] === 'yes',
      swap: {
        total: swapTotal,
        swapfile: swapEntries.some((l) => l.startsWith('/swapfile')) ? '/swapfile' : undefined,
        swapfileSize: Number(sec.SWAPFILE?.[0]) || 0,
        otherSwap,
        swappiness: Number(swappinessLine?.split('=')[1]) || 60
      },
      updates: { count: upd.list.length, security: upd.security, lastChecked: (sec.APTSTAMP?.[0] ?? '').trim().split('.')[0] || undefined, list: upd.list.slice(0, 200) },
      rebootRequired: (sec.REBOOT?.[0] ?? '').trim() === 'yes',
      pendingReboot: (sec.REBOOT ?? []).slice(1).filter(Boolean).join(', ') || undefined,
      scheduledShutdown: (sec.SHUT ?? []).filter(Boolean).join(' ') || undefined,
      firewall: fw,
      clientIp: (sec.CLIENT?.[0] ?? '').trim() || undefined
    }
  })

  // ---------------- SSH port (staged) ----------------
  ctx.handle('qa:changeSshPort', async (serverId: string, newPortRaw: number) => {
    const newPort = assertPort(newPortRaw)
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start(`Change SSH port to ${newPort}`, serverId, async (h) => {
      const cur = await ssh.sudo(`sshd -T 2>/dev/null | awk '/^port /{print $2}'`)
      const oldPorts = cur.stdout.split('\n').map(Number).filter(Boolean)
      const oldPort = oldPorts[0] || ssh.profile.port
      if (oldPorts.includes(newPort)) throw new Error(`sshd already listens on ${newPort}`)
      const socket = await isSocketActivated(ssh)
      const includes = await sshdSupportsInclude(ssh)
      h.log(`Current port(s): ${oldPorts.join(', ')}. Socket activation: ${socket ? 'yes' : 'no'}.`)

      h.log('Step 1/4: opening firewall for the new port (if a firewall is active)…')
      await openFirewallPort(ssh, newPort)

      h.log('Step 2/4: configuring sshd to listen on both ports…')
      const both = `# Managed by ServerMate - staged SSH port change\nPort ${oldPort}\nPort ${newPort}\n`
      if (includes) await writeRootFile(ssh, SSHD_PORT_DROPIN, both)
      else {
        await ssh.sudoRun(`cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.servermate-port.bak && t=$(mktemp) && sed -i -E '/^\\s*Port\\s/d' /etc/ssh/sshd_config && ${b64Echo(both)} | cat - /etc/ssh/sshd_config > "$t" && install -m 644 "$t" /etc/ssh/sshd_config; rc=$?; rm -f "$t"; exit $rc`)
      }
      if (socket) {
        await writeRootFile(ssh, SOCKET_DROPIN, `[Socket]\nListenStream=\nListenStream=${oldPort}\nListenStream=${newPort}\n`)
        await ssh.sudoRun('systemctl daemon-reload && systemctl restart ssh.socket')
      }
      await sshdReload(ssh)

      h.log(`Step 3/4: verifying login on port ${newPort}…`)
      await new Promise((r) => setTimeout(r, 1500))
      const ok = await probeLogin(ctx, serverId, newPort)
      if (!ok) {
        h.log('Login on the new port FAILED. Rolling back…')
        if (includes) await ssh.sudo(`rm -f ${SSHD_PORT_DROPIN}`)
        else await ssh.sudo(`cp /etc/ssh/sshd_config.servermate-port.bak /etc/ssh/sshd_config`)
        if (socket) await ssh.sudo(`rm -f ${SOCKET_DROPIN}; systemctl daemon-reload; systemctl restart ssh.socket`)
        await sshdReload(ssh).catch(() => {})
        throw new Error(`Could not log in on port ${newPort}; previous configuration restored. Check cloud firewalls / security groups.`)
      }

      h.log(`Step 4/4: removing old port ${oldPort}…`)
      const only = `# Managed by ServerMate\nPort ${newPort}\n`
      if (includes) await writeRootFile(ssh, SSHD_PORT_DROPIN, only)
      else await ssh.sudoRun(`t=$(mktemp) && sed -i -E '/^\\s*Port\\s/d' /etc/ssh/sshd_config && ${b64Echo(only)} | cat - /etc/ssh/sshd_config > "$t" && install -m 644 "$t" /etc/ssh/sshd_config; rc=$?; rm -f "$t"; exit $rc`)
      if (socket) {
        await writeRootFile(ssh, SOCKET_DROPIN, `[Socket]\nListenStream=\nListenStream=${newPort}\n`)
        await ssh.sudoRun('systemctl daemon-reload && systemctl restart ssh.socket')
      }
      await sshdReload(ssh)
      await closeFirewallPort(ssh, oldPort).catch(() => {})
      h.log(`Done. SSH now listens on ${newPort} only. The saved server profile has been updated.`)
      const { saveServer } = await import('../store/servers')
      const p = getServer(serverId)
      if (p) saveServer({ ...p, port: newPort })
      ctx.audit(serverId, 'ssh.port', `${oldPort} -> ${newPort}`)
    })
    return id
  })

  // ---------------- SSH login rules (with auto-rollback) ----------------
  ctx.handle('qa:setSshLogin', async (serverId: string, opts: { permitRootLogin: string; passwordAuth: boolean }) => {
    const ssh = ctx.ssh(serverId)
    const prl = ['yes', 'no', 'prohibit-password', 'forced-commands-only'].includes(opts.permitRootLogin) ? opts.permitRootLogin : 'prohibit-password'
    const content = `# Managed by ServerMate - keep at top so these values win\nPermitRootLogin ${prl}\nPasswordAuthentication ${opts.passwordAuth ? 'yes' : 'no'}\nKbdInteractiveAuthentication ${opts.passwordAuth ? 'yes' : 'no'}\nPubkeyAuthentication yes\n`
    const { id } = ctx.tasks.start('Update SSH login rules', serverId, async (h) => {
      const includes = await sshdSupportsInclude(ssh)
      h.log('Backing up current configuration…')
      const backup = await ssh.sudo(`cat ${SSHD_DROPIN} 2>/dev/null`)
      const hadDropin = backup.code === 0
      if (includes) await writeRootFile(ssh, SSHD_DROPIN, content)
      else {
        await ssh.sudoRun(`cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.servermate-login.bak && t=$(mktemp) && sed -i -E '/^\\s*(PermitRootLogin|PasswordAuthentication|KbdInteractiveAuthentication|ChallengeResponseAuthentication)\\s/d' /etc/ssh/sshd_config && ${b64Echo(content)} | cat - /etc/ssh/sshd_config > "$t" && install -m 644 "$t" /etc/ssh/sshd_config; rc=$?; rm -f "$t"; exit $rc`)
      }
      h.log('Testing and reloading sshd…')
      await sshdReload(ssh)
      await new Promise((r) => setTimeout(r, 1200))
      h.log('Verifying this app can still log in…')
      const ok = await probeLogin(ctx, serverId, ssh.profile.port)
      if (!ok) {
        h.log('Login failed with the new rules. Rolling back…')
        if (includes) {
          if (hadDropin) await writeRootFile(ssh, SSHD_DROPIN, backup.stdout)
          else await ssh.sudo(`rm -f ${SSHD_DROPIN}`)
        } else await ssh.sudo('cp /etc/ssh/sshd_config.servermate-login.bak /etc/ssh/sshd_config')
        await sshdReload(ssh)
        throw new Error('The new login rules would lock this app out (probably password login turned off while this profile uses a password). Change reverted.')
      }
      h.log('Done.')
      ctx.audit(serverId, 'ssh.login', `PermitRootLogin=${prl} PasswordAuthentication=${opts.passwordAuth}`)
    })
    return id
  })

  // ---------------- Power ----------------
  ctx.handle('qa:power', async (serverId: string, action: 'reboot' | 'poweroff' | 'cancel', delayMin?: number) => {
    const ssh = ctx.ssh(serverId)
    ctx.audit(serverId, 'power', `${action}${delayMin ? ` +${delayMin}m` : ''}`)
    if (action === 'cancel') return ssh.sudoRun('shutdown -c 2>&1 || true')
    const when = delayMin && delayMin > 0 ? `+${Math.floor(delayMin)}` : 'now'
    const flag = action === 'reboot' ? '-r' : '-h'
    // Run detached so the SSH session closing does not abort it.
    const r = await ssh.sudo(`nohup shutdown ${flag} ${when} "Requested via ServerMate" >/dev/null 2>&1 &`, { timeoutMs: 15000 }).catch(() => ({ code: 0, stdout: '', stderr: '' }))
    return r.stdout
  })

  // ---------------- Updates ----------------
  ctx.handle('qa:checkUpdates', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    await runPkg(ssh, refreshCmd(ssh), { timeoutMs: 300000 })
    return listUpgradable(ssh)
  })
  ctx.handle('qa:upgradeAll', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Install all package updates', serverId, async (h) => {
      await runPkg(ssh, upgradeAllCmd(ssh), { signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      h.log('\nAll updates installed.')
      ctx.audit(serverId, 'pkg.upgradeAll')
    })
    return id
  })
  ctx.handle('qa:installPackages', async (serverId: string, pkgs: string[]) => {
    const ssh = ctx.ssh(serverId)
    pkgs.forEach((p) => assertSafeName(p, 'package'))
    const { id } = ctx.tasks.start(`Install ${pkgs.join(', ')}`, serverId, async (h) => {
      await runPkg(ssh, installCmd(ssh, pkgs), { signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      ctx.audit(serverId, 'pkg.install', pkgs.join(' '))
    })
    return id
  })

  // ---------------- Automatic updates ----------------
  ctx.handle('qa:setAutoUpdates', async (serverId: string, on: boolean) => {
    const ssh = ctx.ssh(serverId)
    const pm = ssh.os?.pkgManager
    const { id } = ctx.tasks.start(`Turn automatic security updates ${on ? 'on' : 'off'}`, serverId, async (h) => {
      if (pm === 'apt') {
        if (on) {
          if (!(await isInstalled(ssh, 'unattended-upgrades'))) {
            h.log('Installing unattended-upgrades…')
            await runPkg(ssh, installCmd(ssh, ['unattended-upgrades']), { onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
          }
          await writeRootFile(ssh, '/etc/apt/apt.conf.d/20auto-upgrades', 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n')
          await ssh.sudo('systemctl enable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true')
        } else {
          await writeRootFile(ssh, '/etc/apt/apt.conf.d/20auto-upgrades', 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n')
          await ssh.sudo('systemctl disable --now apt-daily-upgrade.timer 2>/dev/null || true')
        }
      } else if (pm === 'dnf') {
        if (on) {
          if (!(await isInstalled(ssh, 'dnf-automatic'))) await runPkg(ssh, installCmd(ssh, ['dnf-automatic']), { onStdout: (c) => h.append(c) })
          await ssh.sudoRun(`sed -i -E 's/^apply_updates\\s*=.*/apply_updates = yes/; s/^upgrade_type\\s*=.*/upgrade_type = security/' /etc/dnf/automatic.conf && systemctl enable --now dnf-automatic.timer`)
        } else await ssh.sudo('systemctl disable --now dnf-automatic.timer')
      } else throw new Error('Automatic updates are supported on apt and dnf based systems only')
      h.log('Done.')
      ctx.audit(serverId, 'autoupdates', on ? 'on' : 'off')
    })
    return id
  })

  // ---------------- Fail2ban ----------------
  ctx.handle('qa:fail2banSetup', async (serverId: string, cfg: { maxretry: number; findtime: string; bantime: string; ignoreip: string; sshPorts: number[] }) => {
    const ssh = ctx.ssh(serverId)
    const okTime = (s: string): string => {
      if (!/^-?\d+[smhdw]?$/.test(s.trim())) throw new Error(`Invalid time: ${s}`)
      return s.trim()
    }
    const ignore = cfg.ignoreip
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((ip) => {
        if (!/^[0-9a-fA-F.:/]+$/.test(ip)) throw new Error(`Invalid IP/CIDR: ${ip}`)
        return ip
      })
    const ports = (cfg.sshPorts ?? []).map(assertPort)
    const maxretry = Number.isInteger(cfg.maxretry) && cfg.maxretry >= 1 ? cfg.maxretry : 5
    const jail = `# Managed by ServerMate\n[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 ${ignore.join(' ')}\nbantime = ${okTime(cfg.bantime)}\nfindtime = ${okTime(cfg.findtime)}\nmaxretry = ${maxretry}\nbanaction = %(banaction_allports)s\n\n[sshd]\nenabled = true\nport = ${ports.join(',') || 'ssh'}\nbackend = systemd\n`
    const { id } = ctx.tasks.start('Install & configure Fail2ban', serverId, async (h) => {
      if (!(await isInstalled(ssh, 'fail2ban'))) {
        h.log('Installing fail2ban…')
        await runPkg(ssh, installCmd(ssh, ['fail2ban']), { onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      }
      h.log('Writing /etc/fail2ban/jail.d/servermate.local…')
      await writeRootFile(ssh, '/etc/fail2ban/jail.d/servermate.local', jail)
      await ssh.sudoRun('systemctl enable --now fail2ban && systemctl restart fail2ban')
      await new Promise((r) => setTimeout(r, 1500))
      const st = await ssh.sudo('fail2ban-client status sshd 2>&1')
      h.log(st.stdout + st.stderr)
      ctx.audit(serverId, 'fail2ban.setup', `maxretry=${cfg.maxretry} bantime=${cfg.bantime}`)
    })
    return id
  })
  ctx.handle('qa:fail2banStatus', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.sudo('fail2ban-client status sshd 2>&1; echo; fail2ban-client banned 2>/dev/null')
    return r.stdout + r.stderr
  })
  ctx.handle('qa:fail2banUnban', async (serverId: string, ip: string) => {
    if (!/^[0-9a-fA-F.:]+$/.test(ip)) throw new Error('Invalid IP')
    return ctx.ssh(serverId).sudoRun(`fail2ban-client set sshd unbanip ${ip} 2>&1 || fail2ban-client unban ${ip}`)
  })
  ctx.handle('qa:fail2banToggle', async (serverId: string, on: boolean) => {
    const ssh = ctx.ssh(serverId)
    ctx.audit(serverId, 'fail2ban', on ? 'start' : 'stop')
    return ssh.sudoRun(on ? 'systemctl enable --now fail2ban' : 'systemctl disable --now fail2ban')
  })

  // ---------------- Hostname ----------------
  ctx.handle('qa:setHostname', async (serverId: string, hostname: string, updateHosts: boolean) => {
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)*$/.test(hostname)) throw new Error('Invalid hostname')
    const ssh = ctx.ssh(serverId)
    await ssh.sudoRun(`(hostnamectl set-hostname ${shq(hostname)} 2>/dev/null || (hostname ${shq(hostname)} && echo ${shq(hostname)} > /etc/hostname))`)
    if (updateHosts) {
      await ssh.sudoRun(
        `if grep -qE '^127\\.0\\.1\\.1\\s' /etc/hosts; then sed -i -E 's/^(127\\.0\\.1\\.1\\s+).*/\\1${hostname.replace(/[.]/g, '\\.')} ${hostname.split('.')[0]}/' /etc/hosts; else echo '127.0.1.1 ${hostname} ${hostname.split('.')[0]}' >> /etc/hosts; fi`
      )
    }
    ctx.audit(serverId, 'hostname', hostname)
  })

  // ---------------- Timezone ----------------
  ctx.handle('qa:listTimezones', async (serverId: string) => {
    const r = await ctx.ssh(serverId).exec('timedatectl list-timezones 2>/dev/null || (cd /usr/share/zoneinfo && find . -type f | sed "s|^./||" | grep -E "^[A-Z][a-z]+/" | sort)')
    return r.stdout.split('\n').filter(Boolean)
  })
  ctx.handle('qa:setTimezone', async (serverId: string, tz: string, ntp: boolean) => {
    if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) throw new Error('Invalid timezone')
    const ssh = ctx.ssh(serverId)
    await ssh.sudoRun(`timedatectl set-timezone ${shq(tz)} 2>/dev/null || (ln -sf /usr/share/zoneinfo/${tz} /etc/localtime && echo ${shq(tz)} > /etc/timezone)`)
    await ssh.sudo(`timedatectl set-ntp ${ntp ? 'true' : 'false'} 2>/dev/null || true`)
    ctx.audit(serverId, 'timezone', `${tz} ntp=${ntp}`)
  })

  // ---------------- Swap ----------------
  ctx.handle('qa:setSwap', async (serverId: string, opts: { sizeGb: number | null; swappiness: number }) => {
    const ssh = ctx.ssh(serverId)
    const swappiness = Number.isFinite(opts.swappiness) ? Math.max(0, Math.min(100, Math.floor(opts.swappiness))) : 60
    const { id } = ctx.tasks.start('Configure swap', serverId, async (h) => {
      if (opts.sizeGb !== null) {
        const gb = Math.max(0, Math.floor(opts.sizeGb))
        h.log(gb === 0 ? 'Removing /swapfile…' : `Creating /swapfile of ${gb} GB…`)
        await ssh.sudo('swapoff /swapfile 2>/dev/null; rm -f /swapfile; sed -i "\\|^/swapfile |d" /etc/fstab')
        if (gb > 0) {
          const r = await ssh.sudo(`fallocate -l ${gb}G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=${gb * 1024} status=none`, { timeoutMs: 600000 })
          if (r.code !== 0) throw new Error('Could not allocate swapfile: ' + r.stderr)
          await ssh.sudoRun('chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab')
        }
      }
      h.log(`Setting vm.swappiness=${swappiness}…`)
      await ssh.sudoRun(`sysctl -w vm.swappiness=${swappiness} >/dev/null && mkdir -p /etc/sysctl.d && echo "vm.swappiness=${swappiness}" > /etc/sysctl.d/99-servermate-swappiness.conf`)
      h.log('Done.')
      ctx.audit(serverId, 'swap', `size=${opts.sizeGb ?? 'keep'} swappiness=${swappiness}`)
    })
    return id
  })

  // ---------------- Disk cleanup ----------------
  ctx.handle('qa:cleanupScan', async (serverId: string): Promise<CleanupScan> => {
    const ssh = ctx.ssh(serverId)
    const pm = ssh.os?.pkgManager
    const script = `
echo __FREE; df -PB1 / | tail -1 | awk '{print $4}'
echo __PKGCACHE; du -sb /var/cache/apt/archives /var/cache/dnf /var/cache/yum /var/cache/zypp /var/cache/apk /var/cache/pacman/pkg 2>/dev/null | awk '{s+=$1} END {print s+0}'
echo __AUTOREMOVE; ${pm === 'apt' ? `apt-get -s autoremove 2>/dev/null | grep -oE '^Remv [^ ]+' | wc -l` : pm === 'dnf' ? `dnf -q repoquery --unneeded 2>/dev/null | wc -l` : 'echo 0'}
echo __JOURNAL; journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]?B?' | head -1
echo __ROTATED; find /var/log -type f \\( -name '*.gz' -o -name '*.[0-9]' -o -name '*.[0-9].log' -o -name '*.old' \\) -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END {print s+0}'
echo __TMP; find /tmp /var/tmp -xdev -type f -atime +7 -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END {print s+0}'
echo __CRASH; du -sb /var/crash 2>/dev/null | awk '{print $1+0}'
echo __DOCKER; command -v docker >/dev/null 2>&1 && docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -4 | tr '\\n' ' '
echo __CORE; find / -xdev -maxdepth 3 -type f -name 'core' -size +1M -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END {print s+0}'
echo __THUMB; du -sb ${shq((ssh.os?.homeDir || '/root') + '/.cache')} 2>/dev/null | awk '{print $1+0}'
echo __END`
    const r = await ssh.sudo(script, { timeoutMs: 120000 })
    const sec: Record<string, string> = {}
    let cur = ''
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^__([A-Z]+)$/)
      if (m) cur = m[1]
      else if (cur && line.trim()) sec[cur] = (sec[cur] ? sec[cur] + ' ' : '') + line.trim()
    }
    const parseSize = (s: string | undefined): number => {
      if (!s) return 0
      const m = s.match(/([0-9.]+)\s*([KMGT]?)B?/i)
      if (!m) return 0
      const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
      return parseFloat(m[1]) * (mult[m[2].toUpperCase()] ?? 1)
    }
    const dockerReclaim = (sec.DOCKER ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((x) => parseSize(x.replace(/\(.*\)/, '')))
      .reduce((a, b) => a + b, 0)
    const journal = parseSize(sec.JOURNAL)
    const items: CleanupScan['items'] = [
      { id: 'pkgcache', label: 'Package cache', description: 'Downloaded package files; re-downloaded if needed', bytes: Number(sec.PKGCACHE) || 0, checked: true },
      { id: 'autoremove', label: 'Unused packages & old kernels', description: pm === 'apt' ? 'apt-get autoremove --purge' : 'remove unneeded packages', bytes: 0, count: Number(sec.AUTOREMOVE) || 0, checked: true },
      { id: 'journal', label: 'System journal', description: 'Shrink to the newest 200 MB', bytes: Math.max(0, journal - 200 * 1024 * 1024), checked: journal > 200 * 1024 * 1024 },
      { id: 'rotated', label: 'Rotated log files', description: 'Old compressed / numbered logs in /var/log (*.gz, *.1, …)', bytes: Number(sec.ROTATED) || 0, checked: true },
      { id: 'tmp', label: 'Old temporary files', description: 'Files in /tmp and /var/tmp not used for 7 days', bytes: Number(sec.TMP) || 0, checked: false },
      { id: 'crash', label: 'Crash reports', description: '/var/crash', bytes: Number(sec.CRASH) || 0, checked: true },
      { id: 'core', label: 'Core dumps', description: 'core files larger than 1 MB', bytes: Number(sec.CORE) || 0, checked: false },
      { id: 'docker', label: 'Docker unused data', description: 'docker system prune (stopped containers, dangling images, build cache)', bytes: dockerReclaim, checked: false },
      { id: 'usercache', label: 'User cache', description: '~/.cache of the login user', bytes: Number(sec.THUMB) || 0, checked: false }
    ]
    return { freeBytes: Number(sec.FREE) || 0, items }
  })
  ctx.handle('qa:cleanupRun', async (serverId: string, ids: string[]) => {
    const ssh = ctx.ssh(serverId)
    const pm = ssh.os?.pkgManager
    const cmds: Record<string, string> = {
      pkgcache: pm === 'apt' ? 'apt-get clean' : pm === 'dnf' ? 'dnf clean all' : pm === 'yum' ? 'yum clean all' : pm === 'zypper' ? 'zypper clean -a' : pm === 'apk' ? 'rm -rf /var/cache/apk/*' : pm === 'pacman' ? 'pacman -Scc --noconfirm' : 'true',
      autoremove: pm === 'apt' ? 'apt-get autoremove --purge -y -qq' : pm === 'dnf' ? 'dnf autoremove -y' : pm === 'yum' ? 'yum autoremove -y' : 'true',
      journal: 'journalctl --vacuum-size=200M',
      rotated: `find /var/log -type f \\( -name '*.gz' -o -name '*.[0-9]' -o -name '*.[0-9].log' -o -name '*.old' \\) -delete`,
      tmp: 'find /tmp /var/tmp -xdev -type f -atime +7 -delete',
      crash: 'rm -rf /var/crash/*',
      core: `find / -xdev -maxdepth 3 -type f -name 'core' -size +1M -delete`,
      docker: 'docker system prune -af --volumes=false',
      usercache: 'rm -rf ~/.cache/*'
    }
    const { id } = ctx.tasks.start('Disk cleanup', serverId, async (h) => {
      const before = await ssh.exec(`df -PB1 / | tail -1 | awk '{print $4}'`)
      for (const i of ids) {
        const c = cmds[i]
        if (!c) continue
        h.log(`> ${c}`)
        const r = await ssh.exec(c, { sudo: i !== 'usercache', env: pkgEnv(), timeoutMs: 600000, onStdout: (x) => h.append(x), onStderr: (x) => h.append(x) })
        if (r.code !== 0) h.log(`(exit ${r.code})`)
      }
      const after = await ssh.exec(`df -PB1 / | tail -1 | awk '{print $4}'`)
      const freed = (Number(after.stdout) || 0) - (Number(before.stdout) || 0)
      h.log(`\nFreed ${(Math.max(0, freed) / 1024 / 1024).toFixed(1)} MB on /.`)
      ctx.audit(serverId, 'cleanup', ids.join(','))
    })
    return id
  })

}
