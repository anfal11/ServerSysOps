import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** Earlier product names, newest first: their data folders are migrated on first start. */
export const LEGACY_DATA_DIRS = ['Central Server', 'ServerMate']

/**
 * Chromium keeps the key that `safeStorage` uses on Windows in this file (DPAPI-protected, under
 * `os_crypt.encrypted_key`). Secrets encrypted under one data folder's key cannot be read with another's.
 */
const KEY_FILE = 'Local State'
const MARKER = 'legacy-migration.json'

export interface LegacyMigrationResult {
  action: 'none' | 'copied' | 'key-adopted' | 'key-kept'
  from?: string
  detail?: string
}

function findLegacyDir(current: string): string | undefined {
  for (const name of LEGACY_DATA_DIRS) {
    const dir = join(dirname(current), name)
    if (dir !== current && existsSync(join(dir, 'servers.json'))) return dir
  }
  return undefined
}

function encryptedSecrets(serversFile: string): string[] | null {
  try {
    const j = JSON.parse(readFileSync(serversFile, 'utf8')) as { secrets?: Record<string, string> }
    return Object.values(j.secrets ?? {}).filter((v) => typeof v === 'string' && v.startsWith('enc:'))
  } catch {
    return null
  }
}

function copyKeyFile(from: string, to: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32' || !existsSync(join(from, KEY_FILE))) return false
  copyFileSync(join(from, KEY_FILE), join(to, KEY_FILE))
  return true
}

function writeMarker(current: string, r: LegacyMigrationResult): void {
  writeFileSync(join(current, MARKER), JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2))
}

/**
 * Migrate the data folder of an earlier product name into `current`.
 *
 * MUST run before Electron's `ready` event (top level of the main script): on Windows the safeStorage key
 * is read from `Local State` once at startup, so the key file has to be in place before that.
 *
 * - First start (no servers.json yet): copy every *.json file and, on Windows, the key file, so the
 *   copied secrets stay readable.
 * - Already migrated by 0.3.1/0.4.x without the key file: adopt the legacy key when every encrypted secret
 *   in the current file is byte-identical to one in the legacy file (nothing has been encrypted with the
 *   new key yet). Otherwise keep the new key. Decided once; the marker file records the outcome.
 */
export function migrateLegacyData(current: string, platform: NodeJS.Platform = process.platform): LegacyMigrationResult {
  try {
    const legacy = findLegacyDir(current)
    if (!legacy) return { action: 'none' }
    const currentServers = join(current, 'servers.json')
    if (!existsSync(currentServers)) {
      mkdirSync(current, { recursive: true })
      for (const f of readdirSync(legacy)) {
        if (!f.endsWith('.json')) continue
        const src = join(legacy, f)
        if (statSync(src).isFile() && !existsSync(join(current, f))) copyFileSync(src, join(current, f))
      }
      const key = copyKeyFile(legacy, current, platform)
      const r: LegacyMigrationResult = { action: 'copied', from: legacy, detail: key ? 'data and key file' : 'data' }
      writeMarker(current, r)
      return r
    }
    if (existsSync(join(current, MARKER))) return { action: 'none' }
    const cur = encryptedSecrets(currentServers)
    const old = encryptedSecrets(join(legacy, 'servers.json'))
    if (!cur || !old) return { action: 'none' }
    const oldSet = new Set(old)
    const allLegacy = cur.length > 0 && cur.every((v) => oldSet.has(v))
    let r: LegacyMigrationResult
    if (allLegacy && copyKeyFile(legacy, current, platform)) r = { action: 'key-adopted', from: legacy, detail: `${cur.length} secret(s) encrypted with the legacy key` }
    else r = { action: 'key-kept', from: legacy, detail: cur.length === 0 ? 'no encrypted secrets' : allLegacy ? 'no legacy key file' : 'some secrets already use the new key' }
    writeMarker(current, r)
    return r
  } catch {
    return { action: 'none' }
  }
}
