export interface JournalQuery {
  unit?: string
  /** syslog priority 0 (emerg) .. 7 (debug); shows entries with this priority or more important. */
  priority?: number
  /** journalctl --since (e.g. '1 hour ago', '-24h', ISO date). */
  since?: string
  until?: string
  grep?: string
  lines: number
  /** journalctl --boot argument (0 = current, -1 = previous, or boot id). */
  boot?: string
  /** Return entries after this cursor (follow mode). */
  cursorAfter?: string
}

export interface LogEntry {
  ts: number
  unit: string
  priority: number
  pid?: number
  msg: string
  cursor: string
  host?: string
}

export interface JournalResult {
  entries: LogEntry[]
  nextCursor?: string
  truncated: boolean
}

export interface JournalBoot {
  index: number
  id: string
  from: string
  to: string
}

export interface JournalUnits {
  units: string[]
  boots: JournalBoot[]
}

export interface LogFile {
  name: string
  path: string
  dir: string
  size: number
  mtime: number
  binary: boolean
  compressed: boolean
}

export type AuthKind = 'accepted' | 'failed' | 'invalid' | 'disconnect' | 'sudo'

export interface AuthEvent {
  ts: number
  kind: AuthKind
  user?: string
  ip?: string
  method?: string
  msg: string
}

export interface AuthSummary {
  events: AuthEvent[]
  accepted24h: number
  failed24h: number
  topIps: { ip: string; count: number }[]
  source: 'journal' | 'file' | 'none'
}
