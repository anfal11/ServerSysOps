// Extra Docker module types (DockerContainer/DockerImage/DockerVolume/DockerNetwork live in ../types).

export interface DockerInfo {
  installed: boolean
  running: boolean
  version?: string
  composeVersion?: string
  /** Login user is a member of the "docker" group (or is root). */
  userInGroup: boolean
  /** Docker commands must be run through sudo on this server. */
  needsSudo: boolean
  rootless?: boolean
  /** systemd unit state, when systemd is present. */
  serviceActive?: string
  serviceEnabled?: string
  hasSystemd: boolean
  info?: {
    containers: number
    running: number
    paused: number
    stopped: number
    images: number
    serverVersion: string
    storageDriver: string
    cgroupVersion: string
  }
}

export type DockerContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove' | 'removeForce'

export interface DockerLogsOpts {
  tail: number
  since?: string
  timestamps?: boolean
}

export interface DockerStats {
  id: string
  name: string
  cpuPct: number
  memUsage: string
  memPct: number
  netIO: string
  blockIO: string
  pids: number
}

export interface DockerTop {
  titles: string[]
  processes: string[][]
}

export interface DockerPortMapping {
  host: number
  container: number
  proto: 'tcp' | 'udp'
}

export interface DockerEnvVar {
  k: string
  v: string
}

export interface DockerVolumeMount {
  host: string
  container: string
  ro: boolean
}

export type DockerRestartPolicy = 'no' | 'always' | 'unless-stopped' | 'on-failure'

export interface DockerRunSpec {
  image: string
  name?: string
  ports: DockerPortMapping[]
  env: DockerEnvVar[]
  volumes: DockerVolumeMount[]
  restart: DockerRestartPolicy
  network?: string
  command?: string
  detach: boolean
  pull: boolean
  extraArgs?: string
}

export interface DockerDfRow {
  type: string
  totalCount: number
  active: number
  size: string
  reclaimable: string
}

export interface DockerSystemDf {
  rows: DockerDfRow[]
  /** Raw verbose summary (volume sizes etc.), when available. */
  verbose?: {
    volumes: { name: string; size: string; links: number }[]
    containers: { id: string; name: string; size: string; status: string }[]
  }
}

export interface DockerPruneOpts {
  containers: boolean
  images: boolean
  volumes: boolean
  networks: boolean
  buildCache: boolean
  allImages: boolean
}

export interface ComposeProject {
  name: string
  status: string
  configFiles: string[]
  dir: string
  running?: number
  total?: number
}

export type ComposeAction = 'up' | 'down' | 'restart' | 'pull' | 'ps' | 'logs'

export interface ComposeFile {
  path: string
  content: string
}

export type DockerNetworkDriver = 'bridge' | 'overlay' | 'macvlan'

export interface DockerNetworkCreate {
  name: string
  driver: DockerNetworkDriver
  subnet?: string
}

export type DockerServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
