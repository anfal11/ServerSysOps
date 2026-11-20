import type { AppEvent } from '@shared/types'

export class ApiError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

/**
 * Typed wrapper around the IPC bridge. Throws ApiError when the main process reports a failure.
 *   await api.call<OverviewSnapshot>('overview:snapshot', serverId)
 */
export const api = {
  async call<T = unknown>(channel: string, serverId: string, ...args: unknown[]): Promise<T> {
    const r = await window.api.invoke<T>(channel, serverId, ...args)
    if (!r.ok) throw new ApiError(r.error ?? 'Unknown error', r.code)
    return r.data as T
  },
  /** Global handlers that do not need a server id. */
  async global<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return api.call<T>(channel, '', ...args)
  },
  onEvent(cb: (e: AppEvent) => void): () => void {
    return window.api.onEvent(cb)
  },
  openExternal(url: string): void {
    window.api.openExternal(url)
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
