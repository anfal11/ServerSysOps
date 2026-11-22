import { lazy, type LazyExoticComponent, type ComponentType } from 'react'
import type { PageId } from '@/store/app'

export interface PageProps {
  serverId: string
}

export interface NavEntry {
  id: PageId
  label: string
  group: 'main' | 'services' | 'system' | 'extra'
}

export const NAV: NavEntry[] = [
  { id: 'overview', label: 'Overview', group: 'main' },
  { id: 'terminal', label: 'Terminal', group: 'main' },
  { id: 'files', label: 'Files', group: 'main' },
  { id: 'docker', label: 'Docker', group: 'services' },
  { id: 'kubernetes', label: 'Kubernetes', group: 'services' },
  { id: 'webserver', label: 'Web server', group: 'services' },
  { id: 'databases', label: 'Databases', group: 'services' },
  { id: 'runtimes', label: 'Runtimes', group: 'services' },
  { id: 'cron', label: 'Cron jobs', group: 'services' },
  { id: 'processes', label: 'Processes', group: 'system' },
  { id: 'users', label: 'Users', group: 'system' },
  { id: 'firewall', label: 'Firewall', group: 'system' },
  { id: 'twofactor', label: 'Two-factor auth', group: 'system' },
  { id: 'security', label: 'Security audit', group: 'extra' },
  { id: 'logs', label: 'Logs', group: 'extra' },
  { id: 'snippets', label: 'Snippets', group: 'extra' },
  { id: 'tunnels', label: 'Tunnels', group: 'extra' },
  { id: 'alerts', label: 'Alerts', group: 'extra' },
  { id: 'audit', label: 'Activity log', group: 'extra' }
]

export const PAGES: Record<PageId, LazyExoticComponent<ComponentType<PageProps>>> = {
  overview: lazy(() => import('./Overview')),
  terminal: lazy(() => import('./Terminal')),
  files: lazy(() => import('./Files')),
  docker: lazy(() => import('./Docker')),
  kubernetes: lazy(() => import('./Kubernetes')),
  webserver: lazy(() => import('./WebServer')),
  databases: lazy(() => import('./Databases')),
  runtimes: lazy(() => import('./Runtimes')),
  cron: lazy(() => import('./Cron')),
  processes: lazy(() => import('./Processes')),
  users: lazy(() => import('./Users')),
  firewall: lazy(() => import('./Firewall')),
  twofactor: lazy(() => import('./TwoFactor')),
  security: lazy(() => import('./Security')),
  logs: lazy(() => import('./Logs')),
  snippets: lazy(() => import('./Snippets')),
  tunnels: lazy(() => import('./Tunnels')),
  alerts: lazy(() => import('./Alerts')),
  audit: lazy(() => import('./Audit'))
}
