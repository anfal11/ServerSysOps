import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import type { ServerProfile, ServerProfileInput, ServerSecrets } from '@shared/types'
import { JsonStore } from './jsonStore'

interface ServersFile {
  servers: ServerProfile[]
  /** serverId -> base64 of safeStorage-encrypted JSON secrets */
  secrets: Record<string, string>
}

const store = new JsonStore<ServersFile>('servers.json', { servers: [], secrets: {} })

function encrypt(obj: ServerSecrets): string {
  const json = JSON.stringify(obj)
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(json).toString('base64')
  // Fallback (encryption unavailable on this OS session): obfuscate only, flagged as plain.
  return 'b64:' + Buffer.from(json, 'utf8').toString('base64')
}

function decrypt(s: string | undefined): ServerSecrets {
  if (!s) return {}
  try {
    if (s.startsWith('enc:')) return JSON.parse(safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'))) as ServerSecrets
    if (s.startsWith('b64:')) return JSON.parse(Buffer.from(s.slice(4), 'base64').toString('utf8')) as ServerSecrets
  } catch {
    /* ignore */
  }
  return {}
}

export function listServers(): ServerProfile[] {
  return store.read().servers
}

export function getServer(id: string): ServerProfile | undefined {
  return store.read().servers.find((s) => s.id === id)
}

export function getSecrets(id: string): ServerSecrets {
  return decrypt(store.read().secrets[id])
}

export function saveServer(input: ServerProfileInput): ServerProfile {
  const { password, passphrase, sudoPassword, ...rest } = input
  const data = store.read()
  const existing = rest.id ? data.servers.find((s) => s.id === rest.id) : undefined
  const id = existing?.id ?? rest.id ?? randomUUID()
  const prevSecrets = existing ? decrypt(data.secrets[id]) : {}
  const secrets: ServerSecrets = {
    password: password !== undefined ? password || undefined : prevSecrets.password,
    passphrase: passphrase !== undefined ? passphrase || undefined : prevSecrets.passphrase,
    sudoPassword: sudoPassword !== undefined ? sudoPassword || undefined : prevSecrets.sudoPassword
  }
  const profile: ServerProfile = {
    ...(existing ?? { createdAt: Date.now() }),
    ...rest,
    id,
    port: Number(rest.port) || 22,
    hasPassword: !!secrets.password,
    hasPassphrase: !!secrets.passphrase,
    hasSudoPassword: !!secrets.sudoPassword
  } as ServerProfile
  const servers = existing ? data.servers.map((s) => (s.id === id ? profile : s)) : [...data.servers, profile]
  store.write({ servers, secrets: { ...data.secrets, [id]: encrypt(secrets) } })
  return profile
}

export function updateSecrets(id: string, patch: ServerSecrets): void {
  const data = store.read()
  const cur = decrypt(data.secrets[id])
  const next = { ...cur, ...patch }
  const servers = data.servers.map((s) =>
    s.id === id ? { ...s, hasPassword: !!next.password, hasPassphrase: !!next.passphrase, hasSudoPassword: !!next.sudoPassword } : s
  )
  store.write({ servers, secrets: { ...data.secrets, [id]: encrypt(next) } })
}

export function touchServer(id: string): void {
  store.update((d) => ({ ...d, servers: d.servers.map((s) => (s.id === id ? { ...s, lastConnectedAt: Date.now() } : s)) }))
}

export function deleteServer(id: string): void {
  store.update((d) => {
    const secrets = { ...d.secrets }
    delete secrets[id]
    return { servers: d.servers.filter((s) => s.id !== id), secrets }
  })
}

export function reorderServers(ids: string[]): void {
  store.update((d) => {
    const map = new Map(d.servers.map((s) => [s.id, s]))
    const ordered = ids.map((i) => map.get(i)).filter(Boolean) as ServerProfile[]
    const rest = d.servers.filter((s) => !ids.includes(s.id))
    return { ...d, servers: [...ordered, ...rest] }
  })
}

/** Export profiles without secrets (for backup / sharing). */
export function exportServers(): ServerProfile[] {
  return listServers().map((s) => ({ ...s, hasPassword: false, hasPassphrase: false, hasSudoPassword: false }))
}

export function importServers(list: ServerProfileInput[]): number {
  let n = 0
  for (const s of list) {
    saveServer({ ...s, id: undefined })
    n++
  }
  return n
}
