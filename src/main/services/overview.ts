import type { Ctx } from '../core'
import type { DiskUsage, NetInterface, OverviewSnapshot } from '@shared/types'

interface CpuSample {
  idle: number
  total: number
  ts: number
  netRx: number
  netTx: number
  diskRead: number
  diskWrite: number
}

const SNAPSHOT_SCRIPT = `
echo "__CPU"; head -1 /proc/stat
echo "__NPROC"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo "__MODEL"; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//'
echo "__LOAD"; cat /proc/loadavg
echo "__MEM"; grep -E '^(MemTotal|MemAvailable|MemFree|SwapTotal|SwapFree|Buffers|Cached)' /proc/meminfo
echo "__UPTIME"; cat /proc/uptime
echo "__PROCS"; ls -d /proc/[0-9]* 2>/dev/null | wc -l
echo "__SESS"; who 2>/dev/null | wc -l
echo "__HOST"; hostname
echo "__OS"; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
echo "__KERNEL"; uname -r
echo "__ARCH"; uname -m
echo "__INIT"; if [ -d /run/systemd/system ]; then echo systemd; else ps -p 1 -o comm= 2>/dev/null; fi
echo "__PKG"; for p in apt dnf yum zypper apk pacman; do command -v $p >/dev/null 2>&1 && { echo $p; break; }; done
echo "__USER"; id -un
echo "__DF"; df -PB1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | tail -n +2
echo "__DFT"; df -PT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | tail -n +2 | awk '{print $1" "$2" "$7}'
echo "__IP"; ip -o addr show 2>/dev/null | awk '{print $2" "$3" "$4}'
echo "__LINK"; ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | while read i; do st=$(cat /sys/class/net/$i/operstate 2>/dev/null); mac=$(cat /sys/class/net/$i/address 2>/dev/null); echo "$i $st $mac"; done
echo "__NET"; cat /proc/net/dev | tail -n +3
echo "__DISKIO"; cat /proc/diskstats 2>/dev/null | awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|nvme[0-9]+n[0-9]+|xvd[a-z]+|mmcblk[0-9]+)$/ {r+=$6; w+=$10} END {print r*512" "w*512}'
echo "__SSHPORT"; (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -E 'sshd|systemd' | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\\n' ' '
echo "__SSHCFG"; (sshd -T 2>/dev/null | grep -i '^port ' | awk '{print $2}') || grep -iE '^\\s*Port\\s' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}'
echo "__HOSTKEY"; for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do [ -f "$f" ] && { ssh-keygen -lf "$f" 2>/dev/null | awk '{print $2}'; break; }; done
echo "__TZ"; timedatectl show -p Timezone -p NTPSynchronized --value 2>/dev/null || (cat /etc/timezone 2>/dev/null; echo unknown)
echo "__REBOOT"; [ -f /var/run/reboot-required ] && echo yes || echo no
echo "__END"
`

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

function num(s: string | undefined): number {
  const n = parseFloat(s ?? '')
  return Number.isFinite(n) ? n : 0
}

