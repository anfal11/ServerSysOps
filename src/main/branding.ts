import { app, nativeImage, shell, type NativeImage } from 'electron'
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, writeFileSync } from 'fs'
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

/**
 * Windows only. An in-app update across the product rename (Central Server -> ServerSysOps) left users
 * without Start-menu and desktop shortcuts: electron-builder keeps shortcuts through an update only when
 * the new exe already exists in the install folder, and the rename moved the folder. Recreate them once
 * when no Start-menu entry exists at all; after that never again, so a shortcut the user removes stays removed.
 */
export function repairShortcuts(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  try {
    const marker = join(app.getPath('userData'), 'shortcuts-checked.json')
    if (existsSync(marker)) return
    const exe = process.execPath
    const menus = [process.env.APPDATA, process.env.ProgramData].filter((d): d is string => !!d).map((d) => join(d, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
    const hasStartMenu = menus.some((d) => existsSync(join(d, `${APP_NAME}.lnk`)))
    const made: string[] = []
    if (!hasStartMenu && menus[0] && existsSync(menus[0])) {
      const opts = { target: exe, cwd: dirname(exe), description: APP_NAME, appUserModelId: APP_ID }
      const startLink = join(menus[0], `${APP_NAME}.lnk`)
      if (shell.writeShortcutLink(startLink, 'create', opts)) made.push(startLink)
      const desktopLink = join(app.getPath('desktop'), `${APP_NAME}.lnk`)
      if (!existsSync(desktopLink) && shell.writeShortcutLink(desktopLink, 'create', opts)) made.push(desktopLink)
    }
    writeFileSync(marker, JSON.stringify({ checkedAt: new Date().toISOString(), version: app.getVersion(), hadStartMenu: hasStartMenu, created: made }, null, 2))
  } catch {
    /* best effort */
  }
}
