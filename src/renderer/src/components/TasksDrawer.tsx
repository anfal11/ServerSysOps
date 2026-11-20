import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, Trash2, X, XCircle } from 'lucide-react'
import { useApp } from '@/store/app'
import { Badge, Button, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { cls, fmtDuration } from '@/lib/format'
import type { TaskInfo } from '@shared/types'

export default function TasksDrawer(): React.JSX.Element | null {
  const { tasks, tasksOpen, toggleTasks, servers } = useApp()
  const [selected, setSelected] = useState<string | null>(null)
  const sel = tasks.find((t) => t.id === selected) ?? tasks[0]
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sel?.log])
  useEffect(() => {
    // Auto-open the drawer when a new task starts.
    const running = tasks.find((t) => t.status === 'running')
    if (running && !tasksOpen && Date.now() - running.startedAt < 1500) {
      toggleTasks(true)
      setSelected(running.id)
    }
  }, [tasks, tasksOpen, toggleTasks])
  if (!tasksOpen) return null
  return (
    <div className="h-[300px] shrink-0 border-t border-border bg-bg-2 flex">
      <div className="w-[320px] border-r border-border flex flex-col">
        <div className="flex items-center justify-between px-3 h-9 border-b border-border">
          <span className="text-xs font-semibold">Tasks</span>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => api.global('tasks:clear').then(() => useApp.setState((s) => ({ tasks: s.tasks.filter((t) => t.status === 'running') })))}>
              Clear
            </Button>
            <Button size="xs" variant="ghost" icon={<ChevronDown size={14} />} onClick={() => toggleTasks(false)} title="Hide" />
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {tasks.length === 0 && <div className="text-muted text-xs p-4 text-center">No tasks yet. Installs, updates and other long operations show up here with live output.</div>}
          {tasks.map((t) => (
            <button key={t.id} onClick={() => setSelected(t.id)} className={cls('w-full text-left px-3 py-2 border-b border-border/60 hover:bg-panel', sel?.id === t.id && 'bg-panel')}>
              <div className="flex items-center gap-2">
                <StatusIcon t={t} />
                <span className="text-xs font-medium truncate flex-1">{t.title}</span>
                <span className="text-[10px] text-dim">{t.finishedAt ? fmtDuration(t.finishedAt - t.startedAt) : ''}</span>
              </div>
              <div className="text-[10px] text-dim truncate pl-5">{servers.find((s) => s.id === t.serverId)?.name ?? ''}</div>
              {t.status === 'running' && t.progress !== undefined && (
                <div className="h-1 bg-border rounded mt-1 ml-5 overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${t.progress}%` }} />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        {sel ? (
          <>
            <div className="flex items-center gap-2 px-3 h-9 border-b border-border">
              <StatusIcon t={sel} />
              <span className="text-xs font-medium truncate flex-1">{sel.title}</span>
              {sel.status === 'running' && (
                <Button size="xs" variant="danger" icon={<XCircle size={12} />} onClick={() => api.global('tasks:cancel', sel.id)}>
                  Cancel
                </Button>
              )}
            </div>
            <pre ref={logRef} className="flex-1 overflow-auto p-3 text-[11.5px] font-mono whitespace-pre-wrap break-words text-muted leading-relaxed">
              {sel.log || (sel.status === 'running' ? 'Working…' : '(no output)')}
            </pre>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted text-xs">Select a task to view its output</div>
        )}
      </div>
      <button onClick={() => toggleTasks(false)} className="absolute right-2 bottom-[270px] text-dim hover:text-text hidden">
        <X size={14} />
      </button>
    </div>
  )
}

function StatusIcon({ t }: { t: TaskInfo }): React.JSX.Element {
  if (t.status === 'running') return <Spinner size={12} />
  if (t.status === 'done') return <Badge color="ok">done</Badge>
  if (t.status === 'failed') return <Badge color="danger">failed</Badge>
  if (t.status === 'cancelled') return <Badge color="warn">cancelled</Badge>
  return <Badge>queued</Badge>
}
