import { DEFAULT_SETTINGS, type AppSettings, type Snippet, type AuditEntry, type AlertEvent } from '@shared/types'
import { JsonStore } from './jsonStore'
import { randomUUID } from 'crypto'

const settingsStore = new JsonStore<AppSettings>('settings.json', DEFAULT_SETTINGS)

export function getSettings(): AppSettings {
  return settingsStore.read()
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  return settingsStore.update((cur) => ({ ...cur, ...patch }))
}

// ---------- Snippets ----------

interface SnippetsFile {
  snippets: Snippet[]
}

const DEFAULT_SNIPPETS: Snippet[] = [
  { id: 'disk', name: 'Disk usage by directory', command: 'du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -20', sudo: true, tags: ['disk'], createdAt: 0, description: 'Largest top-level directories' },
  { id: 'mem', name: 'Top memory consumers', command: 'ps aux --sort=-%mem | head -15', sudo: false, tags: ['memory'], createdAt: 0 },
  { id: 'ports', name: 'Listening ports', command: 'ss -tulpn', sudo: true, tags: ['network'], createdAt: 0 },
  { id: 'failed', name: 'Failed systemd units', command: 'systemctl --failed', sudo: false, tags: ['services'], createdAt: 0 },
  { id: 'authlog', name: 'Recent SSH logins', command: 'journalctl -u ssh -u sshd --no-pager -n 50 | grep -Ei "accepted|failed" | tail -30', sudo: true, tags: ['security'], createdAt: 0 },
  { id: 'reboot', name: 'Reboot required?', command: 'if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required; cat /var/run/reboot-required.pkgs 2>/dev/null; else echo "No reboot required"; fi', sudo: false, tags: ['updates'], createdAt: 0 },
  { id: 'dockerdf', name: 'Docker disk usage', command: 'docker system df -v', sudo: true, tags: ['docker'], createdAt: 0 },
  { id: 'inodes', name: 'Inode usage', command: 'df -ih', sudo: false, tags: ['disk'], createdAt: 0 }
]

const snippetStore = new JsonStore<SnippetsFile>('snippets.json', { snippets: DEFAULT_SNIPPETS })

export function listSnippets(): Snippet[] {
  return snippetStore.read().snippets
}

export function saveSnippet(s: Omit<Snippet, 'id' | 'createdAt'> & { id?: string }): Snippet {
  const data = snippetStore.read()
  const existing = s.id ? data.snippets.find((x) => x.id === s.id) : undefined
  const snippet: Snippet = { ...(existing ?? { id: randomUUID(), createdAt: Date.now() }), ...s, id: existing?.id ?? s.id ?? randomUUID() } as Snippet
  const snippets = existing ? data.snippets.map((x) => (x.id === snippet.id ? snippet : x)) : [...data.snippets, snippet]
  snippetStore.write({ snippets })
  return snippet
}

export function deleteSnippet(id: string): void {
  snippetStore.update((d) => ({ snippets: d.snippets.filter((s) => s.id !== id) }))
}

// ---------- Audit log ----------

interface AuditFile {
  entries: AuditEntry[]
}
const auditStore = new JsonStore<AuditFile>('audit.json', { entries: [] })

export function addAudit(entry: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry {
  const e: AuditEntry = { ...entry, id: randomUUID(), ts: Date.now() }
  auditStore.update((d) => ({ entries: [e, ...d.entries].slice(0, 2000) }))
  return e
}

export function listAudit(limit = 500): AuditEntry[] {
  return auditStore.read().entries.slice(0, limit)
}

export function clearAudit(): void {
  auditStore.write({ entries: [] })
}

// ---------- Alerts ----------

interface AlertsFile {
  alerts: AlertEvent[]
}
const alertStore = new JsonStore<AlertsFile>('alerts.json', { alerts: [] })

export function addAlert(a: Omit<AlertEvent, 'id' | 'ts' | 'acknowledged'>): AlertEvent {
  const alert: AlertEvent = { ...a, id: randomUUID(), ts: Date.now(), acknowledged: false }
  alertStore.update((d) => ({ alerts: [alert, ...d.alerts].slice(0, 500) }))
  return alert
}

export function listAlerts(): AlertEvent[] {
  return alertStore.read().alerts
}

export function ackAlerts(ids?: string[]): void {
  alertStore.update((d) => ({ alerts: d.alerts.map((a) => (!ids || ids.includes(a.id) ? { ...a, acknowledged: true } : a)) }))
}

export function clearAlerts(): void {
  alertStore.write({ alerts: [] })
}
