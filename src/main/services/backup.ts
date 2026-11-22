import { app, dialog } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import type { Ctx } from '../core'
import type { ServerProfile, ServerSecrets, Snippet, AppSettings } from '@shared/types'
import { exportAllSecrets, listServers, saveServer, updateSecrets } from '../store/servers'
import { getSettings, listSnippets, saveSnippet, setSettings } from '../store/settings'

/**
 * Full backup / restore of the app's local data: servers, their secrets, settings and snippets.
 * Secrets are only included when the user supplies a passphrase; the payload is then encrypted
 * with AES-256-GCM using a scrypt-derived key, so the file is safe to keep in cloud storage.
 */

interface BackupPayload {
  servers: ServerProfile[]
  secrets?: Record<string, ServerSecrets>
  settings: AppSettings
  snippets: Snippet[]
}

/** Earlier product names: their backup files are still accepted. */
const LEGACY_APP_IDS = ['central-server']

interface BackupFile {
  app: 'serversysops'
  format: 1
  version: string
  createdAt: number
  counts: { servers: number; snippets: number; secrets: number }
  encrypted: boolean
  /** Plain payload (never contains secrets). */
  data?: BackupPayload
  /** Encrypted payload (base64 fields). */
  cipher?: { salt: string; iv: string; tag: string; data: string }
}

export interface BackupInfo {
  path: string
  version: string
  createdAt: number
  encrypted: boolean
  counts: { servers: number; snippets: number; secrets: number }
}

const EXT = 'csbackup'

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

function encrypt(payload: BackupPayload, passphrase: string): BackupFile['cipher'] {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()])
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function decrypt(cipher: NonNullable<BackupFile['cipher']>, passphrase: string): BackupPayload {
  const key = deriveKey(passphrase, Buffer.from(cipher.salt, 'base64'))
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.iv, 'base64'))
  d.setAuthTag(Buffer.from(cipher.tag, 'base64'))
  try {
    const out = Buffer.concat([d.update(Buffer.from(cipher.data, 'base64')), d.final()])
    return JSON.parse(out.toString('utf8')) as BackupPayload
  } catch {
    throw new Error('Wrong passphrase or damaged backup file')
  }
}

function readBackup(path: string): BackupFile {
  let f: BackupFile
  try {
    f = JSON.parse(readFileSync(path, 'utf8')) as BackupFile
  } catch {
    throw new Error('Not a valid backup file (unreadable JSON)')
  }
  if (!(f?.app === 'serversysops' || LEGACY_APP_IDS.includes(String(f?.app))) || f.format !== 1) throw new Error('Not a ServerSysOps backup file')
  return f
}

export function register(ctx: Ctx): void {
  ctx.handle('backup:export', async (_s: string, opts: { passphrase?: string; includeSecrets?: boolean }) => {
    const includeSecrets = !!opts?.includeSecrets
    const passphrase = (opts?.passphrase ?? '').trim()
    if (includeSecrets && passphrase.length < 8) throw new Error('A passphrase of at least 8 characters is required to include passwords and keys')
    const stamp = new Date().toISOString().slice(0, 10)
    const r = await dialog.showSaveDialog({ defaultPath: `serversysops-backup-${stamp}.${EXT}.json`, filters: [{ name: 'ServerSysOps backup', extensions: [`${EXT}.json`, 'json'] }] })
    if (r.canceled || !r.filePath) return false
    const servers = listServers().map((s) => ({ ...s }))
    const secrets = includeSecrets ? exportAllSecrets() : undefined
    const payload: BackupPayload = { servers, secrets, settings: getSettings(), snippets: listSnippets() }
    const file: BackupFile = {
      app: 'serversysops',
      format: 1,
      version: app.getVersion(),
      createdAt: Date.now(),
      counts: { servers: servers.length, snippets: payload.snippets.length, secrets: secrets ? Object.keys(secrets).length : 0 },
      encrypted: passphrase.length > 0
    }
    if (passphrase) file.cipher = encrypt(payload, passphrase)
    else file.data = { ...payload, secrets: undefined, servers: servers.map((s) => ({ ...s, hasPassword: false, hasPassphrase: false, hasSudoPassword: false, hasTotpSecret: false })) }
    writeFileSync(r.filePath, JSON.stringify(file, null, 2))
    ctx.audit(undefined, 'backup.export', `${file.counts.servers} servers, ${file.counts.snippets} snippets${includeSecrets ? ', with secrets (encrypted)' : ''}`)
    return true
  })

  ctx.handle('backup:inspect', async (): Promise<BackupInfo | null> => {
    const r = await dialog.showOpenDialog({ filters: [{ name: 'ServerSysOps backup', extensions: [`${EXT}.json`, 'json'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    const f = readBackup(r.filePaths[0])
    return { path: r.filePaths[0], version: f.version, createdAt: f.createdAt, encrypted: f.encrypted, counts: f.counts }
  })

  ctx.handle('backup:import', async (_s: string, opts: { path: string; passphrase?: string; servers?: boolean; settings?: boolean; snippets?: boolean }) => {
    const f = readBackup(opts.path)
    const payload = f.encrypted ? decrypt(f.cipher!, opts.passphrase ?? '') : f.data!
    const result = { servers: 0, secrets: 0, snippets: 0, settings: false }
    if (opts.servers !== false) {
      for (const s of payload.servers ?? []) {
        // Keep the original id so jump-host references and secrets stay linked.
        saveServer({ ...s })
        result.servers++
        const sec = payload.secrets?.[s.id]
        if (sec && Object.keys(sec).length) {
          updateSecrets(s.id, sec)
          result.secrets++
        }
      }
    }
    if (opts.snippets !== false) {
      for (const sn of payload.snippets ?? []) {
        saveSnippet(sn)
        result.snippets++
      }
    }
    if (opts.settings !== false && payload.settings) {
      setSettings(payload.settings)
      result.settings = true
    }
    ctx.audit(undefined, 'backup.import', `${result.servers} servers (${result.secrets} with secrets), ${result.snippets} snippets${result.settings ? ', settings' : ''}`)
    return result
  })
}
