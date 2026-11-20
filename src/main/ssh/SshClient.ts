import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import type { ExecResult, OsInfo, PkgManager, ServerProfile, ServerSecrets } from '@shared/types'
import { checkHostKey, rememberHostKey, type HostKeyVerdict } from './hostkeys'
import { shq } from './shell'

export interface ExecOptions {
  /** Run via sudo (uses stored sudo password when needed). */
  sudo?: boolean
  /** Data to pipe to the command's stdin. */
  stdin?: string | Buffer
  /** Timeout in ms (default 120s; 0 = none). */
  timeoutMs?: number
  /** Streaming callbacks. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** Environment variables (exported in the shell before the command). */
  env?: Record<string, string>
  /** Allocate a pty (needed by some interactive tools). */
  pty?: boolean
  /** Working directory. */
  cwd?: string
  /** Abort signal. */
  signal?: AbortSignal
  /** Max captured stdout bytes (default 8MB). */
  maxBuffer?: number
}

export class SshError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const SUDO_PROMPT = '__SM_SUDO_PROMPT__'

/**
 * Wrapper around a single ssh2 connection with exec/sudo/shell/sftp helpers.
 * Emits: 'ready', 'close', 'error', 'hostkey' (verdict), 'banner'.
 */
export class SshClient extends EventEmitter {
  readonly profile: ServerProfile
  private secrets: ServerSecrets
  private client: Client | null = null
  private sftpCache: SFTPWrapper | null = null
  private sftpPromise: Promise<SFTPWrapper> | null = null
  private _connected = false
  os: OsInfo | null = null
  hostKeyVerdict: HostKeyVerdict | null = null
  private jump?: SshClient

  constructor(profile: ServerProfile, secrets: ServerSecrets, jump?: SshClient) {
    super()
    this.profile = profile
    this.secrets = secrets
    this.jump = jump
  }

  get connected(): boolean {
    return this._connected
  }

  updateSecrets(s: ServerSecrets): void {
    this.secrets = { ...this.secrets, ...s }
  }

