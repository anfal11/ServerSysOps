export type TunnelStatus = 'up' | 'down' | 'error' | 'starting'

export interface TunnelInfo {
  id: string
  serverId: string
  name: string
  localPort: number
  bindAll: boolean
  remoteHost: string
  remotePort: number
  autoStart: boolean
  status: TunnelStatus
  error?: string
  bytesIn: number
  bytesOut: number
  /** Currently open client connections. */
  connections: number
  totalConnections: number
  createdAt: number
}

export interface TunnelCreate {
  /** 0 = pick a free local port. */
  localPort: number
  remoteHost: string
  remotePort: number
  name?: string
  bindAll?: boolean
  autoStart?: boolean
}
