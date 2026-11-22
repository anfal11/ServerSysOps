// Extra types for the Users module (shared between main and renderer).
// UserInfo and SessionInfo live in @shared/types.

import type { SessionInfo, UserInfo } from '../types'

export interface UserInfoEx extends UserInfo {
  fullName?: string
  /** Direct sudoers entry (not only via group). */
  sudoers: boolean
  /** Password login disabled through the ServerSysOps sshd Match block. */
  keyOnly: boolean
  /** Account expiry date is in the past (blocks every login method). */
  accountExpired: boolean
  /** This is the account ServerSysOps is logged in with. */
  self: boolean
}

export interface SessionInfoEx extends SessionInfo {
  pid?: number
  /** Probably the session of this app (same user and client IP). */
  self: boolean
}

export interface CreateUserInput {
  name: string
  password?: string
  fullName?: string
  shell: string
  sudo: boolean
  createHome: boolean
  /** Public key text (one or more lines) to seed ~/.ssh/authorized_keys. */
  sshKey?: string
  passwordlessSudo: boolean
  /** Force a password change at first login (chage -d 0). */
  expirePassword: boolean
}

export interface SshKeyInfo {
  /** 0-based line index in authorized_keys (counting every line, including comments). */
  line: number
  type: string
  bits?: number
  fingerprint: string
  comment: string
  /** Options prefix (e.g. `from="1.2.3.4",no-pty`), when present. */
  options?: string
  raw: string
}

export interface LastLoginEntry {
  user: string
  tty: string
  from: string
  start: string
  end?: string
  duration?: string
  stillLoggedIn: boolean
}

export interface LastLoginsResult {
  entries: LastLoginEntry[]
  /** Number of failed logins recorded by lastb (undefined when btmp is unreadable). */
  failedCount?: number
  failedRecent: LastLoginEntry[]
  wtmpSince?: string
}

export interface GroupInfo {
  name: string
  gid: number
  members: string[]
  system: boolean
}

export interface DeleteUserOptions {
  removeHome: boolean
  backupHome: boolean
}

export interface LockOptions {
  terminateSessions?: boolean
}
