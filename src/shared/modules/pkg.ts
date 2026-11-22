// Shared types for per-package update checks (main <-> renderer).

export interface PkgVersion {
  name: string
  /** Installed version, undefined when the package is not installed. */
  installed?: string
  /** Newest version offered by the configured repositories, undefined when unknown. */
  candidate?: string
  /** True when a candidate exists and differs from the installed version. */
  updatable: boolean
}

export interface PkgUpdateInput {
  /** Package names to upgrade (exactly these; nothing else is touched). */
  packages: string[]
  /** systemd units to restart after a successful upgrade. */
  restart?: string[]
}
