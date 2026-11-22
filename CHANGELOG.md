# Changelog

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
