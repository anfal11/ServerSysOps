import type { Ctx } from '../core'
import type { CreateUserInput, DeleteUserOptions, GroupInfo, LastLoginEntry, LastLoginsResult, LockOptions, SessionInfoEx, SshKeyInfo, UserInfoEx } from '@shared/modules/users'
import { SshClient, SshError, type ExecOptions } from '../ssh/SshClient'
import { b64Echo, shq } from '../ssh/shell'

/* ------------------------------------------------------------------ */
/* Constants / validation                                              */
/* ------------------------------------------------------------------ */

const SSHD_USERS_DROPIN = '/etc/ssh/sshd_config.d/00-centralserver-users.conf'
const BACKUP_DIR = '/var/backups/centralserver'
const ADMIN_GROUPS = ['sudo', 'wheel', 'admin']
const NEW_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
/** Existing accounts may have been created with looser rules (dots, capitals, trailing $ for Samba machine accounts). */
const EXISTING_USER_RE = /^[a-zA-Z_][a-zA-Z0-9_.@-]{0,31}\$?$/
const GROUP_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$/
const SHELL_RE = /^\/[A-Za-z0-9_./-]+$/
const TTY_RE = /^[a-zA-Z0-9/._-]{1,32}$/
const KEY_LINE_RE =
  /^(?:(.*?)\s+)?(ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com|(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-nistp(?:256|384|521))-cert-v01@openssh\.com)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/

function assertNewUser(name: string): string {
  if (typeof name !== 'string' || !NEW_USER_RE.test(name)) throw new Error('Invalid username: use 1-32 lowercase letters, digits, "_" or "-", starting with a letter or "_"')
  return name
}
function assertUser(name: string): string {
  if (typeof name !== 'string' || !EXISTING_USER_RE.test(name)) throw new Error(`Invalid username: ${String(name).slice(0, 40)}`)
  return name
}
function assertGroup(name: string): string {
  if (typeof name !== 'string' || !GROUP_RE.test(name)) throw new Error(`Invalid group name: ${String(name).slice(0, 40)}`)
  return name
}
function assertShell(shell: string): string {
  if (typeof shell !== 'string' || !SHELL_RE.test(shell) || shell.length > 128) throw new Error(`Invalid shell path: ${String(shell).slice(0, 60)}`)
  return shell
}
function assertPassword(pw: string): string {
  if (typeof pw !== 'string' || pw.length === 0) throw new Error('Password must not be empty')
  if (pw.length > 256) throw new Error('Password is too long (max 256 characters)')
  if (/[\r\n\0]/.test(pw)) throw new Error('Password must not contain line breaks')
  return pw
}
function cleanGecos(s: string | undefined): string {
  return (s ?? '').replace(/[:\r\n\0]/g, ' ').trim().slice(0, 120)
}

/* ------------------------------------------------------------------ */
/* Shell helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run a whole script as root. `sudo` only applies to the first word of a command line, so compound
 * scripts (`a && b; c`) must be wrapped in `sh -c '…'` to run entirely as root.
 */
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

async function sshdSupportsInclude(ssh: SshClient): Promise<boolean> {
  const r = await ssh.exec(`grep -qiE '^\\s*Include\\s+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config && echo yes`)
  return r.stdout.includes('yes')
}

async function sshdTest(ssh: SshClient): Promise<string | null> {
  const t = await rootExec(ssh, 'sshd -t 2>&1 || /usr/sbin/sshd -t 2>&1')
  return t.code === 0 ? null : (t.stdout + t.stderr).trim()
}

async function sshdReload(ssh: SshClient): Promise<void> {
  await rootRun(ssh, 'systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || service sshd reload 2>/dev/null || service ssh reload 2>/dev/null || rc-service sshd reload')
}

function selfUser(ssh: SshClient): string {
  return ssh.os?.user ?? ssh.profile.username
}

/** Name of the admin group that exists on this system (sudo on Debian, wheel on RHEL/Arch/Alpine/SUSE). */
async function adminGroup(ssh: SshClient): Promise<string> {
  const r = await ssh.exec(`for g in sudo wheel admin; do getent group "$g" >/dev/null 2>&1 && echo "$g" && break; done`)
  return r.stdout.trim().split('\n')[0] || 'sudo'
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

/* ------------------------------------------------------------------ */
/* Parsers                                                             */
/* ------------------------------------------------------------------ */

const LAST_DATE = String.raw`\w{3} \w{3}\s+\d{1,2} \d\d:\d\d:\d\d \d{4}`
const LAST_RE = new RegExp(`^(\\S+)\\s+(\\S+)\\s+(.*?)\\s*(${LAST_DATE})(?:\\s+-\\s+(${LAST_DATE}|still logged in|still running|gone - no logout|down|crash)\\s*(?:\\((\\S+)\\))?)?\\s*$`)

/** Parse `last -w -F` / `lastb -w -F` output. */
function parseLast(lines: string[]): { entries: LastLoginEntry[]; since?: string } {
  const entries: LastLoginEntry[] = []
  let since: string | undefined
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const b = line.match(/^(?:wtmp|btmp) begins\s+(.*)$/)
    if (b) {
      since = b[1].trim()
      continue
    }
    const m = line.match(LAST_RE)
    if (!m) continue
    const [, user, tty, from, start, end, duration] = m
    if (user === 'reboot' || user === 'shutdown') continue
    const still = end === 'still logged in' || end === 'still running'
    entries.push({ user, tty, from: from.trim(), start, end: still ? undefined : end || undefined, duration: duration || undefined, stillLoggedIn: still })
  }
  return { entries, since }
}

