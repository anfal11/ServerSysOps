import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { Badge, Button, confirm, useAction } from '@/components/ui'
import type { PkgUpdateInput, PkgVersion } from '@shared/modules/pkg'

/**
 * Run `fn` whenever a background task of this server finishes (done / failed / cancelled).
 * Skips the initial render.
 */
export function useTaskRefresh(serverId: string, fn: () => void | Promise<void>): void {
  const key = useApp((s) =>
    s.tasks
      .filter((t) => t.serverId === serverId && t.status !== 'running' && t.status !== 'queued')
      .map((t) => t.id)
      .join(',')
  )
  const first = useRef(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => void fnRef.current(), 500)
    return () => clearTimeout(t)
  }, [key])
}

/**
 * "nginx 1.24.0 → 1.26.2  [Update]" next to an installed service.
 * Renders nothing while loading, on error, or when none of the packages is installed.
 *
 *   <PackageUpdate serverId={serverId} packages={['nginx']} restart={['nginx']} label="nginx" />
 */
export function PackageUpdate({ serverId, packages, restart, label, className }: { serverId: string; packages: string[]; restart?: string[]; label?: string; className?: string }): React.JSX.Element | null {
  const [versions, setVersions] = useState<PkgVersion[] | null>(null)
  const { run, busy } = useAction()
  const pkgKey = packages.join(',')

  const load = useCallback(async (): Promise<void> => {
    if (!packages.length) return
    try {
      const v = await api.call<PkgVersion[]>('pkg:versions', serverId, packages)
      setVersions(v)
    } catch {
      setVersions(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, pkgKey])

  useEffect(() => {
    setVersions(null)
    void load()
  }, [load])
  useTaskRefresh(serverId, load)

  if (!versions) return null
  const installed = versions.filter((v) => v.installed)
  if (!installed.length) return null
  const updatable = installed.filter((v) => v.updatable)
  const multi = packages.length > 1

  if (!updatable.length) {
    return (
      <span className={['text-dim text-[11px] whitespace-nowrap', className].filter(Boolean).join(' ')} title={installed.map((v) => `${v.name} ${v.installed}`).join('\n')}>
        up to date ({installed[0].installed})
      </span>
    )
  }

  const update = async (): Promise<void> => {
    const names = updatable.map((v) => v.name)
    const what = label ?? names.join(', ')
    const ok = await confirm({
      title: `Update ${what}`,
      message: (
        <>
          Upgrade from the distribution repositories:
          <ul className="list-disc ml-5 mt-2 space-y-0.5 font-mono text-xs">
            {updatable.map((v) => (
              <li key={v.name}>
                {v.name} {v.installed} → {v.candidate}
              </li>
            ))}
          </ul>
          {restart?.length ? (
            <div className="mt-2">
              Afterwards <b className="font-mono">{restart.join(', ')}</b> will be restarted; connections to it drop for a moment.
            </div>
          ) : null}
        </>
      ),
      confirmLabel: 'Update'
    })
    if (!ok) return
    const input: PkgUpdateInput = { packages: names, restart }
    const id = await run(() => api.call<string>('pkg:update', serverId, input))
    if (id) {
      const st = useApp.getState()
      st.toast({ kind: 'info', title: `Started: Update ${what}`, detail: 'Progress is shown in the Tasks drawer.' })
      st.toggleTasks(true)
    }
  }

  return (
    <span className={['inline-flex items-center gap-1.5 flex-wrap', className].filter(Boolean).join(' ')}>
      {updatable.map((v) => (
        <Badge key={v.name} color="warn" className="font-mono">
          {multi ? `${v.name} ` : ''}
          {v.installed} → {v.candidate}
        </Badge>
      ))}
      <Button size="xs" variant="primary" icon={<ArrowUpCircle size={11} />} loading={busy} onClick={() => void update()} title={`Upgrade ${updatable.map((v) => v.name).join(', ')}`}>
        Update
      </Button>
    </span>
  )
}

export default PackageUpdate
