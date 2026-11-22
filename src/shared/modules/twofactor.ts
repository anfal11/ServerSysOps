// Types shared by the two-factor service (main) and the TwoFactor page (renderer).
import type { AuthMethod } from '../types'

/** Enforcement mode derived from the Central Server-managed sshd drop-in. */
export type TfaMode = 'off' | 'password+code' | 'key+code' | 'key-or-code'
export type TfaEnforceMode = Exclude<TfaMode, 'off'>

export interface TfaUser {
  name: string
  uid: number
  /** `~/.google_authenticator` exists. */
  enrolled: boolean
  /** The account Central Server is logged in with. */
  self: boolean
  /** Number of keys in ~/.ssh/authorized_keys. */
  hasKeys: number
  /** Password login disabled through the Users module (sshd Match block turns keyboard-interactive off too). */
  keyOnly: boolean
}

export interface TfaSshd {
  /** `sshd -T` could be read (needs root). */
  readable: boolean
  kbdInteractive: boolean
  usePam: boolean
  /** Effective `AuthenticationMethods` ("any" when unset). */
  authenticationMethods: string
  passwordAuth: boolean
  challengeResponse: boolean
  pubkeyAuth: boolean
}

export interface TfaConflict {
  file: string
  line: string
}

export interface TfaStatus {
  pamModuleInstalled: boolean
  pamModulePath?: string
  /** Package that provides the PAM module on this distro. */
  packageName: string
  pkgManager: string
  /** `pam_google_authenticator` is referenced (uncommented) in /etc/pam.d/sshd. */
  pamConfigured: boolean
  /** The PAM line carries `nullok` (users without a code may still log in). */
  nullok: boolean
  sshd: TfaSshd
  mode: TfaMode
  /** sshd_config supports `Include /etc/ssh/sshd_config.d`. */
  sshdIncludeSupported: boolean
  /** Settings in files that sshd reads BEFORE our drop-in and that would neutralise it. */
  conflicts: TfaConflict[]
  users: TfaUser[]
  loginUser: string
  hostname: string
  profileAuth: AuthMethod
  /** The app profile has a stored password (needed for "password + code" with a key profile). */
  profileHasPassword: boolean
  /** The app profile holds the TOTP secret of the login user. */
  profileHasTotp: boolean
  isRoot: boolean
}

export interface TfaEnrollOptions {
  /** `" RATE_LIMIT 3 30` (max 3 attempts per 30 s). Default true. */
  rateLimit?: boolean
  /** Allow a code to be used more than once. Default false (`" DISALLOW_REUSE`). */
  reuse?: boolean
  /** `" WINDOW_SIZE n` (1-17, default 3 = one step either side). */
  window?: number
  /** Overwrite an existing enrollment. */
  force?: boolean
  /** Login user only: store the secret in the app profile so Central Server can answer the prompt itself. */
  saveToProfile?: boolean
}

export interface TfaEnrollResult {
  secret: string
  otpauthUrl: string
  scratchCodes: string[]
  savedToProfile: boolean
  account: string
}

export interface TfaEnableOptions {
  mode: TfaEnforceMode
  /** Add `nullok` so users without a `~/.google_authenticator` can still log in. */
  nullok: boolean
}

export const TFA_MODE_LABEL: Record<TfaMode, string> = {
  off: 'Off',
  'password+code': 'Enforced: password + code',
  'key+code': 'Enforced: key + code',
  'key-or-code': 'Enforced: key or code'
}
