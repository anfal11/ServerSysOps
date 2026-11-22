import { app, nativeImage, type NativeImage } from 'electron'
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'fs'
import { join, dirname } from 'path'

export const APP_NAME = 'Central Server'
export const APP_ID = 'com.centralserver.app'

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

/**
 * 0.1.x stored its data under the old product name. On first start of the renamed app, copy
 * servers, secrets, settings, snippets and history over so nothing is lost.
 */
export function migrateLegacyUserData(): void {
  try {
    const current = app.getPath('userData')
    const legacy = join(dirname(current), 'ServerMate')
    if (!existsSync(legacy) || legacy === current) return
    if (existsSync(join(current, 'servers.json'))) return
    mkdirSync(current, { recursive: true })
    for (const f of readdirSync(legacy)) {
      if (!f.endsWith('.json')) continue
      const src = join(legacy, f)
      if (statSync(src).isFile() && !existsSync(join(current, f))) copyFileSync(src, join(current, f))
    }
  } catch {
    /* best effort */
  }
}
