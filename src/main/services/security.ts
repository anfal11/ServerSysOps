import type { Ctx } from '../core'
import { probeLogin } from '../ssh/probe'
import type { SecurityCheck } from '@shared/types'
import type { SecurityHistoryEntry, SecurityReportEx } from '@shared/modules/security'
import { SshClient } from '../ssh/SshClient'
import { SSHD_CONFIG_DUMP, b64Echo, parseSshdConfig, shq } from '../ssh/shell'
import { JsonStore } from '../store/jsonStore'
import { getSecrets, getServer } from '../store/servers'

/* ------------------------------------------------------------------ */
/* Combined audit script (runs once, as root)                          */
/* ------------------------------------------------------------------ */

const AUDIT_SCRIPT = `
echo __HOST; hostname 2>/dev/null
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"
echo __SSHD; sshd -T 2>/dev/null | grep -iE '^(permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|challengeresponseauthentication|authenticationmethods|port|maxauthtries|x11forwarding|permitemptypasswords|protocol|logingracetime|clientaliveinterval|allowtcpforwarding) '
echo __SSHDME; if [ -n "$SM_USER" ]; then sshd -T -C "user=$SM_USER,host=$(hostname 2>/dev/null || echo localhost),addr=\${SM_ADDR:-127.0.0.1}" 2>/dev/null | grep -iE '^(permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|challengeresponseauthentication|authenticationmethods) '; fi
echo __SSHDCFG; ${SSHD_CONFIG_DUMP}
echo __F2B; if command -v fail2ban-client >/dev/null 2>&1; then echo installed; systemctl is-active fail2ban 2>/dev/null || echo inactive; fail2ban-client status sshd 2>/dev/null | grep -E 'Currently banned' | awk '{print $NF}'; else echo missing; fi
echo __FW; if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then echo "ufw $(ufw status numbered 2>/dev/null | grep -c '^\\[')"; elif systemctl is-active firewalld >/dev/null 2>&1; then echo "firewalld $(firewall-cmd --list-all 2>/dev/null | grep -E '^\\s*(ports|services|rich rules):' | awk -F: '{print $2}' | wc -w)"; elif command -v nft >/dev/null 2>&1 && [ "$(nft list ruleset 2>/dev/null | grep -cE '^\\s+(tcp|udp|ip|ip6|ct|iif|iifname|meta|accept|drop|reject)')" -gt 0 ]; then echo "nftables $(nft list ruleset 2>/dev/null | grep -cE '^\\s+(tcp|udp|ip|ip6|ct|iif|iifname|meta|accept|drop|reject)')"; elif command -v iptables >/dev/null 2>&1 && [ "$(iptables -S 2>/dev/null | grep -vc '^-P')" -gt 0 ]; then echo "iptables $(iptables -S 2>/dev/null | grep -vc '^-P')"; else echo none; fi
echo __UU; if [ -f /etc/apt/apt.conf.d/20auto-upgrades ]; then grep -E 'Unattended-Upgrade' /etc/apt/apt.conf.d/20auto-upgrades | grep -oE '"[0-9]+"' | tr -d '"' | head -1; elif systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1 || systemctl is-enabled dnf-automatic-install.timer >/dev/null 2>&1; then echo 1; elif command -v apt-get >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1; then echo 0; else echo NA; fi
echo __UPD; if command -v apt-get >/dev/null 2>&1; then apt list --upgradable 2>/dev/null | tail -n +2; elif command -v dnf >/dev/null 2>&1; then dnf -q -C check-update 2>/dev/null | awk 'NF>=3 && $1 !~ /^(Obsoleting|Last)/ {print $1" "$2}'; echo "__SECCOUNT $(dnf -q -C updateinfo list security 2>/dev/null | grep -c .)"; elif command -v yum >/dev/null 2>&1; then yum -q -C check-update 2>/dev/null | awk 'NF>=3 {print $1" "$2}'; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive -q list-updates 2>/dev/null | grep '^v ' | awk -F'|' '{print $3}'; elif command -v apk >/dev/null 2>&1; then apk version -l '<' 2>/dev/null | tail -n +2; elif command -v pacman >/dev/null 2>&1; then pacman -Qu 2>/dev/null; fi
echo __REBOOT; [ -f /var/run/reboot-required ] && echo yes || echo no
echo __KERNEL; uname -r; ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's|.*/vmlinuz-||' | sort -V | tail -1
echo __EMPTYPW; awk -F: '($2==""){print $1}' /etc/shadow 2>/dev/null
echo __UID0; awk -F: '($3==0 && $1!="root"){print $1}' /etc/passwd 2>/dev/null
echo __NOPASSWD; grep -rhE '^[^#]*NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null | sed 's/[[:space:]]\\+/ /g' | head -20
echo __WW; timeout 20 find /etc /usr/local/bin /usr/local/sbin -xdev -type f -perm -0002 2>/dev/null | head -20
echo __SUID; timeout 30 find / -xdev -type f -perm -4000 2>/dev/null | head -300
echo __LISTEN; ss -tulnpH 2>/dev/null | awk '{print $1" "$5" "$7}'
echo __DISK; df -P -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | tail -n +2 | awk '{print $5" "$6}'
echo __SWAP; tail -n +2 /proc/swaps 2>/dev/null | wc -l
echo __TIME; timedatectl show -p NTPSynchronized -p NTP --value 2>/dev/null | tr '\\n' ' '; echo; chronyc tracking 2>/dev/null | grep -i 'Leap status'; ntpq -p 2>/dev/null | grep -c '^\\*'
echo __KEYPERM; stat -c '%a %n' /etc/ssh/ssh_host_*_key 2>/dev/null
echo __ROOTKEYS; grep -cE '^(ssh-|ecdsa-|sk-)' /root/.ssh/authorized_keys 2>/dev/null || echo 0
echo __FAILED; if command -v journalctl >/dev/null 2>&1; then journalctl -q --no-pager --since '-24h' _COMM=sshd _COMM=sshd-session 2>/dev/null | grep -cE 'Failed password|Invalid user'; else grep -hE 'Failed password|Invalid user' /var/log/auth.log /var/log/secure 2>/dev/null | wc -l; fi
echo __CORE; echo "pattern=$(sysctl -n kernel.core_pattern 2>/dev/null)"; echo "suid_dumpable=$(sysctl -n fs.suid_dumpable 2>/dev/null)"; echo "hardlimit=$(grep -hE '^\\*\\s+hard\\s+core' /etc/security/limits.conf /etc/security/limits.d/*.conf 2>/dev/null | awk '{print $4}' | tail -1)"; echo "storage=$(grep -hE '^Storage=' /etc/systemd/coredump.conf /etc/systemd/coredump.conf.d/*.conf 2>/dev/null | tail -1 | cut -d= -f2)"
echo __SYSCTL; sysctl -e net.ipv4.ip_forward kernel.randomize_va_space net.ipv4.tcp_syncookies net.ipv4.conf.all.rp_filter net.ipv4.conf.all.accept_redirects net.ipv4.conf.all.send_redirects net.ipv4.conf.all.accept_source_route kernel.kptr_restrict kernel.dmesg_restrict fs.protected_symlinks fs.protected_hardlinks 2>/dev/null
echo __MAC; if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = "Y" ]; then echo "apparmor $(aa-status --profiled 2>/dev/null || echo 0) $(aa-status --enforced 2>/dev/null || echo 0)"; elif command -v getenforce >/dev/null 2>&1; then echo "selinux $(getenforce 2>/dev/null)"; else echo none; fi
echo __AUDITD; if command -v auditctl >/dev/null 2>&1 || [ -x /sbin/auditd ] || [ -x /usr/sbin/auditd ]; then echo installed; systemctl is-active auditd 2>/dev/null || echo inactive; else echo missing; fi
echo __DOCKER; if [ -S /var/run/docker.sock ]; then stat -c '%U:%G %a' /var/run/docker.sock 2>/dev/null; getent group docker 2>/dev/null | cut -d: -f4; else echo none; fi
echo __CRON; crontab -l -u root 2>/dev/null | grep -vE '^\\s*(#|$)' | wc -l; ls /etc/cron.d 2>/dev/null | grep -v placeholder | wc -l; ls /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly 2>/dev/null | grep -vE ':$|^$|placeholder' | wc -l
echo __END
`

