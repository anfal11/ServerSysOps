// Types shared by the processes service (main) and the Processes page (renderer).
import type { ProcessInfo, ServiceInfo } from '../types'

export interface ProcListResult {
  processes: ProcessInfo[]
  total: number
  load: [number, number, number]
}

export interface ProcDetail {
  pid: number
  cmdline: string
  cwd: string
  exe: string
  /** Selected fields of /proc/<pid>/status (Name, State, PPid, Uid, Gid, Threads, VmRSS, VmSwap, …). */
  status: Record<string, string>
  openFiles: number
  limits: string[]
  children: { pid: number; name: string }[]
  /** /proc/<pid>/io counters in bytes (rchar, wchar, read_bytes, write_bytes, …). */
  io: Record<string, number>
  cgroup: string
  unit?: string
  nice?: number
  started?: string
  threads?: number
}

export interface SvcListResult {
  systemd: boolean
  services: ServiceInfo[]
  failed: number
}

export interface SvcStatusResult {
  status: string
  logs: string
  activeState: string
}

export type ProcSignal = 'TERM' | 'KILL' | 'STOP' | 'CONT' | 'HUP' | 'INT'
export type SvcAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' | 'mask' | 'unmask'
