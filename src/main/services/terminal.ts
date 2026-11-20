import { randomUUID } from 'crypto'
import type { ClientChannel } from 'ssh2'
import type { Ctx } from '../core'

interface Pty {
  serverId: string
  stream: ClientChannel
}

export function register(ctx: Ctx): void {
  const ptys = new Map<string, Pty>()

  ctx.handle('terminal:open', async (serverId: string, opts: { cols: number; rows: number; command?: string }) => {
    const ssh = ctx.ssh(serverId)
    const stream = await ssh.shell(opts.cols || 80, opts.rows || 24)
    const ptyId = randomUUID()
    ptys.set(ptyId, { serverId, stream })
    stream.on('data', (d: Buffer) => ctx.emit({ type: 'terminal:data', ptyId, data: d.toString('utf8') }))
    stream.stderr.on('data', (d: Buffer) => ctx.emit({ type: 'terminal:data', ptyId, data: d.toString('utf8') }))
    stream.on('close', () => {
      ptys.delete(ptyId)
      ctx.emit({ type: 'terminal:exit', ptyId })
    })
    if (opts.command) stream.write(opts.command + '\n')
    return { ptyId }
  })

  ctx.handle('terminal:write', (_s, ptyId: string, data: string) => {
    ptys.get(ptyId)?.stream.write(data)
  })

  ctx.handle('terminal:resize', (_s, ptyId: string, cols: number, rows: number) => {
    ptys.get(ptyId)?.stream.setWindow(rows, cols, 0, 0)
  })

  ctx.handle('terminal:close', (_s, ptyId: string) => {
    const p = ptys.get(ptyId)
    if (p) {
      try {
        p.stream.close()
      } catch {
        /* ignore */
      }
      ptys.delete(ptyId)
    }
  })

  ctx.sessions.on('state', (st) => {
    if (st.status !== 'connected') {
      for (const [id, p] of ptys) {
        if (p.serverId === st.serverId) {
          ptys.delete(id)
          ctx.emit({ type: 'terminal:exit', ptyId: id })
        }
      }
    }
  })
}
