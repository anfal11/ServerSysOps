import { app, nativeImage, type NativeImage } from 'electron'
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'fs'
import { join, dirname } from 'path'

export const APP_NAME = 'ServerSysOps'
export const APP_ID = 'com.serversysops.app'

/** Absolute path of the product icon (PNG) in both dev and packaged builds. */
export function appIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.png')
  return join(app.getAppPath(), 'build', 'icon.png')
}

let cached: NativeImage | null = null
export function appIcon(): NativeImage {
  if (!cached) cached = nativeImage.createFromPath(appIconPath())
  return cached
}

/** Earlier product names, newest first: their data folders are migrated on first start. */
const LEGACY_DATA_DIRS = ['Central Server', 'ServerMate']

/**
 * Earlier versions stored their data under the old product names. On first start of the renamed app,
 * copy servers, secrets, settings, snippets and history over so nothing is lost.
 */
export function migrateLegacyUserData(): void {
  try {
    const current = app.getPath('userData')
    if (existsSync(join(current, 'servers.json'))) return
    for (const name of LEGACY_DATA_DIRS) {
      const legacy = join(dirname(current), name)
      if (!existsSync(legacy) || legacy === current || !existsSync(join(legacy, 'servers.json'))) continue
      mkdirSync(current, { recursive: true })
      for (const f of readdirSync(legacy)) {
        if (!f.endsWith('.json')) continue
        const src = join(legacy, f)
        if (statSync(src).isFile() && !existsSync(join(current, f))) copyFileSync(src, join(current, f))
      }
      return
    }
  } catch {
    /* best effort */
  }
}
