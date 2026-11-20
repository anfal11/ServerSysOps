import type { ConnectionStatus } from '../types'

/** Latest sampled values of a connected server (fleet overview). */
export interface ServerSample {
  serverId: string
  serverName: string
  status: ConnectionStatus
  ts: number
  cpuPct: number
  memPct: number
  diskPct: number
  diskMount: string
  load1: number
  nproc: number
  rebootRequired: boolean
  error?: string
}