const SUID_STANDARD = new Set([
  'su', 'sudo', 'sudoedit', 'passwd', 'chsh', 'chfn', 'gpasswd', 'newgrp', 'sg', 'mount', 'umount', 'ping', 'ping6', 'fusermount', 'fusermount3', 'pkexec',
  'ssh-keysign', 'chage', 'expiry', 'unix_chkpwd', 'pam_timestamp_check', 'at', 'crontab', 'dbus-daemon-launch-helper', 'polkit-agent-helper-1', 'snap-confine',
  'Xorg', 'Xorg.wrap', 'newuidmap', 'newgidmap', 'suexec', 'wall', 'write', 'ntfs-3g', 'mtr-packet', 'exim4', 'procmail', 'bwrap', 'ksu', 'userhelper',
  'staprun', 'usernetctl', 'chrome-sandbox', 'mount.cifs', 'mount.nfs', 'vmware-user-suid-wrapper', 'lxc-user-nic', 'authpf', 'authpf-noip', 'cockpit-session',
  'grub2-set-bootflag', 'utempter', 'vmware-vmx', 'traceroute6.iputils', 'arping', 'clockdiff', 'fusermount-glusterfs', 'ssh-agent', 'chrony', 'dmcrypt-get-device',
  'unix2_chkpwd', 'mount.ecryptfs_private', 'umount.ecryptfs_private', 'lockdev', 'pt_chown', 'Xwayland', 'sshd', 'uuidd', 'kismet_capture', 'rpcbind'
])

