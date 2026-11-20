import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type { TaskInfo } from '@shared/types'

export interface TaskHandle {
  id: string
  log(line: string): void
  /** Append raw chunk (no newline handling). */
  append(chunk: string): void
  progress(pct: number): void
  signal: AbortSignal
}

const MAX_LOG = 400 * 1024

/**
 * Background tasks with live log streaming to the renderer. Emits 'update' with TaskInfo.
 */
export class TaskManager extends EventEmitter {
  private tasks = new Map<string, TaskInfo>()
  private aborts = new Map<string, AbortController>()
  private throttle = new Map<string, NodeJS.Timeout>()

  list(): TaskInfo[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): TaskInfo | undefined {
    return this.tasks.get(id)
  }

  private emitUpdate(id: string, immediate = false): void {
    const t = this.tasks.get(id)
    if (!t) return
    if (immediate) {
      const timer = this.throttle.get(id)
      if (timer) clearTimeout(timer)
      this.throttle.delete(id)
      this.emit('update', { ...t })
      return
    }
    if (this.throttle.has(id)) return
    this.throttle.set(
      id,
      setTimeout(() => {
        this.throttle.delete(id)
        const cur = this.tasks.get(id)
        if (cur) this.emit('update', { ...cur })
      }, 150)
    )
  }

  /** Start a task. Resolves with the task id immediately; the work runs in background. */
  start<T>(title: string, serverId: string | undefined, work: (h: TaskHandle) => Promise<T>): { id: string; done: Promise<T> } {
    const id = randomUUID()
    const info: TaskInfo = { id, serverId, title, status: 'running', log: '', startedAt: Date.now() }
    const ac = new AbortController()
    this.tasks.set(id, info)
    this.aborts.set(id, ac)
    this.emitUpdate(id, true)
    const handle: TaskHandle = {
      id,
      signal: ac.signal,
      log: (line) => this.appendLog(id, line.endsWith('\n') ? line : line + '\n'),
      append: (chunk) => this.appendLog(id, chunk),
      progress: (pct) => {
        const t = this.tasks.get(id)
        if (t) {
          t.progress = Math.max(0, Math.min(100, pct))
          this.emitUpdate(id)
        }
      }
    }
    const done = (async () => {
      try {
        const result = await work(handle)
        const t = this.tasks.get(id)
        if (t) {
          t.status = ac.signal.aborted ? 'cancelled' : 'done'
          t.finishedAt = Date.now()
          if (t.progress !== undefined) t.progress = 100
        }
        this.emitUpdate(id, true)
        return result
      } catch (e) {
        const t = this.tasks.get(id)
        if (t) {
          t.status = ac.signal.aborted ? 'cancelled' : 'failed'
          t.finishedAt = Date.now()
          t.error = e instanceof Error ? e.message : String(e)
          this.appendLog(id, `\n[error] ${t.error}\n`)
        }
        this.emitUpdate(id, true)
        throw e
      } finally {
        this.aborts.delete(id)
      }
    })()
    // Prevent unhandled rejection noise when caller does not await.
    done.catch(() => {})
    return { id, done }
  }

  private appendLog(id: string, chunk: string): void {
    const t = this.tasks.get(id)
    if (!t) return
    t.log += chunk
    if (t.log.length > MAX_LOG) t.log = t.log.slice(-MAX_LOG)
    this.emitUpdate(id)
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
  }

  clearFinished(): void {
    for (const [id, t] of this.tasks) if (t.status !== 'running' && t.status !== 'queued') this.tasks.delete(id)
    this.emit('cleared')
  }
}
