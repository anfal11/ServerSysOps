import { createServer, type Server, type Socket } from 'net'
import { randomUUID } from 'crypto'
import type { Ctx } from '../core'
import type { ConnectionState } from '@shared/types'
import type { TunnelCreate, TunnelInfo, TunnelStatus } from '@shared/modules/tunnels'
import { assertPort } from '../ssh/shell'
import type { SshClient } from '../ssh/SshClient'
import { JsonStore } from '../store/jsonStore'

/** Persisted definition (no runtime state). */
interface TunnelDef {
  id: string
  serverId: string
  name: string
  localPort: number
  bindAll: boolean
  remoteHost: string
  remotePort: number
  autoStart: boolean
  createdAt: number
}

interface TunnelsFile {
  tunnels: TunnelDef[]
}

interface Runtime {
  server: Server | null
  status: TunnelStatus
  error?: string
  bytesIn: number
  bytesOut: number
  connections: number
  totalConnections: number
  /** Actual bound port (differs from def.localPort when 0 = auto). */
  boundPort: number
  sockets: Set<Socket>
}

const store = new JsonStore<TunnelsFile>('tunnels.json', { tunnels: [] })
const HOST_RE = /^(\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]+|[A-Za-z0-9]([A-Za-z0-9.\-_]{0,251}[A-Za-z0-9])?)$/

function checkHost(h: unknown): string {
  const s = String(h ?? '').trim()
  if (!s || s.length > 253 || !HOST_RE.test(s)) throw new Error(`Invalid remote host: ${s}`)
  return s.replace(/^\[|\]$/g, '')
}

