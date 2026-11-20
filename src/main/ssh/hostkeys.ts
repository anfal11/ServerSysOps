import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

interface KnownHost {
  type: string
  fingerprint: string
  key: string
  firstSeen: number
  lastSeen: number
}

type KnownHosts = Record<string, KnownHost>

function filePath(): string {
  return join(app.getPath('userData'), 'known_hosts.json')
}

function load(): KnownHosts {
  try {
    const p = filePath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8')) as KnownHosts
  } catch {
    return {}
  }
}

function save(data: KnownHosts): void {
  const p = filePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
}

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export type HostKeyVerdict =
  | { verdict: 'trusted' }
  | { verdict: 'new'; fingerprint: string }
  | { verdict: 'changed'; fingerprint: string; previous: string }

/** Pure check; does not mutate the store. */
export function checkHostKey(host: string, port: number, keyType: string, key: Buffer): HostKeyVerdict {
  const id = `${host}:${port}`
  const known = load()[id]
  const fp = fingerprintOf(key)
  if (!known) return { verdict: 'new', fingerprint: fp }
  if (known.key === key.toString('base64')) return { verdict: 'trusted' }
  return { verdict: 'changed', fingerprint: fp, previous: known.fingerprint }
}

export function rememberHostKey(host: string, port: number, keyType: string, key: Buffer): void {
  const id = `${host}:${port}`
  const data = load()
  const now = Date.now()
  const existing = data[id]
  data[id] = {
    type: keyType,
    fingerprint: fingerprintOf(key),
    key: key.toString('base64'),
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now
  }
  save(data)
}

export function forgetHostKey(host: string, port: number): void {
  const id = `${host}:${port}`
  const data = load()
  delete data[id]
  save(data)
}

export function getKnownHostFingerprint(host: string, port: number): string | undefined {
  return load()[`${host}:${port}`]?.fingerprint
}
