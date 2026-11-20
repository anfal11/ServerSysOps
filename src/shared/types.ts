// Shared types between main, preload and renderer.

export type AuthMethod = 'password' | 'key' | 'agent'
export type SudoMode = 'same' | 'separate' | 'none'

export interface ServerProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: AuthMethod
  privateKeyPath?: string
  /** Password / passphrase are stored encrypted (OS safeStorage), never in this object. */
  hasPassword?: boolean
  hasPassphrase?: boolean
  hasSudoPassword?: boolean
  sudoMode: SudoMode
  group?: string
  color?: string
  notes?: string
  jumpHostId?: string
  createdAt: number
  lastConnectedAt?: number
}

export interface ServerSecrets {
  password?: string
  passphrase?: string
  sudoPassword?: string
}

export type ServerProfileInput = Omit<ServerProfile, 'id' | 'createdAt' | 'hasPassword' | 'hasPassphrase' | 'hasSudoPassword'> &
  Partial<Pick<ServerProfile, 'id'>> &
  ServerSecrets

export type PkgManager = 'apt' | 'dnf' | 'yum' | 'zypper' | 'apk' | 'pacman' | 'unknown'

export interface OsInfo {
  id: string
  idLike: string
  prettyName: string
  versionId: string
  kernel: string
  arch: string
  hostname: string
  user: string
  isRoot: boolean
  sudoAvailable: boolean
  sudoPasswordless: boolean
  pkgManager: PkgManager
  hasSystemd: boolean
  homeDir: string
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface ConnectionState {
  serverId: string
  status: ConnectionStatus
  error?: string
  errorCode?: 'HOST_KEY_CHANGED' | 'AUTH_FAILED' | 'SUDO_FAILED' | 'TIMEOUT' | 'NETWORK' | 'UNKNOWN'
  hostKey?: { type: string; fingerprint: string; previous?: string }
  os?: OsInfo
  connectedAt?: number
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  signal?: string
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TaskInfo {
  id: string
  serverId?: string
  title: string
  status: TaskStatus
  log: string
  progress?: number
  startedAt: number
  finishedAt?: number
  error?: string
}

export interface AppSettings {
  /** Colour theme id (see renderer/src/lib/themes.ts). */
  theme: string
  terminalFontSize: number
  terminalFontFamily: string
  terminalScrollback: number
  metricsIntervalMs: number
  confirmDangerous: boolean
  autoReconnect: boolean
  keepAliveIntervalMs: number
  alertsEnabled: boolean
  alertCpuPct: number
  alertMemPct: number
  alertDiskPct: number
  checkForUpdates: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'graphite',
  terminalFontSize: 13,
  terminalFontFamily: 'Cascadia Mono, Consolas, "JetBrains Mono", Menlo, monospace',
  terminalScrollback: 10000,
  metricsIntervalMs: 3000,
  confirmDangerous: true,
  autoReconnect: true,
  keepAliveIntervalMs: 15000,
  alertsEnabled: true,
  alertCpuPct: 90,
  alertMemPct: 90,
  alertDiskPct: 90,
  checkForUpdates: true
}

// ---------- Overview ----------

export interface DiskUsage {
  mount: string
  device: string
  fstype: string
  sizeBytes: number
  usedBytes: number
  availBytes: number
  usePct: number
}

export interface NetInterface {
  name: string
  addresses: string[]
  mac?: string
  state?: string
  rxBytes?: number
  txBytes?: number
}

export interface OverviewSnapshot {
  ts: number
  cpuPct: number
  cpuCount: number
  cpuModel: string
  load: [number, number, number]
  memTotal: number
  memUsed: number
  memAvailable: number
  swapTotal: number
  swapUsed: number
  uptimeSec: number
  processes: number
  sessions: number
  hostname: string
  os: string
  kernel: string
  arch: string
  initSystem: string
  pkgManager: string
  user: string
  disks: DiskUsage[]
  interfaces: NetInterface[]
  ipAddresses: string[]
  sshPort: number
  hostKeyFingerprint?: string
  timezone: string
  ntpSynced: boolean
  rebootRequired: boolean
  netRx: number
  netTx: number
  diskRead: number
  diskWrite: number
}

export interface QuickActionsState {
  sshPort: number
  sshPorts: number[]
  sshSocketActivated: boolean
  permitRootLogin: string
  passwordAuth: boolean
  pubkeyAuth: boolean
  unattendedUpgrades: 'on' | 'off' | 'unavailable'
  fail2ban: { installed: boolean; running: boolean; maxretry?: number; findtime?: string; bantime?: string; ignoreip?: string; bannedCount?: number }
  hostname: string
  timezone: string
  ntp: boolean
  swap: { total: number; swapfile?: string; swapfileSize?: number; otherSwap: string[]; swappiness: number }
  updates: { count: number; security: number; lastChecked?: string; list: string[] }
  rebootRequired: boolean
  pendingReboot?: string
  scheduledShutdown?: string
  firewall: 'none' | 'ufw' | 'firewalld' | 'nftables' | 'iptables'
  clientIp?: string
}

export interface CleanupScan {
  freeBytes: number
  items: { id: string; label: string; description: string; bytes: number; count?: number; checked: boolean }[]
}

// ---------- Files ----------

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtime: number
  mode: number
  modeStr: string
  owner: string
  group: string
  uid: number
  gid: number
  linkTarget?: string
}

// ---------- Terminal ----------

export interface TerminalOpenResult {
  ptyId: string
}

// ---------- Docker ----------

export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
  created: string
  cpuPct?: number
  memUsage?: string
  memPct?: number
}