export function register(ctx: Ctx): void {
  const prev = new Map<string, CpuSample>()

  ctx.handle('overview:snapshot', async (serverId: string): Promise<OverviewSnapshot> => {
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(SNAPSHOT_SCRIPT, { timeoutMs: 30000 })
    const s = sections(r.stdout)
    const now = Date.now()

    // CPU
    const cpuParts = (s.CPU?.[0] ?? '').trim().split(/\s+/).slice(1).map(Number)
    const idle = (cpuParts[3] ?? 0) + (cpuParts[4] ?? 0)
    const total = cpuParts.reduce((a, b) => a + (b || 0), 0)

    // net totals
    let netRxTotal = 0
    let netTxTotal = 0
    const ifaceStats = new Map<string, { rx: number; tx: number }>()
    for (const line of s.NET ?? []) {
      const m = line.trim().match(/^([^:]+):\s*(.*)$/)
      if (!m) continue
      const f = m[2].trim().split(/\s+/).map(Number)
      const rx = f[0] ?? 0
      const tx = f[8] ?? 0
      ifaceStats.set(m[1], { rx, tx })
      if (m[1] !== 'lo') {
        netRxTotal += rx
        netTxTotal += tx
      }
    }
    const [dr, dw] = (s.DISKIO?.[0] ?? '0 0').trim().split(/\s+/).map(Number)

    const p = prev.get(serverId)
    let cpuPct = 0
    let netRx = 0
    let netTx = 0
    let diskRead = 0
    let diskWrite = 0
    if (p) {
      const dIdle = idle - p.idle
      const dTotal = total - p.total
      cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0
      const dt = Math.max(0.5, (now - p.ts) / 1000)
      netRx = Math.max(0, (netRxTotal - p.netRx) / dt)
      netTx = Math.max(0, (netTxTotal - p.netTx) / dt)
      diskRead = Math.max(0, ((dr || 0) - p.diskRead) / dt)
      diskWrite = Math.max(0, ((dw || 0) - p.diskWrite) / dt)
    }
    prev.set(serverId, { idle, total, ts: now, netRx: netRxTotal, netTx: netTxTotal, diskRead: dr || 0, diskWrite: dw || 0 })

    // memory
    const mem: Record<string, number> = {}
    for (const line of s.MEM ?? []) {
      const m = line.match(/^(\w+):\s+(\d+)/)
      if (m) mem[m[1]] = Number(m[2]) * 1024
    }
    const memTotal = mem.MemTotal ?? 0
    const memAvailable = mem.MemAvailable ?? mem.MemFree ?? 0
    const swapTotal = mem.SwapTotal ?? 0
    const swapUsed = swapTotal - (mem.SwapFree ?? 0)

    // disks
    const fstypes = new Map<string, string>()
    for (const line of s.DFT ?? []) {
      const [dev, type] = line.trim().split(/\s+/)
      if (dev) fstypes.set(dev, type)
    }
    const disks: DiskUsage[] = []
    for (const line of s.DF ?? []) {
      const f = line.trim().split(/\s+/)
      if (f.length < 6) continue
      const mount = f.slice(5).join(' ')
      if (/^\/(snap|boot\/efi|run|dev|sys|proc)(\/|$)/.test(mount) && mount !== '/boot') continue
      disks.push({
        device: f[0],
        fstype: fstypes.get(f[0]) ?? '',
        sizeBytes: num(f[1]),
        usedBytes: num(f[2]),
        availBytes: num(f[3]),
        usePct: num(f[4]),
        mount
      })
    }

    // interfaces
    const ifaces = new Map<string, NetInterface>()
    for (const line of s.LINK ?? []) {
      const [name, state, mac] = line.trim().split(/\s+/)
      if (!name) continue
      const n = name.replace(/@.*$/, '')
      ifaces.set(n, { name: n, addresses: [], state, mac, rxBytes: ifaceStats.get(n)?.rx, txBytes: ifaceStats.get(n)?.tx })
    }
    const ipAddresses: string[] = []
    for (const line of s.IP ?? []) {
      const [name, fam, addr] = line.trim().split(/\s+/)
      if (!name || !addr) continue
      const n = name.replace(/@.*$/, '')
      const entry = ifaces.get(n) ?? { name: n, addresses: [] }
      entry.addresses.push(addr)
      ifaces.set(n, entry)
      const ip = addr.split('/')[0]
      if (n !== 'lo' && !/^(fe80:|127\.)/.test(ip) && (fam === 'inet' || fam === 'inet6')) ipAddresses.push(ip)
    }

    const sshPorts = (s.SSHPORT?.[0] ?? '').trim().split(/\s+/).map(Number).filter((n) => n > 0)
    const cfgPort = num(s.SSHCFG?.[0])
    const sshPort = cfgPort || sshPorts[0] || 22
    const tzLines = (s.TZ ?? []).map((l) => l.trim()).filter(Boolean)
    const load = (s.LOAD?.[0] ?? '0 0 0').trim().split(/\s+/).slice(0, 3).map(Number) as [number, number, number]

    return {
      ts: now,
      cpuPct: Math.round(cpuPct * 10) / 10,
      cpuCount: num(s.NPROC?.[0]) || 1,
      cpuModel: (s.MODEL?.[0] ?? '').trim(),
      load,
      memTotal,
      memUsed: memTotal - memAvailable,
      memAvailable,
      swapTotal,
      swapUsed,
      uptimeSec: num(s.UPTIME?.[0]?.split(' ')[0]),
      processes: num(s.PROCS?.[0]),
      sessions: num(s.SESS?.[0]),
      hostname: (s.HOST?.[0] ?? '').trim(),
      os: (s.OS?.[0] ?? 'Linux').trim(),
      kernel: (s.KERNEL?.[0] ?? '').trim(),
      arch: (s.ARCH?.[0] ?? '').trim(),
      initSystem: (s.INIT?.[0] ?? '').trim(),
      pkgManager: (s.PKG?.[0] ?? '').trim(),
      user: (s.USER?.[0] ?? '').trim(),
      disks,
      interfaces: [...ifaces.values()],
      ipAddresses,
      sshPort,
      hostKeyFingerprint: (s.HOSTKEY?.[0] ?? '').trim() || undefined,
      timezone: tzLines[0] ?? 'unknown',
      ntpSynced: tzLines[1] === 'yes',
      rebootRequired: (s.REBOOT?.[0] ?? '').trim() === 'yes',
      netRx,
      netTx,
      diskRead,
      diskWrite
    }
  })
}
