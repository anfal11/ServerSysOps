import { app, BrowserWindow, shell, ipcMain, nativeTheme, Menu } from 'electron'
import { join } from 'path'
import { createContext } from './core'
import pkg from '../../package.json'
import * as servers from './services/servers'
import * as terminal from './services/terminal'
import * as overview from './services/overview'
import * as quickactions from './services/quickactions'
import * as files from './services/files'
import * as docker from './services/docker'
import * as kubernetes from './services/kubernetes'
import * as webserver from './services/webserver'
import * as databases from './services/databases'
import * as runtimes from './services/runtimes'
import * as cron from './services/cron'
import * as processes from './services/processes'
import * as users from './services/users'
import * as firewall from './services/firewall'
import * as twofactor from './services/twofactor'
import * as security from './services/security'
import * as logs from './services/logs'
import * as snippets from './services/snippets'
import * as alerts from './services/alerts'
import * as tunnels from './services/tunnels'
import * as pkgupdates from './services/pkgupdates'
import * as updater from './services/updater'
import * as backup from './services/backup'
import { APP_ID, APP_NAME, appIcon, migrateLegacyUserData } from './branding'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#1c1f26',
    title: APP_NAME,
    icon: appIcon(),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  if (process.env.SERVERSYSOPS_DEBUG) {
    mainWindow.webContents.on('console-message', (ev) => {
      const { level, message, lineNumber, sourceId } = ev as unknown as { level: string | number; message: string; lineNumber: number; sourceId: string }
      console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`)
    })
    mainWindow.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', d.reason))
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => console.log('[did-fail-load]', code, desc))
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID)
  migrateLegacyUserData()
  nativeTheme.themeSource = 'dark'
  Menu.setApplicationMenu(null)

  const ctx = createContext()
  for (const svc of [servers, terminal, overview, quickactions, files, docker, kubernetes, webserver, databases, runtimes, cron, processes, users, firewall, twofactor, security, logs, snippets, alerts, tunnels, backup, pkgupdates]) {
    svc.register(ctx)
  }
  updater.register(ctx)

  ipcMain.handle('app:info', () => ({ version: app.isPackaged ? app.getVersion() : (pkg as { version: string }).version, platform: process.platform, userData: app.getPath('userData'), electron: process.versions.electron }))
  ipcMain.on('app:openExternal', (_e, url: string) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  ipcMain.on('app:showItem', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.on('window:control', (_e, action: 'minimize' | 'maximize' | 'close') => {
    const w = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!w) return
    if (action === 'minimize') w.minimize()
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize())
    else w.close()
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('before-quit', () => ctx.sessions.disconnectAll())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
