import { EventEmitter } from 'events'
import type { ConnectionState, ServerProfile } from '@shared/types'
import { SshClient, SshError } from './SshClient'
import { getSecrets, getServer, touchServer } from '../store/servers'
import { getSettings } from '../store/settings'
import { forgetHostKey } from './hostkeys'

/**
 * Keeps one SshClient per server id, tracks connection state and auto-reconnects.
 * Emits 'state' (ConnectionState) on every change.
 */
export class SessionManager extends EventEmitter {
  private clients = new Map<string, SshClient>()
  private states = new Map<string, ConnectionState>()
  private reconnectTimers = new Map<string, NodeJS.Timeout>()
  private manualDisconnect = new Set<string>()
  /** Set by core: asks the user to answer interactive login prompts (2FA codes etc.). */
  askAuth?: (serverId: string, name: string, instructions: string, prompts: { prompt: string; echo: boolean }[], prefilled: (string | null)[]) => Promise<string[] | null>

  getState(serverId: string): ConnectionState {
    return this.states.get(serverId) ?? { serverId, status: 'disconnected' }
  }

  allStates(): ConnectionState[] {
    return [...this.states.values()]
  }

  private setState(serverId: string, patch: Partial<ConnectionState>): void {
    const next: ConnectionState = { ...this.getState(serverId), ...patch, serverId }
    this.states.set(serverId, next)
    this.emit('state', next)
  }

  /** Returns a connected client or throws. */
  get(serverId: string): SshClient {
    const c = this.clients.get(serverId)
    if (!c || !c.connected) throw new SshError('DISCONNECTED', 'Server is not connected')
    return c
  }

  peek(serverId: string): SshClient | undefined {
    return this.clients.get(serverId)
  }

  async connect(serverId: string, opts: { trustNewHostKey?: boolean } = {}): Promise<ConnectionState> {
    const profile = getServer(serverId)
    if (!profile) throw new Error('Server not found')
    this.manualDisconnect.delete(serverId)
    const existing = this.clients.get(serverId)
    if (existing?.connected) return this.getState(serverId)
    if (existing) existing.disconnect()
    if (opts.trustNewHostKey) forgetHostKey(profile.host, profile.port)

    let jump: SshClient | undefined
    if (profile.jumpHostId) {
      await this.connect(profile.jumpHostId)
      jump = this.get(profile.jumpHostId)
    }

    const client = new SshClient(profile, getSecrets(serverId), jump)
    if (this.askAuth) client.promptHandler = (name, instr, prompts, prefilled) => this.askAuth!(serverId, name, instr, prompts, prefilled)
    this.clients.set(serverId, client)
    this.setState(serverId, { status: 'connecting', error: undefined, errorCode: undefined, hostKey: undefined })
    client.on('close', () => this.onClose(serverId, profile))
    client.on('error', () => {
      /* close follows */
    })
    try {
      await client.connect()
      const hk = client.hostKeyVerdict
      touchServer(serverId)
      this.setState(serverId, {
        status: 'connected',
        os: client.os ?? undefined,
        connectedAt: Date.now(),
        hostKey: hk && hk.verdict !== 'trusted' ? { type: '', fingerprint: hk.fingerprint } : undefined
      })
      return this.getState(serverId)
    } catch (e) {
      const err = e as SshError
      const hk = client.hostKeyVerdict
      this.clients.delete(serverId)
      this.setState(serverId, {
        status: 'error',
        error: err.message,
        errorCode: (err.code as ConnectionState['errorCode']) ?? 'UNKNOWN',
        hostKey: hk && hk.verdict === 'changed' ? { type: '', fingerprint: hk.fingerprint, previous: hk.previous } : undefined
      })
      throw e
    }
  }

  private onClose(serverId: string, profile: ServerProfile): void {
    if (this.manualDisconnect.has(serverId)) {
      this.setState(serverId, { status: 'disconnected', os: undefined })
      return
    }
    const settings = getSettings()
    if (!settings.autoReconnect) {
      this.setState(serverId, { status: 'disconnected', error: 'Connection lost' })
      return
    }
    this.setState(serverId, { status: 'reconnecting', error: 'Connection lost, reconnecting…' })
    let attempt = 0
    const tryAgain = (): void => {
      if (this.manualDisconnect.has(serverId)) return
      attempt++
      const delay = Math.min(30000, 2000 * attempt)
      const t = setTimeout(async () => {
        this.reconnectTimers.delete(serverId)
        try {
          await this.connect(serverId)
        } catch (e) {
          const code = (e as SshError).code
          if (code === 'AUTH_FAILED' || code === 'HOST_KEY_CHANGED' || attempt >= 20) {
            return
          }
          this.setState(serverId, { status: 'reconnecting', error: `Reconnecting (attempt ${attempt + 1})…` })
          tryAgain()
        }
      }, delay)
      this.reconnectTimers.set(serverId, t)
    }
    void profile
    tryAgain()
  }

  disconnect(serverId: string): void {
    this.manualDisconnect.add(serverId)
    const t = this.reconnectTimers.get(serverId)
    if (t) clearTimeout(t)
    this.reconnectTimers.delete(serverId)
    const c = this.clients.get(serverId)
    this.clients.delete(serverId)
    if (c) c.disconnect()
    this.setState(serverId, { status: 'disconnected', error: undefined, os: undefined })
  }

  disconnectAll(): void {
    for (const id of [...this.clients.keys()]) this.disconnect(id)
  }

  refreshSecrets(serverId: string): void {
    this.clients.get(serverId)?.updateSecrets(getSecrets(serverId))
  }
}
