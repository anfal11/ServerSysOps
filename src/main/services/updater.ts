import { app, Notification } from 'electron'
import { appIcon } from '../branding'
import type { Ctx } from '../core'
import { getSettings } from '../store/settings'

/**
 * Application self-update via electron-updater (GitHub Releases provider configured in electron-builder.yml).
 * Fails quietly when no update server is configured.
 */
export function register(ctx: Ctx): void {
  let autoUpdater: typeof import('electron-updater').autoUpdater | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    autoUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater
    autoUpdater.autoDownload = false
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => ctx.emit({ type: 'update', status: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      ctx.emit({ type: 'update', status: 'available', info })
      try {
        if (Notification.isSupported()) new Notification({ title: `Central Server ${info.version} is available`, body: 'Open the app and click "Update" in the top bar to install it.', icon: appIcon() }).show()
      } catch {
        /* ignore */
      }
    })
    autoUpdater.on('update-not-available', () => ctx.emit({ type: 'update', status: 'none' }))
    autoUpdater.on('download-progress', (p) => ctx.emit({ type: 'update', status: 'downloading', info: p }))
    autoUpdater.on('update-downloaded', () => ctx.emit({ type: 'update', status: 'downloaded' }))
    autoUpdater.on('error', (e) => ctx.emit({ type: 'update', status: 'error', info: e?.message }))
  } catch {
    autoUpdater = null
  }

  ctx.handle('update:check', async () => {
    if (!autoUpdater || !app.isPackaged) return { status: 'unavailable' }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { status: r?.updateInfo ? 'checked' : 'none', info: r?.updateInfo }
    } catch (e) {
      return { status: 'error', error: (e as Error).message }
    }
  })
  ctx.handle('update:download', async () => {
    if (!autoUpdater) return false
    await autoUpdater.downloadUpdate()
    return true
  })
  ctx.handle('update:install', async () => {
    autoUpdater?.quitAndInstall()
  })

  if (app.isPackaged && autoUpdater) {
    const check = (): void => {
      if (getSettings().checkForUpdates) autoUpdater?.checkForUpdates().catch(() => {})
    }
    setTimeout(check, 8000)
    // Long-running sessions still learn about new releases.
    setInterval(check, 6 * 60 * 60 * 1000)
  }
}
