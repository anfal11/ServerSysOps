import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  FolderSymlink,
  House,
  Image,
  KeyRound,
  Link,
  Lock,
  PackageOpen,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  ShieldCheck,
  Terminal,
  Trash2,
  Upload,
  UserCog,
  X
} from 'lucide-react'
import type { PageProps } from '@/pages'
import { api, ApiError, errMsg } from '@/lib/api'
import { useApp } from '@/store/app'
import { Badge, Button, Callout, Checkbox, ContextMenu, ErrorBox, Field, IconButton, Input, Loading, Modal, PageHeader, ProgressBar, SearchInput, Select, Spinner, Table, Toggle, confirm, useAsync, type Column, type MenuItem } from '@/components/ui'
import { cls, fmtBytes, fmtDate, modeToString } from '@/lib/format'
import type { ArchiveFormat, FileReadResult, FileRow, UsersGroups } from '@shared/modules/files'
import { FILES_MAX_DROP_BYTES } from '@shared/modules/files'
import type { AppEvent } from '@shared/types'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Last visited path / sudo mode per server (survives page switches while the app runs). */
const lastPath = new Map<string, string>()
const lastSudo = new Map<string, boolean>()

function pnorm(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}
const pjoin = (dir: string, name: string): string => pnorm(`${dir}/${name}`)
const pdirname = (p: string): string => {
  const n = pnorm(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}
const pbasename = (p: string): string => pnorm(p).split('/').pop() || '/'
const presolve = (base: string, target: string): string => (target.startsWith('/') ? pnorm(target) : pjoin(base, target))

const isDirLike = (r: FileRow): boolean => r.type === 'dir' || (r.type === 'symlink' && !!r.targetIsDir)
const isPermErr = (e: unknown): boolean => (e instanceof ApiError && e.code === 'EACCES') || /permission denied|operation not permitted/i.test(errMsg(e))
const isToolMissing = (e: unknown): string | null => {
  if (!(e instanceof ApiError) || e.code !== 'TOOL_MISSING') return null
  const m = e.message.match(/^(\S+) is not installed/)
  return m ? m[1] : null
}
const ARCHIVE_RE = /\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar\.zst|tzst|tar|zip|7z|gz|xz|bz2)$/i
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i
const CODE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|conf|cfg|sh|bash|zsh|py|rb|php|go|rs|c|h|cpp|hpp|java|kt|cs|sql|html?|css|scss|xml|env|service|timer|socket|dockerfile|lock)$/i
const TEXT_RE = /\.(txt|md|log|csv|tsv|rst|text|list)$/i

function FileIcon({ row }: { row: FileRow }): React.JSX.Element {
  const s = 15
  if (row.type === 'dir') return <Folder size={s} className="text-warn-fg/90 fill-warn/20 shrink-0" />
  if (row.type === 'symlink') return row.targetIsDir ? <FolderSymlink size={s} className="text-warn-fg/90 shrink-0" /> : <Link size={s} className="text-info-fg shrink-0" />
  if (row.type === 'other') return <File size={s} className="text-dim shrink-0" />
  if (ARCHIVE_RE.test(row.name)) return <FileArchive size={s} className="text-accent-fg shrink-0" />
  if (IMAGE_RE.test(row.name)) return <Image size={s} className="text-info-fg shrink-0" />
  if (CODE_RE.test(row.name)) return <FileCode size={s} className="text-ok-fg shrink-0" />
  if (TEXT_RE.test(row.name)) return <FileText size={s} className="text-muted shrink-0" />
  return <File size={s} className="text-muted shrink-0" />
}

type SortKey = 'name' | 'size' | 'mtime' | 'mode' | 'owner'

type DialogState =
  | { kind: 'newFolder' }
  | { kind: 'newFile' }
  | { kind: 'rename'; row: FileRow }
  | { kind: 'copyTo' | 'moveTo'; paths: string[] }
  | { kind: 'symlink'; row: FileRow }
  | { kind: 'compress'; paths: string[] }
  | { kind: 'perms'; rows: FileRow[] }
  | { kind: 'owner'; rows: FileRow[] }

interface EditorState {
  path: string
  sudo: boolean
  loading: boolean
  content: string
  original: string
  size: number
  truncated: boolean
  binary: boolean
  mode: number
  error?: string
}

