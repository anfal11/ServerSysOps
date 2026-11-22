import type { Ctx } from '../core'
import type { TfaConflict, TfaEnableOptions, TfaEnrollOptions, TfaEnrollResult, TfaMode, TfaStatus, TfaUser } from '@shared/modules/twofactor'
import { SshClient, SshError, type ExecOptions } from '../ssh/SshClient'
import { assertSafeName, b64Echo, shq } from '../ssh/shell'
import { generateSecret, otpauthUrl, scratchCodes, verifyTotp } from '../ssh/totp'
import { getSecrets, updateSecrets } from '../store/servers'
import { installCmd, runPkg } from './pkg'
import { probeLogin } from '../ssh/probe'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PAM_FILE = '/etc/pam.d/sshd'
const PAM_BACKUP = '/etc/pam.d/sshd.centralserver.bak'
const SSHD_DROPIN = '/etc/ssh/sshd_config.d/00-centralserver-2fa.conf'
const SSHD_DROPIN_BASENAME = '00-centralserver-2fa.conf'
const SSHD_CONFIG = '/etc/ssh/sshd_config'
const SSHD_BACKUP = '/etc/ssh/sshd_config.centralserver-2fa.bak'
const MARKER = '# Central Server 2FA'
const MARKER_DISABLED = `${MARKER} disabled:`
const BLOCK_BEGIN = '# BEGIN Central Server 2FA'
const BLOCK_END = '# END Central Server 2FA'
const PAM_SO = 'pam_google_authenticator.so'
const MODES: TfaMode[] = ['off', 'password+code', 'key+code', 'key-or-code']
/** Lines in /etc/pam.d/sshd that pull in the password stack (Debian, RHEL, SUSE, Arch, Alpine). */
const PAM_INCLUDE_RE = /^\s*(?:@include\s+common-auth\b|auth\s+(?:include|substack)\s+(?!postlogin\b)\S+)/i
const CODE_RE = /^\d{6,8}$/
const SECRET_RE = /^[A-Z2-7]{16,128}=*$/

/* ------------------------------------------------------------------ */
/* Shell helpers (same pattern as users.ts)                            */
/* ------------------------------------------------------------------ */

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

/** Write a root-owned file (base64 transport, atomic install). */
async function writeRootFile(ssh: SshClient, path: string, content: string, mode = '644'): Promise<void> {
  await rootRun(ssh, `d=$(dirname ${shq(path)}); mkdir -p "$d" && t=$(mktemp) && ${b64Echo(content)} > "$t" && install -m ${mode} -o root -g root "$t" ${shq(path)}; rc=$?; rm -f "$t"; exit $rc`)
}

async function readRootFile(ssh: SshClient, path: string): Promise<string | null> {
  const r = await rootExec(ssh, `cat ${shq(path)} 2>/dev/null`)
  return r.code === 0 ? r.stdout : null
}

async function sshdSupportsInclude(ssh: SshClient): Promise<boolean> {
  const r = await ssh.exec(`grep -qiE '^\\s*Include\\s+/etc/ssh/sshd_config.d' ${SSHD_CONFIG} && echo yes`)
  return r.stdout.includes('yes')
}

async function sshdTest(ssh: SshClient): Promise<string | null> {
  const t = await rootExec(ssh, 'sshd -t 2>&1 || /usr/sbin/sshd -t 2>&1')
  return t.code === 0 ? null : (t.stdout + t.stderr).trim()
}

async function sshdReload(ssh: SshClient): Promise<void> {
  await rootRun(
    ssh,
    'systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || service sshd reload 2>/dev/null || service ssh reload 2>/dev/null || rc-service sshd reload'
  )
}

