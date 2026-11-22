// Types shared by the cron service (main) and the Cron page (renderer).
import type { CronJob } from '../types'

export interface CronVariable {
  key: string
  value: string
}

export interface CronStatus {
  /** `crontab` binary found on the server. */
  installed: boolean
  /** cron / crond daemon is running. */
  cronActive: boolean
  /** Numeric UTC offset as printed by `date +%z`, e.g. "+0600". */
  serverTz: string
  /** Zone abbreviation as printed by `date +%Z`, e.g. "UTC" or "+06". */
  serverTzName: string
  /** Server clock at the time of the call (ISO-8601, UTC). */
  serverNow: string
  /** Login user first, then root and regular users with a usable shell. */
  users: string[]
  loginUser: string
  isRoot: boolean
  sudoAvailable: boolean
}

export interface CronListResult {
  jobs: CronJob[]
  variables: CronVariable[]
  raw: string
}

export interface CronSaveInput {
  jobs: Pick<CronJob, 'schedule' | 'command' | 'comment' | 'enabled'>[]
  variables: CronVariable[]
}

export interface CronSystemFile {
  name: string
  path: string
  executable: boolean
  size: number
}

export interface CronSystemDir {
  dir: string
  exists: boolean
  files: CronSystemFile[]
}

export interface CronSystemResult {
  crontab: { path: string; exists: boolean; lines: number; jobs: number; preview: string }
  dirs: CronSystemDir[]
}

export interface SystemdTimer {
  next: string
  left: string
  last: string
  passed: string
  unit: string
  activates: string
}

/** Marker written on the line above a disabled job so plain comments are never mistaken for jobs. */
export const CRON_DISABLED_MARKER = '# serversysops:disabled'

export const CRON_ALIASES = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'] as const

/** Loose structural check of a cron schedule (5 fields or an @alias). Real validation is done by `crontab -`. */
export function looksLikeCronSchedule(s: string): boolean {
  const t = s.trim()
  if ((CRON_ALIASES as readonly string[]).includes(t.toLowerCase())) return true
  const parts = t.split(/\s+/)
  if (parts.length !== 5) return false
  const field = /^(\*|\?|[A-Za-z0-9]+(-[A-Za-z0-9]+)?)(\/\d+)?(,(\*|[A-Za-z0-9]+(-[A-Za-z0-9]+)?)(\/\d+)?)*$/
  return parts.every((p) => field.test(p))
}

/** Strict numeric-only check used to recognise commented-out jobs that lack our marker. */
export function isStrictNumericCronSchedule(s: string): boolean {
  const parts = s.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const field = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
  return parts.every((p) => field.test(p))
}
