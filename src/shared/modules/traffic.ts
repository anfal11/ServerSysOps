// Types shared by the traffic service (main) and the Traffic page (renderer).
// "Which IP addresses are hitting this server, and what?" – for the host, the web server,
// Docker containers and databases. Everything is derived from ss / awk / docker over SSH.

export type TrafficProto = 'tcp' | 'udp'

/** A listening socket with the service that owns it (process name or publishing Docker container). */
export interface TrafficListener {
  port: number
  proto: TrafficProto
  address: string
  /** Process name (needs root) or the Docker container publishing the port; '' when unknown. */
  service: string
  kind: 'process' | 'docker' | 'unknown'
  pid?: number
  /** Established connections currently targeting this port. */
  connections: number
}

export interface TrafficRemotePort {
  /** Local (listening) port for inbound connections, the remote port for outbound ones. */
  port: number
  proto: TrafficProto
  count: number
  service: string
  /** The local port is a listener on this server (the remote side opened the connection). */
  inbound: boolean
}

/** One remote IP with everything it currently has open towards (or from) this server. */
export interface TrafficRemote {
  ip: string
  connections: number
  inbound: number
  outbound: number
  ports: TrafficRemotePort[]
  /** The IP of the SSH session this app is using right now. */
  you: boolean
  v6: boolean
}

export interface TrafficConnections {
  remotes: TrafficRemote[]
  listeners: TrafficListener[]
  totals: {
    established: number
    inbound: number
    outbound: number
    udp: number
    uniqueIps: number
  }
  /** Client address of the current SSH session (first field of $SSH_CONNECTION). */
  yourIp?: string
  /** Process names for listeners could not be resolved (no root). */
  noProcessNames: boolean
  /** docker CLI is present and `docker ps` worked. */
  docker: boolean
  /** Non-fatal problems (ss missing, docker permission denied, …). */
  hints: string[]
}

/* ------------------------------------------------------------------ */
/* Web server access logs                                              */
/* ------------------------------------------------------------------ */

export type TrafficWebServer = 'nginx' | 'apache' | 'caddy'
export type TrafficLogFormat = 'combined' | 'caddy-json'
export type TrafficWindow = '15m' | '1h' | '6h' | '24h' | 'all'

export interface TrafficWebLog {
  server: TrafficWebServer
  path: string
  sizeBytes: number
  /** Modification time, epoch ms. */
  mtime: number
  format: TrafficLogFormat
}

export interface TrafficWebLogs {
  logs: TrafficWebLog[]
  /** Web servers whose binary was found on the server. */
  servers: TrafficWebServer[]
  /** Caddy is installed but no access log is written anywhere we can find. */
  caddyNoAccessLog: boolean
}

export interface TrafficStatusBuckets {
  s2xx: number
  s3xx: number
  s4xx: number
  s5xx: number
}

export interface TrafficWebIp {
  ip: string
  requests: number
  bytes: number
  /** Epoch ms of the newest request. */
  lastSeen: number
  statuses: TrafficStatusBuckets
  topPaths: { path: string; count: number }[]
  /** Most common user agent of this IP (truncated). */
  userAgent: string
}

export interface TrafficWebSummary {
  path: string
  window: TrafficWindow
  total: number
  uniqueIps: number
  bytes: number
  statuses: TrafficStatusBuckets
  /** One point per minute, oldest first (60 points). */
  perMinute: { t: number; count: number }[]
  topIps: TrafficWebIp[]
  /** Lines that were read from the end of the file (capped). */
  linesScanned: number
  /** The file has more lines than the cap; older requests were not considered. */
  truncated: boolean
  /** Oldest / newest request in the window, epoch ms. */
  from?: number
  to?: number
  /** Lines that did not match the expected format. */
  unparsed: number
}

/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */

export interface TrafficContainerConn {
  ip: string
  count: number
  /** Container-side ports the IP is connected to. */
  ports: number[]
}

export interface TrafficContainer {
  id: string
  name: string
  image: string
  /** Published ports as "80/tcp->8080, 443/tcp" (container port -> host port). */
  ports: string
  networkMode: string
  pid: number
  connections: TrafficContainerConn[]
  /** nsenter/ss failed for this container. */
  error?: string
  /** Not inspected (host network: see the Connections section). */
  skipped?: string
}

export interface TrafficContainers {
  containers: TrafficContainer[]
  docker: boolean
  nsenter: boolean
  hint?: string
}

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

export type TrafficDbEngine = 'mysql' | 'postgres' | 'mongo' | 'redis'

export interface TrafficDbClient {
  ip: string
  connections: number
  users?: string[]
  dbs?: string[]
}

export interface TrafficDbEngineInfo {
  engine: TrafficDbEngine
  where: 'host' | 'docker'
  container?: string
  port: number
  /** Process name (host) or image (docker). */
  label: string
  clients: TrafficDbClient[]
  /** Rows from the engine's own client list (processlist / pg_stat_activity / currentOp / CLIENT LIST). */
  detailColumns?: string[]
  detail?: string[][]
  /** Why the engine's own client list is missing. */
  hint?: string
  /** Admin credentials for this engine are stored in the Databases module. */
  credentials: boolean
}

export interface TrafficDatabases {
  engines: TrafficDbEngineInfo[]
  hint?: string
}