  private buildConfig(): ConnectConfig {
    const p = this.profile
    const cfg: ConnectConfig = {
      host: p.host,
      port: p.port,
      username: p.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer | string, cb: (ok: boolean) => void) => {
        const buf = Buffer.isBuffer(key) ? key : Buffer.from(key)
        // ssh2 hostVerifier does not pass the key type; detect from the wire format.
        const typeLen = buf.readUInt32BE(0)
        const type = buf.subarray(4, 4 + typeLen).toString('ascii')
        const verdict = checkHostKey(p.host, p.port, type, buf)
        this.hostKeyVerdict = verdict
        this.emit('hostkey', verdict)
        if (verdict.verdict === 'changed') return cb(false)
        if (verdict.verdict === 'new') rememberHostKey(p.host, p.port, type, buf)
        cb(true)
      }
    }
    if (p.auth === 'password') {
      cfg.password = this.secrets.password ?? ''
    } else if (p.auth === 'key') {
      if (!p.privateKeyPath) throw new SshError('CONFIG', 'No private key path configured')
      cfg.privateKey = readFileSync(p.privateKeyPath)
      if (this.secrets.passphrase) cfg.passphrase = this.secrets.passphrase
      if (this.secrets.password) cfg.password = this.secrets.password
    } else if (p.auth === 'agent') {
      cfg.agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK
      if (this.secrets.password) cfg.password = this.secrets.password
    }
    return cfg
  }

  async connect(): Promise<void> {
    if (this._connected) return
    const cfg = this.buildConfig()
    if (this.jump) {
      const stream = await this.jump.forwardOut('127.0.0.1', 0, this.profile.host, this.profile.port)
      cfg.sock = stream
    }
    await new Promise<void>((resolve, reject) => {
      const c = new Client()
      this.client = c
      let settled = false
      c.on('ready', () => {
        settled = true
        this._connected = true
        this.emit('ready')
        resolve()
      })
      c.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => this.secrets.password ?? ''))
      })
      c.on('banner', (msg) => this.emit('banner', msg))
      c.on('error', (err: Error & { level?: string }) => {
        if (!settled) {
          settled = true
          const v = this.hostKeyVerdict
          if (v && v.verdict === 'changed') {
            reject(new SshError('HOST_KEY_CHANGED', `Host key for ${this.profile.host} has changed (was ${v.previous}, now ${v.fingerprint}).`))
          } else if (err.level === 'client-authentication') {
            reject(new SshError('AUTH_FAILED', 'Authentication failed. Check the username, password or key.'))
          } else if (err.level === 'client-timeout' || /timed? ?out/i.test(err.message)) {
            reject(new SshError('TIMEOUT', `Connection to ${this.profile.host}:${this.profile.port} timed out.`))
          } else {
            reject(new SshError('NETWORK', err.message))
          }
        } else {
          this.emit('error', err)
        }
      })
      c.on('close', () => {
        const was = this._connected
        this._connected = false
        this.sftpCache = null
        this.sftpPromise = null
        if (!settled) {
          settled = true
          reject(new SshError('NETWORK', 'Connection closed before authentication completed.'))
        }
        if (was) this.emit('close')
      })
      try {
        c.connect(cfg)
      } catch (e) {
        settled = true
        reject(e)
      }
    })
    this.os = await this.detectOs()
  }

  disconnect(): void {
    const c = this.client
    this.client = null
    this._connected = false
    this.sftpCache = null
    this.sftpPromise = null
    if (c) {
      try {
        c.end()
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          c.destroy()
        } catch {
          /* ignore */
        }
      }, 1000)
    }
  }

  private requireClient(): Client {
    if (!this.client || !this._connected) throw new SshError('DISCONNECTED', 'Not connected')
    return this.client
  }

  // ---------- exec ----------

  /** Run a command and collect its output. Rejects only on transport failures; check result.code. */
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const c = this.requireClient()
    let cmd = command
    if (opts.cwd) cmd = `cd ${shq(opts.cwd)} && ${cmd}`
    if (opts.env) {
      // Export so every statement of a compound command sees the variables (not just the first).
      const exports = Object.entries(opts.env)
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join('; ')
      cmd = `${exports}; ${cmd}`
    }
    let sudoPw: string | undefined
    if (opts.sudo && !this.os?.isRoot) {
      if (!this.os?.sudoAvailable) throw new SshError('SUDO_FAILED', 'sudo is not available on this server')
      // Always run the whole command through `sh -c` so multi-statement scripts, pipes and
      // redirections are elevated as a unit (not just the first word).
      // "$SHELL" is expanded by the remote login shell before sudo runs, so root scripts use the same
      // shell dialect (usually bash) as non-root ones.
      const wrapped = `"\${SHELL:-/bin/sh}" -c ${shq(cmd)}`
      if (this.os.sudoPasswordless) {
        cmd = `sudo -n -H ${wrapped}`
      } else {
        sudoPw = this.sudoPassword()
        if (sudoPw === undefined) throw new SshError('SUDO_FAILED', 'A sudo password is required but none is stored for this server')
        cmd = `sudo -S -k -H -p ${shq(SUDO_PROMPT)} ${wrapped}`
      }
    }
    const timeoutMs = opts.timeoutMs ?? 120000
    const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024
    return new Promise<ExecResult>((resolve, reject) => {
      c.exec(cmd, { pty: opts.pty ? { term: 'xterm', cols: 200, rows: 50 } : undefined }, (err, stream) => {
        if (err) return reject(new SshError('EXEC', err.message))
        const out: Buffer[] = []
        const errb: Buffer[] = []
        let outLen = 0
        let code = -1
        let signal: string | undefined
        let timer: NodeJS.Timeout | undefined
        let finished = false
        let sawPrompt = false
        const finish = (): void => {
          if (finished) return
          finished = true
          if (timer) clearTimeout(timer)
          let stderr = Buffer.concat(errb).toString('utf8')
          // Strip the sudo prompt token and detect wrong password.
          if (sudoPw !== undefined) {
            if (stderr.includes(SUDO_PROMPT)) {
              sawPrompt = true
              const occurrences = stderr.split(SUDO_PROMPT).length - 1
              stderr = stderr.split(SUDO_PROMPT).join('')
              if (occurrences > 1 || /Sorry, try again|incorrect password/i.test(stderr)) {
                return reject(new SshError('SUDO_FAILED', 'sudo password rejected'))
              }
            }
          }
          // sudo never prompted (e.g. a per-command NOPASSWD rule) while we also fed a stdin payload:
          // the password line was consumed by the command instead. Do not report that as success.
          if (sudoPw !== undefined && !sawPrompt && opts.stdin !== undefined && code !== 0) {
            return reject(new SshError('SUDO_FAILED', 'sudo did not prompt for a password; the stdin payload was not delivered cleanly'))
          }
          resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr })
        }
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try {
              stream.close()
              stream.destroy()
            } catch {
              /* ignore */
            }
            if (!finished) {
              finished = true
              reject(new SshError('TIMEOUT', `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 120)}`))
            }
          }, timeoutMs)
        }
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            try {
              stream.signal('TERM')
              stream.close()
            } catch {
              /* ignore */
            }
          })
        }
        stream.on('data', (d: Buffer) => {
          if (outLen < maxBuffer) {
            out.push(d)
            outLen += d.length
          }
          opts.onStdout?.(d.toString('utf8'))
        })
        stream.stderr.on('data', (d: Buffer) => {
          const s = d.toString('utf8')
          errb.push(d)
          if (!(sudoPw !== undefined && s.includes(SUDO_PROMPT))) opts.onStderr?.(s)
        })
        stream.on('exit', (c2: number | null, sig?: string | null) => {
          if (typeof c2 === 'number') code = c2
          if (sig) signal = sig
        })
        stream.on('close', () => finish())
        stream.on('error', (e: Error) => {
          if (!finished) {
            finished = true
            reject(new SshError('EXEC', e.message))
          }
        })
        // Feed stdin: sudo password line first (sudo -S consumes only the first line), then payload.
        if (sudoPw !== undefined) stream.write(sudoPw + '\n')
        if (opts.stdin !== undefined && opts.stdin !== null) stream.write(opts.stdin)
        stream.end()
      })
    })
  }

  /** Convenience: run and return stdout, throw on non-zero exit. */
  async run(command: string, opts: ExecOptions = {}): Promise<string> {
    const r = await this.exec(command, opts)
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || `exit code ${r.code}`).trim()
      throw new SshError('CMD_FAILED', msg.split('\n').slice(-6).join('\n'))
    }
    return r.stdout
  }

  /** Run as root (sudo when needed). */
  sudo(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.exec(command, { ...opts, sudo: true })
  }

  async sudoRun(command: string, opts: ExecOptions = {}): Promise<string> {
    return this.run(command, { ...opts, sudo: true })
  }

  sudoPassword(): string | undefined {
    const m = this.profile.sudoMode
    if (m === 'none') return undefined
    if (m === 'separate') return this.secrets.sudoPassword
    return this.secrets.password ?? this.secrets.sudoPassword
  }

  // ---------- shell ----------

  shell(cols: number, rows: number, term = 'xterm-256color'): Promise<ClientChannel> {
    const c = this.requireClient()
    return new Promise((resolve, reject) => {
      c.shell({ term, cols, rows }, { env: { LANG: 'en_US.UTF-8' } }, (err, stream) => {
        if (err) return reject(new SshError('SHELL', err.message))
        resolve(stream)
      })
    })
  }

  // ---------- sftp ----------

  sftp(): Promise<SFTPWrapper> {
    if (this.sftpCache) return Promise.resolve(this.sftpCache)
    if (this.sftpPromise) return this.sftpPromise
    const c = this.requireClient()
    this.sftpPromise = new Promise((resolve, reject) => {
      c.sftp((err, sftp) => {
        if (err) {
          this.sftpPromise = null
          return reject(new SshError('SFTP', err.message))
        }
        this.sftpCache = sftp
        sftp.on('close', () => {
          this.sftpCache = null
          this.sftpPromise = null
        })
        resolve(sftp)
      })
    })
    return this.sftpPromise
  }

  // ---------- port forwarding ----------

  forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number): Promise<ClientChannel> {
    const c = this.requireClient()
    return new Promise((resolve, reject) => {
      c.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, stream) => {
        if (err) return reject(new SshError('FORWARD', err.message))
        resolve(stream)
      })
    })
  }

  // ---------- OS detection ----------

  private async detectOs(): Promise<OsInfo> {
    const script = [
      'echo "__ID=$(id -u)"',
      'echo "__USER=$(id -un)"',
      'echo "__HOME=$HOME"',
      'echo "__HOST=$(hostname 2>/dev/null)"',
      'echo "__KERNEL=$(uname -r)"',
      'echo "__ARCH=$(uname -m)"',
      'if command -v sudo >/dev/null 2>&1; then echo __SUDO=1; if sudo -n true >/dev/null 2>&1; then echo __NOPASS=1; fi; fi',
      'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then echo __SYSTEMD=1; fi',
      'for p in apt-get dnf yum zypper apk pacman; do if command -v $p >/dev/null 2>&1; then echo "__PKG=$p"; break; fi; done',
      'echo __OSRELEASE',
      'cat /etc/os-release 2>/dev/null'
    ].join('; ')
    const r = await this.exec(script, { timeoutMs: 20000 })
    const lines = r.stdout.split('\n')
    const kv: Record<string, string> = {}
    const osrel: Record<string, string> = {}
    let inOs = false
    for (const line of lines) {
      if (line === '__OSRELEASE') {
        inOs = true
        continue
      }
      if (inOs) {
        const m = line.match(/^([A-Z_]+)=(.*)$/)
        if (m) osrel[m[1]] = m[2].replace(/^"|"$/g, '')
      } else {
        const m = line.match(/^__([A-Z]+)=(.*)$/)
        if (m) kv[m[1]] = m[2]
      }
    }
    const pkgMap: Record<string, PkgManager> = { 'apt-get': 'apt', dnf: 'dnf', yum: 'yum', zypper: 'zypper', apk: 'apk', pacman: 'pacman' }
    const isRoot = kv.ID === '0'
    return {
      id: osrel.ID ?? 'linux',
      idLike: osrel.ID_LIKE ?? '',
      prettyName: osrel.PRETTY_NAME ?? 'Linux',
      versionId: osrel.VERSION_ID ?? '',
      kernel: kv.KERNEL ?? '',
      arch: kv.ARCH ?? '',
      hostname: kv.HOST ?? this.profile.host,
      user: kv.USER ?? this.profile.username,
      isRoot,
      sudoAvailable: isRoot || kv.SUDO === '1',
      sudoPasswordless: isRoot || kv.NOPASS === '1',
      pkgManager: pkgMap[kv.PKG ?? ''] ?? 'unknown',
      hasSystemd: kv.SYSTEMD === '1',
      homeDir: kv.HOME ?? '/'
    }
  }

  /** Verify stored sudo password works (returns true/false, never throws for wrong password). */
  async verifySudo(): Promise<boolean> {
    if (!this.os || this.os.isRoot || this.os.sudoPasswordless) return true
    try {
      const r = await this.exec('true', { sudo: true, timeoutMs: 15000 })
      return r.code === 0
    } catch {
      return false
    }
  }
}
