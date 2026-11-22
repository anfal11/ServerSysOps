# Changelog

## 0.4.1 - 2026-11-22

### Fixed
- **Missing shortcuts after updating from Central Server.** The in-app update across the rename removed the old "Central Server" Start-menu and desktop shortcuts without creating new ones (the installer keeps shortcuts only when the exe stays in the same folder). The app now recreates its Start-menu entry (and the desktop shortcut) once on start when none exists. If you updated already and cannot find the app in Start, launch ServerSysOps.exe from its install folder once, or run the installer again.

## 0.4.0 – 2026-11-22

### New
- **Traffic** page (System group): who is hitting the server, live. *Connections*: every remote IP with its connection count and the service or Docker container behind each port, listening ports with their process, "you" badge on your own session, optional reverse DNS. *Web server*: nginx, Apache and Caddy access logs found automatically; per time window the requests, unique IPs, bytes, status codes, requests per minute and the top client IPs with their paths and user agent, aggregated on the server; "Follow live" tails the log in the Tasks drawer. *Containers*: the real client IPs seen inside each container's network namespace. *Databases*: client IPs of MySQL/MariaDB, PostgreSQL, MongoDB and Redis on the host or in Docker, with users and databases when admin credentials are stored. Every IP row has Block, Whois and Copy.
- **iptables / nftables firewall backend** for servers without ufw or firewalld: rule list, add and delete rules, safe enable (loopback, established, ICMP and SSH are allowed before INPUT is set to DROP, then the login is verified), default policies, presets, logging, persistence across reboots (iptables-persistent, iptables-services, OpenRC or iptables.service) with a one-click installer, Docker-aware (FORWARD, DOCKER chains and nat are never touched). ufw and firewalld keep working exactly as before.
- **Blocked addresses** on the Firewall page: block or unblock an IP or CIDR on any backend; the app refuses to block the address your own SSH session comes from.

## 0.3.1 – 2026-11-22

**Renamed:** Central Server is now **ServerSysOps**. Installed copies keep their servers, settings and snippets (data is migrated on first start), backup files made by the old name still import, and the installer replaces an existing Central Server install instead of adding a second app. Files the app writes on servers now use the `serversysops` prefix; two-factor auth, key-only logins, SSH hardening or runtime shims set up with 0.2.0/0.3.0 are not recognised under the old prefix and should be applied again from this version (the old files stay in place).

### Fixed
- **Cancel really stops the command.** Cancelling a task (for example following container logs) killed nothing on the server and stayed "running" until the command happened to write again. Cancellable commands now run in their own process group, Cancel kills that group, and the task ends within two seconds either way. Timed-out commands are killed the same way.

## 0.3.0 – 2026-11-22

### New
- **Kubernetes** module: works through `kubectl` on the server (k3s, microk8s, kubeadm or any cluster whose kubeconfig is there). Overview with nodes (cordon, drain), workloads (deployments, statefulsets, daemonsets, jobs, cronjobs: scale, restart, set image, trigger, delete), pods (logs, describe, events, shell, delete), services and ingresses, configmaps, secrets, volumes, namespaces, events, Helm releases, an Apply-YAML editor with server dry run, and one-click installers for k3s, microk8s or kubectl.

## 0.2.0 – 2026-11-22

**Renamed:** ServerMate is now **Central Server**. Installed copies of 0.1.0 keep their servers, settings and snippets (data is migrated on first start). Server-side files written by the app now use the `centralserver` prefix.

### New
- **Redis** engine in Databases: install, service control, configuration (bind, port, password, memory limit and eviction policy, AOF), key browser with TTL and value viewer, slow log, client list, flush and save.
- **One-click service updates**: Web server, Runtimes, Docker and Databases show when a newer package is available (for example nginx 1.24 → 1.26) with an Update button that upgrades only that service and restarts it.
- **Backup & restore** in Settings: one file with all servers, settings and snippets; with a passphrase the passwords, key passphrases, sudo passwords and 2FA secrets are included, encrypted with AES-256-GCM.
- **Update banner**: when a new release is published the top bar shows "Update to x.y.z"; one click downloads it and a second click restarts into the new version. A desktop notification is shown as well, and checks repeat every six hours.
- Product logo and icon everywhere: window, taskbar, installer, desktop notifications and the website.

### Fixed
- Notifications showed the Electron icon.

## 0.1.0 – 2026-11-20

First release.