function selfUser(ssh: SshClient): string {
  return ssh.os?.user ?? ssh.profile.username
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function assertUser(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Invalid username')
  return assertSafeName(name, 'username')
}

function assertCode(code: unknown): string {
  const c = typeof code === 'string' ? code.replace(/\s+/g, '') : ''
  if (!CODE_RE.test(c)) throw new Error('A code is 6 to 8 digits')
  return c
}

/* ------------------------------------------------------------------ */
/* Distro                                                              */
/* ------------------------------------------------------------------ */

function packageName(ssh: SshClient): string {
  switch (ssh.os?.pkgManager) {
    case 'apt':
    case 'pacman':
      return 'libpam-google-authenticator'
    case 'dnf':
    case 'yum':
    case 'apk':
      return 'google-authenticator'
    case 'zypper':
      return 'google-authenticator-libpam'
    default:
      return 'google-authenticator'
  }
}

/** RHEL-family (not Fedora) needs EPEL for the PAM module. */
function needsEpel(ssh: SshClient): boolean {
  const os = ssh.os
  if (!os || (os.pkgManager !== 'dnf' && os.pkgManager !== 'yum')) return false
  if (os.id === 'fedora') return false
  return /\b(rhel|centos|fedora)\b/.test(`${os.id} ${os.idLike}`)
}

/* ------------------------------------------------------------------ */
/* PAM editing                                                         */
/* ------------------------------------------------------------------ */

/** Remove every Central Server-managed line from /etc/pam.d/sshd and restore the lines it commented out. */
function pamStrip(content: string): string[] {
  const out: string[] = []
  for (const line of content.replace(/\r/g, '').split('\n')) {
    const i = line.indexOf(MARKER_DISABLED)
    if (i >= 0) {
      out.push(line.slice(i + MARKER_DISABLED.length).replace(/^ /, ''))
      continue
    }
    if (line.includes(MARKER)) continue
    out.push(line)
  }
  if (out.length && out[out.length - 1] === '') out.pop()
  return out
}

function pamModuleLine(nullok: boolean): string {
  return `auth required ${PAM_SO}${nullok ? ' nullok' : ''} ${MARKER}`
}

/** Build the new /etc/pam.d/sshd for a mode (`off` = restore). */
function pamBuild(content: string, mode: TfaMode, nullok: boolean): string {
  const base = pamStrip(content)
  if (mode === 'off') return base.join('\n') + '\n'
  const moduleLine = pamModuleLine(nullok)
  if (mode === 'password+code') {
    // Password stack first, then the verification code.
    const idx = base.findIndex((l) => PAM_INCLUDE_RE.test(l))
    if (idx >= 0) base.splice(idx + 1, 0, moduleLine)
    else {
      let last = -1
      base.forEach((l, i) => {
        if (/^\s*auth\s/i.test(l)) last = i
      })
      base.splice(last + 1, 0, moduleLine)
    }
    return base.join('\n') + '\n'
  }
  // key+code / key-or-code: keyboard-interactive asks for the code only.
  const out = base.map((l) => (PAM_INCLUDE_RE.test(l) ? `${MARKER_DISABLED} ${l}` : l))
  // Keep a "#%PAM-1.0" header (RHEL/SUSE) on the first line.
  out.splice(/^#%PAM/i.test(out[0] ?? '') ? 1 : 0, 0, moduleLine)
  return out.join('\n') + '\n'
}

/* ------------------------------------------------------------------ */
/* sshd drop-in                                                        */
/* ------------------------------------------------------------------ */

function authMethods(mode: TfaMode): string {
  switch (mode) {
    case 'password+code':
      return 'keyboard-interactive'
    case 'key+code':
      return 'publickey,keyboard-interactive'
    case 'key-or-code':
      return 'publickey keyboard-interactive'
    default:
      return 'any'
  }
}

function dropinContent(mode: TfaMode, nullok: boolean): string {
  return [
    `${MARKER} mode=${mode} nullok=${nullok ? 'yes' : 'no'}`,
    '# Managed by Central Server - two-factor authentication for SSH logins. Do not edit; use the app.',
    'UsePAM yes',
    'KbdInteractiveAuthentication yes',
    'ChallengeResponseAuthentication yes',
    'PasswordAuthentication no',
    'PubkeyAuthentication yes',
    `AuthenticationMethods ${authMethods(mode)}`,
    ''
  ].join('\n')
}

function parseDropinMode(text: string): { mode: TfaMode; nullok: boolean } {
  const m = text.match(/^# Central Server 2FA mode=(\S+) nullok=(yes|no)/m)
  if (m && (MODES as string[]).includes(m[1])) return { mode: m[1] as TfaMode, nullok: m[2] === 'yes' }
  const am = text.match(/^\s*AuthenticationMethods\s+(.+)$/im)?.[1].trim().toLowerCase()
  if (am === 'keyboard-interactive') return { mode: 'password+code', nullok: true }
  if (am === 'publickey,keyboard-interactive') return { mode: 'key+code', nullok: true }
  if (am === 'publickey keyboard-interactive') return { mode: 'key-or-code', nullok: true }
  return { mode: 'off', nullok: true }
}

/** Remove the marker block from sshd_config (Include-less systems) and optionally prepend a new one. */
async function writeSshdBlock(ssh: SshClient, block: string | null): Promise<void> {
  const section = block ? `${BLOCK_BEGIN}\n${block}${BLOCK_END}\n` : ''
  await rootRun(
    ssh,
    `set -e; t=$(mktemp); sed '/^${BLOCK_BEGIN}$/,/^${BLOCK_END}$/d' ${SSHD_CONFIG} > "$t"; t2=$(mktemp); { ${b64Echo(section)}; cat "$t"; } > "$t2"; install -m 644 -o root -g root "$t2" ${SSHD_CONFIG}; rm -f "$t" "$t2"`
  )
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

async function userHome(ssh: SshClient, name: string): Promise<{ home: string; group: string }> {
  const r = await ssh.exec(`getent passwd ${shq(name)} | cut -d: -f6; id -gn ${shq(name)} 2>/dev/null`)
  const [home, group] = r.stdout.split('\n').map((s) => s.trim())
  if (!home || !home.startsWith('/')) throw new Error(`User ${name} does not exist or has no home directory`)
  return { home, group: group || name }
}

async function readStatus(ctx: Ctx, serverId: string): Promise<TfaStatus> {
  const ssh = ctx.ssh(serverId)
  const script = `
echo __SO; find /lib /lib64 /usr/lib /usr/lib64 -name ${PAM_SO} -print -quit 2>/dev/null
echo __PAM; cat ${PAM_FILE} 2>/dev/null
echo __SSHDT; (sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null) | grep -iE '^(kbdinteractiveauthentication|challengeresponseauthentication|usepam|authenticationmethods|passwordauthentication|pubkeyauthentication) '
echo __DROPIN; cat ${SSHD_DROPIN} 2>/dev/null; sed -n '/^${BLOCK_BEGIN}$/,/^${BLOCK_END}$/p' ${SSHD_CONFIG} 2>/dev/null
echo __INCLUDE; grep -qiE '^\\s*Include\\s+/etc/ssh/sshd_config.d' ${SSHD_CONFIG} 2>/dev/null && echo yes
echo __OTHERS; for f in /etc/ssh/sshd_config.d/*.conf; do [ -f "$f" ] && awk -v F="$f" 'tolower($1)=="match"{exit} {print F":"$0}' "$f"; done 2>/dev/null | grep -iE ':[[:space:]]*((KbdInteractiveAuthentication|ChallengeResponseAuthentication|UsePAM)[[:space:]]+no|AuthenticationMethods[[:space:]])'
echo __MAIN; awk 'tolower($1)=="include"||tolower($1)=="match"{exit} {print}' ${SSHD_CONFIG} 2>/dev/null | grep -iE '^[[:space:]]*((KbdInteractiveAuthentication|ChallengeResponseAuthentication|UsePAM)[[:space:]]+no|AuthenticationMethods[[:space:]])'
echo __KEYONLY; grep -ihE '^\\s*Match\\s+User' /etc/ssh/sshd_config.d/00-centralserver-users.conf ${SSHD_CONFIG} 2>/dev/null | awk '{print $3}'
echo __HOST; hostname 2>/dev/null
echo __USERS; getent passwd | awk -F: '($3==0 || $3>=1000) && $3<60000 {print $1":"$3":"$6":"$7}'
echo __ENROLLED; getent passwd | awk -F: '($3==0 || $3>=1000) && $3<60000 {print $1":"$6}' | while IFS=: read -r u h; do [ -f "$h/.google_authenticator" ] && echo "$u"; done
echo __KEYS; getent passwd | awk -F: '($3==0 || $3>=1000) && $3<60000 {print $1":"$6}' | while IFS=: read -r u h; do f="$h/.ssh/authorized_keys"; if [ -f "$f" ]; then echo "$u:$(grep -cvE '^[[:space:]]*(#|$)' "$f" 2>/dev/null)"; fi; done
echo __END`
  let r
  try {
    r = await rootExec(ssh, script, { timeoutMs: 60000 })
  } catch (e) {
    // No sudo: degrade gracefully (sshd -T and other users' home files are unreadable).
    if (e instanceof SshError && e.code === 'SUDO_FAILED') r = await ssh.exec(script, { timeoutMs: 60000 })
    else throw e
  }
  const sec = sectionize(r.stdout)
  const first = (k: string): string => (sec[k] ?? []).map((s) => s.trim()).find(Boolean) ?? ''

  const soPath = first('SO')
  const pamText = (sec.PAM ?? []).join('\n')
  const pamLines = pamText.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes(PAM_SO))
  const pamConfigured = pamLines.length > 0
  const nullok = pamConfigured ? pamLines.some((l) => /\bnullok\b/.test(l)) : true

  const sshdKv: Record<string, string> = {}
  for (const l of sec.SSHDT ?? []) {
    const m = l.trim().match(/^(\S+)\s+(.*)$/)
    if (m) sshdKv[m[1].toLowerCase()] = m[2].trim().toLowerCase()
  }
  const sshdReadable = Object.keys(sshdKv).length > 0
  const sshd = {
    readable: sshdReadable,
    kbdInteractive: sshdKv.kbdinteractiveauthentication === 'yes',
    usePam: sshdKv.usepam === 'yes',
    authenticationMethods: sshdKv.authenticationmethods || 'any',
    passwordAuth: sshdKv.passwordauthentication === 'yes',
    challengeResponse: sshdKv.challengeresponseauthentication === 'yes',
    pubkeyAuth: sshdKv.pubkeyauthentication !== 'no'
  }

  const dropin = (sec.DROPIN ?? []).join('\n').trim()
  let mode: TfaMode = 'off'
  if (dropin) {
    mode = parseDropinMode(dropin).mode
    // The drop-in is present but sshd does not apply it (Include missing / overridden earlier): report "off".
    if (sshdReadable && sshd.authenticationMethods === 'any') mode = 'off'
  }

  const conflicts: TfaConflict[] = []
  for (const l of sec.OTHERS ?? []) {
    const m = l.match(/^([^:]+):(.*)$/)
    if (!m) continue
    const base = m[1].slice(m[1].lastIndexOf('/') + 1)
    if (base === SSHD_DROPIN_BASENAME) continue
    if (base < SSHD_DROPIN_BASENAME) conflicts.push({ file: m[1], line: m[2].trim() })
  }
  for (const l of sec.MAIN ?? []) if (l.trim()) conflicts.push({ file: SSHD_CONFIG, line: l.trim() })

  const keyOnly = new Set<string>()
  for (const l of sec.KEYONLY ?? []) l.trim().split(',').filter(Boolean).forEach((u) => keyOnly.add(u))
  const enrolled = new Set((sec.ENROLLED ?? []).map((s) => s.trim()).filter(Boolean))
  const keyCount = new Map<string, number>()
  for (const l of sec.KEYS ?? []) {
    const i = l.lastIndexOf(':')
    if (i > 0) keyCount.set(l.slice(0, i), Number(l.slice(i + 1)) || 0)
  }
  const self = selfUser(ssh)
  const users: TfaUser[] = []
  for (const l of sec.USERS ?? []) {
    const f = l.split(':')
    if (f.length < 4) continue
    const [name, uidS, , shell] = f
    if (!shell || /(nologin|false|sync|halt|shutdown)$/.test(shell)) continue
    users.push({ name, uid: Number(uidS), enrolled: enrolled.has(name), self: name === self, hasKeys: keyCount.get(name) ?? 0, keyOnly: keyOnly.has(name) })
  }
  users.sort((a, b) => (a.self === b.self ? a.uid - b.uid : a.self ? -1 : 1))

  const secrets = getSecrets(serverId)
  return {
    pamModuleInstalled: !!soPath,
    pamModulePath: soPath || undefined,
    packageName: packageName(ssh),
    pkgManager: ssh.os?.pkgManager ?? 'unknown',
    pamConfigured,
    nullok,
    sshd,
    mode,
    sshdIncludeSupported: first('INCLUDE') === 'yes',
    conflicts,
    users,
    loginUser: self,
    hostname: first('HOST') || ssh.os?.hostname || ssh.profile.host,
    profileAuth: ssh.profile.auth,
    profileHasPassword: !!secrets.password,
    profileHasTotp: !!secrets.totpSecret,
    isRoot: !!ssh.os?.isRoot
  }
}

/* ------------------------------------------------------------------ */
/* Enable / disable (shared implementation)                            */
/* ------------------------------------------------------------------ */

interface Backups {
  pam: string
  includes: boolean
  dropin: string | null
}

async function applyConfig(ctx: Ctx, serverId: string, mode: TfaMode, nullok: boolean, log: (s: string) => void): Promise<void> {
  const ssh = ctx.ssh(serverId)
  const includes = await sshdSupportsInclude(ssh)

  log('Backing up /etc/pam.d/sshd and the sshd configuration…')
  const pamCur = await readRootFile(ssh, PAM_FILE)
  if (pamCur === null) throw new Error(`${PAM_FILE} not found. Is OpenSSH server installed with PAM support?`)
  const dropinCur = includes ? await readRootFile(ssh, SSHD_DROPIN) : null
  await rootRun(ssh, `cp -p ${PAM_FILE} ${PAM_BACKUP} && cp -p ${SSHD_CONFIG} ${SSHD_BACKUP}`)
  const backups: Backups = { pam: pamCur, includes, dropin: dropinCur }

  const rollback = async (why: string): Promise<void> => {
    log(`${why} Restoring the previous configuration…`)
    await writeRootFile(ssh, PAM_FILE, backups.pam).catch(() => rootExec(ssh, `cp -p ${PAM_BACKUP} ${PAM_FILE}`))
    if (backups.includes) {
      if (backups.dropin !== null) await writeRootFile(ssh, SSHD_DROPIN, backups.dropin).catch(() => {})
      else await rootExec(ssh, `rm -f ${SSHD_DROPIN}`)
    } else await rootExec(ssh, `cp -p ${SSHD_BACKUP} ${SSHD_CONFIG}`)
    await sshdReload(ssh).catch(() => {})
    log('Previous configuration restored.')
  }

  try {
    log(mode === 'off' ? 'Removing the Central Server lines from /etc/pam.d/sshd…' : `Writing /etc/pam.d/sshd (${mode}${nullok ? ', nullok' : ''})…`)
    await writeRootFile(ssh, PAM_FILE, pamBuild(pamCur, mode, nullok))

    if (mode === 'off') {
      log(includes ? `Removing ${SSHD_DROPIN}…` : `Removing the Central Server 2FA block from ${SSHD_CONFIG}…`)
      if (includes) await rootExec(ssh, `rm -f ${SSHD_DROPIN}`)
      // Clean a block left over from an earlier Include-less setup as well.
      await writeSshdBlock(ssh, null)
    } else {
      const content = dropinContent(mode, nullok)
      if (includes) {
        log(`Writing ${SSHD_DROPIN}…`)
        await writeRootFile(ssh, SSHD_DROPIN, content)
      } else {
        log(`sshd_config has no Include directive; writing a marker block at the top of ${SSHD_CONFIG}…`)
        await writeSshdBlock(ssh, content)
      }
    }

    log('Testing the configuration (sshd -t)…')
    const err = await sshdTest(ssh)
    if (err) throw new Error('sshd rejected the configuration: ' + err)

    log('Reloading sshd…')
    await sshdReload(ssh)
    await sleep(1500)

    log('Verifying that Central Server can still log in with the saved credentials…')
    let ok = await probeLogin(ctx, serverId, ssh.profile.port)
    if (!ok) {
      await sleep(2000)
      ok = await probeLogin(ctx, serverId, ssh.profile.port)
    }
    if (!ok) throw new Error(mode === 'off' ? 'Login verification failed after disabling two-factor authentication.' : 'Central Server could not log back in with the new rules (wrong secret, PAM module problem or the server rejected keyboard-interactive).')
    log('Login verified.')
  } catch (e) {
    await rollback((e as Error).message)
    throw new Error(`${(e as Error).message} The change was reverted automatically; nothing is enforced.`)
  }
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  ctx.handle('tfa:status', async (serverId: string): Promise<TfaStatus> => readStatus(ctx, serverId))

  // ---------------- install PAM module ----------------
  ctx.handle('tfa:install', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const pkg = packageName(ssh)
    if (!ssh.os || ssh.os.pkgManager === 'unknown') throw new Error('Unsupported package manager; install the Google Authenticator PAM module manually')
    const { id } = ctx.tasks.start('Install Google Authenticator PAM module', serverId, async (h) => {
      const stream = { timeoutMs: 1800000, signal: h.signal, onStdout: (c: string) => h.append(c), onStderr: (c: string) => h.append(c) }
      if (needsEpel(ssh)) {
        const has = await rootExec(ssh, `${ssh.os!.pkgManager} repolist --enabled 2>/dev/null | grep -qi '^epel' && echo yes`)
        if (!has.stdout.includes('yes')) {
          h.log('Enabling the EPEL repository (provides google-authenticator on RHEL-family systems)…')
          await runPkg(ssh, `${ssh.os!.pkgManager} install -y epel-release`, stream)
        }
      }
      if (ssh.os!.pkgManager === 'apk') {
        h.log('Alpine: installing openssh-server-pam so sshd can use PAM…')
        await runPkg(ssh, 'apk add openssh-server-pam', stream).catch(() => h.log('openssh-server-pam not available; sshd may lack UsePAM support.'))
      }
      h.log(`Installing ${pkg}…`)
      await runPkg(ssh, installCmd(ssh, [pkg]), stream)
      const so = await ssh.exec(`find /lib /lib64 /usr/lib /usr/lib64 -name ${PAM_SO} -print -quit 2>/dev/null`)
      const path = so.stdout.trim().split('\n')[0]
      if (!path) throw new Error(`${pkg} installed but ${PAM_SO} was not found under /lib, /lib64 or /usr/lib`)
      h.log(`PAM module found: ${path}`)
      ctx.audit(serverId, 'tfa.install', pkg)
    })
    return id
  })

  // ---------------- enroll ----------------
  ctx.handle('tfa:enroll', async (serverId: string, userRaw: string, optsRaw?: TfaEnrollOptions): Promise<TfaEnrollResult> => {
    const ssh = ctx.ssh(serverId)
    const user = assertUser(userRaw)
    const opts = optsRaw ?? {}
    const windowSize = opts.window === undefined ? 3 : Number(opts.window)
    if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > 17) throw new Error('Window size must be between 1 and 17')
    const rateLimit = opts.rateLimit !== false
    const reuse = opts.reuse === true
    const self = user === selfUser(ssh)
    const saveToProfile = self && opts.saveToProfile !== false

    const { home, group } = await userHome(ssh, user)
    const path = `${home}/.google_authenticator`
    const exists = await rootExec(ssh, `[ -e ${shq(path)} ] && echo yes`)
    if (exists.stdout.includes('yes') && !opts.force) throw new Error(`${user} is already enrolled. Re-enrolling replaces the secret and invalidates the current authenticator app.`)

    const secret = generateSecret()
    const codes = scratchCodes(5)
    const lines = [secret]
    if (rateLimit) lines.push('" RATE_LIMIT 3 30')
    lines.push(`" WINDOW_SIZE ${windowSize}`)
    if (!reuse) lines.push('" DISALLOW_REUSE')
    lines.push('" TOTP_AUTH', ...codes)
    const content = lines.join('\n') + '\n'
    // The secret travels base64-embedded inside the command; it is never logged or audited.
    await rootRun(ssh, `t=$(mktemp) && ${b64Echo(content)} > "$t" && install -m 400 -o ${shq(user)} -g ${shq(group)} "$t" ${shq(path)}; rc=$?; rm -f "$t"; exit $rc`)

    if (saveToProfile) {
      updateSecrets(serverId, { totpSecret: secret })
      ctx.sessions.refreshSecrets(serverId)
    } else if (self) {
      // Re-enrolled without saving: a stale profile secret would fail every prompt, so drop it.
      if (getSecrets(serverId).totpSecret) {
        updateSecrets(serverId, { totpSecret: undefined })
        ctx.sessions.refreshSecrets(serverId)
      }
    }
    const hostname = ssh.os?.hostname || ssh.profile.host
    const account = `${user}@${hostname}`
    ctx.audit(serverId, 'tfa.enroll', `${user}${opts.force ? ' (re-enrolled)' : ''}${saveToProfile ? ' secret saved in profile' : ''}`)
    return { secret, otpauthUrl: otpauthUrl(secret, account, `Central Server ${hostname}`), scratchCodes: codes, savedToProfile: saveToProfile, account }
  })

  // ---------------- verify a code against a user's file ----------------
  ctx.handle('tfa:verify', async (serverId: string, userRaw: string, codeRaw: string): Promise<boolean> => {
    const ssh = ctx.ssh(serverId)
    const user = assertUser(userRaw)
    const code = assertCode(codeRaw)
    const { home } = await userHome(ssh, user)
    const r = await rootExec(ssh, `head -n 1 ${shq(`${home}/.google_authenticator`)} 2>/dev/null`)
    const secret = r.stdout.trim().toUpperCase()
    if (r.code !== 0 || !secret) throw new Error(`${user} is not enrolled`)
    if (!SECRET_RE.test(secret)) throw new Error('The enrollment file does not look like a TOTP secret (HOTP or corrupted file)')
    return verifyTotp(secret, code)
  })

  // ---------------- unenroll ----------------
  ctx.handle('tfa:unenroll', async (serverId: string, userRaw: string) => {
    const ssh = ctx.ssh(serverId)
    const user = assertUser(userRaw)
    const self = user === selfUser(ssh)
    if (self) {
      const st = await readStatus(ctx, serverId)
      if (st.mode !== 'off' && !st.nullok) throw new Error('Two-factor authentication is enforced without nullok: removing the enrollment of the login account would lock Central Server out. Disable enforcement first.')
    }
    const { home } = await userHome(ssh, user)
    await rootRun(ssh, `rm -f ${shq(`${home}/.google_authenticator`)}`)
    if (self && getSecrets(serverId).totpSecret) {
      updateSecrets(serverId, { totpSecret: undefined })
      ctx.sessions.refreshSecrets(serverId)
    }
    ctx.audit(serverId, 'tfa.unenroll', user)
  })

  // ---------------- enable ----------------
  ctx.handle('tfa:enable', async (serverId: string, optsRaw: TfaEnableOptions) => {
    const ssh = ctx.ssh(serverId)
    const mode = optsRaw?.mode
    if (mode !== 'password+code' && mode !== 'key+code' && mode !== 'key-or-code') throw new Error('Invalid mode')
    const nullok = optsRaw.nullok !== false

    const st = await readStatus(ctx, serverId)
    if (!st.pamModuleInstalled) throw new Error('The Google Authenticator PAM module is not installed (step 1).')
    const me = st.users.find((u) => u.name === st.loginUser)
    if (!me?.enrolled) throw new Error(`The login account ${st.loginUser} is not enrolled. Enroll it first so Central Server can verify the new rules without locking itself out.`)
    if (!st.profileHasTotp) throw new Error(`The server profile does not hold the TOTP secret of ${st.loginUser}. Re-enroll the login account with "Save secret in this app" enabled.`)
    if (mode === 'key+code' && st.profileAuth === 'password') throw new Error('"Key + code" requires the app to log in with an SSH key, but this profile uses a password. Switch the profile to key authentication or choose "password + code".')
    if (mode === 'password+code' && st.profileAuth !== 'password' && !st.profileHasPassword) throw new Error('"Password + code" makes the app\'s SSH key useless and this profile has no stored password. Choose "key + code" or "key or code".')
    if (mode !== 'key-or-code' && me.keyOnly) throw new Error(`${st.loginUser} is marked key-only in Users, which also turns keyboard-interactive off for that account. Allow password login for it again (or choose "key or code") first.`)
    if (!st.sshdIncludeSupported) {
      /* marker block at the top of sshd_config wins; nothing to check */
    } else if (st.conflicts.length) {
      const c = st.conflicts[0]
      throw new Error(`${c.file} sets "${c.line}" before the Central Server 2FA drop-in is read, which would disable keyboard-interactive logins. Fix that first (Overview → SSH login rules controls 00-centralserver.conf).`)
    }

    const { id } = ctx.tasks.start(`Enable two-factor authentication (${mode})`, serverId, async (h) => {
      await applyConfig(ctx, serverId, mode, nullok, h.log)
      h.log(`Done. SSH logins now require ${mode === 'password+code' ? 'password + verification code' : mode === 'key+code' ? 'SSH key + verification code' : 'an SSH key or a verification code'}${nullok ? ' (users without an enrollment are still allowed in)' : ''}.`)
      ctx.audit(serverId, 'tfa.enable', `${mode}${nullok ? ' nullok' : ''}`)
    })
    return id
  })

  // ---------------- disable ----------------
  ctx.handle('tfa:disable', async (serverId: string) => {
    ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Disable two-factor authentication', serverId, async (h) => {
      await applyConfig(ctx, serverId, 'off', true, h.log)
      h.log('Done. SSH logins no longer ask for a verification code. Enrollments (~/.google_authenticator) were kept.')
      ctx.audit(serverId, 'tfa.disable')
    })
    return id
  })

  // ---------------- test a code against the profile secret ----------------
  ctx.handle('tfa:testCode', async (serverId: string, codeRaw: string): Promise<boolean> => {
    const code = assertCode(codeRaw)
    const secret = getSecrets(serverId).totpSecret
    if (!secret) throw new Error('The server profile holds no TOTP secret')
    return verifyTotp(secret, code)
  })
}
