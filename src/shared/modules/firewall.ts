// Extra types for the Firewall module (shared between main and renderer).
// FirewallRule and FirewallState live in @shared/types.

import type { FirewallRule, FirewallState, ListeningPort } from '../types'

export interface FirewallRuleEx extends FirewallRule {
  direction: 'in' | 'out' | 'fwd'
  /** Rule applies to a specific interface. */
  iface?: string
}

/**
 * ufw / firewalld manage the firewall through their own front end; `iptables` manages the kernel
 * tables directly (used when neither of the others is installed, e.g. Debian/Ubuntu minimal, Docker
 * hosts, Alpine, older CentOS). On nftables-only hosts (no iptables binary) the iptables backend is
 * read-only until `iptables` (nft-backed on modern distros) is installed.
 */
export type FwBackend = 'ufw' | 'firewalld' | 'iptables'
export type FwAction = 'allow' | 'deny' | 'reject' | 'limit'
export type FwProto = 'tcp' | 'udp' | 'any'
export type FwDirection = 'in' | 'out'
export type FwPolicy = 'deny' | 'allow' | 'reject'
export type FwLogLevel = 'off' | 'low' | 'medium' | 'high' | 'full'

export interface FirewalldZone {
  name: string
  interfaces: string[]
  sources: string[]
  services: string[]
  ports: string[]
  richRules: string[]
  target: string
}

/** Chain policies of the filter table (iptables backend). */
export interface IptPolicies {
  input: FwPolicy
  forward: FwPolicy
  output: FwPolicy
}

export interface FirewallStateEx extends Omit<FirewallState, 'backend' | 'rules'> {
  backend: FwBackend | 'none'
  rules: FirewallRuleEx[]
  /** Which backends are present on the server. */
  backendAvailable: FwBackend[]
  /** True when a backend can be installed with the package manager. */
  installable: boolean
  /** Service is enabled at boot (ufw: ufw service / firewalld: systemctl is-enabled / iptables: persistence set up). */
  enabledAtBoot: boolean
  logging: string
  /** firewalld only. */
  defaultZone?: string
  zones?: FirewalldZone[]
  /** All listening ports of sshd (first one is `sshPort`). */
  sshPorts: number[]
  /** A rule permits the SSH port (for every protocol / any source). */
  sshAllowed: boolean
  /** Recommended backend for this distro when nothing is installed. */
  recommended: FwBackend
  version?: string

  // ---- iptables backend ----
  /** `iptables` is the nf_tables variant (iptables-nft), or only `nft` exists. */
  nftBackend?: boolean
  /** Only `nft` exists (no iptables binary): rules are listed read-only from `nft list ruleset`. */
  nftOnly?: boolean
  /** ip6tables is usable on this host. */
  ip6?: boolean
  /** Chain policies of the filter table (v4). */
  policies?: IptPolicies
  /** Number of rules in INPUT (v4 + v6). */
  ruleCount?: number
  /** Rules are saved and restored at boot (netfilter-persistent / iptables-services / OpenRC / iptables.service). */
  persistent?: boolean
  /** Which persistence mechanism was detected (also when not enabled). */
  persistMethod?: string
  /** Docker chains exist: FORWARD / DOCKER-USER and the nat table are never touched. */
  docker?: boolean
  /** Raw rule dump (`iptables-save` + `ip6tables-save`, or `nft list ruleset`). */
  raw?: string
}

export interface AddRuleInput {
  action: FwAction
  /** Port, comma-separated list (`80,443`) or range (`6000:6100`). Omit for "any port" rules (requires `from`). */
  port?: string | number
  proto?: FwProto
  /** Source IP or CIDR. */
  from?: string
  /** Destination IP or CIDR (ufw and iptables). */
  to?: string
  comment?: string
  direction?: FwDirection
  v6?: boolean
  /** Confirm a deny/reject rule that would block the SSH port. */
  force?: boolean
}

export interface FirewallPreset {
  id: string
  label: string
  description: string
  /** Port specs as `port/proto`. */
  ports: { port: string; proto: 'tcp' | 'udp' }[]
  /** firewalld service name (preferred when available). */
  service?: string
  /** All ports in this preset are allowed by the current rules. */
  allowed: boolean
  /** A preset that only opens the UI's custom-rule dialog. */
  custom?: boolean
}

export interface BlockedPacket {
  time: string
  action: string
  iface: string
  src: string
  dst: string
  proto: string
  spt?: number
  dpt?: number
  raw: string
}

export interface ExposedPort extends ListeningPort {
  /** Covered by an allow rule (or firewall inactive => everything exposed). */
  allowed: boolean
  /** Listens on a non-loopback address. */
  public: boolean
}

// ---- generic block / unblock of an address (works on every backend; used by the Traffic page) ----

export interface BlockIpInput {
  /** IPv4 / IPv6 address or CIDR. */
  ip: string
  comment?: string
}

export interface UnblockIpInput {
  ip: string
}

export interface BlockedIp {
  /** Address or CIDR as the firewall reports it (host masks /32 and /128 are stripped). */
  ip: string
  /** Comment without the `ServerSysOps block:` prefix. */
  comment?: string
  /** Backend-specific rule text (same as the matching FirewallRuleEx.raw). */
  raw: string
  v6: boolean
}