const SYSCTL_EXPECT: Record<string, { want: string; title: string }> = {
  'kernel.randomize_va_space': { want: '2', title: 'ASLR (kernel.randomize_va_space)' },
  'net.ipv4.tcp_syncookies': { want: '1', title: 'SYN cookies' },
  'net.ipv4.conf.all.rp_filter': { want: '1|2', title: 'Reverse path filtering' },
  'net.ipv4.conf.all.accept_redirects': { want: '0', title: 'Ignore ICMP redirects (IPv4)' },
  'net.ipv4.conf.all.send_redirects': { want: '0', title: 'Do not send ICMP redirects' },
  'net.ipv4.conf.all.accept_source_route': { want: '0', title: 'Reject source-routed packets' },
  'kernel.kptr_restrict': { want: '1|2', title: 'Hide kernel pointers' },
  'kernel.dmesg_restrict': { want: '1', title: 'Restrict dmesg to root' },
  'fs.protected_symlinks': { want: '1', title: 'Protected symlinks' },
  'fs.protected_hardlinks': { want: '1', title: 'Protected hardlinks' }
}

function sections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.split('\n')) {
    const m = line.match(/^__([A-Z0-9]+)$/)
    if (m) {
      cur = m[1]
      res[cur] = []
      continue
    }
    if (cur) res[cur].push(line)
  }
  return res
}

function nonEmpty(lines: string[] | undefined): string[] {
  return (lines ?? []).map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
}

interface HistoryFile {
  servers: Record<string, SecurityHistoryEntry[]>
}
const history = new JsonStore<HistoryFile>('security-history.json', { servers: {} })

/* ------------------------------------------------------------------ */
/* Report builder                                                      */
/* ------------------------------------------------------------------ */

