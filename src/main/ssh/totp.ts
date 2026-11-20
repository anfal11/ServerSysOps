import { createHmac, randomBytes } from 'crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** New random 160-bit secret (Google Authenticator compatible). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

/** RFC 6238 TOTP code (SHA-1, 6 digits, 30 s step by default). */
export function totp(secret: string, opts: { digits?: number; period?: number; time?: number } = {}): string {
  const digits = opts.digits ?? 6
  const period = opts.period ?? 30
  const counter = Math.floor((opts.time ?? Date.now()) / 1000 / period)
  const msg = Buffer.alloc(8)
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  msg.writeUInt32BE(counter >>> 0, 4)
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest()
  const off = h[h.length - 1] & 0x0f
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(code % 10 ** digits).padStart(digits, '0')
}

/** Accept the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, window = 1): boolean {
  const c = code.replace(/\s+/g, '')
  if (!/^\d{6,8}$/.test(c)) return false
  for (let i = -window; i <= window; i++) {
    if (totp(secret, { time: Date.now() + i * 30000 }) === c) return true
  }
  return false
}

export function otpauthUrl(secret: string, account: string, issuer = 'ServerMate'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

/** Google Authenticator PAM emergency scratch codes (8 digits each). */
export function scratchCodes(n = 5): string[] {
  const out: string[] = []
  while (out.length < n) {
    const v = randomBytes(4).readUInt32BE(0) % 100000000
    if (v >= 10000000) out.push(String(v))
  }
  return out
}