export function register(ctx: Ctx): void {
  const runtime = new Map<string, Runtime>()

  const defs = (): TunnelDef[] => store.read().tunnels
  const getDef = (id: string): TunnelDef => {
    const d = defs().find((t) => t.id === id)
    if (!d) throw new Error('Tunnel not found')
    return d
  }
  const rt = (id: string): Runtime => {
    let r = runtime.get(id)
    if (!r) {
      r = { server: null, status: 'down', bytesIn: 0, bytesOut: 0, connections: 0, totalConnections: 0, boundPort: 0, sockets: new Set() }
      runtime.set(id, r)
    }
    return r
  }

  const info = (d: TunnelDef): TunnelInfo => {
    const r = rt(d.id)
    return {
      id: d.id,
      serverId: d.serverId,
      name: d.name,
      localPort: r.status === 'up' && r.boundPort ? r.boundPort : d.localPort,
      bindAll: d.bindAll,
      remoteHost: d.remoteHost,
      remotePort: d.remotePort,
      autoStart: d.autoStart,
      status: r.status,
      error: r.error,
      bytesIn: r.bytesIn,
      bytesOut: r.bytesOut,
      connections: r.connections,
      totalConnections: r.totalConnections,
      createdAt: d.createdAt
    }
  }

  const stop = (id: string, status: TunnelStatus = 'down', error?: string): void => {
    const r = rt(id)
    const srv = r.server
    r.server = null
    r.status = status
    r.error = error
    r.connections = 0
    for (const s of r.sockets) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    r.sockets.clear()
    if (srv) {
      try {
        srv.close()
      } catch {
        /* ignore */
      }
    }
  }

  const start = (d: TunnelDef): Promise<TunnelInfo> => {
    const r = rt(d.id)
    if (r.server) return Promise.resolve(info(d))
    // Must be connected to start.
    ctx.ssh(d.serverId)
    r.status = 'starting'
    r.error = undefined
    return new Promise<TunnelInfo>((resolve, reject) => {
      const server = createServer((socket) => {
        const cur = rt(d.id)
        cur.sockets.add(socket)
        cur.connections++
        cur.totalConnections++
        const cleanup = (): void => {
          if (cur.sockets.delete(socket)) cur.connections = Math.max(0, cur.connections - 1)
        }
        socket.on('close', cleanup)
        socket.on('error', () => socket.destroy())
        let ssh: SshClient
        try {
          ssh = ctx.ssh(d.serverId)
        } catch {
          socket.destroy()
          return
        }
        socket.pause()
        ssh
          .forwardOut('127.0.0.1', cur.boundPort || d.localPort, d.remoteHost, d.remotePort)
          .then((channel) => {
            if (socket.destroyed) {
              channel.close()
              return
            }
            socket.on('data', (c: Buffer) => {
              cur.bytesOut += c.length
            })
            channel.on('data', (c: Buffer) => {
              cur.bytesIn += c.length
            })
            channel.on('close', () => socket.destroy())
            channel.on('error', () => socket.destroy())
            socket.on('close', () => {
              try {
                channel.close()
              } catch {
                /* ignore */
              }
            })
            socket.pipe(channel).pipe(socket)
            socket.resume()
          })
          .catch((e: Error) => {
            cur.error = `Remote ${d.remoteHost}:${d.remotePort} refused: ${e.message}`
            socket.destroy()
          })
      })
      server.on('error', (e: NodeJS.ErrnoException) => {
        const cur = rt(d.id)
        const msg = e.code === 'EADDRINUSE' ? `Local port ${d.localPort} is already in use` : e.message
        if (cur.status === 'starting') {
          cur.server = null
          cur.status = 'error'
          cur.error = msg
          reject(new Error(msg))
        } else stop(d.id, 'error', msg)
      })
      server.listen(d.localPort, d.bindAll ? '0.0.0.0' : '127.0.0.1', () => {
        const addr = server.address()
        r.boundPort = typeof addr === 'object' && addr ? addr.port : d.localPort
        r.server = server
        r.status = 'up'
        resolve(info(d))
      })
    })
  }

  // ---- lifecycle: start auto-start tunnels on connect, stop all on disconnect
  const lastStatus = new Map<string, ConnectionState['status']>()
  ctx.sessions.on('state', (st: ConnectionState) => {
    const prev = lastStatus.get(st.serverId)
    lastStatus.set(st.serverId, st.status)
    if (st.status === 'connected' && prev !== 'connected') {
      for (const d of defs().filter((t) => t.serverId === st.serverId && t.autoStart)) {
        start(d).catch(() => {
          /* error stored in runtime */
        })
      }
    } else if (st.status !== 'connected' && prev === 'connected') {
      for (const d of defs().filter((t) => t.serverId === st.serverId)) {
        if (rt(d.id).server) stop(d.id, 'down', 'Server disconnected')
      }
    }
  })

  // ---- handlers
  ctx.handle('tunnels:list', (serverId: string): TunnelInfo[] => defs().filter((t) => !serverId || t.serverId === serverId).map(info))

  ctx.handle('tunnels:create', async (serverId: string, input: TunnelCreate): Promise<TunnelInfo> => {
    if (!serverId) throw new Error('Server id required')
    const localPort = Number(input.localPort) === 0 ? 0 : assertPort(Number(input.localPort))
    const remotePort = assertPort(Number(input.remotePort))
    const remoteHost = checkHost(input.remoteHost)
    const name = String(input.name ?? '').trim().slice(0, 80) || `${remoteHost}:${remotePort}`
    const d: TunnelDef = { id: randomUUID(), serverId, name, localPort, bindAll: !!input.bindAll, remoteHost, remotePort, autoStart: input.autoStart ?? true, createdAt: Date.now() }
    store.update((f) => ({ tunnels: [...f.tunnels, d] }))
    try {
      const i = await start(d)
      // Persist the auto-picked port so the tunnel keeps the same address next time.
      if (localPort === 0 && i.localPort) store.update((f) => ({ tunnels: f.tunnels.map((t) => (t.id === d.id ? { ...t, localPort: i.localPort } : t)) }))
      ctx.audit(serverId, 'tunnel.create', `${name}: 127.0.0.1:${i.localPort} -> ${remoteHost}:${remotePort}`)
      return info(getDef(d.id))
    } catch (e) {
      ctx.audit(serverId, 'tunnel.create', `${name}: ${(e as Error).message}`, false)
      return info(d)
    }
  })

  ctx.handle('tunnels:start', async (_s: string, id: string): Promise<TunnelInfo> => {
    const d = getDef(String(id))
    try {
      return await start(d)
    } catch (e) {
      throw new Error((e as Error).message)
    }
  })

  ctx.handle('tunnels:close', (_s: string, id: string): TunnelInfo => {
    const d = getDef(String(id))
    stop(d.id)
    return info(d)
  })

  ctx.handle('tunnels:delete', (_s: string, id: string) => {
    const d = getDef(String(id))
    stop(d.id)
    runtime.delete(d.id)
    store.update((f) => ({ tunnels: f.tunnels.filter((t) => t.id !== d.id) }))
    ctx.audit(d.serverId, 'tunnel.delete', d.name)
  })

  ctx.handle('tunnels:setAutoStart', (_s: string, id: string, on: boolean): TunnelInfo => {
    const d = getDef(String(id))
    store.update((f) => ({ tunnels: f.tunnels.map((t) => (t.id === d.id ? { ...t, autoStart: !!on } : t)) }))
    return info(getDef(d.id))
  })

  ctx.handle('tunnels:rename', (_s: string, id: string, name: string): TunnelInfo => {
    const d = getDef(String(id))
    const n = String(name ?? '').trim().slice(0, 80)
    if (!n) throw new Error('Name required')
    store.update((f) => ({ tunnels: f.tunnels.map((t) => (t.id === d.id ? { ...t, name: n } : t)) }))
    return info(getDef(d.id))
  })
}