function buildReport(out: string, pkgManager: string, durationMs: number): SecurityReportEx {
  const s = sections(out)
  const checks: SecurityCheck[] = []
  const add = (c: SecurityCheck): void => {
    checks.push(c)
  }

  // ---- sshd effective config
  // Prefer `sshd -T` (effective, as root). Fall back to the config files in sshd's own read order.
  const fromT = nonEmpty(s.SSHD).length > 0
  const parsed = parseSshdConfig(fromT ? nonEmpty(s.SSHD) : nonEmpty(s.SSHDCFG))
  const sshd: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) sshd[k] = v[0]
  // Settings that apply to *our* login (Match blocks for this user / address applied).
  const me = parseSshdConfig(nonEmpty(s.SSHDME))
  const mine = (k: string): string | undefined => me[k]?.[0]?.toLowerCase()
  const sshPort = Number(parsed.port?.[0]) || 22
  const haveSshd = Object.keys(sshd).length > 0
  if (!haveSshd) {
    add({ id: 'sshd', title: 'SSH server configuration', status: 'info', detail: 'Could not read the effective sshd configuration (sshd -T failed and no config files were readable).', weight: 0 })
  } else {
    const prl = (sshd.permitrootlogin ?? 'prohibit-password').toLowerCase()
    add({
      id: 'ssh-root',
      title: 'Root login over SSH',
      status: prl === 'yes' ? 'fail' : prl === 'no' ? 'pass' : 'warn',
      detail: `PermitRootLogin ${prl}${prl === 'yes' ? ' — root can log in with a password; brute-force target #1' : prl === 'no' ? '' : ' — root can log in with a key only'}`,
      fixAction: prl === 'yes' ? 'ssh-login' : undefined,
      weight: 6
    })
    // Password logins are possible through PasswordAuthentication *or* keyboard-interactive (PAM),
    // which is how many distributions actually accept passwords (and how 2FA prompts arrive).
    const yes = (v: string | undefined, dflt: string): boolean => (v ?? dflt).toLowerCase() === 'yes'
    const kbdKey = 'kbdinteractiveauthentication' in sshd ? 'kbdinteractiveauthentication' : 'challengeresponseauthentication'
    const globalPwd = yes(sshd.passwordauthentication, 'yes') || yes(sshd[kbdKey], 'yes')
    const minePwd = Object.keys(me).length ? yes(mine('passwordauthentication'), sshd.passwordauthentication ?? 'yes') || yes(mine(kbdKey), sshd[kbdKey] ?? 'yes') : globalPwd
    // AuthenticationMethods "publickey,keyboard-interactive" (2FA) means a key is always required,
    // so a password alone can never log in even though keyboard-interactive is on.
    const keyRequired = (am: string | undefined): boolean => !!am && am.trim() !== 'any' && am.trim().split(/\s+/).every((list) => list.split(',').includes('publickey'))
    const pwd = (globalPwd && !keyRequired(sshd.authenticationmethods)) || (minePwd && !keyRequired(mine('authenticationmethods') ?? sshd.authenticationmethods))
    const amNote = keyRequired(sshd.authenticationmethods) ? ` · AuthenticationMethods ${sshd.authenticationmethods} requires a key for every login` : ''
    const how = [sshd.passwordauthentication !== undefined ? `PasswordAuthentication ${sshd.passwordauthentication}` : undefined, sshd[kbdKey] !== undefined ? `${kbdKey === 'kbdinteractiveauthentication' ? 'KbdInteractiveAuthentication' : 'ChallengeResponseAuthentication'} ${sshd[kbdKey]}` : undefined].filter(Boolean).join(', ')
    const matchNote = Object.keys(me).length && minePwd !== globalPwd ? ` · a Match block ${minePwd ? 'allows' : 'disables'} passwords for your login specifically` : ''
    add({
      id: 'ssh-password',
      title: 'Password authentication',
      status: pwd ? 'warn' : 'pass',
      detail: pwd ? `Passwords are accepted (${how})${matchNote} — prefer SSH keys and turn passwords off once your key works` : `Keys only (${how})${amNote}${matchNote}`,
      fixAction: pwd ? 'ssh-login' : undefined,
      weight: 4
    })
    if (!fromT) add({ id: 'sshd-source', title: 'SSH settings read from config files', status: 'info', detail: 'sshd -T was not available, so the values above come from /etc/ssh/sshd_config and its includes (Match blocks not evaluated).', weight: 0 })
    add({ id: 'ssh-port', title: 'SSH port', status: 'info', detail: `Port ${sshPort}${sshPort === 22 ? ' (default; a non-standard port reduces log noise but is not a security control)' : ' (non-standard)'}`, weight: 0 })
    const mat = Number(sshd.maxauthtries ?? 6)
    add({ id: 'ssh-maxauth', title: 'MaxAuthTries', status: mat <= 4 ? 'pass' : 'warn', detail: `MaxAuthTries ${mat}${mat > 4 ? ' — recommended 4 or less' : ''}`, fixAction: mat > 4 ? 'ssh-hardening' : undefined, weight: 1 })
    const x11 = (sshd.x11forwarding ?? 'no').toLowerCase() === 'yes'
    add({ id: 'ssh-x11', title: 'X11 forwarding', status: x11 ? 'warn' : 'pass', detail: `X11Forwarding ${x11 ? 'yes — unnecessary on servers' : 'no'}`, fixAction: x11 ? 'ssh-hardening' : undefined, weight: 1 })
    const empty = (sshd.permitemptypasswords ?? 'no').toLowerCase() === 'yes'
    add({ id: 'ssh-emptypw', title: 'Empty passwords over SSH', status: empty ? 'fail' : 'pass', detail: `PermitEmptyPasswords ${empty ? 'yes' : 'no'}`, fixAction: empty ? 'ssh-hardening' : undefined, weight: 5 })
    if (sshd.protocol && sshd.protocol.includes('1')) add({ id: 'ssh-proto', title: 'SSH protocol 1 enabled', status: 'fail', detail: `Protocol ${sshd.protocol} — protocol 1 is broken; remove it`, weight: 5 })
    const grace = Number(sshd.logingracetime ?? 120)
    add({ id: 'ssh-grace', title: 'LoginGraceTime', status: grace <= 60 ? 'pass' : 'warn', detail: `LoginGraceTime ${grace}s${grace > 60 ? ' — 30–60 s limits unauthenticated connections' : ''}`, fixAction: grace > 60 ? 'ssh-hardening' : undefined, weight: 1 })
  }

  // ---- fail2ban
  const f2b = nonEmpty(s.F2B).map((l) => l.trim())
  if (f2b[0] === 'installed') {
    const active = f2b[1] === 'active'
    const banned = f2b.find((l, i) => i > 1 && /^\d+$/.test(l))
    add({ id: 'fail2ban', title: 'Fail2ban brute-force protection', status: active ? 'pass' : 'warn', detail: active ? `fail2ban is running${banned !== undefined ? ` · ${banned} IP(s) currently banned in the sshd jail` : ''}` : 'fail2ban is installed but not running', fixAction: active ? undefined : 'fail2ban', weight: 4 })
  } else add({ id: 'fail2ban', title: 'Fail2ban brute-force protection', status: 'warn', detail: 'fail2ban is not installed — repeated failed logins are not blocked', fixAction: 'fail2ban', weight: 4 })

  // ---- firewall
  const fw = (nonEmpty(s.FW)[0] ?? 'none').trim().split(/\s+/)
  if (fw[0] === 'none') add({ id: 'firewall', title: 'Firewall', status: 'fail', detail: 'No active firewall detected (ufw / firewalld / nftables / iptables). Every listening service is reachable from the Internet.', fixAction: 'firewall', weight: 6 })
  else add({ id: 'firewall', title: 'Firewall', status: 'pass', detail: `${fw[0]} is active · ${fw[1] ?? '?'} rule(s)`, weight: 6 })

  // ---- updates
  const updLines = nonEmpty(s.UPD)
  const secCountLine = updLines.find((l) => l.startsWith('__SECCOUNT'))
  const upd = updLines.filter((l) => !l.startsWith('__SECCOUNT') && !/^(Listing|WARNING)/i.test(l))
  const security = secCountLine ? Number(secCountLine.split(/\s+/)[1]) || 0 : upd.filter((l) => /-security|security/i.test(l)).length
  if (pkgManager === 'unknown') add({ id: 'updates', title: 'Pending package updates', status: 'info', detail: 'Unknown package manager', weight: 0 })
  else
    add({
      id: 'updates',
      title: 'Pending package updates',
      status: upd.length === 0 ? 'pass' : security > 0 ? 'fail' : 'warn',
      detail: upd.length === 0 ? 'System is up to date' : `${upd.length} package(s) can be upgraded${security ? `, ${security} security update(s)` : ''}: ${upd.slice(0, 6).map((l) => l.split(/[\s/]/)[0]).join(', ')}${upd.length > 6 ? ', …' : ''}`,
      fixAction: upd.length ? 'updates' : undefined,
      weight: 4
    })
  const uu = (nonEmpty(s.UU)[0] ?? 'NA').trim()
  if (uu === 'NA') add({ id: 'auto-updates', title: 'Automatic security updates', status: 'info', detail: 'Not available for this distribution (apt / dnf only)', weight: 0 })
  else add({ id: 'auto-updates', title: 'Automatic security updates', status: uu === '1' ? 'pass' : 'warn', detail: uu === '1' ? 'unattended-upgrades / dnf-automatic is enabled' : 'Automatic security updates are off', fixAction: uu === '1' ? undefined : 'auto-updates', weight: 3 })

  // ---- reboot / kernel
  const reboot = (nonEmpty(s.REBOOT)[0] ?? 'no').trim() === 'yes'
  const kern = nonEmpty(s.KERNEL).map((l) => l.trim())
  const running = kern[0] ?? ''
  const newest = kern[1] ?? ''
  const kernelStale = !!newest && !!running && newest !== running && !running.startsWith(newest)
  add({
    id: 'reboot',
    title: 'Reboot required',
    status: reboot || kernelStale ? 'warn' : 'pass',
    detail: reboot ? `/var/run/reboot-required is present${kernelStale ? ` · running kernel ${running}, newest installed ${newest}` : ''}` : kernelStale ? `Running kernel ${running} but ${newest} is installed — reboot to activate it` : `Running kernel ${running}${newest ? ' (newest installed)' : ''}`,
    fixAction: reboot || kernelStale ? 'reboot' : undefined,
    weight: 2
  })

  // ---- accounts
  const emptyPw = nonEmpty(s.EMPTYPW).map((l) => l.trim())
  add({ id: 'empty-passwords', title: 'Accounts with empty passwords', status: emptyPw.length ? 'fail' : 'pass', detail: emptyPw.length ? `${emptyPw.join(', ')} — set a password or lock the account (passwd -l)` : 'None', weight: 6 })
  const uid0 = nonEmpty(s.UID0).map((l) => l.trim())
  add({ id: 'uid0', title: 'Extra UID 0 accounts', status: uid0.length ? 'fail' : 'pass', detail: uid0.length ? `${uid0.join(', ')} have uid 0 (root privileges)` : 'Only root has uid 0', weight: 6 })
  const nopasswd = nonEmpty(s.NOPASSWD).map((l) => l.trim())
  add({ id: 'sudo-nopasswd', title: 'sudo without password', status: nopasswd.length ? 'warn' : 'pass', detail: nopasswd.length ? `${nopasswd.length} NOPASSWD rule(s): ${nopasswd.slice(0, 3).join(' | ')}${nopasswd.length > 3 ? ' | …' : ''}` : 'All sudo rules require a password', weight: 2 })

  // ---- files
  const ww = nonEmpty(s.WW).map((l) => l.trim())
  add({ id: 'world-writable', title: 'World-writable files in /etc, /usr/local', status: ww.length ? 'fail' : 'pass', detail: ww.length ? ww.join(', ') : 'None found', weight: 3 })
  const suid = nonEmpty(s.SUID).map((l) => l.trim())
  const unusual = suid.filter((p) => !SUID_STANDARD.has(p.split('/').pop() ?? ''))
  add({ id: 'suid', title: 'SUID binaries', status: 'info', detail: `${suid.length} SUID binaries, ${unusual.length} outside the usual set${unusual.length ? `: ${unusual.slice(0, 8).join(', ')}${unusual.length > 8 ? ', …' : ''}` : ''}`, weight: 0 })
  const keyPerm = nonEmpty(s.KEYPERM).map((l) => l.trim())
  const badKeys = keyPerm.filter((l) => {
    const mode = l.split(/\s+/)[0]
    return mode !== '600' && mode !== '640' && mode !== '400'
  })
  if (keyPerm.length) add({ id: 'hostkey-perms', title: 'SSH host key permissions', status: badKeys.length ? 'fail' : 'pass', detail: badKeys.length ? badKeys.join(', ') + ' — should be 600' : `${keyPerm.length} host key(s) are private (600)`, weight: 3 })
  const rootKeys = Number((nonEmpty(s.ROOTKEYS)[0] ?? '0').trim()) || 0
  add({ id: 'root-keys', title: 'authorized_keys for root', status: 'info', detail: `${rootKeys} key(s) in /root/.ssh/authorized_keys`, weight: 0 })

  // ---- network
  const listen = nonEmpty(s.LISTEN)
    .map((l) => {
      const [proto, addr, proc] = l.trim().split(/\s+/)
      const m = (addr ?? '').match(/^(.*):(\d+)$/)
      const host = m ? m[1] : addr
      const port = m ? Number(m[2]) : 0
      const pm = (proc ?? '').match(/\("([^"]+)"/)
      return { proto, host, port, proc: pm ? pm[1] : '' }
    })
    .filter((x) => x.port && (x.host === '0.0.0.0' || x.host === '*' || x.host === '[::]' || x.host === '::'))
  const pub = new Map<string, Set<string>>()
  for (const x of listen) {
    const key = `${x.port}/${x.proto}`
    pub.set(key, (pub.get(key) ?? new Set()).add(x.proc || '?'))
  }
  const pubList = [...pub.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k} (${[...v].join(',')})`)
  const risky = listen.filter((x) => [3306, 5432, 27017, 6379, 11211, 9200, 5984, 2375, 2376].includes(x.port))
  add({
    id: 'listening',
    title: 'Services listening on all interfaces',
    status: risky.length ? 'fail' : listen.length > 3 ? 'warn' : 'info',
    detail: pubList.length ? `${pubList.join(', ')}${risky.length ? ` — databases / caches / docker API exposed publicly: ${risky.map((x) => `${x.port} ${x.proc}`).join(', ')}` : ''}` : 'Nothing bound to 0.0.0.0 / ::',
    fixAction: risky.length || listen.length > 3 ? 'firewall' : undefined,
    weight: risky.length ? 5 : listen.length > 3 ? 2 : 0
  })

  // ---- disk / swap
  const disks = nonEmpty(s.DISK)
    .map((l) => {
      const [pct, mount] = l.trim().split(/\s+/)
      return { pct: Number((pct ?? '').replace('%', '')) || 0, mount: mount ?? '' }
    })
    .filter((d) => d.mount)
  const fullDisks = disks.filter((d) => d.pct >= 90)
  add({ id: 'disk', title: 'Disk usage', status: fullDisks.length ? 'fail' : disks.some((d) => d.pct >= 80) ? 'warn' : 'pass', detail: fullDisks.length ? `${fullDisks.map((d) => `${d.mount} ${d.pct}%`).join(', ')} — a full disk breaks logging, updates and databases` : disks.length ? disks.map((d) => `${d.mount} ${d.pct}%`).join(', ') : 'No filesystems reported', weight: 2 })
  const swapN = Number((nonEmpty(s.SWAP)[0] ?? '0').trim()) || 0
  add({ id: 'swap', title: 'Swap configured', status: swapN ? 'pass' : 'warn', detail: swapN ? `${swapN} swap device(s) active` : 'No swap — the OOM killer may terminate services under memory pressure (configure in Overview → Quick actions)', weight: 1 })

  // ---- time sync
  const time = nonEmpty(s.TIME).map((l) => l.trim())
  const tdc = (time[0] ?? '').split(/\s+/)
  const synced = tdc[0] === 'yes' || time.some((l) => /Leap status\s*:\s*Normal/i.test(l)) || time.some((l) => /^[1-9]\d*$/.test(l))
  add({ id: 'timesync', title: 'Time synchronisation', status: synced ? 'pass' : 'warn', detail: synced ? `Clock is synchronised (${tdc[1] === 'yes' ? 'systemd-timesyncd / NTP active' : 'NTP daemon'})` : 'Clock is not synchronised — breaks TLS, logs and 2FA; enable NTP in Overview → Quick actions', weight: 2 })

  // ---- failed logins
  const failed = Number((nonEmpty(s.FAILED)[0] ?? '0').trim()) || 0
  add({ id: 'failed-logins', title: 'Failed SSH logins (24 h)', status: failed > 500 ? 'warn' : 'info', detail: `${failed} failed / invalid-user attempts in the last 24 hours${failed > 500 ? ' — heavy brute-forcing; fail2ban and key-only login recommended' : ''}`, fixAction: failed > 500 && f2b[0] !== 'installed' ? 'fail2ban' : undefined, weight: failed > 500 ? 1 : 0 })

  // ---- core dumps
  const core: Record<string, string> = {}
  for (const l of nonEmpty(s.CORE)) {
    const m = l.match(/^(\w+)=(.*)$/)
    if (m) core[m[1]] = m[2].trim()
  }
  const systemdCore = (core.pattern ?? '').startsWith('|') && core.pattern.includes('systemd-coredump')
  const coreOff = core.hardlimit === '0' || (systemdCore && core.storage === 'none') || core.suid_dumpable === '0' && core.hardlimit === '0'
  add({ id: 'coredumps', title: 'Core dumps', status: coreOff ? 'pass' : systemdCore ? 'info' : 'warn', detail: coreOff ? 'Core dumps are disabled' : systemdCore ? `Handled by systemd-coredump (Storage=${core.storage || 'external'}); fs.suid_dumpable=${core.suid_dumpable || '?'}` : `core_pattern=${core.pattern || '?'} · hard core limit ${core.hardlimit || 'unlimited'} — core files can leak secrets from memory`, weight: coreOff || systemdCore ? 0 : 1 })

  // ---- sysctl
  const sysctl: Record<string, string> = {}
  for (const l of nonEmpty(s.SYSCTL)) {
    const m = l.match(/^([\w.]+)\s*=\s*(.*)$/)
    if (m) sysctl[m[1]] = m[2].trim()
  }
  const ipf = sysctl['net.ipv4.ip_forward']
  add({ id: 'ip-forward', title: 'IP forwarding', status: 'info', detail: ipf === '1' ? 'net.ipv4.ip_forward=1 (expected when Docker, Kubernetes, VPN or routing is used)' : ipf === '0' ? 'net.ipv4.ip_forward=0' : 'unknown', weight: 0 })
  const badSysctl: string[] = []
  for (const [k, exp] of Object.entries(SYSCTL_EXPECT)) {
    const v = sysctl[k]
    if (v === undefined) continue
    if (!new RegExp(`^(${exp.want})$`).test(v)) badSysctl.push(`${k}=${v}`)
  }
  add({ id: 'sysctl', title: 'Kernel hardening (sysctl)', status: badSysctl.length === 0 ? 'pass' : badSysctl.length <= 2 ? 'warn' : 'fail', detail: badSysctl.length ? `${badSysctl.length} setting(s) weaker than recommended: ${badSysctl.join(', ')}` : 'ASLR, SYN cookies, rp_filter, ICMP redirects, kptr/dmesg restrictions and protected links are all set', fixAction: badSysctl.length ? 'sysctl' : undefined, weight: 3 })

  // ---- MAC / auditd
  const mac = (nonEmpty(s.MAC)[0] ?? 'none').trim().split(/\s+/)
  if (mac[0] === 'apparmor') add({ id: 'mac', title: 'Mandatory access control', status: 'pass', detail: `AppArmor enabled · ${mac[1] ?? '?'} profiles loaded, ${mac[2] ?? '?'} in enforce mode`, weight: 2 })
  else if (mac[0] === 'selinux') add({ id: 'mac', title: 'Mandatory access control', status: /enforcing/i.test(mac[1] ?? '') ? 'pass' : 'warn', detail: `SELinux ${mac[1] ?? '?'}${/permissive|disabled/i.test(mac[1] ?? '') ? ' — set to enforcing when possible' : ''}`, weight: 2 })
  else add({ id: 'mac', title: 'Mandatory access control', status: 'warn', detail: 'Neither AppArmor nor SELinux is enabled', weight: 2 })
  const auditd = nonEmpty(s.AUDITD).map((l) => l.trim())
  add({ id: 'auditd', title: 'Audit daemon (auditd)', status: 'info', detail: auditd[0] === 'installed' ? `auditd installed · ${auditd[1] ?? 'unknown'}` : 'auditd not installed (optional; useful for compliance / forensic logging)', weight: 0 })

  // ---- docker
  const dock = nonEmpty(s.DOCKER).map((l) => l.trim())
  if (dock[0] !== 'none' && dock.length) {
    const members = (dock[1] ?? '').split(',').filter(Boolean)
    const mode = dock[0].split(/\s+/)[1] ?? ''
    const worldRw = /[2367]$/.test(mode)
    add({ id: 'docker-sock', title: 'Docker socket exposure', status: worldRw ? 'fail' : members.length ? 'warn' : 'pass', detail: worldRw ? `/var/run/docker.sock is ${dock[0]} — world-writable socket = root for everyone` : members.length ? `docker group members (equivalent to root): ${members.join(', ')}` : `/var/run/docker.sock ${dock[0]}, no extra docker group members`, weight: 3 })
  }

  // ---- cron
  const cron = nonEmpty(s.CRON).map((l) => Number(l.trim()) || 0)
  add({ id: 'cron', title: 'Root cron jobs', status: 'info', detail: `${cron[0] ?? 0} in root's crontab · ${cron[1] ?? 0} files in /etc/cron.d · ${cron[2] ?? 0} scripts in cron.{hourly,daily,weekly,monthly}`, weight: 0 })

  // ---- score
  let total = 0
  let got = 0
  for (const c of checks) {
    if (c.status === 'info' || c.weight <= 0) continue
    total += c.weight
    if (c.status === 'pass') got += c.weight
    else if (c.status === 'warn') got += c.weight / 2
  }
  const score = total ? Math.round((100 * got) / total) : 100
  return { score, checks, ts: Date.now(), hostname: (nonEmpty(s.HOST)[0] ?? '').trim(), sshPort, pkgManager, durationMs }
}

