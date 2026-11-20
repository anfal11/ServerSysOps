// Shared types for the Web server module (main <-> renderer).

export type WebServerId = 'nginx' | 'apache' | 'caddy' | 'openlitespeed' | 'lighttpd'

export interface WebServerInfo {
  id: WebServerId
  name: string
  installed: boolean
  version: string
  running: boolean
  enabled: boolean
  /** systemd unit name (nginx / apache2|httpd / caddy / lsws / lighttpd). */
  unit: string
  configTestCmd: string
  configDir: string
  /** Directory where per-site vhost files live (nginx sites-available, apache sites-available, conf.d …). */
  sitesDir?: string
  logDir: string
  /** Admin console URL (OpenLiteSpeed). */
  adminUrl?: string
  /** Whether this module can list / create sites for this server. */
  sitesSupported: boolean
}

export interface WebAvailable {
  id: WebServerId
  name: string
  description: string
  /** Package(s) that will be installed, for display. */
  packages: string
}

export interface WebDetectResult {
  servers: WebServerInfo[]
  /** Raw `ss -tlnp` lines for web-ish ports / processes. */
  ports: string[]
  available: WebAvailable[]
  hasSystemd: boolean
  pkgManager: string
  /** Server host (for "open in browser"). */
  host: string
}

export type WebServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'

export interface WebTestResult {
  ok: boolean
  output: string
}

export interface WebSite {
  server: WebServerId
  name: string
  path: string
  enabled: boolean
  serverNames: string[]
  listen: string[]
  root?: string
  proxy?: string
  ssl: boolean
  /** True when the file can be edited / toggled / deleted (false for Caddyfile summaries). */
  editable: boolean
}

export type WebSiteType = 'static' | 'proxy' | 'php'

export interface WebSiteSpec {
  name: string
  domains: string[]
  type: WebSiteType
  root?: string
  /** e.g. http://127.0.0.1:3000 */
  proxyTarget?: string
  /** PHP-FPM version ("8.2") or absolute socket path. */
  phpVersion?: string
  http2: boolean
}

export interface SslCert {
  name: string
  domains: string[]
  expiry: string
  /** Days until expiry (negative when expired, undefined when unknown). */
  daysLeft?: number
  path: string
  keyPath?: string
  keyType?: string
}

export interface SslStatus {
  certbotInstalled: boolean
  certbotVersion?: string
  certs: SslCert[]
  /** Description of the renewal mechanism found (timer / cron), if any. */
  renewal?: string
  renewalActive: boolean
  snapAvailable: boolean
}

export interface WebLogResult {
  path: string
  content: string
}

export interface WebLogCount {
  key: string
  count: number
}

export interface WebLogSummary {
  path: string
  requests: number
  bytes: number
  topPaths: WebLogCount[]
  topIps: WebLogCount[]
  statuses: WebLogCount[]
}

export interface PhpFpmUnit {
  unit: string
  version?: string
  active: boolean
  enabled: boolean
}

export interface PhpFpmInfo {
  units: PhpFpmUnit[]
  sockets: string[]
  phpVersion?: string
}
