# Central Server

A desktop app for managing and controlling Linux servers over plain SSH. Nothing is installed on the server: no agent, no background service, no extra open port. Connect with a password or SSH key and get a full control panel for each machine.

Inspired by Serverias, rebuilt from scratch and extended.


## Features

| Module | What it does |
|---|---|
| **Overview** | CPU, memory, swap, uptime, live CPU/network sparklines, disks, network interfaces, host key. Quick actions: change SSH port (staged and verified so you cannot lock yourself out), SSH login rules (root login, password logins; rolled back automatically if the app cannot log back in), reboot/shutdown now or scheduled, package updates (check / install all), automatic security updates, Fail2ban install & tuning, hostname, time zone + NTP, swap file size + swappiness, disk cleanup with sizes shown before deleting. |
| **Terminal** | Multiple shells per server, tabs survive page switches, search, copy whole buffer, paste with Ctrl+V / Shift+Insert / middle-click / right-click menu, a shortcut-key bar (Esc, Tab, Ctrl+C/D/Z/L/R, arrows, Home/End, F-keys, quick commands), a compose box for pasting long or multi-line text (send as typed, send + Enter, or run line by line), "Highlight output" (colours errors/warnings/successes), clickable links. |
| **Files** | SFTP file manager: upload / download with progress, drag-and-drop, new file/folder, rename, copy/cut/paste, move/copy to…, symlinks, compress/extract, permissions (rwx grid + numeric), owner/group, hidden files, "sudo" mode to browse and edit root-owned files, built-in text editor with save-as-root. |
| **Docker** | Install Docker; containers (start/stop/restart/pause/kill/remove, live logs, stats, inspect, shell into container), images (pull/remove/prune), volumes, networks, Compose projects (up/down/pull/edit compose file), system disk usage and prune. |
| **Web server** | Detect nginx / Apache / Caddy / OpenLiteSpeed / Lighttpd; one-click install; start/stop/reload with config test first; sites (list, enable/disable, edit with automatic rollback on failed test, create static / reverse-proxy / PHP sites); HTTPS with certbot; access/error logs with a traffic summary. |
| **Databases** | MySQL / MariaDB / PostgreSQL / MongoDB / Redis / Microsoft SQL Server install and service control, databases and users with grants, backups (dump/restore), and a database client: browse tables, filter and edit rows, run SQL, import/export. SQLite client for local files. Everything goes through the SSH connection, no database port needs to be opened. |
| **Runtimes** | Node.js versions side by side with a `.nvmrc`-aware shim, default version, global npm packages, nvm per user; Bun; Go; PHP versions, extensions, php.ini limits, Composer; Python tooling (pip, venv, pipx, uv). |
| **Cron jobs** | Schedule builder (no cron syntax required), human-readable schedules and next run times, per-user crontabs, variables, raw editor with validation, run now, system cron directories, systemd timers, cron log. |
| **Processes** | Processes sorted by load with signal actions and details; systemd services (start/stop/restart/enable/disable, status and logs, unit file); listening ports with owning process. |
| **Users** | Create users (password or key, admin rights, passwordless sudo), lock/unlock, set password/shell/groups, SSH authorized keys, key-only login, active sessions, login history and failed logins. |
| **Two-factor auth** | SSH two-factor authentication with Google Authenticator or any TOTP app: install the PAM module, enroll users (QR code, secret, scratch codes, verify a code first), enforce password+code, key+code or key-or-code with automatic rollback if the app cannot log back in. The app can keep a profile's TOTP secret so it fills verification codes itself, and prompts for a code otherwise. |
| **Firewall** | ufw and firewalld: enable with SSH protection (the SSH port is allowed first and the change verified), default policies, one-click presets for common services, custom rules, exposed-service hints, blocked-packet log, reset. |
| **Security audit** | Scored audit of SSH config, firewall, Fail2ban, updates, users, sudoers, permissions, kernel hardening, exposed services; one-click fixes; trend of previous scores; exportable report. |
| **Logs** | systemd journal viewer with unit/priority/time filters and follow mode, /var/log file browser and tail, kernel log, SSH auth analysis (accepted/failed logins, top attacking IPs). |
| **Snippets** | Library of reusable commands, ad-hoc command runner with history, run a command on many servers at once and compare results. |
| **Tunnels** | Local port forwarding through the SSH connection: reach databases and internal web apps on the server without opening ports. Auto-start per server. |
| **Alerts** | Background checks of CPU, memory and disk on all connected servers with thresholds, cooldowns and desktop notifications; fleet overview. |
| **Activity log** | Local record of every change the app made, per server. |

