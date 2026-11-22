# Changelog

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
