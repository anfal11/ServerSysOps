import { Notification } from 'electron'
import type { Ctx } from '../core'
import { appIcon } from '../branding'
import type { AlertEvent, ConnectionState } from '@shared/types'
import type { ServerSample } from '@shared/modules/alerts'
import { ackAlerts, addAlert, clearAlerts, getSettings, listAlerts } from '../store/settings'
import { getServer } from '../store/servers'

const POLL_MS = 30000
const COOLDOWN_MS = 15 * 60 * 1000

const SAMPLE_SCRIPT = `
echo __CPU1; head -1 /proc/stat
sleep 0.5
echo __CPU2; head -1 /proc/stat
echo __MEM; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached)' /proc/meminfo
echo __DF; df -P -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x iso9660 2>/dev/null | tail -n +2 | awk '{print $5" "$6}'
echo __LOAD; cat /proc/loadavg
echo __NPROC; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo __REBOOT; [ -f /var/run/reboot-required ] && echo yes || echo no
echo __END`

function sections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {}
  let cur = ''
  for (const line of out.split('\n')) {
    const m = line.match(/^__([A-Z0-9]+)$/)
    if (m) {
      cur = m[1]
      res[cur] = []
      continue
    }
    if (cur) res[cur].push(line)
  }
  return res
}

function cpuFrom(line: string | undefined): { idle: number; total: number } {
  const p = (line ?? '').trim().split(/\s+/).slice(1).map(Number)
  const idle = (p[3] ?? 0) + (p[4] ?? 0)
  const total = p.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  return { idle, total }
}