export interface DockerImage {
  id: string
  repository: string
  tag: string
  size: string
  created: string
  dangling: boolean
}

export interface DockerVolume {
  name: string
  driver: string
  mountpoint: string
  size?: string
}

export interface DockerNetwork {
  id: string
  name: string
  driver: string
  scope: string
}

// ---------- Processes ----------

export interface ProcessInfo {
  pid: number
  ppid: number
  user: string
  cpu: number
  mem: number
  rss: number
  stat: string
  elapsed: string
  command: string
  args: string
}

export interface ServiceInfo {
  name: string
  description: string
  load: string
  active: string
  sub: string
  enabled: string
}

export interface ListeningPort {
  proto: string
  address: string
  port: number
  process: string
  pid?: number
  user?: string
}

// ---------- Users ----------

export interface UserInfo {
  name: string
  uid: number
  gid: number
  home: string
  shell: string
  groups: string[]
  isAdmin: boolean
  locked: boolean
  hasPassword: boolean
  lastLogin?: string
  system: boolean
  sshKeys: number
}

export interface SessionInfo {
  user: string
  tty: string
  from: string
  since: string
  idle?: string
  what?: string
}

// ---------- Cron ----------

export interface CronJob {
  index: number
  schedule: string
  command: string
  comment?: string
  enabled: boolean
  nextRun?: string
  user: string
}

// ---------- Firewall ----------

export interface FirewallRule {
  index: number
  to: string
  action: string
  from: string
  comment?: string
  raw: string
  v6: boolean
}

export interface FirewallState {
  backend: 'ufw' | 'firewalld' | 'none'
  installed: boolean
  active: boolean
  defaultIncoming: string
  defaultOutgoing: string
  rules: FirewallRule[]
  sshPort: number
}

// ---------- Snippets ----------

export interface Snippet {
  id: string
  name: string
  command: string
  description?: string
  sudo: boolean
  tags: string[]
  createdAt: number
}

// ---------- Alerts ----------

export interface AlertEvent {
  id: string
  serverId: string
  serverName: string
  kind: 'cpu' | 'mem' | 'disk' | 'disconnect' | 'reboot-required' | 'updates'
  message: string
  value?: number
  ts: number
  acknowledged: boolean
}

// ---------- Audit log ----------

export interface AuditEntry {
  id: string
  ts: number
  serverId?: string
  serverName?: string
  action: string
  detail?: string
  ok: boolean
}

// ---------- Security audit ----------

export interface SecurityCheck {
  id: string
  title: string
  status: 'pass' | 'warn' | 'fail' | 'info'
  detail: string
  fixAction?: string
  weight: number
}

export interface SecurityReport {
  score: number
  checks: SecurityCheck[]
  ts: number
}

// ---------- Events sent main -> renderer ----------

export type AppEvent =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'task'; task: TaskInfo }
  | { type: 'terminal:data'; ptyId: string; data: string }
  | { type: 'terminal:exit'; ptyId: string; code?: number }
  | { type: 'alert'; alert: AlertEvent }
  | { type: 'transfer'; id: string; name: string; direction: 'upload' | 'download'; done: number; total: number; status: 'running' | 'done' | 'failed'; error?: string }
  | { type: 'update'; status: string; info?: unknown }
