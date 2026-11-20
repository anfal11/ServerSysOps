import type { Ctx } from '../core'
import { SshClient } from './SshClient'
import { getSecrets, getServer } from '../store/servers'

/**
 * Open a second SSH connection with the same credentials (through the jump host when one is
 * configured) to prove the app is not locked out after an sshd / firewall change.
 */
export async function probeLogin(ctx: Ctx, serverId: string, port: number): Promise<boolean> {
  const profile = getServer(serverId)
  if (!profile) return false
  const jump = profile.jumpHostId ? ctx.sessions.peek(profile.jumpHostId) : undefined
  const c = new SshClient({ ...profile, port }, getSecrets(serverId), jump?.connected ? jump : undefined)
  try {
    await c.connect()
    const r = await c.exec('echo ok', { timeoutMs: 10000 })
    c.disconnect()
    return r.stdout.includes('ok')
  } catch {
    try {
      c.disconnect()
    } catch {
      /* ignore */
    }
    return false
  }
}
