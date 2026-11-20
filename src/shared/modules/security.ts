import type { SecurityReport } from '../types'

/** Extended audit report with a few extra facts the page needs for "Fix" actions. */
export interface SecurityReportEx extends SecurityReport {
  hostname: string
  sshPort: number
  pkgManager: string
  durationMs: number
}

export interface SecurityHistoryEntry {
  ts: number
  score: number
  failed: number
  warnings: number
}
