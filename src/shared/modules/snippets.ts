import type { ExecResult } from '../types'

export interface RunResult extends ExecResult {
  ms: number
}

export interface MultiRunResult {
  serverId: string
  serverName: string
  ok: boolean
  code: number
  stdout: string
  stderr: string
  ms: number
  error?: string
}