function parseLastlog(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+.*?(\w{3} \w{3}\s+\d{1,2} \d\d:\d\d:\d\d [+-]\d{4} \d{4})\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function parseKeyLine(raw: string): { options?: string; type: string; blob: string; comment: string } | null {
  const m = raw.trim().match(KEY_LINE_RE)
  if (!m) return null
  return { options: m[1]?.trim() || undefined, type: m[2], blob: m[3], comment: (m[4] ?? '').trim() }
}

/** Parse `ssh-keygen -l` output: `256 SHA256:xxx comment (ED25519)`. */
function parseFingerprint(s: string): { bits: number; fingerprint: string; type: string } | null {
  const m = s.trim().match(/^(\d+)\s+(\S+)\s+(?:.*\s+)?\(([\w-]+)\)$/)
  if (!m) return null
  return { bits: Number(m[1]), fingerprint: m[2], type: m[3] }
}

/* ------------------------------------------------------------------ */
/* authorized_keys helpers                                             */
/* ------------------------------------------------------------------ */

/** Compute fingerprints of key lines on the server (no root needed). Lines that are not valid keys get fingerprint ''. */
async function fingerprintLines(ssh: SshClient, lines: string[]): Promise<{ raw: string; fp: string }[]> {
  if (!lines.length) return []
  const script = `d=$(mktemp -d) && ${b64Echo(lines.join('\n') + '\n')} > "$d/keys" && n=0; while IFS= read -r line || [ -n "$line" ]; do n=$((n+1)); case "$line" in ''|'#'*) echo "$n|"; continue;; esac; printf '%s\\n' "$line" > "$d/one"; fp=$(ssh-keygen -lf "$d/one" 2>/dev/null); echo "$n|$fp"; done < "$d/keys"; rm -rf "$d"`
  const r = await ssh.exec(script, { timeoutMs: 60000 })
  const map = new Map<number, string>()
  for (const l of r.stdout.split('\n')) {
    const i = l.indexOf('|')
    if (i < 0) continue
    map.set(Number(l.slice(0, i)), l.slice(i + 1).trim())
  }
  return lines.map((raw, i) => ({ raw, fp: map.get(i + 1) ?? '' }))
}

async function homeAndGroup(ssh: SshClient, name: string): Promise<{ home: string; group: string }> {
  const r = await ssh.exec(`getent passwd ${shq(name)} | cut -d: -f6; id -gn ${shq(name)} 2>/dev/null`)
  const [home, group] = r.stdout.split('\n').map((s) => s.trim())
  if (!home || !home.startsWith('/')) throw new Error(`User ${name} does not exist or has no home directory`)
  return { home, group: group || name }
}

async function readAuthorizedKeys(ssh: SshClient, name: string): Promise<{ home: string; group: string; lines: string[] }> {
  const { home, group } = await homeAndGroup(ssh, name)
  const r = await rootExec(ssh, `cat ${shq(home + '/.ssh/authorized_keys')} 2>/dev/null`)
  const text = r.code === 0 ? r.stdout : ''
  const lines = text.replace(/\r/g, '').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { home, group, lines }
}

async function writeAuthorizedKeys(ssh: SshClient, name: string, home: string, group: string, lines: string[]): Promise<void> {
  const content = lines.join('\n') + (lines.length ? '\n' : '')
  const dir = home + '/.ssh'
  await rootRun(
    ssh,
    `install -d -m 700 -o ${shq(name)} -g ${shq(group)} ${shq(dir)} && t=$(mktemp) && ${b64Echo(content)} > "$t" && install -m 600 -o ${shq(name)} -g ${shq(group)} "$t" ${shq(dir + '/authorized_keys')}; rc=$?; rm -f "$t"; exit $rc`
  )
}

/** Validate key text (one or more lines) and return the normalized, deduplicated lines plus their fingerprints. */
async function validateKeys(ssh: SshClient, keyText: string): Promise<{ raw: string; fp: string; blob: string }[]> {
  if (typeof keyText !== 'string') throw new Error('No key provided')
  const candidates = keyText
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (!candidates.length) throw new Error('No public key found in the text')
  if (candidates.some((l) => /PRIVATE KEY/.test(l))) throw new Error('This looks like a PRIVATE key. Paste the public key (usually the .pub file) instead.')
  const parsed = candidates.map((raw) => ({ raw, p: parseKeyLine(raw) }))
  const bad = parsed.find((x) => !x.p)
  if (bad) throw new Error(`Not a valid OpenSSH public key line: ${bad.raw.slice(0, 60)}…`)
  const fps = await fingerprintLines(ssh, candidates)
  const out: { raw: string; fp: string; blob: string }[] = []
  for (let i = 0; i < parsed.length; i++) {
    const fp = parseFingerprint(fps[i].fp)
    if (!fp) throw new Error(`ssh-keygen rejected this key: ${candidates[i].slice(0, 60)}…`)
    const blob = parsed[i].p!.blob
    if (!out.some((o) => o.blob === blob)) out.push({ raw: candidates[i], fp: fp.fingerprint, blob })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* sudoers helpers                                                     */
/* ------------------------------------------------------------------ */

/** sudo silently ignores files in /etc/sudoers.d whose name contains a '.' (or ends in '~'), so dots in user names are mapped to '_'. */
function sudoersDropinPath(name: string): string {
  return `/etc/sudoers.d/centralserver-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

async function writeSudoersDropin(ssh: SshClient, name: string, content: string): Promise<void> {
  const path = sudoersDropinPath(name)
  await rootRun(
    ssh,
    `set -e; mkdir -p /etc/sudoers.d; if ! grep -qE '^[[:space:]]*[#@]includedir[[:space:]]+/etc/sudoers.d' /etc/sudoers 2>/dev/null; then c=$(mktemp); cat /etc/sudoers > "$c"; printf '\\n#includedir /etc/sudoers.d\\n' >> "$c"; visudo -cf "$c" >/dev/null && install -m 440 -o root -g root "$c" /etc/sudoers; rm -f "$c"; fi; t=$(mktemp); ${b64Echo(content)} > "$t"; if visudo -cf "$t" >/dev/null; then install -m 440 -o root -g root "$t" ${shq(path)}; rm -f "$t"; else rm -f "$t"; echo "sudoers syntax check failed" >&2; exit 1; fi`
  )
}

async function removeSudoersDropin(ssh: SshClient, name: string): Promise<void> {
  await rootExec(ssh, `rm -f ${shq(sudoersDropinPath(name))} ${shq(`/etc/sudoers.d/centralserver-${name}`)}`)
}

async function hasSudoRights(ssh: SshClient, name: string): Promise<boolean> {
  const r = await rootExec(ssh, `sudo -n -l -U ${shq(name)} 2>/dev/null | grep -q '(ALL' && echo yes`)
  return r.stdout.includes('yes')
}

/* ------------------------------------------------------------------ */
/* Key-only (sshd Match block)                                          */
/* ------------------------------------------------------------------ */

const KEYONLY_BEGIN = '# BEGIN Central Server key-only logins'
const KEYONLY_END = '# END Central Server key-only logins'

function keyOnlyBlock(users: string[]): string {
  if (!users.length) return ''
  return `Match User ${users.join(',')}\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n`
}

async function readKeyOnlyUsers(ssh: SshClient): Promise<string[]> {
  const r = await ssh.exec(`cat ${SSHD_USERS_DROPIN} 2>/dev/null; sed -n '/^${KEYONLY_BEGIN}$/,/^${KEYONLY_END}$/p' /etc/ssh/sshd_config 2>/dev/null`)
  const users = new Set<string>()
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*Match\s+User\s+(\S+)/i)
    if (m) m[1].split(',').filter(Boolean).forEach((u) => users.add(u))
  }
  return [...users]
}

async function writeKeyOnlyUsers(ssh: SshClient, users: string[]): Promise<void> {
  const includes = await sshdSupportsInclude(ssh)
  const block = keyOnlyBlock(users)
  if (includes) {
    const prev = await rootExec(ssh, `cat ${SSHD_USERS_DROPIN} 2>/dev/null`)
    const hadFile = prev.code === 0
    if (block) await writeRootFile(ssh, SSHD_USERS_DROPIN, `# Managed by Central Server - users with password login disabled\n${block}`)
    else await rootExec(ssh, `rm -f ${SSHD_USERS_DROPIN}`)
    const err = await sshdTest(ssh)
    if (err) {
      if (hadFile) await writeRootFile(ssh, SSHD_USERS_DROPIN, prev.stdout)
      else await rootExec(ssh, `rm -f ${SSHD_USERS_DROPIN}`)
      throw new Error('sshd rejected the configuration; change reverted: ' + err)
    }
  } else {
    // Match blocks must come last, so the marker section is appended to the end of sshd_config.
    const section = block ? `${KEYONLY_BEGIN}\n${block}${KEYONLY_END}\n` : ''
    await rootRun(
      ssh,
      `set -e; cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.centralserver.bak; t=$(mktemp); sed '/^${KEYONLY_BEGIN}$/,/^${KEYONLY_END}$/d' /etc/ssh/sshd_config > "$t"; ${b64Echo(section)} >> "$t"; install -m 644 -o root -g root "$t" /etc/ssh/sshd_config; rm -f "$t"`
    )
    const err = await sshdTest(ssh)
    if (err) {
      await rootExec(ssh, 'cp -p /etc/ssh/sshd_config.centralserver.bak /etc/ssh/sshd_config')
      throw new Error('sshd rejected the configuration; change reverted: ' + err)
    }
  }
  await sshdReload(ssh)
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  // ---------------- list ----------------
  ctx.handle('users:list', async (serverId: string, opts?: { includeSystem?: boolean }): Promise<UserInfoEx[]> => {
    const ssh = ctx.ssh(serverId)
    const includeSystem = !!opts?.includeSystem
    const script = `
echo __UIDMIN; grep -E '^UID_MIN' /etc/login.defs 2>/dev/null | awk '{print $2}'
echo __TODAY; echo $(( $(date +%s) / 86400 ))
echo __PASSWD; getent passwd
echo __GROUP; getent group
echo __SHADOW; awk -F: '{print $1":"substr($2,1,2)":"length($2)":"$8}' /etc/shadow 2>/dev/null
echo __SUDOERS; if command -v sudo >/dev/null 2>&1; then for u in $(getent passwd | awk -F: '$3==0 || $3>=500 {print $1}'); do sudo -n -l -U "$u" 2>/dev/null | grep -q '(ALL' && echo "$u"; done; fi
echo __KEYS; getent passwd | awk -F: '{print $1":"$6}' | while IFS=: read -r u h; do f="$h/.ssh/authorized_keys"; if [ -f "$f" ]; then echo "$u:$(grep -cvE '^[[:space:]]*(#|$)' "$f" 2>/dev/null)"; fi; done
echo __LASTLOG; lastlog 2>/dev/null | tail -n +2
echo __LAST; last -w -F 2>/dev/null | head -400
echo __KEYONLY; grep -ihE '^\\s*Match\\s+User' ${SSHD_USERS_DROPIN} /etc/ssh/sshd_config 2>/dev/null | awk '{print $3}'
echo __END`
    let r
    try {
      r = await rootExec(ssh, script, { timeoutMs: 60000 })
    } catch (e) {
      // No sudo: degrade gracefully (no shadow / key info).
      if (e instanceof SshError && e.code === 'SUDO_FAILED') r = await ssh.exec(script, { timeoutMs: 60000 })
      else throw e
    }
    const sec = sectionize(r.stdout)
    const uidMin = Number(sec.UIDMIN?.[0]) || 1000
    const today = Number(sec.TODAY?.[0]) || Math.floor(Date.now() / 86400000)
    const groupsOf = new Map<string, string[]>()
    const gidName = new Map<number, string>()
    for (const l of sec.GROUP ?? []) {
      const f = l.split(':')
      if (f.length < 4) continue
      gidName.set(Number(f[2]), f[0])
      for (const m of f[3].split(',').filter(Boolean)) groupsOf.set(m, [...(groupsOf.get(m) ?? []), f[0]])
    }
    const shadow = new Map<string, { prefix: string; len: number; expire: number | null }>()
    for (const l of sec.SHADOW ?? []) {
      const f = l.split(':')
      if (f.length < 3) continue
      shadow.set(f[0], { prefix: f[1], len: Number(f[2]) || 0, expire: f[3] && /^\d+$/.test(f[3]) ? Number(f[3]) : null })
    }
    const sudoers = new Set((sec.SUDOERS ?? []).map((s) => s.trim()).filter(Boolean))
    const keyCount = new Map<string, number>()
    for (const l of sec.KEYS ?? []) {
      const i = l.lastIndexOf(':')
      if (i > 0) keyCount.set(l.slice(0, i), Number(l.slice(i + 1)) || 0)
    }
    const lastlog = parseLastlog(sec.LASTLOG ?? [])
    const lastEntries = parseLast(sec.LAST ?? []).entries
    const lastFromWtmp = new Map<string, string>()
    for (const e of lastEntries) if (!lastFromWtmp.has(e.user)) lastFromWtmp.set(e.user, e.start)
    const keyOnly = new Set<string>()
    for (const l of sec.KEYONLY ?? []) l.trim().split(',').filter(Boolean).forEach((u) => keyOnly.add(u))
    const self = selfUser(ssh)

    const users: UserInfoEx[] = []
    for (const l of sec.PASSWD ?? []) {
      const f = l.split(':')
      if (f.length < 7) continue
      const [name, , uidS, gidS, gecos, home, shell] = f
      const uid = Number(uidS)
      const gid = Number(gidS)
      const system = !(uid === 0 || (uid >= uidMin && uid < 60000))
      if (system && !includeSystem) continue
      const primary = gidName.get(gid)
      const groups = [...new Set([...(primary ? [primary] : []), ...(groupsOf.get(name) ?? [])])]
      const sh = shadow.get(name)
      const hasShadow = sh !== undefined
      const prefix = sh?.prefix ?? ''
      const len = sh?.len ?? 0
      const locked = hasShadow && prefix.startsWith('!')
      const hasPassword = hasShadow ? (prefix.startsWith('!') ? len > 2 : len > 0 && !prefix.startsWith('*')) : f[1] !== '*' && f[1] !== '!' && f[1] !== ''
      const accountExpired = !!(sh && sh.expire !== null && sh.expire <= today)
      const inSudoers = sudoers.has(name)
      users.push({
        name,
        uid,
        gid,
        home,
        shell,
        groups,
        isAdmin: uid === 0 || inSudoers || groups.some((g) => ADMIN_GROUPS.includes(g)),
        locked,
        hasPassword,
        lastLogin: lastlog[name] ?? lastFromWtmp.get(name),
        system,
        sshKeys: keyCount.get(name) ?? 0,
        fullName: (gecos ?? '').split(',')[0].trim() || undefined,
        sudoers: inSudoers,
        keyOnly: keyOnly.has(name),
        accountExpired,
        self: name === self
      })
    }
    users.sort((a, b) => (a.system === b.system ? a.uid - b.uid : a.system ? 1 : -1))
    return users
  })

  // ---------------- create ----------------
  ctx.handle('users:create', async (serverId: string, input: CreateUserInput) => {
    const ssh = ctx.ssh(serverId)
    const name = assertNewUser(input.name)
    const shell = assertShell(input.shell || '/bin/bash')
    const fullName = cleanGecos(input.fullName)
    if (input.password !== undefined && input.password !== '') assertPassword(input.password)
    const keys = input.sshKey?.trim() ? await validateKeys(ssh, input.sshKey) : []
    const exists = await ssh.exec(`getent passwd ${shq(name)} >/dev/null && echo yes`)
    if (exists.stdout.includes('yes')) throw new Error(`User ${name} already exists`)
    const homeFlag = input.createHome === false ? '-M' : '-m'
    const comment = fullName ? `-c ${shq(fullName)}` : ''
    await rootRun(
      ssh,
      `if command -v useradd >/dev/null 2>&1; then useradd ${homeFlag} -s ${shq(shell)} ${comment} ${shq(name)}; else adduser -D ${input.createHome === false ? '-H' : ''} -s ${shq(shell)} ${fullName ? `-g ${shq(fullName)}` : ''} ${shq(name)}; fi`
    )
    const notes: string[] = []
    if (input.password) {
      await ssh.run('chpasswd', { sudo: true, stdin: `${name}:${input.password}\n` })
      if (input.expirePassword) await rootExec(ssh, `chage -d 0 ${shq(name)} 2>/dev/null || passwd -e ${shq(name)}`)
    } else notes.push('no password set (password login disabled until one is set)')
    if (input.sudo || input.passwordlessSudo) {
      const grp = await adminGroup(ssh)
      await rootRun(ssh, `usermod -aG ${shq(grp)} ${shq(name)} 2>/dev/null || addgroup ${shq(name)} ${shq(grp)}`)
      if (input.passwordlessSudo) await writeSudoersDropin(ssh, name, `# Managed by Central Server\n${name} ALL=(ALL:ALL) NOPASSWD:ALL\n`)
      else if (!(await hasSudoRights(ssh, name))) {
        // Group exists but is not enabled in sudoers (common on Arch/Alpine): grant explicitly.
        await writeSudoersDropin(ssh, name, `# Managed by Central Server\n${name} ALL=(ALL:ALL) ALL\n`)
        notes.push(`the ${grp} group had no sudo rights, so an explicit sudoers entry was created`)
      }
    }
    if (keys.length) {
      const { home, group } = await homeAndGroup(ssh, name)
      await writeAuthorizedKeys(ssh, name, home, group, keys.map((k) => k.raw))
    }
    ctx.audit(serverId, 'users.create', `${name}${input.sudo ? ' (admin)' : ''}${keys.length ? ` +${keys.length} key(s)` : ''}`)
    return { name, notes }
  })

  // ---------------- delete ----------------
  ctx.handle('users:delete', async (serverId: string, nameRaw: string, opts: DeleteUserOptions) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    if (name === 'root') throw new Error('Refusing to delete root')
    if (name === selfUser(ssh)) throw new Error('Refusing to delete the account Central Server is logged in with')
    const { home } = await homeAndGroup(ssh, name).catch(() => ({ home: '', group: '' }))
    if (opts?.removeHome && (!home || home === '/' || /^\/(bin|sbin|usr|etc|var|proc|sys|dev|run|opt|srv)(\/|$)/.test(home))) {
      throw new Error(`Refusing to remove ${home || 'an unknown home directory'}; delete the account without removing its home`)
    }
    let backup: string | undefined
    if (opts?.backupHome && home && home !== '/' && !/^\/(bin|sbin|usr|etc|var|proc|sys|dev|run)(\/|$)/.test(home)) {
      backup = `${BACKUP_DIR}/home-${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
      await rootRun(ssh, `if [ -d ${shq(home)} ]; then mkdir -p ${BACKUP_DIR} && chmod 700 ${BACKUP_DIR} && tar -czf ${shq(backup)} -C / ${shq(home.replace(/^\//, ''))}; fi`, { timeoutMs: 1800000 })
    }
    await rootRun(
      ssh,
      `pkill -KILL -u ${shq(name)} 2>/dev/null; sleep 0.3; rm -f ${shq(sudoersDropinPath(name))} ${shq(`/etc/sudoers.d/centralserver-${name}`)}; if command -v userdel >/dev/null 2>&1; then userdel ${opts?.removeHome ? '-r' : ''} ${shq(name)} 2>&1 | grep -v 'mail spool' || true; else deluser ${opts?.removeHome ? '--remove-home' : ''} ${shq(name)}; fi; getent passwd ${shq(name)} >/dev/null && { echo "userdel failed" >&2; exit 1; } || true`,
      { timeoutMs: 600000 }
    )
    const keyOnlyUsers = await readKeyOnlyUsers(ssh)
    if (keyOnlyUsers.includes(name)) await writeKeyOnlyUsers(ssh, keyOnlyUsers.filter((u) => u !== name)).catch(() => {})
    ctx.audit(serverId, 'users.delete', `${name}${opts?.removeHome ? ' (home removed)' : ''}${backup ? ` backup=${backup}` : ''}`)
    return { backup }
  })

  // ---------------- admin ----------------
  ctx.handle('users:setAdmin', async (serverId: string, nameRaw: string, admin: boolean) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    if (name === 'root') throw new Error('root is always an administrator')
    if (!admin && name === selfUser(ssh)) throw new Error('Refusing to revoke admin rights from the account Central Server is logged in with')
    const grp = await adminGroup(ssh)
    if (admin) {
      await rootRun(ssh, `usermod -aG ${shq(grp)} ${shq(name)} 2>/dev/null || addgroup ${shq(name)} ${shq(grp)}`)
      if (!(await hasSudoRights(ssh, name))) await writeSudoersDropin(ssh, name, `# Managed by Central Server\n${name} ALL=(ALL:ALL) ALL\n`)
    } else {
      await rootRun(ssh, `for g in ${ADMIN_GROUPS.join(' ')}; do if id -nG ${shq(name)} 2>/dev/null | tr ' ' '\\n' | grep -qx "$g"; then gpasswd -d ${shq(name)} "$g" >/dev/null 2>&1 || deluser ${shq(name)} "$g" >/dev/null 2>&1 || true; fi; done`)
      await removeSudoersDropin(ssh, name)
      if (await hasSudoRights(ssh, name)) throw new Error(`${name} still has sudo rights through another sudoers entry (check /etc/sudoers and /etc/sudoers.d). Group membership and the Central Server entry were removed.`)
    }
    ctx.audit(serverId, 'users.admin', `${name} ${admin ? 'granted' : 'revoked'}`)
  })

  // ---------------- lock / unlock ----------------
  ctx.handle('users:lock', async (serverId: string, nameRaw: string, opts?: LockOptions) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    if (name === selfUser(ssh)) throw new Error('Refusing to lock the account Central Server is logged in with')
    // Lock the password AND expire the account so key logins are blocked too.
    await rootRun(ssh, `usermod -L -e 1970-01-02 ${shq(name)} 2>/dev/null || { passwd -l ${shq(name)} && chage -E 1 ${shq(name)} 2>/dev/null; } || passwd -l ${shq(name)}`)
    if (opts?.terminateSessions) await rootExec(ssh, `pkill -KILL -u ${shq(name)} 2>/dev/null || true`)
    ctx.audit(serverId, 'users.lock', `${name}${opts?.terminateSessions ? ' (sessions killed)' : ''}`)
  })

  ctx.handle('users:unlock', async (serverId: string, nameRaw: string) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    const keyOnlyUsers = await readKeyOnlyUsers(ssh)
    // Key-only users keep their password locked; only the account expiry is cleared.
    const unlockPw = keyOnlyUsers.includes(name) ? '' : `usermod -U ${shq(name)} 2>/dev/null || passwd -u ${shq(name)} 2>/dev/null || true;`
    await rootRun(ssh, `usermod -e '' ${shq(name)} 2>/dev/null || chage -E -1 ${shq(name)} 2>/dev/null || true; ${unlockPw} true`)
    ctx.audit(serverId, 'users.unlock', name)
  })

  // ---------------- password / shell ----------------
  ctx.handle('users:setPassword', async (serverId: string, nameRaw: string, password: string) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    assertPassword(password)
    await ssh.run('chpasswd', { sudo: true, stdin: `${name}:${password}\n` })
    ctx.audit(serverId, 'users.password', name)
  })

  ctx.handle('users:setShell', async (serverId: string, nameRaw: string, shellRaw: string) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    const shell = assertShell(shellRaw)
    const ok = await ssh.exec(`[ -x ${shq(shell)} ] && echo yes`)
    if (!ok.stdout.includes('yes')) throw new Error(`${shell} does not exist or is not executable on this server`)
    if (name === selfUser(ssh) && /(nologin|false)$/.test(shell)) throw new Error('Refusing to give the account Central Server is logged in with a non-interactive shell')
    await rootRun(ssh, `usermod -s ${shq(shell)} ${shq(name)} 2>/dev/null || chsh -s ${shq(shell)} ${shq(name)}`)
    ctx.audit(serverId, 'users.shell', `${name} -> ${shell}`)
  })

  ctx.handle('users:shells', async (serverId: string): Promise<string[]> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(`grep -E '^/' /etc/shells 2>/dev/null; for s in /usr/sbin/nologin /sbin/nologin /bin/false; do [ -x "$s" ] && echo "$s"; done`)
    return [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter((s) => SHELL_RE.test(s)))]
  })

  // ---------------- SSH keys ----------------
  ctx.handle('users:keys', async (serverId: string, nameRaw: string): Promise<SshKeyInfo[]> => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    const { lines } = await readAuthorizedKeys(ssh, name)
    const keyLines = lines.map((raw, i) => ({ raw, i })).filter((x) => x.raw.trim() && !x.raw.trim().startsWith('#'))
    const fps = await fingerprintLines(ssh, keyLines.map((k) => k.raw))
    return keyLines.map((k, idx) => {
      const p = parseKeyLine(k.raw)
      const fp = parseFingerprint(fps[idx]?.fp ?? '')
      return {
        line: k.i,
        type: fp?.type ?? p?.type ?? 'invalid',
        bits: fp?.bits,
        fingerprint: fp?.fingerprint ?? '(not a valid key)',
        comment: p?.comment ?? '',
        options: p?.options,
        raw: k.raw
      }
    })
  })

  ctx.handle('users:addKey', async (serverId: string, nameRaw: string, keyText: string) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    const keys = await validateKeys(ssh, keyText)
    const { home, group, lines } = await readAuthorizedKeys(ssh, name)
    const existing = new Set(lines.map((l) => parseKeyLine(l)?.blob).filter(Boolean))
    const fresh = keys.filter((k) => !existing.has(k.blob))
    if (!fresh.length) return { added: 0, skipped: keys.length }
    await writeAuthorizedKeys(ssh, name, home, group, [...lines, ...fresh.map((k) => k.raw)])
    ctx.audit(serverId, 'users.addKey', `${name} ${fresh.map((k) => k.fp).join(' ')}`)
    return { added: fresh.length, skipped: keys.length - fresh.length }
  })

  ctx.handle('users:removeKey', async (serverId: string, nameRaw: string, ref: { line?: number; fingerprint?: string }) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    const { home, group, lines } = await readAuthorizedKeys(ssh, name)
    let idx = -1
    if (typeof ref?.line === 'number' && Number.isInteger(ref.line) && ref.line >= 0 && ref.line < lines.length) idx = ref.line
    if (idx < 0 && ref?.fingerprint) {
      const fps = await fingerprintLines(ssh, lines)
      idx = fps.findIndex((f) => parseFingerprint(f.fp)?.fingerprint === ref.fingerprint)
    }
    if (idx < 0) throw new Error('Key not found (the file may have changed, reload and try again)')
    if (name === selfUser(ssh) && ssh.profile.auth !== 'password') {
      const remaining = lines.filter((l, i) => i !== idx && parseKeyLine(l)).length
      if (remaining === 0) throw new Error('Refusing to remove the last key of the account Central Server uses to log in with a key')
    }
    const removed = lines[idx]
    await writeAuthorizedKeys(ssh, name, home, group, lines.filter((_, i) => i !== idx))
    ctx.audit(serverId, 'users.removeKey', `${name} ${(parseKeyLine(removed)?.comment || removed.slice(0, 40)).trim()}`)
  })

  // ---------------- key-only login ----------------
  ctx.handle('users:keyOnly', async (serverId: string, nameRaw: string, keyOnly: boolean) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    const self = selfUser(ssh)
    if (keyOnly && name === self && ssh.profile.auth === 'password') throw new Error('This profile logs in with a password. Switch the profile to key authentication first, otherwise Central Server would lock itself out.')
    if (keyOnly) {
      const { lines } = await readAuthorizedKeys(ssh, name)
      if (!lines.some((l) => parseKeyLine(l))) throw new Error(`${name} has no SSH keys. Add a key first, otherwise the account could not log in at all.`)
    }
    const current = await readKeyOnlyUsers(ssh)
    const next = keyOnly ? [...new Set([...current, name])] : current.filter((u) => u !== name)
    await writeKeyOnlyUsers(ssh, next)
    // Locking the Unix password of the login account would also break Central Server's own sudo (which
    // authenticates with that password). The sshd Match block already denies password SSH logins.
    const breaksSudo = name === self && !ssh.os?.isRoot && !ssh.os?.sudoPasswordless
    if (keyOnly && !breaksSudo) await rootExec(ssh, `passwd -l ${shq(name)} 2>/dev/null || usermod -L ${shq(name)}`)
    else await rootExec(ssh, `passwd -u ${shq(name)} 2>/dev/null || usermod -U ${shq(name)} 2>/dev/null || true`)
    ctx.audit(serverId, 'users.keyOnly', `${name} ${keyOnly ? 'on' : 'off'}`)
  })

  // ---------------- sessions ----------------
  ctx.handle('users:sessions', async (serverId: string): Promise<SessionInfoEx[]> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(`echo __WHO; who -u 2>/dev/null; echo __W; w -h 2>/dev/null; echo __CLIENT; echo "$SSH_CLIENT" | awk '{print $1}'`)
    const sec = sectionize(r.stdout)
    const clientIp = (sec.CLIENT?.[0] ?? '').trim()
    const self = selfUser(ssh)
    const what = new Map<string, string>()
    for (const l of sec.W ?? []) {
      const t = l.trim().split(/\s+/)
      if (t.length < 4) continue
      // USER TTY [FROM] LOGIN@ IDLE JCPU PCPU WHAT  (FROM is present in the default procps output)
      const start = t.length >= 8 ? 7 : 6
      what.set(`${t[0]}\t${t[1]}`, t.slice(start).join(' '))
    }
    const out: SessionInfoEx[] = []
    for (const l of sec.WHO ?? []) {
      const m = l.match(/^(\S+)\s+(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s+(\S+)\s+(\d+)\s*(?:\((.*)\))?\s*$/)
      if (!m) continue
      const [, user, tty, since, idle, pid, from] = m
      const idleStr = idle === '.' ? 'active' : idle === 'old' ? '> 1 day' : idle
      const fromStr = (from ?? '').trim()
      out.push({ user, tty, from: fromStr || 'local', since, idle: idleStr, what: what.get(`${user}\t${tty}`), pid: Number(pid) || undefined, self: user === self && !!clientIp && fromStr === clientIp })
    }
    return out
  })

  ctx.handle('users:killSession', async (serverId: string, target: { tty?: string; pid?: number }) => {
    const ssh = ctx.ssh(serverId)
    if (target?.tty) {
      const tty = target.tty.replace(/^\/dev\//, '')
      if (!TTY_RE.test(tty)) throw new Error('Invalid tty')
      await rootRun(ssh, `pkill -KILL -t ${shq(tty)} 2>/dev/null || true`)
      ctx.audit(serverId, 'users.killSession', tty)
    } else if (typeof target?.pid === 'number' && Number.isInteger(target.pid) && target.pid > 1) {
      await rootRun(ssh, `kill -KILL ${target.pid}`)
      ctx.audit(serverId, 'users.killSession', `pid ${target.pid}`)
    } else throw new Error('tty or pid required')
  })

  // ---------------- login history ----------------
  ctx.handle('users:lastLogins', async (serverId: string, nRaw?: number): Promise<LastLoginsResult> => {
    const ssh = ctx.ssh(serverId)
    const n = Math.max(1, Math.min(2000, Math.floor(Number(nRaw) || 100)))
    const script = `echo __LAST; last -n ${n} -w -F 2>/dev/null; echo __LASTB; lastb -n 25 -w -F 2>/dev/null; echo __LASTBC; if [ -r /var/log/btmp ]; then lastb -w -F 2>/dev/null | grep -vcE '^$|^btmp begins'; else echo NA; fi; echo __END`
    let r
    try {
      r = await rootExec(ssh, script, { timeoutMs: 60000 })
    } catch (e) {
      if (e instanceof SshError && e.code === 'SUDO_FAILED') r = await ssh.exec(script, { timeoutMs: 60000 })
      else throw e
    }
    const sec = sectionize(r.stdout)
    const last = parseLast(sec.LAST ?? [])
    const lastb = parseLast(sec.LASTB ?? [])
    const cnt = (sec.LASTBC?.[0] ?? '').trim()
    return { entries: last.entries, failedRecent: lastb.entries, failedCount: /^\d+$/.test(cnt) ? Number(cnt) : undefined, wtmpSince: last.since }
  })

  // ---------------- groups ----------------
  ctx.handle('users:groups', async (serverId: string): Promise<GroupInfo[]> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(`echo __GROUP; getent group; echo __PASSWD; getent passwd | awk -F: '{print $1":"$4}'; echo __GIDMIN; grep -E '^GID_MIN' /etc/login.defs 2>/dev/null | awk '{print $2}'`)
    const sec = sectionize(r.stdout)
    const gidMin = Number(sec.GIDMIN?.[0]) || 1000
    const primary = new Map<number, string[]>()
    for (const l of sec.PASSWD ?? []) {
      const [u, g] = l.split(':')
      if (!u) continue
      primary.set(Number(g), [...(primary.get(Number(g)) ?? []), u])
    }
    const out: GroupInfo[] = []
    for (const l of sec.GROUP ?? []) {
      const f = l.split(':')
      if (f.length < 4) continue
      const gid = Number(f[2])
      const members = [...new Set([...f[3].split(',').filter(Boolean), ...(primary.get(gid) ?? [])])].sort()
      out.push({ name: f[0], gid, members, system: !(gid >= gidMin && gid < 60000) })
    }
    return out.sort((a, b) => a.gid - b.gid)
  })

  ctx.handle('users:setGroups', async (serverId: string, nameRaw: string, groupsRaw: string[]) => {
    const ssh = ctx.ssh(serverId)
    const name = assertUser(nameRaw)
    if (!Array.isArray(groupsRaw)) throw new Error('groups must be an array')
    const groups = [...new Set(groupsRaw.map(assertGroup))]
    const cur = await ssh.exec(`id -nG ${shq(name)}; id -gn ${shq(name)}`)
    const [curGroupsLine, primaryGroup] = cur.stdout.split('\n')
    const curGroups = (curGroupsLine ?? '').trim().split(/\s+/).filter(Boolean)
    const supplementary = groups.filter((g) => g !== primaryGroup?.trim())
    if (name === selfUser(ssh)) {
      const losesAdmin = curGroups.some((g) => ADMIN_GROUPS.includes(g)) && !supplementary.some((g) => ADMIN_GROUPS.includes(g))
      if (losesAdmin) throw new Error('Refusing to remove the account Central Server is logged in with from its admin group')
    }
    await rootRun(ssh, `usermod -G ${shq(supplementary.join(','))} ${shq(name)}`)
    ctx.audit(serverId, 'users.groups', `${name}: ${supplementary.join(',') || '(none)'}`)
  })
}
