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