/* ------------------------------------------------------------------ */
/* Hardening helpers                                                   */
/* ------------------------------------------------------------------ */

const SYSCTL_FILE = '/etc/sysctl.d/99-serversysops-hardening.conf'
const SYSCTL_CONTENT = `# Managed by ServerSysOps - kernel/network hardening (safe defaults)
kernel.randomize_va_space = 2
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
`

const SSHD_HARDEN_DROPIN = '/etc/ssh/sshd_config.d/01-serversysops-hardening.conf'
const SSHD_HARDEN_CONTENT = `# Managed by ServerSysOps - SSH hardening
MaxAuthTries 4
X11Forwarding no
PermitEmptyPasswords no
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowTcpForwarding yes
`
const BLOCK_START = '# >>> ServerSysOps hardening >>>'
const BLOCK_END = '# <<< ServerSysOps hardening <<<'

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


/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  ctx.handle('sec:audit', async (serverId: string): Promise<SecurityReportEx> => {
    const ssh = ctx.ssh(serverId)
    const t0 = Date.now()
    // Who are we, and from where? Lets the audit evaluate Match blocks for this very login.
    const who = await ssh.exec(`id -un; echo "$SSH_CLIENT" | awk '{print $1}'`, { timeoutMs: 10000 }).catch(() => ({ stdout: '' }))
    const [smUser, smAddr] = who.stdout.split('\n').map((l) => l.trim())
    const env: Record<string, string> = {}
    if (smUser && /^[A-Za-z0-9._-]+$/.test(smUser)) env.SM_USER = smUser
    if (smAddr && /^[0-9a-fA-F.:]+$/.test(smAddr)) env.SM_ADDR = smAddr
    const r = await ssh.sudo(AUDIT_SCRIPT, { timeoutMs: 180000, maxBuffer: 4 * 1024 * 1024, env })
    if (!r.stdout.includes('__END') && !r.stdout.includes('__SSHD')) throw new Error('Audit script produced no output: ' + (r.stderr.trim() || `exit ${r.code}`))
    const report = buildReport(r.stdout, ssh.os?.pkgManager ?? 'unknown', Date.now() - t0)
    const failed = report.checks.filter((c) => c.status === 'fail').length
    const warnings = report.checks.filter((c) => c.status === 'warn').length
    history.update((d) => {
      const list = [...(d.servers[serverId] ?? []), { ts: report.ts, score: report.score, failed, warnings }].slice(-10)
      return { servers: { ...d.servers, [serverId]: list } }
    })
    ctx.audit(serverId, 'security.audit', `score ${report.score} · ${failed} failed · ${warnings} warnings`)
    return report
  })

  ctx.handle('sec:history', (serverId: string): SecurityHistoryEntry[] => history.read().servers[serverId] ?? [])

  ctx.handle('sec:hardenSysctl', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Apply kernel hardening (sysctl)', serverId, async (h) => {
      h.log(`Writing ${SYSCTL_FILE}…`)
      await writeRootFile(ssh, SYSCTL_FILE, SYSCTL_CONTENT)
      h.log('Applying with sysctl --system…')
      const r = await ssh.sudo('sysctl --system 2>&1 | tail -n 20')
      h.append(r.stdout)
      if (r.code !== 0) throw new Error('sysctl --system failed: ' + (r.stderr || r.stdout).trim())
      h.log('Done. Settings persist across reboots.')
      ctx.audit(serverId, 'security.sysctl', SYSCTL_FILE)
    })
    return id
  })

  ctx.handle('sec:hardenSsh', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Apply SSH hardening', serverId, async (h) => {
      const includes = await sshdSupportsInclude(ssh)
      h.log(includes ? `Writing ${SSHD_HARDEN_DROPIN}…` : 'sshd_config.d is not included on this system; adding a managed block to /etc/ssh/sshd_config…')
      let hadDropin = false
      let prevDropin = ''
      if (includes) {
        const prev = await ssh.sudo(`cat ${SSHD_HARDEN_DROPIN} 2>/dev/null`)
        hadDropin = prev.code === 0
        prevDropin = prev.stdout
        await writeRootFile(ssh, SSHD_HARDEN_DROPIN, SSHD_HARDEN_CONTENT)
      } else {
        const block = `${BLOCK_START}\n${SSHD_HARDEN_CONTENT}${BLOCK_END}\n`
        await ssh.sudoRun(
          `cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.serversysops-hardening.bak && t=$(mktemp) && sed -i '/^${BLOCK_START}$/,/^${BLOCK_END}$/d' /etc/ssh/sshd_config && sed -i -E '/^\\s*(MaxAuthTries|X11Forwarding|PermitEmptyPasswords|LoginGraceTime|ClientAliveInterval|ClientAliveCountMax)\\s/d' /etc/ssh/sshd_config && ${b64Echo(block)} | cat - /etc/ssh/sshd_config > "$t" && install -m 644 "$t" /etc/ssh/sshd_config; rc=$?; rm -f "$t"; exit $rc`
        )
      }
      h.log('Testing configuration and reloading sshd…')
      try {
        await sshdReload(ssh)
      } catch (e) {
        h.log('Configuration test failed, reverting…')
        if (includes) {
          if (hadDropin) await writeRootFile(ssh, SSHD_HARDEN_DROPIN, prevDropin)
          else await ssh.sudo(`rm -f ${SSHD_HARDEN_DROPIN}`)
        } else await ssh.sudo('cp /etc/ssh/sshd_config.serversysops-hardening.bak /etc/ssh/sshd_config')
        throw e
      }
      await new Promise((r) => setTimeout(r, 1200))
      h.log('Verifying this app can still log in…')
      const ok = await probeLogin(ctx, serverId, ssh.profile.port)
      if (!ok) {
        h.log('Login failed. Rolling back…')
        if (includes) {
          if (hadDropin) await writeRootFile(ssh, SSHD_HARDEN_DROPIN, prevDropin)
          else await ssh.sudo(`rm -f ${SSHD_HARDEN_DROPIN}`)
        } else await ssh.sudo('cp /etc/ssh/sshd_config.serversysops-hardening.bak /etc/ssh/sshd_config')
        await sshdReload(ssh).catch(() => {})
        throw new Error('Could not log in after applying the hardening; previous configuration restored.')
      }
      h.log('Done: MaxAuthTries 4, X11Forwarding no, PermitEmptyPasswords no, LoginGraceTime 30, ClientAlive 300×2.')
      ctx.audit(serverId, 'security.sshHardening', includes ? SSHD_HARDEN_DROPIN : '/etc/ssh/sshd_config')
    })
    return id
  })
}