export function register(ctx: Ctx): void {
  const samples = new Map<string, ServerSample>()
  const lastAlert = new Map<string, number>()
  const rebootAlerted = new Set<string>()
  const lastStatus = new Map<string, ConnectionState['status']>()
  let polling = false

  const notify = (alert: AlertEvent): void => {
    try {
      if (Notification.isSupported()) new Notification({ title: `${alert.serverName}: ${alert.kind === 'disconnect' ? 'connection lost' : alert.kind === 'reboot-required' ? 'reboot required' : `${alert.kind} alert`}`, body: alert.message, silent: false, icon: appIcon() }).show()
    } catch {
      /* notifications unavailable */
    }
  }

  const raise = (serverId: string, kind: AlertEvent['kind'], message: string, value?: number, cooldownKey: string = kind): boolean => {
    const key = `${serverId}|${cooldownKey}`
    const now = Date.now()
    const last = lastAlert.get(key) ?? 0
    if (now - last < COOLDOWN_MS) return false
    lastAlert.set(key, now)
    const alert = addAlert({ serverId, serverName: getServer(serverId)?.name ?? serverId, kind, message, value })
    ctx.emit({ type: 'alert', alert })
    notify(alert)
    return true
  }

  /** Sample one connected server and raise threshold alerts. */
  const check = async (serverId: string): Promise<ServerSample> => {
    const settings = getSettings()
    const name = getServer(serverId)?.name ?? serverId
    const state = ctx.sessions.getState(serverId)
    try {
      const ssh = ctx.ssh(serverId)
      const r = await ssh.exec(SAMPLE_SCRIPT, { timeoutMs: 20000 })
      const s = sections(r.stdout)
      const c1 = cpuFrom(s.CPU1?.[0])
      const c2 = cpuFrom(s.CPU2?.[0])
      const dTotal = c2.total - c1.total
      const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - (c2.idle - c1.idle) / dTotal) * 100)) : 0
      const mem: Record<string, number> = {}
      for (const l of s.MEM ?? []) {
        const m = l.match(/^(\w+):\s+(\d+)/)
        if (m) mem[m[1]] = Number(m[2])
      }
      const memTotal = mem.MemTotal ?? 0
      const memAvail = mem.MemAvailable ?? (mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0)
      const memPct = memTotal ? Math.max(0, Math.min(100, ((memTotal - memAvail) / memTotal) * 100)) : 0
      let diskPct = 0
      let diskMount = '/'
      const fullMounts: { pct: number; mount: string }[] = []
      for (const l of s.DF ?? []) {
        const [pct, mount] = l.trim().split(/\s+/)
        const v = Number((pct ?? '').replace('%', ''))
        if (!mount || !Number.isFinite(v)) continue
        if (/^\/(boot|snap|run|dev|sys|proc)(\/|$)/.test(mount)) continue
        if (v > diskPct) {
          diskPct = v
          diskMount = mount
        }
        if (v >= settings.alertDiskPct) fullMounts.push({ pct: v, mount })
      }
      const load1 = Number((s.LOAD?.[0] ?? '').trim().split(/\s+/)[0]) || 0
      const nproc = Number((s.NPROC?.[0] ?? '1').trim()) || 1
      const rebootRequired = (s.REBOOT?.[0] ?? 'no').trim() === 'yes'
      const sample: ServerSample = { serverId, serverName: name, status: state.status, ts: Date.now(), cpuPct, memPct, diskPct, diskMount, load1, nproc, rebootRequired }
      samples.set(serverId, sample)

      if (settings.alertsEnabled) {
        if (cpuPct >= settings.alertCpuPct) raise(serverId, 'cpu', `CPU usage ${cpuPct.toFixed(0)}% (threshold ${settings.alertCpuPct}%, load ${load1.toFixed(2)} on ${nproc} core${nproc === 1 ? '' : 's'})`, cpuPct)
        if (memPct >= settings.alertMemPct) raise(serverId, 'mem', `Memory usage ${memPct.toFixed(0)}% (threshold ${settings.alertMemPct}%)`, memPct)
        for (const d of fullMounts) raise(serverId, 'disk', `Disk ${d.mount} is ${d.pct}% full (threshold ${settings.alertDiskPct}%)`, d.pct, `disk|${d.mount}`)
        const connKey = `${serverId}|${state.connectedAt ?? 0}`
        if (rebootRequired && !rebootAlerted.has(connKey)) {
          rebootAlerted.add(connKey)
          raise(serverId, 'reboot-required', 'A reboot is required to finish installing updates', undefined, 'reboot-required')
        }
      }
      return sample
    } catch (e) {
      const sample: ServerSample = { serverId, serverName: name, status: state.status, ts: Date.now(), cpuPct: 0, memPct: 0, diskPct: 0, diskMount: '/', load1: 0, nproc: 0, rebootRequired: false, error: (e as Error).message }
      samples.set(serverId, sample)
      return sample
    }
  }

  const poll = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      const connected = ctx.sessions.allStates().filter((s) => s.status === 'connected')
      // Drop samples of servers that are no longer connected.
      for (const id of [...samples.keys()]) if (!connected.some((s) => s.serverId === id)) samples.delete(id)
      await Promise.allSettled(connected.map((s) => check(s.serverId)))
    } finally {
      polling = false
    }
  }
  const timer = setInterval(() => void poll(), POLL_MS)
  timer.unref?.()

  // Disconnect alerts: connected -> reconnecting/error (not a manual disconnect).
  ctx.sessions.on('state', (st: ConnectionState) => {
    const prev = lastStatus.get(st.serverId)
    lastStatus.set(st.serverId, st.status)
    if (prev === 'connected' && (st.status === 'reconnecting' || st.status === 'error')) {
      if (getSettings().alertsEnabled) raise(st.serverId, 'disconnect', st.error ? `Connection lost: ${st.error}` : 'Connection lost unexpectedly', undefined, 'disconnect')
      samples.delete(st.serverId)
    }
    if (st.status === 'connected' && prev !== 'connected') {
      // First sample shortly after connecting so the fleet view fills quickly.
      setTimeout(() => void check(st.serverId).catch(() => {}), 3000)
    }
    if (st.status === 'disconnected') samples.delete(st.serverId)
  })

  // ---- handlers
  ctx.handle('alerts:list', (): AlertEvent[] => listAlerts())
  ctx.handle('alerts:ack', (_s: string, ids?: string[]) => {
    ackAlerts(Array.isArray(ids) ? ids.map(String) : undefined)
    return listAlerts()
  })
  ctx.handle('alerts:clear', () => {
    clearAlerts()
  })
  ctx.handle('alerts:test', async (serverId: string): Promise<ServerSample> => {
    if (!serverId) throw new Error('Server id required')
    // Bypass the cooldown for an explicit test so the user sees the result.
    for (const k of [...lastAlert.keys()]) if (k.startsWith(`${serverId}|`)) lastAlert.delete(k)
    return check(serverId)
  })
  ctx.handle('alerts:snapshot', (): ServerSample[] => {
    const connected = ctx.sessions.allStates().filter((s) => s.status === 'connected')
    return connected.map((s) => samples.get(s.serverId) ?? { serverId: s.serverId, serverName: getServer(s.serverId)?.name ?? s.serverId, status: s.status, ts: 0, cpuPct: 0, memPct: 0, diskPct: 0, diskMount: '/', load1: 0, nproc: 0, rebootRequired: false })
  })
}