Also: background tasks with live output, automatic reconnection after drops or sleep, host-key change warnings, jump hosts (bastions), server groups and colours, encrypted backup & restore of all servers, secrets, settings and snippets (Settings), one-click package updates for installed services (Web server, Runtimes, Docker, Databases), an in-app update banner when a new release is published, settings for metrics interval, terminal font, confirmations and alert thresholds, and **26 colour themes** (18 dark: Graphite, Slate Dark, Carbon, Midnight Blue, Tokyo Night, One Dark, Gruvbox, Dracula, Nord, Catppuccin Mocha, Rosé Pine, Solarized Dark, Deep Ocean, Forest, Ember, Aurora, Monochrome, High Contrast; 8 light: Light, GitHub Light, Paper, Solarized Light, Catppuccin Latte, Mint, Rosé Pine Dawn, Slate) that restyle the whole UI including the terminal.

## Download and install (Windows)

Two ready-to-run files are produced in `release/` by `npm run dist`:

| File | Use |
|---|---|
| `CentralServer_<version>_x64-setup.exe` | Installer (per-user, no admin rights needed, desktop + Start menu shortcut, uninstaller). Put this on your website for one-click download → install. |
| `CentralServer_<version>_x64-portable.exe` | Single-file portable build: runs from a USB stick or any folder without installing. Settings live in `%APPDATA%\Central Server`. |

Official downloads live on [GitHub Releases](https://github.com/anfal11/CentralServer/releases); the landing page in `site/` (deployed on Vercel) links to the latest release automatically. Installed copies check GitHub Releases on start and offer updates in Settings.

Publishing a new version: bump `version` in `package.json`, commit, tag `vX.Y.Z`, run `npm run dist`, then create a GitHub release for that tag and attach `CentralServer_X.Y.Z_x64-setup.exe`, `CentralServer_X.Y.Z_x64-setup.exe.blockmap`, `CentralServer_X.Y.Z_x64-portable.exe` and `latest.yml` from `release/`. The `latest.yml` file is what existing installs use to detect the update.

The build is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time: click **More info → Run anyway**. To remove that warning, sign the exe with an Authenticode certificate (set `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` for electron-builder). macOS and Linux packages need to be built on those platforms (`npm run dist:mac`, `npm run dist:linux`).

## Security model

- Credentials never leave your computer. Passwords and passphrases are encrypted with the OS credential store (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux through Electron `safeStorage`).
- Host keys are pinned on first connection; a changed key blocks the connection until you explicitly trust it.
- Root actions use `sudo` with the stored password fed over stdin; nothing is written to the server's disk.
- Risky SSH changes are staged: the new SSH port is opened next to the old one and the app logs in through it before the old port is removed; login-rule changes are reverted if the app cannot reconnect; enabling the firewall always allows the current SSH port first.
- All user input that reaches a shell is quoted or validated (see `src/main/ssh/shell.ts`).

## Requirements

- Windows 10/11 (64-bit), macOS 10.15+, or Linux. The installer for Windows is produced by `npm run dist`.
- Target servers: any Linux reachable by SSH (Ubuntu, Debian, RHEL, Rocky, Alma, Fedora, openSUSE, Alpine, Arch). Most modules need `sudo` or a root login. systemd is used where available; distros without it get reduced service features.

## Status and known limitations

- Built and type-checked; every page was exercised in the running app. The server-side shell logic was reviewed line by line for injection and lock-out risks but has **not yet been run against a live Linux host** from this environment, so expect small distro-specific parsing fixes on first real use. Please report anything that misbehaves together with the server's distribution.
- Busybox-only systems (Alpine) lack GNU `find -printf`; the Files module falls back to SFTP metadata there, but search is limited.
- Web server site management is read-only for OpenLiteSpeed and Lighttpd; Caddy sites are summarised from the Caddyfile.
- Reverse (remote → local) SSH tunnels and a local terminal are not included yet.
- The app is unsigned; Windows SmartScreen will warn on first launch of the installer.

## Development

```powershell
npm install            # installs dependencies and downloads Electron
npm run dev            # start with hot reload
npm run typecheck      # tsc for main and renderer
npm run build          # production bundle to out/
npm run dist           # Windows NSIS installer to release/
```

The environment variable `CENTRALSERVER_DEBUG=1` forwards renderer console output to the terminal. For automated UI checks, launch `electron out/main/index.js --remote-debugging-port=9222`; the renderer exposes `window.__centralserver.useApp` (the zustand store) for scripted navigation.

Build output: `release/CentralServer_<version>_x64-setup.exe` (NSIS, per-user install, desktop shortcut) plus `latest.yml` for the generic update feed configured in `electron-builder.yml`.

### Project layout

```
src/main/        Electron main process
  ssh/           SshClient (exec/sudo/shell/sftp/forward), SessionManager (reconnect), host keys, shell quoting
  services/      One file per module: SSH commands, parsing, background tasks
  store/         JSON stores: servers (+encrypted secrets), settings, snippets, audit, alerts
  tasks/         TaskManager: background tasks with live logs
src/preload/     contextBridge API (invoke + events)
src/renderer/    React UI (pages/<Module>.tsx, components/ui kit, zustand store)
src/shared/      Types shared between processes
docs/            MODULE-GUIDE.md explains how to add a module
```

## License

MIT
