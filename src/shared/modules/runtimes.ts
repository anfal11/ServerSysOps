// Shared types for the Runtimes module (Node.js, Bun, Go, PHP, Python).

// ---------- Node.js ----------

export interface NodeManagedVersion {
  version: string
  path: string
  default: boolean
}

export interface NodeOtherInstall {
  path: string
  version: string
}

export interface NodeAvailableVersion {
  version: string
  /** LTS codename or false. */
  lts: string | false
  date: string
  /** Human label: "Active LTS", "Maintenance LTS", "Current" or "". */
  label: string
  installed: boolean
}

export interface NodeGlobalPackage {
  name: string
  version: string
}

export interface NvmUser {
  user: string
  nvmVersion: string
}

export interface LoginUser {
  name: string
  home: string
  shell: string
}

export interface NodeStatus {
  arch: string
  versions: NodeManagedVersion[]
  defaultVersion?: string
  others: NodeOtherInstall[]
  available: NodeAvailableVersion[]
  /** True when the available list came from nodejs.org, false when the static fallback was used. */
  availableLive: boolean
  globals: NodeGlobalPackage[]
  shimInstalled: boolean
  nvmUsers: NvmUser[]
  users: LoginUser[]
  curlInstalled: boolean
}

// ---------- Bun ----------

export interface BunStatus {
  installed: boolean
  version?: string
  path: string
  linked: boolean
  others: { path: string; version: string }[]
  users: { user: string; path: string }[]
}

// ---------- Go ----------

export interface GoManagedVersion {
  version: string
  path: string
  default: boolean
}

export interface GoAvailableVersion {
  version: string
  stable: boolean
  installed: boolean
}

export interface GoStatus {
  arch: string
  versions: GoManagedVersion[]
  defaultVersion?: string
  /** /usr/local/go exists and is a real directory (not managed by Central Server). */
  usrLocalGoIsDir: boolean
  others: { path: string; version: string }[]
  available: GoAvailableVersion[]
  availableLive: boolean
  profileInstalled: boolean
}

// ---------- PHP ----------

export type PhpSettingKey = 'upload_max_filesize' | 'post_max_size' | 'memory_limit' | 'max_execution_time' | 'max_input_vars' | 'display_errors'

export const PHP_SETTING_KEYS: PhpSettingKey[] = ['upload_max_filesize', 'post_max_size', 'memory_limit', 'max_execution_time', 'max_input_vars', 'display_errors']

export type PhpSettings = Partial<Record<PhpSettingKey, string>>

export interface PhpVersionInfo {
  /** major.minor, e.g. "8.3" */
  version: string
  /** full version, e.g. "8.3.12" */
  fullVersion: string
  binary: string
  fpmUnit?: string
  fpmActive: boolean
  fpmEnabled: boolean
  /** php.ini used by the CLI binary. */
  iniPath: string
  /** php.ini used by FPM (when found). */
  fpmIniPath?: string
  extensions: string[]
  settings: PhpSettings
  settingsSource: 'fpm' | 'cli'
  isDefault: boolean
}

export interface PhpStatus {
  family: 'debian' | 'rhel' | 'other'
  pkgManager: string
  versions: PhpVersionInfo[]
  defaultVersion?: string
  availableVersions: string[]
  /** Third-party repository (ondrej/sury or remi) already configured. */
  repoReady: boolean
  repoName: string
  availableExtensions: string[]
  composer: { installed: boolean; version?: string; path?: string }
}

export type PhpFpmAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'
export type PhpSettingsTarget = 'fpm' | 'cli' | 'both'

// ---------- Python ----------

export interface PythonStatus {
  python3?: { version: string; path: string }
  pip?: { version: string }
  venvAvailable: boolean
  pipx?: { version: string; path: string }
  uv?: { version: string; path: string }
  pyenvUsers: string[]
  pkgManager: string
}

export type PythonTool = 'pip' | 'venv' | 'pipx' | 'uv'

export interface PipxPackage {
  name: string
  version: string
  apps: string[]
}
