import { dialog } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import type { Ctx } from '../core'
import type { Snippet } from '@shared/types'
import type { MultiRunResult, RunResult } from '@shared/modules/snippets'
import { deleteSnippet, listSnippets, saveSnippet } from '../store/settings'
import { getServer } from '../store/servers'

const MAX_CMD = 20000
const RUN_TIMEOUT = 300000

function checkCommand(cmd: unknown): string {
  if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('Command is empty')
  if (cmd.length > MAX_CMD) throw new Error('Command is too long')
  if (cmd.includes('\0')) throw new Error('Invalid command')
  return cmd
}

function checkSnippetInput(s: Partial<Snippet>): Omit<Snippet, 'id' | 'createdAt'> & { id?: string } {
  if (!s || typeof s !== 'object') throw new Error('Invalid snippet')
  const name = String(s.name ?? '').trim()
  if (!name || name.length > 120) throw new Error('Snippet name is required (max 120 characters)')
  const command = checkCommand(s.command)
  const tags = Array.isArray(s.tags) ? s.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20) : []
  return { id: s.id ? String(s.id) : undefined, name, command, description: s.description ? String(s.description).slice(0, 500) : undefined, sudo: !!s.sudo, tags: [...new Set(tags)] }
}

export function register(ctx: Ctx): void {
  ctx.handle('snippets:list', (): Snippet[] => listSnippets())

  ctx.handle('snippets:save', (_s: string, snippet: Partial<Snippet>): Snippet => saveSnippet(checkSnippetInput(snippet)))

  ctx.handle('snippets:delete', (_s: string, id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid snippet id')
    deleteSnippet(id)
  })

  /** Run a saved snippet (by id) or an ad-hoc command on one server. */
  ctx.handle('snippets:run', async (serverId: string, what: string | { command: string; sudo?: boolean }): Promise<RunResult> => {
    const ssh = ctx.ssh(serverId)
    let command: string
    let sudo: boolean
    let label: string
    if (typeof what === 'string') {
      const sn = listSnippets().find((s) => s.id === what)
      if (!sn) throw new Error('Snippet not found')
      command = sn.command
      sudo = sn.sudo
      label = `snippet "${sn.name}"`
    } else {
      command = checkCommand(what?.command)
      sudo = !!what?.sudo
      label = command.slice(0, 200)
    }
    const t0 = Date.now()
    const r = await ssh.exec(command, { sudo, timeoutMs: RUN_TIMEOUT })
    ctx.audit(serverId, 'snippet.run', label, r.code === 0)
    return { ...r, ms: Date.now() - t0 }
  })

  /** Run one command on many connected servers in parallel. */
  ctx.handle('snippets:runMany', async (_s: string, opts: { serverIds: string[]; command: string; sudo?: boolean }): Promise<MultiRunResult[]> => {
    if (!opts || !Array.isArray(opts.serverIds) || opts.serverIds.length === 0) throw new Error('No servers selected')
    const command = checkCommand(opts.command)
    const sudo = !!opts.sudo
    const ids = [...new Set(opts.serverIds.map(String))].slice(0, 100)
    const results = await Promise.allSettled(
      ids.map(async (serverId): Promise<MultiRunResult> => {
        const name = getServer(serverId)?.name ?? serverId
        const t0 = Date.now()
        try {
          const ssh = ctx.ssh(serverId)
          const r = await ssh.exec(command, { sudo, timeoutMs: RUN_TIMEOUT })
          ctx.audit(serverId, 'snippet.runMany', command.slice(0, 200), r.code === 0)
          return { serverId, serverName: name, ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 }
        } catch (e) {
          const msg = (e as Error).message
          ctx.audit(serverId, 'snippet.runMany', command.slice(0, 200), false)
          return { serverId, serverName: name, ok: false, code: -1, stdout: '', stderr: '', ms: Date.now() - t0, error: msg }
        }
      })
    )
    return results.map((r, i) => (r.status === 'fulfilled' ? r.value : { serverId: ids[i], serverName: getServer(ids[i])?.name ?? ids[i], ok: false, code: -1, stdout: '', stderr: '', ms: 0, error: String(r.reason) }))
  })

  ctx.handle('snippets:export', async (): Promise<boolean> => {
    const r = await dialog.showSaveDialog({ defaultPath: 'snippets.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, JSON.stringify(listSnippets(), null, 2))
    return true
  })

  ctx.handle('snippets:import', async (): Promise<number> => {
    const r = await dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return 0
    const raw = readFileSync(r.filePaths[0], 'utf8')
    if (raw.length > 5 * 1024 * 1024) throw new Error('File too large')
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : (parsed as { snippets?: unknown[] })?.snippets
    if (!Array.isArray(list)) throw new Error('Not a snippets export')
    const existing = new Set(listSnippets().map((s) => s.id))
    let n = 0
    for (const item of list) {
      try {
        const input = checkSnippetInput(item as Partial<Snippet>)
        // Keep the id only when it does not clash with an existing snippet.
        saveSnippet({ ...input, id: input.id && !existing.has(input.id) ? input.id : undefined })
        n++
      } catch {
        /* skip invalid entry */
      }
    }
    return n
  })
}