interface TransferRow {
  id: string
  name: string
  direction: 'upload' | 'download'
  done: number
  total: number
  status: 'running' | 'done' | 'failed'
  error?: string
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Files({ serverId }: PageProps): React.JSX.Element {
  const toast = useApp((s) => s.toast)
  const os = useApp((s) => s.connections[serverId]?.os)
  const canSudo = !!os && !os.isRoot && os.sudoAvailable
  const isRoot = !!os?.isRoot

  const [path, setPath] = useState<string>(() => lastPath.get(serverId) ?? '')
  const [hist, setHist] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] })
  const [rows, setRows] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  const [hidden, setHidden] = useState(false)
  const [sudo, setSudoState] = useState<boolean>(() => lastSudo.get(serverId) ?? false)
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState<{ pattern: string; results: FileRow[]; loading: boolean } | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  const [clipboard, setClipboard] = useState<{ op: 'copy' | 'cut'; paths: string[] } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; row?: FileRow } | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [pathEdit, setPathEdit] = useState<string | null>(null)
  const [transfers, setTransfers] = useState<TransferRow[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const pendingTasks = useRef(new Set<string>())
  const containerRef = useRef<HTMLDivElement>(null)

  const setSudo = (v: boolean): void => {
    setSudoState(v)
    lastSudo.set(serverId, v)
  }

  /* ---------- loading ---------- */

  useEffect(() => {
    if (path) return
    api
      .call<string>('files:home', serverId)
      .then((h) => setPath(h || '/'))
      .catch(() => setPath('/'))
  }, [path, serverId])

  useEffect(() => {
    if (!path) return
    let alive = true
    setLoading(true)
    api
      .call<FileRow[]>('files:list', serverId, path, { hidden, sudo })
      .then((r) => {
        if (!alive) return
        setRows(r)
        setError(null)
        lastPath.set(serverId, path)
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [path, hidden, sudo, serverId, tick])

  const reload = useCallback((): void => setTick((t) => t + 1), [])

  const navigate = useCallback(
    (to: string, mode: 'push' | 'replace' = 'push'): void => {
      const target = pnorm(to)
      setSelected(new Set())
      anchorRef.current = null
      setFilter('')
      setSearch(null)
      setPathEdit(null)
      if (target === path) {
        reload()
        return
      }
      if (mode === 'push') setHist((h) => ({ back: [...h.back, path].slice(-100), fwd: [] }))
      setPath(target)
    },
    [path, reload]
  )
  const goBack = (): void => {
    const prev = hist.back[hist.back.length - 1]
    if (prev === undefined) return
    setHist((h) => ({ back: h.back.slice(0, -1), fwd: [path, ...h.fwd] }))
    navigate(prev, 'replace')
  }
  const goForward = (): void => {
    const next = hist.fwd[0]
    if (next === undefined) return
    setHist((h) => ({ back: [...h.back, path], fwd: h.fwd.slice(1) }))
    navigate(next, 'replace')
  }
  const goUp = (): void => {
    if (path !== '/') navigate(pdirname(path))
  }
  const goHome = (): void => {
    api
      .call<string>('files:home', serverId)
      .then((h) => navigate(h || '/'))
      .catch(() => navigate('/'))
  }

  /* ---------- events: transfers + task completion ---------- */

  useEffect(() => {
    const timers = new Map<string, number>()
    const off = api.onEvent((e: AppEvent) => {
      if (e.type === 'transfer') {
        setTransfers((list) => {
          const row: TransferRow = { id: e.id, name: e.name, direction: e.direction, done: e.done, total: e.total, status: e.status, error: e.error }
          const idx = list.findIndex((t) => t.id === e.id)
          return idx >= 0 ? list.map((t) => (t.id === e.id ? row : t)) : [...list, row]
        })
        if (e.status !== 'running' && !timers.has(e.id)) {
          if (e.status === 'failed' && e.error !== 'Cancelled') toast({ kind: 'error', title: `${e.direction === 'upload' ? 'Upload' : 'Download'} failed: ${e.name}`, detail: e.error })
          if (e.direction === 'upload') reload()
          timers.set(
            e.id,
            window.setTimeout(() => {
              setTransfers((list) => list.filter((t) => t.id !== e.id))
              timers.delete(e.id)
            }, e.status === 'done' ? 4000 : 10000)
          )
        }
      } else if (e.type === 'task') {
        if (pendingTasks.current.has(e.task.id) && (e.task.status === 'done' || e.task.status === 'failed' || e.task.status === 'cancelled')) {
          pendingTasks.current.delete(e.task.id)
          reload()
        }
      }
    })
    return () => {
      off()
      for (const t of timers.values()) window.clearTimeout(t)
    }
  }, [reload, toast])

  /* ---------- derived ---------- */

  const visible = useMemo((): FileRow[] => {
    const base = search ? search.results : rows
    const f = filter.trim().toLowerCase()
    const list = f && !search ? base.filter((r) => r.name.toLowerCase().includes(f)) : base
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const da = isDirLike(a) ? 0 : 1
      const db = isDirLike(b) ? 0 : 1
      if (da !== db) return da - db
      let r = 0
      switch (sort.key) {
        case 'size':
          r = a.size - b.size
          break
        case 'mtime':
          r = a.mtime - b.mtime
          break
        case 'mode':
          r = a.modeStr.localeCompare(b.modeStr)
          break
        case 'owner':
          r = `${a.owner}:${a.group}`.localeCompare(`${b.owner}:${b.group}`)
          break
      }
      if (r === 0) r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      return r * dir
    })
  }, [rows, filter, sort, search])

  const selectedRows = useMemo(() => visible.filter((r) => selected.has(r.path)), [visible, selected])
  const selectedBytes = useMemo(() => selectedRows.reduce((a, r) => a + (isDirLike(r) ? 0 : r.size), 0), [selectedRows])
  const single = selectedRows.length === 1 ? selectedRows[0] : null

  /* ---------- action runner with sudo retry / tool install ---------- */

  const act = useCallback(
    async <T,>(label: string, fn: (asSudo: boolean) => Promise<T>, opts: { success?: string; sudo?: boolean } = {}): Promise<T | undefined> => {
      const attempt = async (asSudo: boolean): Promise<T | undefined> => {
        setBusy(true)
        try {
          const r = await fn(asSudo)
          if (opts.success) toast({ kind: 'success', title: opts.success })
          return r
        } catch (e) {
          if (!asSudo && canSudo && isPermErr(e)) {
            const ok = await confirm({
              title: 'Permission denied',
              message: (
                <>
                  <span className="text-muted">{label}:</span> {errMsg(e)}
                  <div className="mt-3">Retry as administrator (sudo)?</div>
                </>
              ),
              confirmLabel: 'Retry as admin'
            })
            if (ok) return attempt(true)
            return undefined
          }
          const tool = isToolMissing(e)
          if (tool) {
            const ok = await confirm({ title: `${tool} is not installed`, message: <>The <b className="font-mono">{tool}</b> package is required for this action. Install it now?</>, confirmLabel: 'Install' })
            if (ok) {
              try {
                await api.call('qa:installPackages', serverId, [tool])
                toast({ kind: 'info', title: `Installing ${tool}…`, detail: 'Follow the progress in the Tasks drawer, then retry.' })
              } catch (e2) {
                toast({ kind: 'error', title: 'Install failed', detail: errMsg(e2) })
              }
            }
            return undefined
          }
          toast({ kind: 'error', title: `${label} failed`, detail: errMsg(e) })
          return undefined
        } finally {
          setBusy(false)
        }
      }
      return attempt(opts.sudo ?? sudo)
    },
    [sudo, canSudo, serverId, toast]
  )

  /* ---------- selection ---------- */

  const onRowClick = (row: FileRow, e: React.MouseEvent): void => {
    containerRef.current?.focus()
    if (e.detail === 2) {
      openRow(row)
      return
    }
    if (e.shiftKey && anchorRef.current) {
      const a = visible.findIndex((r) => r.path === anchorRef.current)
      const b = visible.findIndex((r) => r.path === row.path)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const range = visible.slice(lo, hi + 1).map((r) => r.path)
        setSelected((s) => (e.ctrlKey || e.metaKey ? new Set([...s, ...range]) : new Set(range)))
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s)
        if (n.has(row.path)) n.delete(row.path)
        else n.add(row.path)
        return n
      })
      anchorRef.current = row.path
      return
    }
    setSelected(new Set([row.path]))
    anchorRef.current = row.path
  }

  const selectAll = (): void => setSelected(new Set(visible.map((r) => r.path)))
  const moveSelection = (delta: number): void => {
    if (!visible.length) return
    const cur = anchorRef.current ? visible.findIndex((r) => r.path === anchorRef.current) : -1
    const next = Math.max(0, Math.min(visible.length - 1, cur + delta))
    const row = visible[next]
    anchorRef.current = row.path
    setSelected(new Set([row.path]))
    document.querySelector<HTMLElement>(`[data-row-path="${CSS.escape(row.path)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  /* ---------- operations ---------- */

  const openRow = (row: FileRow): void => {
    if (isDirLike(row)) navigate(row.path)
    else if (row.type === 'file' || (row.type === 'symlink' && row.linkTarget)) openEditor(row.path)
  }

  const openEditor = (p: string, asSudo = sudo): void => {
    setEditor({ path: p, sudo: asSudo, loading: true, content: '', original: '', size: 0, truncated: false, binary: false, mode: 0o644 })
    api
      .call<FileReadResult>('files:read', serverId, p, asSudo)
      .then((r) => setEditor((ed) => (ed && ed.path === p ? { ...ed, loading: false, content: r.content, original: r.content, size: r.size, truncated: r.truncated, binary: r.binary, mode: r.mode } : ed)))
      .catch(async (e) => {
        if (!asSudo && canSudo && isPermErr(e)) {
          setEditor(null)
          if (await confirm({ title: 'Permission denied', message: <>You do not have permission to read <b className="font-mono">{p}</b>. Open it as administrator (sudo)?</>, confirmLabel: 'Open as admin' })) openEditor(p, true)
          return
        }
        setEditor((ed) => (ed && ed.path === p ? { ...ed, loading: false, error: errMsg(e) } : ed))
      })
  }

  const saveEditor = async (asSudo?: boolean): Promise<void> => {
    if (!editor || editor.loading || editor.binary || editor.truncated) return
    const useSudo = asSudo ?? editor.sudo
    const { path: p, content } = editor
    setBusy(true)
    try {
      await api.call('files:write', serverId, p, content, useSudo)
      setEditor((ed) => (ed && ed.path === p ? { ...ed, original: content, sudo: useSudo } : ed))
      toast({ kind: 'success', title: `Saved ${pbasename(p)}${useSudo ? ' (as root)' : ''}` })
      reload()
    } catch (e) {
      if (!useSudo && canSudo && isPermErr(e)) {
        if (await confirm({ title: 'Permission denied', message: <>Saving <b className="font-mono">{p}</b> failed: {errMsg(e)}<div className="mt-3">Save as administrator (sudo)?</div></>, confirmLabel: 'Save as admin' })) return saveEditor(true)
        return
      }
      toast({ kind: 'error', title: 'Save failed', detail: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }

  const closeEditor = async (): Promise<void> => {
    if (editor && !editor.loading && editor.content !== editor.original) {
      if (!(await confirm({ title: 'Discard changes?', message: <>You have unsaved changes in <b className="font-mono">{pbasename(editor.path)}</b>.</>, danger: true, confirmLabel: 'Discard' }))) return
    }
    setEditor(null)
  }

  const doDelete = async (targets: FileRow[]): Promise<void> => {
    if (!targets.length) return
    const names = targets.map((r) => r.name)
    const ok = await confirm({
      title: targets.length === 1 ? `Delete ${targets[0].type === 'dir' ? 'folder' : 'file'}` : `Delete ${targets.length} items`,
      message: (
        <>
          <div>This permanently deletes {targets.length === 1 ? <b className="font-mono">{targets[0].path}</b> : <>the following items from <b className="font-mono">{pdirname(targets[0].path)}</b></>}. Folders are removed with everything inside.</div>
          {targets.length > 1 && <div className="mt-2 max-h-40 overflow-auto font-mono text-xs text-muted bg-bg-2 border border-border rounded p-2">{names.slice(0, 50).join('\n')}{names.length > 50 ? `\n… and ${names.length - 50} more` : ''}</div>}
        </>
      ),
      danger: true,
      confirmLabel: 'Delete',
      // Deleting many items or a folder is hard to undo: require typing the word first.
      typeToConfirm: targets.length > 5 || targets.some((t) => t.type === 'dir') ? 'delete' : undefined
    })
    if (!ok) return
    const r = await act('Delete', (s) => api.call('files:delete', serverId, targets.map((t) => t.path), s), { success: `Deleted ${targets.length === 1 ? names[0] : `${targets.length} items`}` })
    if (r !== undefined) {
      setSelected(new Set())
      reload()
    }
  }

  const doPaste = async (): Promise<void> => {
    if (!clipboard) return
    const channel = clipboard.op === 'copy' ? 'files:copy' : 'files:move'
    const r = await act(clipboard.op === 'copy' ? 'Copy' : 'Move', (s) => api.call(channel, serverId, clipboard.paths, path, s), { success: `${clipboard.op === 'copy' ? 'Copied' : 'Moved'} ${clipboard.paths.length} item(s)` })
    if (r !== undefined) {
      if (clipboard.op === 'cut') setClipboard(null)
      reload()
    }
  }

  const doDownload = async (targets: FileRow[]): Promise<void> => {
    if (!targets.length) return
    const ids = await act('Download', (s) => api.call<string[]>('files:download', serverId, targets.map((t) => t.path), s))
    if (ids && ids.length) toast({ kind: 'info', title: `Downloading ${targets.length === 1 ? targets[0].name : `${targets.length} items`}…` })
  }

  const doUpload = async (): Promise<void> => {
    const ids = await act('Upload', (s) => api.call<string[]>('files:upload', serverId, path, s))
    if (ids && ids.length) toast({ kind: 'info', title: `Uploading ${ids.length} item(s)…` })
  }

  const doExtract = async (row: FileRow): Promise<void> => {
    const id = await act('Extract', (s) => api.call<string>('files:extract', serverId, row.path, path, s))
    if (id) {
      pendingTasks.current.add(id)
      toast({ kind: 'info', title: `Extracting ${row.name}…`, detail: 'Progress is shown in the Tasks drawer.' })
    }
  }

  const copyPath = (p: string): void => {
    void navigator.clipboard.writeText(p).then(() => toast({ kind: 'success', title: 'Path copied' }))
  }

  const runSearch = async (pattern: string): Promise<void> => {
    const pat = pattern.trim()
    if (!pat) return
    setSearch({ pattern: pat, results: [], loading: true })
    setSelected(new Set())
    try {
      const results = await api.call<FileRow[]>('files:search', serverId, path, pat, sudo)
      setSearch({ pattern: pat, results, loading: false })
    } catch (e) {
      setSearch(null)
      toast({ kind: 'error', title: 'Search failed', detail: errMsg(e) })
    }
  }

  /* ---------- drag & drop upload ---------- */

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const items = Array.from(e.dataTransfer.items ?? [])
    const files = Array.from(e.dataTransfer.files ?? [])
    if (!files.length) return
    let skippedDirs = 0
    let uploaded = 0
    let useSudo = sudo
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const entry = (items[i] as DataTransferItem | undefined)?.webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        skippedDirs++
        continue
      }
      if (f.size > FILES_MAX_DROP_BYTES) {
        toast({ kind: 'warn', title: `${f.name} is too large for drag & drop`, detail: `Files over ${fmtBytes(FILES_MAX_DROP_BYTES)} must be sent with the Upload button.` })
        continue
      }
      const data = new Uint8Array(await f.arrayBuffer())
      const r = await act('Upload', (s) => api.call('files:uploadBuffer', serverId, path, f.name, data, s), { sudo: useSudo })
      if (r === undefined) break
      uploaded++
      // If the user switched to sudo for the first file, keep it for the rest of the batch.
      if (!useSudo && (r as FileRow | undefined)?.owner === 'root' && !isRoot) useSudo = true
    }
    if (skippedDirs) toast({ kind: 'warn', title: `${skippedDirs} folder(s) skipped`, detail: 'Folders cannot be dropped; use the Upload button.' })
    if (uploaded) reload()
  }

  /* ---------- keyboard ---------- */

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || dialog || editor || menu) return
    const ctrl = e.ctrlKey || e.metaKey
    const k = e.key
    if (k === 'Delete') {
      e.preventDefault()
      void doDelete(selectedRows)
    } else if (k === 'F2' && single) {
      e.preventDefault()
      setDialog({ kind: 'rename', row: single })
    } else if (k === 'F5') {
      e.preventDefault()
      reload()
    } else if (k === 'Backspace' && !search) {
      e.preventDefault()
      goUp()
    } else if (k === 'Enter' && single) {
      e.preventDefault()
      openRow(single)
    } else if (k === 'Escape') {
      setSelected(new Set())
    } else if (k === 'ArrowDown') {
      e.preventDefault()
      moveSelection(1)
    } else if (k === 'ArrowUp') {
      e.preventDefault()
      moveSelection(-1)
    } else if (ctrl && k.toLowerCase() === 'a') {
      e.preventDefault()
      selectAll()
    } else if (ctrl && k.toLowerCase() === 'c' && selectedRows.length) {
      e.preventDefault()
      setClipboard({ op: 'copy', paths: selectedRows.map((r) => r.path) })
    } else if (ctrl && k.toLowerCase() === 'x' && selectedRows.length) {
      e.preventDefault()
      setClipboard({ op: 'cut', paths: selectedRows.map((r) => r.path) })
    } else if (ctrl && k.toLowerCase() === 'v' && clipboard) {
      e.preventDefault()
      void doPaste()
    } else if (ctrl && k.toLowerCase() === 'h') {
      e.preventDefault()
      setHidden((h) => !h)
    } else if (e.altKey && k === 'ArrowLeft') {
      e.preventDefault()
      goBack()
    } else if (e.altKey && k === 'ArrowRight') {
      e.preventDefault()
      goForward()
    }
  }

  /* ---------- context menu ---------- */

  const menuItems = (): MenuItem[] => {
    if (!menu) return []
    if (!menu.row) {
      return [
        { label: 'New folder', icon: <FolderPlus />, onClick: () => setDialog({ kind: 'newFolder' }) },
        { label: 'New file', icon: <FilePlus />, onClick: () => setDialog({ kind: 'newFile' }) },
        { label: 'Upload files…', icon: <Upload />, onClick: () => void doUpload() },
        { separator: true, label: '' },
        { label: clipboard ? `Paste ${clipboard.paths.length} item(s)` : 'Paste', icon: <ClipboardPaste />, disabled: !clipboard, onClick: () => void doPaste() },
        { label: 'Select all', onClick: selectAll },
        { separator: true, label: '' },
        { label: 'Copy path', icon: <Copy />, onClick: () => copyPath(path) },
        { label: 'Open terminal here', icon: <Terminal />, onClick: () => useApp.getState().openTerminal(serverId, `cd ${shellQuote(path)}`) },
        { label: 'Refresh', icon: <RefreshCw />, onClick: reload }
      ]
    }
    const row = menu.row
    const targets = selected.has(row.path) && selectedRows.length > 1 ? selectedRows : [row]
    const many = targets.length > 1
    const dirLike = isDirLike(row)
    return [
      { label: dirLike ? 'Open' : 'Edit', icon: dirLike ? <FolderPlus /> : <Pencil />, disabled: many || row.type === 'other', onClick: () => openRow(row) },
      { label: many ? `Download ${targets.length} items` : 'Download', icon: <Download />, onClick: () => void doDownload(targets) },
      ...(row.type === 'file' && ARCHIVE_RE.test(row.name) && !many ? [{ label: 'Extract here', icon: <PackageOpen />, onClick: () => void doExtract(row) }] : []),
      { separator: true, label: '' },
      { label: 'Copy', icon: <Copy />, onClick: () => setClipboard({ op: 'copy', paths: targets.map((t) => t.path) }) },
      { label: 'Cut', icon: <Scissors />, onClick: () => setClipboard({ op: 'cut', paths: targets.map((t) => t.path) }) },
      { label: 'Copy to…', icon: <Copy />, onClick: () => setDialog({ kind: 'copyTo', paths: targets.map((t) => t.path) }) },
      { label: 'Move to…', icon: <ArrowRight />, onClick: () => setDialog({ kind: 'moveTo', paths: targets.map((t) => t.path) }) },
      { label: 'Rename', icon: <Pencil />, disabled: many, onClick: () => setDialog({ kind: 'rename', row }) },
      { label: 'Create symlink', icon: <Link />, disabled: many, onClick: () => setDialog({ kind: 'symlink', row }) },
      { label: 'Compress…', icon: <Archive />, onClick: () => setDialog({ kind: 'compress', paths: targets.map((t) => t.path) }) },
      { separator: true, label: '' },
      { label: 'Permissions…', icon: <Lock />, onClick: () => setDialog({ kind: 'perms', rows: targets }) },
      { label: 'Change owner…', icon: <UserCog />, onClick: () => setDialog({ kind: 'owner', rows: targets }) },
      { label: 'Copy path', icon: <Copy />, onClick: () => copyPath(row.path) },
      { separator: true, label: '' },
      { label: many ? `Delete ${targets.length} items` : 'Delete', icon: <Trash2 />, danger: true, onClick: () => void doDelete(targets) }
    ]
  }

  /* ---------- table ---------- */

  const header = (key: SortKey, label: string): React.ReactNode => (
    <button type="button" className="hover:text-text inline-flex items-center gap-1" onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))}>
      {label}
      {sort.key === key && <span className="text-dim">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  )

  const columns: Column<FileRow>[] = [
    {
      key: 'name',
      header: header('name', 'Name'),
      render: (r) => {
        const cut = clipboard?.op === 'cut' && clipboard.paths.includes(r.path)
        return (
          <div className={cls('flex items-center gap-2 min-w-0', cut && 'opacity-50')} data-row-path={r.path}>
            <FileIcon row={r} />
            <span className="truncate" title={r.path}>
              {r.name}
            </span>
            {r.type === 'symlink' && r.linkTarget && <span className="text-dim text-xs truncate shrink-0 max-w-[40%]">→ {r.linkTarget}</span>}
            {search && <span className="text-dim text-[11px] truncate ml-1">{pdirname(r.path)}</span>}
          </div>
        )
      }
    },
    { key: 'size', header: header('size', 'Size'), width: '90px', align: 'right', render: (r) => <span className={cls('text-xs tabular-nums', isDirLike(r) ? 'text-dim' : 'text-muted')}>{isDirLike(r) ? '—' : fmtBytes(r.size)}</span> },
    { key: 'mtime', header: header('mtime', 'Modified'), width: '150px', render: (r) => <span className="text-muted text-xs whitespace-nowrap">{fmtDate(r.mtime)}</span> },
    { key: 'mode', header: header('mode', 'Permissions'), width: '120px', render: (r) => <span className="font-mono text-xs text-muted">{r.modeStr}</span> },
    {
      key: 'owner',
      header: header('owner', 'Owner'),
      width: '140px',
      render: (r) => (
        <span className="text-xs text-muted truncate">
          {r.owner}
          <span className="text-dim">:{r.group}</span>
        </span>
      )
    }
  ]

  const segments = path === '/' ? [] : path.split('/').filter(Boolean)
  const hiddenCount = useMemo(() => (hidden ? 0 : rows.filter((r) => r.name.startsWith('.')).length), [rows, hidden])
  const permDenied = !!error && isPermErr(error)

  return (
    <>
      <PageHeader
        title="Files"
        subtitle={search ? `search results for “${search.pattern}” in ${path}` : undefined}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<Terminal size={13} />} onClick={() => useApp.getState().openTerminal(serverId, `cd ${shellQuote(path)}`)} title="Open a terminal in this folder">
              Terminal here
            </Button>
            {!isRoot && (
              <div className="flex items-center gap-2 pl-2 ml-1 border-l border-border" title={canSudo ? 'Browse, read and change files as root (sudo)' : 'sudo is not available on this server'}>
                <ShieldCheck size={14} className={sudo ? 'text-warn-fg' : 'text-dim'} />
                <Toggle checked={sudo} onChange={(v) => setSudo(v)} disabled={!canSudo} label={<span className={cls('text-xs', sudo ? 'text-warn-fg font-medium' : 'text-muted')}>sudo</span>} />
              </div>
            )}
            {isRoot && <Badge color="warn">root</Badge>}
          </>
        }
      />

      <div className="flex-1 min-h-0 flex flex-col px-6 pb-4 gap-2">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button icon={<Upload size={13} />} onClick={() => void doUpload()} disabled={!path}>
            Upload
          </Button>
          <Button icon={<FolderPlus size={13} />} onClick={() => setDialog({ kind: 'newFolder' })} disabled={!path}>
            New folder
          </Button>
          <Button icon={<FilePlus size={13} />} onClick={() => setDialog({ kind: 'newFile' })} disabled={!path}>
            New file
          </Button>
          <span className="w-px h-5 bg-border mx-1" />
          <Button icon={<Download size={13} />} disabled={!selectedRows.length} onClick={() => void doDownload(selectedRows)}>
            Download
          </Button>
          <Button icon={<Copy size={13} />} disabled={!selectedRows.length} onClick={() => setClipboard({ op: 'copy', paths: selectedRows.map((r) => r.path) })}>
            Copy
          </Button>
          <Button icon={<Scissors size={13} />} disabled={!selectedRows.length} onClick={() => setClipboard({ op: 'cut', paths: selectedRows.map((r) => r.path) })}>
            Cut
          </Button>
          <Button icon={<ClipboardPaste size={13} />} disabled={!clipboard || !!search} onClick={() => void doPaste()} title={clipboard ? `${clipboard.op === 'copy' ? 'Copy' : 'Move'} ${clipboard.paths.length} item(s) here` : 'Nothing to paste'}>
            Paste
            {clipboard && <Badge color="accent" className="ml-1 h-4 px-1">{clipboard.paths.length}</Badge>}
          </Button>
          <Button icon={<Archive size={13} />} disabled={!selectedRows.length} onClick={() => setDialog({ kind: 'compress', paths: selectedRows.map((r) => r.path) })}>
            Compress
          </Button>
          <Button icon={<Lock size={13} />} disabled={!selectedRows.length} onClick={() => setDialog({ kind: 'perms', rows: selectedRows })}>
            Permissions
          </Button>
          <Button icon={<UserCog size={13} />} disabled={!selectedRows.length} onClick={() => setDialog({ kind: 'owner', rows: selectedRows })}>
            Owner
          </Button>
          <Button variant="danger" icon={<Trash2 size={13} />} disabled={!selectedRows.length} onClick={() => void doDelete(selectedRows)}>
            Delete
          </Button>
          <div className="flex-1" />
          <Button variant={hidden ? 'subtle' : 'ghost'} icon={hidden ? <Eye size={13} /> : <EyeOff size={13} />} onClick={() => setHidden((h) => !h)} title="Show hidden files (Ctrl+H)">
            Hidden
            {!hidden && hiddenCount > 0 && <span className="text-dim text-[10px] ml-0.5">({hiddenCount})</span>}
          </Button>
          <SearchInputWithEnter value={filter} onChange={setFilter} onEnter={(v) => void runSearch(v)} placeholder="Filter · Enter = search subfolders" />
          <IconButton title="Refresh (F5)" onClick={reload} icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} />
        </div>

        {/* Path bar */}
        <div className="flex items-center gap-1 bg-panel border border-border rounded-md h-9 px-1.5">
          <IconButton title="Back (Alt+←)" size="xs" disabled={!hist.back.length} onClick={goBack} icon={<ArrowLeft size={14} />} />
          <IconButton title="Forward (Alt+→)" size="xs" disabled={!hist.fwd.length} onClick={goForward} icon={<ArrowRight size={14} />} />
          <IconButton title="Up (Backspace)" size="xs" disabled={path === '/'} onClick={goUp} icon={<ArrowUp size={14} />} />
          <IconButton title="Home" size="xs" onClick={goHome} icon={<House size={14} />} />
          <span className="w-px h-5 bg-border mx-1" />
          {pathEdit !== null ? (
            <Input
              mono
              autoFocus
              value={pathEdit}
              onChange={(e) => setPathEdit(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => setPathEdit(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = pathEdit.trim()
                  if (v.startsWith('/')) navigate(v)
                  else if (v.startsWith('~')) goHome()
                  else if (v) navigate(presolve(path, v))
                  setPathEdit(null)
                } else if (e.key === 'Escape') setPathEdit(null)
              }}
              className="h-7 text-xs flex-1"
            />
          ) : (
            <div className="flex-1 min-w-0 flex items-center h-7 overflow-x-auto whitespace-nowrap text-[13px] cursor-text rounded hover:bg-panel-2/60 px-1" onClick={() => setPathEdit(path)} title="Click to edit the path">
              <button type="button" className={cls('px-1 rounded hover:bg-border-2 hover:text-text font-mono', path === '/' ? 'text-text' : 'text-muted')} onClick={(e) => { e.stopPropagation(); navigate('/') }}>
                /
              </button>
              {segments.map((seg, i) => {
                const target = '/' + segments.slice(0, i + 1).join('/')
                const last = i === segments.length - 1
                return (
                  <React.Fragment key={target}>
                    {i > 0 && <span className="text-dim">/</span>}
                    <button type="button" className={cls('px-1 rounded hover:bg-border-2 hover:text-text font-mono', last ? 'text-text font-medium' : 'text-muted')} onClick={(e) => { e.stopPropagation(); navigate(target) }}>
                      {seg}
                    </button>
                  </React.Fragment>
                )
              })}
            </div>
          )}
          <IconButton title="Edit path" size="xs" onClick={() => setPathEdit(path)} icon={<Pencil size={12} />} />
          {sudo && <Badge color="warn">root</Badge>}
        </div>

        {/* Table */}
        <div
          ref={containerRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes('Files')) {
              e.preventDefault()
              if (!dragOver) setDragOver(true)
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
          }}
          onDrop={(e) => void onDrop(e)}
          className={cls('relative flex-1 min-h-0 flex flex-col bg-panel border rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-accent/50 transition-colors', dragOver ? 'border-accent ring-2 ring-accent/30' : 'border-border')}
        >
          {dragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-accent/10 pointer-events-none rounded-lg">
              <div className="flex items-center gap-2 bg-panel-2 border border-accent/50 rounded-md px-4 py-2 text-[13px] shadow-xl">
                <Upload size={16} className="text-accent" /> Drop to upload into <span className="font-mono">{path}</span>
                {sudo && <Badge color="warn">as root</Badge>}
              </div>
            </div>
          )}
          {error ? (
            <div className="p-4 flex flex-col gap-3">
              <ErrorBox error={error} onRetry={reload} />
              <div className="flex items-center gap-2">
                {permDenied && canSudo && !sudo && (
                  <Button variant="primary" icon={<ShieldCheck size={13} />} onClick={() => setSudo(true)}>
                    Browse as admin (sudo)
                  </Button>
                )}
                {hist.back.length > 0 && (
                  <Button icon={<ArrowLeft size={13} />} onClick={goBack}>
                    Go back
                  </Button>
                )}
                <Button icon={<ArrowUp size={13} />} onClick={goUp} disabled={path === '/'}>
                  Parent folder
                </Button>
                <Button icon={<House size={13} />} onClick={goHome}>
                  Home
                </Button>
              </div>
            </div>
          ) : !path || (loading && rows.length === 0) || search?.loading ? (
            <Loading label={search?.loading ? 'Searching…' : 'Loading…'} />
          ) : (
            <Table<FileRow>
              className="flex-1 min-h-0"
              dense
              columns={columns}
              rows={visible}
              rowKey={(r) => r.path}
              selected={(r) => selected.has(r.path)}
              onRowClick={onRowClick}
              onRowContextMenu={(row, e) => {
                e.stopPropagation()
                if (!selected.has(row.path)) {
                  setSelected(new Set([row.path]))
                  anchorRef.current = row.path
                }
                setMenu({ x: e.clientX, y: e.clientY, row })
              }}
              empty={
                search ? (
                  <span>No matches for “{search.pattern}”</span>
                ) : filter ? (
                  <span>No items match “{filter}”</span>
                ) : (
                  <span>
                    Empty folder{hiddenCount > 0 ? ` · ${hiddenCount} hidden item(s)` : ''}
                    <div className="text-dim text-xs mt-1">Drop files here to upload them, or right-click for more actions.</div>
                  </span>
                )
              }
            />
          )}

          {/* Transfers */}
          {transfers.length > 0 && (
            <div className="border-t border-border bg-bg-2/60 px-3 py-2 flex flex-col gap-1.5 max-h-40 overflow-auto shrink-0">
              {transfers.map((t) => {
                const pct = t.total > 0 ? Math.min(100, (t.done / t.total) * 100) : t.status === 'done' ? 100 : 0
                return (
                  <div key={t.id} className="flex items-center gap-3 text-xs">
                    {t.direction === 'upload' ? <Upload size={13} className="text-accent shrink-0" /> : <Download size={13} className="text-ok shrink-0" />}
                    <span className="truncate w-56" title={t.name}>
                      {t.name}
                    </span>
                    <ProgressBar value={pct} className="flex-1" color={t.status === 'failed' ? 'bg-danger' : t.status === 'done' ? 'bg-ok' : undefined} />
                    <span className="text-muted tabular-nums w-40 text-right">
                      {t.status === 'failed' ? <span className="text-danger-fg">{t.error ?? 'Failed'}</span> : t.status === 'done' ? 'Done' : `${fmtBytes(t.done)}${t.total ? ` / ${fmtBytes(t.total)} · ${pct.toFixed(0)}%` : ''}`}
                    </span>
                    {t.status === 'running' ? (
                      <button className="text-dim hover:text-text" title="Cancel" onClick={() => void api.call('files:cancelTransfer', serverId, t.id)}>
                        <X size={13} />
                      </button>
                    ) : (
                      <button className="text-dim hover:text-text" title="Dismiss" onClick={() => setTransfers((l) => l.filter((x) => x.id !== t.id))}>
                        <X size={13} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Status bar */}
          <div className="border-t border-border px-3 h-7 flex items-center gap-3 text-[11px] text-muted shrink-0">
            <span>
              {visible.length} item{visible.length === 1 ? '' : 's'}
              {selected.size > 0 && (
                <>
                  , {selected.size} selected{selectedBytes > 0 ? ` (${fmtBytes(selectedBytes)})` : ''}
                </>
              )}
            </span>
            {search ? (
              <button className="text-accent hover:underline" onClick={() => setSearch(null)}>
                Clear search
              </button>
            ) : (
              hiddenCount > 0 && !hidden && <span className="text-dim">{hiddenCount} hidden</span>
            )}
            {clipboard && (
              <span className="flex items-center gap-1 text-dim">
                {clipboard.op === 'copy' ? <Copy size={11} /> : <Scissors size={11} />}
                {clipboard.paths.length} item(s) to {clipboard.op === 'copy' ? 'copy' : 'move'}
                <button className="hover:text-text" onClick={() => setClipboard(null)} title="Clear clipboard">
                  <X size={11} />
                </button>
              </span>
            )}
            <div className="flex-1" />
            {busy && <Spinner size={12} />}
            {loading && rows.length > 0 && <span className="text-dim">refreshing…</span>}
            <span className="font-mono text-dim truncate max-w-[40%]" title={path}>
              {path}
            </span>
          </div>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}

      {/* ---------- dialogs ---------- */}
      {dialog?.kind === 'newFolder' && (
        <NamePrompt
          title="New folder"
          label="Folder name"
          placeholder="new-folder"
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const r = await act('Create folder', (s) => api.call('files:mkdir', serverId, pjoin(path, name), s), { success: `Created ${name}` })
            if (r !== undefined) {
              setDialog(null)
              reload()
            }
          }}
        />
      )}
      {dialog?.kind === 'newFile' && (
        <NamePrompt
          title="New file"
          label="File name"
          placeholder="notes.txt"
          confirmLabel="Create & edit"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const p = pjoin(path, name)
            const r = await act('Create file', (s) => api.call('files:touch', serverId, p, s))
            if (r !== undefined) {
              setDialog(null)
              reload()
              openEditor(p)
            }
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NamePrompt
          title={`Rename ${dialog.row.name}`}
          label="New name"
          initial={dialog.row.name}
          confirmLabel="Rename"
          selectBase
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const row = dialog.row
            if (name === row.name) return setDialog(null)
            const r = await act('Rename', (s) => api.call('files:rename', serverId, row.path, pjoin(pdirname(row.path), name), s), { success: `Renamed to ${name}` })
            if (r !== undefined) {
              setDialog(null)
              setSelected(new Set())
              reload()
            }
          }}
        />
      )}
      {(dialog?.kind === 'copyTo' || dialog?.kind === 'moveTo') && (
        <NamePrompt
          title={dialog.kind === 'copyTo' ? `Copy ${dialog.paths.length} item(s) to…` : `Move ${dialog.paths.length} item(s) to…`}
          label="Destination folder (absolute path)"
          initial={path}
          mono
          confirmLabel={dialog.kind === 'copyTo' ? 'Copy' : 'Move'}
          hint={<span className="font-mono break-all">{dialog.paths.map(pbasename).join(', ')}</span>}
          validate={(v) => (v.startsWith('/') ? null : 'Enter an absolute path starting with /')}
          onClose={() => setDialog(null)}
          onSubmit={async (dest) => {
            const d = dialog
            const r = await act(d.kind === 'copyTo' ? 'Copy' : 'Move', (s) => api.call(d.kind === 'copyTo' ? 'files:copy' : 'files:move', serverId, d.paths, pnorm(dest), s), { success: `${d.kind === 'copyTo' ? 'Copied' : 'Moved'} to ${pnorm(dest)}` })
            if (r !== undefined) {
              setDialog(null)
              setSelected(new Set())
              reload()
            }
          }}
        />
      )}
      {dialog?.kind === 'symlink' && (
        <NamePrompt
          title="Create symbolic link"
          label="Link path"
          initial={pjoin(path, dialog.row.name + '-link')}
          mono
          confirmLabel="Create link"
          hint={
            <>
              Target: <span className="font-mono">{dialog.row.path}</span>
            </>
          }
          validate={(v) => (v.startsWith('/') ? null : 'Enter an absolute path starting with /')}
          onClose={() => setDialog(null)}
          onSubmit={async (link) => {
            const row = dialog.row
            const r = await act('Create symlink', (s) => api.call('files:symlink', serverId, row.path, pnorm(link), s), { success: 'Symlink created' })
            if (r !== undefined) {
              setDialog(null)
              reload()
            }
          }}
        />
      )}
      {dialog?.kind === 'compress' && (
        <CompressDialog
          paths={dialog.paths}
          dir={path}
          onClose={() => setDialog(null)}
          onSubmit={async (archivePath, format) => {
            const ps = dialog.paths
            const id = await act('Compress', (s) => api.call<string>('files:compress', serverId, ps, archivePath, format, s))
            if (id) {
              pendingTasks.current.add(id)
              setDialog(null)
              toast({ kind: 'info', title: `Creating ${pbasename(archivePath)}…`, detail: 'Progress is shown in the Tasks drawer.' })
            }
          }}
        />
      )}
      {dialog?.kind === 'perms' && (
        <PermissionsDialog
          rows={dialog.rows}
          onClose={() => setDialog(null)}
          onSubmit={async (mode, recursive) => {
            const ps = dialog.rows.map((r) => r.path)
            const r = await act('Change permissions', (s) => api.call('files:chmod', serverId, ps, mode, recursive, s), { success: `Permissions set to ${mode}` })
            if (r !== undefined) {
              setDialog(null)
              reload()
            }
          }}
        />
      )}
      {dialog?.kind === 'owner' && (
        <OwnerDialog
          serverId={serverId}
          rows={dialog.rows}
          onClose={() => setDialog(null)}
          onSubmit={async (owner, group, recursive) => {
            const ps = dialog.rows.map((r) => r.path)
            const r = await act('Change owner', (s) => api.call('files:chown', serverId, ps, owner, group, recursive, s), { success: `Owner set to ${owner}${group ? ':' + group : ''}` })
            if (r !== undefined) {
              setDialog(null)
              reload()
            }
          }}
        />
      )}

      {editor && <EditorModal editor={editor} busy={busy} canSudo={canSudo} onChange={(c) => setEditor((ed) => (ed ? { ...ed, content: c } : ed))} onSave={(asSudo) => void saveEditor(asSudo)} onClose={() => void closeEditor()} onDownload={() => void doDownload([{ path: editor.path, name: pbasename(editor.path), type: 'file', size: editor.size, mtime: 0, mode: editor.mode, modeStr: '', owner: '', group: '', uid: 0, gid: 0 }])} />}
    </>
  )
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@,+~]+$/.test(s)) return s
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

/* ------------------------------------------------------------------ */
/* Filter input that also fires a search on Enter                      */
/* ------------------------------------------------------------------ */

function SearchInputWithEnter({ value, onChange, onEnter, placeholder }: { value: string; onChange: (v: string) => void; onEnter: (v: string) => void; placeholder: string }): React.JSX.Element {
  return (
    <div
      className="w-64"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) {
          e.preventDefault()
          onEnter(value)
        }
      }}
    >
      <SearchInput value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Generic single-value prompt                                         */
/* ------------------------------------------------------------------ */

function NamePrompt({
  title,
  label,
  initial = '',
  placeholder,
  confirmLabel,
  hint,
  mono,
  selectBase,
  validate,
  onClose,
  onSubmit
}: {
  title: string
  label: string
  initial?: string
  placeholder?: string
  confirmLabel: string
  hint?: React.ReactNode
  mono?: boolean
  /** Select only the base name (without extension) on open — for rename. */
  selectBase?: boolean
  validate?: (v: string) => string | null
  onClose: () => void
  onSubmit: (value: string) => Promise<void> | void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (selectBase) {
      const dot = initial.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : initial.length)
    } else el.select()
  }, [initial, selectBase])
  const v = value.trim()
  const err = !v ? 'Required' : v === '.' || v === '..' ? 'Invalid name' : !mono && v.includes('/') ? 'Names cannot contain /' : validate ? validate(v) : null
  const submit = async (): Promise<void> => {
    if (err || saving) return
    setSaving(true)
    try {
      await onSubmit(v)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!!err} loading={saving}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label} hint={hint}>
        <Input
          ref={ref}
          mono={mono}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
        />
      </Field>
      {err && value && <div className="text-xs text-danger-fg mt-2">{err}</div>}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Compress dialog                                                     */
/* ------------------------------------------------------------------ */

function CompressDialog({ paths, dir, onClose, onSubmit }: { paths: string[]; dir: string; onClose: () => void; onSubmit: (archivePath: string, format: ArchiveFormat) => Promise<void> }): React.JSX.Element {
  const base = paths.length === 1 ? pbasename(paths[0]) : 'archive'
  const [format, setFormat] = useState<ArchiveFormat>('tar.gz')
  const [name, setName] = useState(`${base}.tar.gz`)
  const [saving, setSaving] = useState(false)
  const changeFormat = (f: ArchiveFormat): void => {
    setFormat(f)
    setName((n) => n.replace(/\.(tar\.gz|tar\.xz|zip)$/i, '') + '.' + f)
  }
  const ok = name.trim() && !name.includes('/')
  const submit = async (): Promise<void> => {
    if (!ok || saving) return
    setSaving(true)
    try {
      await onSubmit(pjoin(dir, name.trim()), format)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Compress"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!ok} loading={saving} icon={<Archive size={13} />}>
            Create archive
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Field label="Archive name" className="col-span-2">
          <Input
            mono
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </Field>
        <Field label="Format">
          <Select value={format} onChange={(e) => changeFormat(e.target.value as ArchiveFormat)}>
            <option value="tar.gz">tar.gz</option>
            <option value="tar.xz">tar.xz</option>
            <option value="zip">zip</option>
          </Select>
        </Field>
      </div>
      <div className="mt-4 text-xs text-muted">
        {paths.length} item{paths.length === 1 ? '' : 's'} from <span className="font-mono text-text">{pdirname(paths[0])}</span> will be archived to <span className="font-mono text-text">{pjoin(dir, name.trim() || '…')}</span>.
        <div className="mt-2 max-h-28 overflow-auto font-mono text-[11px] text-dim bg-bg-2 border border-border rounded p-2 whitespace-pre-wrap">{paths.map(pbasename).join('\n')}</div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Permissions dialog                                                  */
/* ------------------------------------------------------------------ */

function PermissionsDialog({ rows, onClose, onSubmit }: { rows: FileRow[]; onClose: () => void; onSubmit: (mode: string, recursive: boolean) => Promise<void> }): React.JSX.Element {
  const initial = rows.length === 1 ? rows[0].mode & 0o7777 : 0o644
  const [mode, setMode] = useState(initial)
  const [text, setText] = useState(initial.toString(8).padStart(3, '0'))
  const [recursive, setRecursive] = useState(false)
  const [saving, setSaving] = useState(false)
  const hasDir = rows.some(isDirLike)
  const setBit = (bit: number, on: boolean): void => {
    const m = on ? mode | bit : mode & ~bit
    setMode(m)
    setText(m.toString(8).padStart(3, '0'))
  }
  const onText = (v: string): void => {
    setText(v)
    if (/^[0-7]{3,4}$/.test(v)) setMode(parseInt(v, 8))
  }
  const valid = /^[0-7]{3,4}$/.test(text)
  const submit = async (): Promise<void> => {
    if (!valid || saving) return
    setSaving(true)
    try {
      await onSubmit(text, recursive)
    } finally {
      setSaving(false)
    }
  }
  const who: { label: string; shift: number }[] = [
    { label: 'Owner', shift: 6 },
    { label: 'Group', shift: 3 },
    { label: 'Others', shift: 0 }
  ]
  const perms: { label: string; bit: number }[] = [
    { label: 'Read', bit: 4 },
    { label: 'Write', bit: 2 },
    { label: 'Execute', bit: 1 }
  ]
  const presets = [
    ['644', 'rw-r--r--'],
    ['600', 'rw-------'],
    ['664', 'rw-rw-r--'],
    ['755', 'rwxr-xr-x'],
    ['700', 'rwx------'],
    ['775', 'rwxrwxr-x'],
    ['777', 'rwxrwxrwx']
  ]
  return (
    <Modal
      open
      onClose={onClose}
      title="Permissions"
      badge={rows.length === 1 ? <span className="font-mono text-xs text-muted font-normal truncate max-w-xs">{rows[0].name}</span> : <Badge>{rows.length} items</Badge>}
      footer={
        <>
          {hasDir && <Checkbox checked={recursive} onChange={setRecursive} label="Apply recursively to contents" className="mr-auto" />}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid} loading={saving} icon={<Lock size={13} />}>
            Apply
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_auto] gap-6">
        <table className="text-[13px]">
          <thead>
            <tr className="text-muted text-xs">
              <th className="text-left font-medium pb-2"></th>
              {perms.map((p) => (
                <th key={p.label} className="font-medium pb-2 px-3 text-center">
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {who.map((w) => (
              <tr key={w.label} className="border-t border-border/60">
                <td className="py-2 pr-3 text-muted">{w.label}</td>
                {perms.map((p) => {
                  const bit = p.bit << w.shift
                  return (
                    <td key={p.label} className="py-2 px-3 text-center">
                      <Checkbox checked={(mode & bit) !== 0} onChange={(v) => setBit(bit, v)} />
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr className="border-t border-border/60">
              <td className="py-2 pr-3 text-muted">Special</td>
              <td className="py-2 px-3 text-center" title="setuid">
                <Checkbox checked={(mode & 0o4000) !== 0} onChange={(v) => setBit(0o4000, v)} label={<span className="text-[11px] text-dim">suid</span>} />
              </td>
              <td className="py-2 px-3 text-center" title="setgid">
                <Checkbox checked={(mode & 0o2000) !== 0} onChange={(v) => setBit(0o2000, v)} label={<span className="text-[11px] text-dim">sgid</span>} />
              </td>
              <td className="py-2 px-3 text-center" title="sticky">
                <Checkbox checked={(mode & 0o1000) !== 0} onChange={(v) => setBit(0o1000, v)} label={<span className="text-[11px] text-dim">sticky</span>} />
              </td>
            </tr>
          </tbody>
        </table>
        <div className="w-44 flex flex-col gap-3">
          <Field label="Numeric">
            <Input mono value={text} onChange={(e) => onText(e.target.value)} className={cls(!valid && 'border-danger')} />
          </Field>
          <div className="font-mono text-xs text-muted bg-bg-2 border border-border rounded px-2 py-1.5 text-center">{modeToString((rows.length === 1 ? rows[0].mode & 0o170000 : 0o100000) | mode)}</div>
          <div className="flex flex-wrap gap-1">
            {presets.map(([n, s]) => (
              <button key={n} type="button" title={s} onClick={() => onText(n)} className={cls('px-1.5 h-6 rounded border text-[11px] font-mono', text === n ? 'bg-accent/20 border-accent/40 text-text' : 'bg-panel-2 border-border-2 text-muted hover:text-text')}>
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
      {rows.length > 1 && <Callout>The same mode is applied to all {rows.length} selected items.</Callout>}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Owner dialog                                                        */
/* ------------------------------------------------------------------ */

function OwnerDialog({ serverId, rows, onClose, onSubmit }: { serverId: string; rows: FileRow[]; onClose: () => void; onSubmit: (owner: string, group: string, recursive: boolean) => Promise<void> }): React.JSX.Element {
  const { data, loading, error } = useAsync(() => api.call<UsersGroups>('files:usersGroups', serverId), [serverId])
  const [owner, setOwner] = useState(rows[0]?.owner ?? '')
  const [group, setGroup] = useState(rows[0]?.group ?? '')
  const [recursive, setRecursive] = useState(false)
  const [saving, setSaving] = useState(false)
  const hasDir = rows.some(isDirLike)
  const users = useMemo(() => {
    const u = data?.users ?? []
    return owner && !u.includes(owner) ? [owner, ...u] : u
  }, [data, owner])
  const groups = useMemo(() => {
    const g = data?.groups ?? []
    return group && !g.includes(group) ? [group, ...g] : g
  }, [data, group])
  const valid = /^[A-Za-z0-9_][A-Za-z0-9_.@$\-]*$/.test(owner) && (group === '' || /^[A-Za-z0-9_][A-Za-z0-9_.@$\-]*$/.test(group))
  const submit = async (): Promise<void> => {
    if (!valid || saving) return
    setSaving(true)
    try {
      await onSubmit(owner, group, recursive)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Change owner"
      badge={rows.length === 1 ? <span className="font-mono text-xs text-muted font-normal truncate max-w-xs">{rows[0].name}</span> : <Badge>{rows.length} items</Badge>}
      footer={
        <>
          {hasDir && <Checkbox checked={recursive} onChange={setRecursive} label="Apply recursively to contents" className="mr-auto" />}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid || loading} loading={saving} icon={<UserCog size={13} />}>
            Apply
          </Button>
        </>
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Owner" hint={loading ? 'Loading users…' : undefined}>
          <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
            {users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Group" hint={loading ? 'Loading groups…' : undefined}>
          <Select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">(keep current)</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-4 text-xs text-muted">
        Current: <span className="font-mono text-text">{rows[0]?.owner}:{rows[0]?.group}</span>
        {rows.length > 1 && ` (first of ${rows.length} items)`}. Changing ownership usually requires sudo.
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function EditorModal({ editor, busy, canSudo, onChange, onSave, onClose, onDownload }: { editor: EditorState; busy: boolean; canSudo: boolean; onChange: (c: string) => void; onSave: (asSudo?: boolean) => void; onClose: () => void; onDownload: () => void }): React.JSX.Element {
  const dirty = !editor.loading && editor.content !== editor.original
  const lines = useMemo(() => (editor.content ? editor.content.split('\n').length : 0), [editor.content])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const readOnly = editor.loading || editor.binary || editor.truncated || !!editor.error
  const updateCursor = (): void => {
    const el = taRef.current
    if (!el) return
    const before = el.value.slice(0, el.selectionStart)
    const ln = before.split('\n')
    setCursor({ line: ln.length, col: (ln[ln.length - 1]?.length ?? 0) + 1 })
  }
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (!readOnly) onSave()
    } else if (e.key === 'Tab' && !readOnly) {
      e.preventDefault()
      const el = e.currentTarget
      const s = el.selectionStart
      const en = el.selectionEnd
      const next = el.value.slice(0, s) + '\t' + el.value.slice(en)
      onChange(next)
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = s + 1
      })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-6xl"
      title={
        <span className="flex items-center gap-2 min-w-0">
          <FileText size={15} className="text-muted shrink-0" />
          <span className="font-mono text-[13px] truncate">{editor.path}</span>
        </span>
      }
      badge={
        <>
          {editor.sudo && <Badge color="warn">root</Badge>}
          {dirty && <Badge color="accent">modified</Badge>}
          {editor.truncated && <Badge color="danger">truncated</Badge>}
          {editor.binary && <Badge color="danger">binary</Badge>}
        </>
      }
      footer={
        <>
          <div className="text-[11px] text-muted flex items-center gap-3 mr-auto">
            <span>{fmtBytes(editor.size)}</span>
            <span>{lines} lines</span>
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span className="font-mono">{modeToString(0o100000 | editor.mode)}</span>
            <span className="text-dim">Ctrl+S to save</span>
          </div>
          <Button icon={<Download size={13} />} onClick={onDownload}>
            Download
          </Button>
          <Button onClick={onClose}>{dirty ? 'Discard & close' : 'Close'}</Button>
          {canSudo && !editor.sudo && !readOnly && (
            <Button onClick={() => onSave(true)} disabled={busy} icon={<ShieldCheck size={13} />} title="Write the file as root (sudo)">
              Save as admin
            </Button>
          )}
          <Button variant="primary" onClick={() => onSave()} disabled={readOnly || !dirty} loading={busy} icon={<Save size={13} />}>
            Save
          </Button>
        </>
      }
    >
      {editor.loading ? (
        <Loading label="Reading file…" />
      ) : editor.error ? (
        <ErrorBox error={editor.error} />
      ) : editor.binary ? (
        <Callout kind="warn">
          This looks like a binary file ({fmtBytes(editor.size)}). It cannot be edited here — download it instead.
        </Callout>
      ) : (
        <>
          {editor.truncated && (
            <div className="mb-2">
              <Callout kind="warn">This file is larger than the editor limit; only the first {fmtBytes(editor.content.length)} of {fmtBytes(editor.size)} are shown. Saving is disabled to avoid truncating it.</Callout>
            </div>
          )}
          <textarea
            ref={taRef}
            value={editor.content}
            readOnly={readOnly}
            spellCheck={false}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            onKeyUp={updateCursor}
            onClick={updateCursor}
            wrap="off"
            className="w-full h-[68vh] bg-bg-2 border border-border-2 rounded-md p-3 font-mono text-xs leading-[1.6] outline-none focus:border-accent resize-none whitespace-pre"
            style={{ tabSize: 4 }}
          />
        </>
      )}
    </Modal>
  )
}
