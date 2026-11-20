import { dialog, nativeTheme } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import type { Ctx } from '../core'
import * as store from '../store/servers'
import { getSettings, setSettings, listAudit, clearAudit } from '../store/settings'
import type { AppSettings, ServerProfileInput, ServerSecrets } from '@shared/types'
import { SshClient, SshError } from '../ssh/SshClient'

export function register(ctx: Ctx): void {
  ctx.handle('servers:list', () => store.listServers())
  ctx.handle('servers:save', (_s, input: ServerProfileInput) => store.saveServer(input))
  ctx.handle('servers:delete', (id: string) => {
    ctx.sessions.disconnect(id)
    store.deleteServer(id)
  })
  ctx.handle('servers:reorder', (_s, ids: string[]) => store.reorderServers(ids))
  ctx.handle('servers:setSecrets', (id: string, secrets: ServerSecrets) => {
    store.updateSecrets(id, secrets)
    ctx.sessions.refreshSecrets(id)
  })
  ctx.handle('servers:export', async () => {
    const r = await dialog.showSaveDialog({ defaultPath: 'servers.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, JSON.stringify(store.exportServers(), null, 2))
    return true
  })
  ctx.handle('servers:import', async () => {
    const r = await dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return 0
    const list = JSON.parse(readFileSync(r.filePaths[0], 'utf8')) as ServerProfileInput[]
    return store.importServers(list)
  })
  ctx.handle('servers:pickKeyFile', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'showHiddenFiles'], title: 'Choose private key' })
    return r.canceled ? null : r.filePaths[0]
  })

  ctx.handle('servers:connect', async (id: string, opts?: { trustNewHostKey?: boolean }) => {
    const st = await ctx.sessions.connect(id, opts)
    ctx.audit(id, 'connect', `${st.os?.prettyName ?? ''}`)
    return st
  })
  ctx.handle('servers:disconnect', (id: string) => {
    ctx.sessions.disconnect(id)
    ctx.audit(id, 'disconnect')
  })
  ctx.handle('servers:state', (id: string) => ctx.sessions.getState(id))
  ctx.handle('servers:states', () => ctx.sessions.allStates())

  /** Test a connection without saving. */
  ctx.handle('servers:test', async (_s, input: ServerProfileInput) => {
    const { password, passphrase, sudoPassword, totpSecret, ...rest } = input
    const profile = { ...rest, id: 'test', createdAt: Date.now(), port: Number(rest.port) || 22 }
    const saved = rest.id ? store.getSecrets(rest.id) : {}
    const client = new SshClient(profile as never, {
      password: password || saved.password,
      passphrase: passphrase || saved.passphrase,
      sudoPassword: sudoPassword || saved.sudoPassword,
      totpSecret: totpSecret?.replace(/\s+/g, '').toUpperCase() || saved.totpSecret
    })
    client.promptHandler = (name, instr, prompts, prefilled) => ctx.askAuth(rest.id ?? 'test', name, instr, prompts, prefilled)
    try {
      await client.connect()
      const sudoOk = await client.verifySudo()
      const os = client.os
      client.disconnect()
      return { ok: true, os, sudoOk, hostKey: client.hostKeyVerdict }
    } catch (e) {
      const err = e as SshError
      return { ok: false, error: err.message, code: err.code, hostKey: client.hostKeyVerdict }
    }
  })

  ctx.handle('servers:verifySudo', async (id: string) => ctx.ssh(id).verifySudo())
  ctx.handle('servers:answerPrompt', (_s, requestId: string, answers: string[] | null) => ctx.answerAuth(requestId, answers))

  // ----- settings / audit -----
  ctx.handle('settings:get', () => getSettings())
  const LIGHT_THEMES = ['light', 'paper']
  const applyNativeTheme = (theme: string): void => {
    nativeTheme.themeSource = LIGHT_THEMES.includes(theme) ? 'light' : 'dark'
  }
  applyNativeTheme(getSettings().theme)
  ctx.handle('settings:set', (_s, patch: Partial<AppSettings>) => {
    const next = setSettings(patch)
    applyNativeTheme(next.theme)
    return next
  })
  ctx.handle('audit:list', (_s, limit?: number) => listAudit(limit))
  ctx.handle('audit:clear', () => clearAudit())

  // ----- tasks -----
  ctx.handle('tasks:list', () => ctx.tasks.list())
  ctx.handle('tasks:cancel', (_s, id: string) => ctx.tasks.cancel(id))
  ctx.handle('tasks:clear', () => ctx.tasks.clearFinished())

  // ----- generic exec (used by snippets & ad-hoc tools) -----
  ctx.handle('exec:run', async (id: string, command: string, opts?: { sudo?: boolean; timeoutMs?: number }) => {
    const ssh = ctx.ssh(id)
    const r = await ssh.exec(command, { sudo: !!opts?.sudo, timeoutMs: opts?.timeoutMs ?? 120000 })
    ctx.audit(id, 'exec', command.slice(0, 200), r.code === 0)
    return r
  })
  ctx.handle('exec:task', async (id: string, title: string, command: string, opts?: { sudo?: boolean }) => {
    const ssh = ctx.ssh(id)
    const { id: taskId } = ctx.tasks.start(title, id, async (h) => {
      const r = await ssh.exec(command, {
        sudo: !!opts?.sudo,
        timeoutMs: 0,
        signal: h.signal,
        onStdout: (c) => h.append(c),
        onStderr: (c) => h.append(c)
      })
      if (r.code !== 0) throw new Error(`exit code ${r.code}`)
    })
    ctx.audit(id, 'task', `${title}: ${command.slice(0, 160)}`)
    return taskId
  })
}
