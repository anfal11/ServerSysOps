/** Shell quoting helpers used when composing remote commands. */

/** Single-quote a string for POSIX sh. */
export function shq(s: string | number): string {
  const str = String(s)
  if (str === '') return "''"
  if (/^[A-Za-z0-9_\-./:=@,+]+$/.test(str)) return str
  return "'" + str.replace(/'/g, `'\\''`) + "'"
}

/** Join command words with quoting. */
export function shJoin(parts: (string | number)[]): string {
  return parts.map(shq).join(' ')
}

/** Wrap a script so it runs under bash -c with proper quoting. */
export function bashC(script: string): string {
  return `bash -c ${shq(script)}`
}

/** Base64-embed content into a command that writes it to stdout. */
export function b64Echo(content: string | Buffer): string {
  const b = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  return `printf %s ${shq(b.toString('base64'))} | base64 -d`
}

/** Validate a simple identifier (username, db name, service name). */
export function isSafeName(s: string, max = 64): boolean {
  return typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.@\-]*$/.test(s)
}

export function assertSafeName(s: string, what = 'name'): string {
  if (!isSafeName(s)) throw new Error(`Invalid ${what}: ${s}`)
  return s
}

export function assertPort(p: number): number {
  const n = Number(p)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port: ${p}`)
  return n
}

export function assertAbsPath(p: string): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) throw new Error(`Invalid path: ${p}`)
  return p
}

/**
 * POSIX sh snippet that prints the *global* sshd configuration lines in the order sshd reads them:
 * `Include` directives are expanded in place (so /etc/ssh/sshd_config.d/*.conf wins when the Include
 * sits at the top, as on Ubuntu/Debian), and reading stops at the first `Match` block of each file.
 * A plain `grep` over all files got this wrong (file order, Match-block overrides) and reported
 * "PasswordAuthentication no" on servers that accept passwords.
 */
export const SSHD_CONFIG_DUMP = `smsshcfg() { [ -r "$1" ] || return 0; awk 'tolower($1)=="match"{exit} {print}' "$1" 2>/dev/null | while IFS= read -r l; do case "$l" in [Ii]nclude*) set -- $l; shift; for p in "$@"; do case "$p" in /*) ;; *) p="/etc/ssh/$p";; esac; for f in $p; do smsshcfg "$f"; done; done;; *) printf '%s\\n' "$l";; esac; done; }; smsshcfg /etc/ssh/sshd_config`

/**
 * Parse `sshd -T` output or SSHD_CONFIG_DUMP lines into lowercase key → values (first match wins per
 * key, like sshd; `port` and a few others may legitimately repeat so every value is kept in order).
 */
export function parseSshdConfig(lines: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const repeatable = new Set(['port', 'listenaddress', 'hostkey', 'acceptenv', 'subsystem', 'authorizedkeysfile'])
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z0-9]+)\s*(?:=|\s)\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (!(key in out)) out[key] = [val]
    else if (repeatable.has(key)) out[key].push(val)
  }
  return out
}
