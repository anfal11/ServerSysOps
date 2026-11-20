// Types for the Files module (SFTP file manager). Shared between main and renderer.
import type { FileEntry } from '../types'

/** Directory listing row. Extends the base FileEntry with symlink target info. */
export interface FileRow extends FileEntry {
  /** For symlinks: true when the resolved target is a directory (so it can be opened). */
  targetIsDir?: boolean
}

export interface FileListOpts {
  hidden?: boolean
  sudo?: boolean
}

export interface FileReadResult {
  content: string
  size: number
  truncated: boolean
  binary: boolean
  mode: number
}

export interface FileStatResult extends FileRow {
  /** Disk usage in bytes (directories only, when requested). */
  duBytes?: number
}

export interface UsersGroups {
  users: string[]
  groups: string[]
}

export type ArchiveFormat = 'tar.gz' | 'tar.xz' | 'zip'

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'running' | 'done' | 'failed'

export interface TransferInfo {
  id: string
  serverId: string
  name: string
  direction: TransferDirection
  remotePath: string
  localPath: string
  done: number
  total: number
  status: TransferStatus
  error?: string
  startedAt: number
  finishedAt?: number
}

/** Max bytes loaded into the in-app text editor. */
export const FILES_MAX_EDIT_BYTES = 2 * 1024 * 1024
/** Max size of a file uploaded through drag & drop (sent through IPC as a buffer). */
export const FILES_MAX_DROP_BYTES = 50 * 1024 * 1024
/** Max results returned by files:search. */
export const FILES_MAX_SEARCH_RESULTS = 500
