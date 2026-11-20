import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { cls } from '@/lib/format'
import { errMsg } from '@/lib/api'
import { useApp } from '@/store/app'

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger' | 'subtle'
export type ButtonSize = 'xs' | 'sm' | 'md'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}

const btnVariant: Record<ButtonVariant, string> = {
  primary: 'bg-accent hover:bg-accent-2 text-on-accent border-transparent shadow-sm',
  default: 'bg-panel-2 hover:bg-border-2 text-text border-border-2',
  ghost: 'bg-transparent hover:bg-panel-2 text-muted hover:text-text border-transparent',
  subtle: 'bg-transparent hover:bg-panel-2 text-text border-border',
  danger: 'bg-danger/15 hover:bg-danger/25 text-danger-fg border-danger/30'
}
const btnSize: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-md'
}

export function Button({ variant = 'default', size = 'sm', loading, icon, className, children, disabled, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cls(
        'inline-flex items-center justify-center border font-medium whitespace-nowrap select-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        btnVariant[variant],
        btnSize[size],
        className
      )}
    >
      {loading ? <Loader2 size={size === 'xs' ? 11 : 14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ title, className, size = 'sm', ...rest }: ButtonProps & { title: string }): React.JSX.Element {
  return <Button variant="ghost" size={size} title={title} aria-label={title} className={cls('px-1.5', className)} {...rest} />
}

/* ------------------------------------------------------------------ */
/* Card / layout                                                       */
/* ------------------------------------------------------------------ */

export function Card({ title, actions, children, className, bodyClass, flush }: { title?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; bodyClass?: string; flush?: boolean }): React.JSX.Element {
  return (
    <section className={cls('bg-panel border border-border rounded-lg flex flex-col min-w-0', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between px-4 h-11 border-b border-border shrink-0">
          <h3 className="font-semibold text-[13px] truncate">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cls(flush ? '' : 'p-4', 'min-w-0', bodyClass)}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-6 h-14 shrink-0">
      <div className="flex items-baseline gap-3 min-w-0">
        <h1 className="text-[15px] font-semibold">{title}</h1>
        {subtitle && <span className="text-muted text-xs truncate">{subtitle}</span>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  )
}

/** Standard scrolling page body. */
export function Page({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={cls('flex-1 min-h-0 overflow-auto px-6 pb-6', className)}>{children}</div>
}

export function Stat({ label, value, unit, sub, bar, color }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; bar?: number; color?: string }): React.JSX.Element {
  const c = color ?? (bar !== undefined && bar > 90 ? 'bg-danger' : bar !== undefined && bar > 75 ? 'bg-warn' : 'bg-accent')
  return (
    <div className="bg-panel border border-border rounded-lg p-4 min-w-0">
      <div className="text-muted text-xs mb-1">{label}</div>
      <div className="text-2xl font-semibold tracking-tight">
        {value}
        {unit && <span className="text-sm text-muted ml-0.5">{unit}</span>}
      </div>
      {bar !== undefined && (
        <div className="h-1 bg-border rounded mt-2 overflow-hidden">
          <div className={cls('h-full rounded transition-all', c)} style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
        </div>
      )}
      {sub && <div className="text-dim text-[11px] mt-2 truncate">{sub}</div>}
    </div>
  )
}

export function KV({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }): React.JSX.Element {
  return (
    <dl className={cls('grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px]', className)}>
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function Badge({ children, color = 'muted', className }: { children: ReactNode; color?: 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'accent'; className?: string }): React.JSX.Element {
  const map = {
    ok: 'bg-ok/15 text-ok-fg border-ok/30',
    warn: 'bg-warn/15 text-warn-fg border-warn/30',
    danger: 'bg-danger/15 text-danger-fg border-danger/30',
    info: 'bg-info/15 text-info-fg border-info/30',
    accent: 'bg-accent/15 text-accent-fg border-accent/30',
    muted: 'bg-panel-2 text-muted border-border-2'
  }
  return <span className={cls('inline-flex items-center px-1.5 h-5 rounded text-[11px] font-medium border whitespace-nowrap', map[color], className)}>{children}</span>
}

export function Dot({ status }: { status: 'ok' | 'warn' | 'danger' | 'muted' | 'info' }): React.JSX.Element {
  const map = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', muted: 'bg-dim', info: 'bg-info' }
  return <span className={cls('inline-block w-2 h-2 rounded-full', map[status])} />
}

export function Spinner({ className, size = 16 }: { className?: string; size?: number }): React.JSX.Element {
  return <Loader2 size={size} className={cls('animate-spin text-muted', className)} />
}

export function Loading({ label = 'Loading…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 text-muted py-16">
      <Spinner /> {label}
    </div>
  )
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6 gap-2">
      {icon && <div className="text-dim mb-1 [&>svg]:w-8 [&>svg]:h-8">{icon}</div>}
      <div className="font-medium text-[14px]">{title}</div>
      {description && <div className="text-muted text-xs max-w-md">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 bg-danger/10 border border-danger/30 text-danger-fg rounded-md p-3 text-xs">
      <AlertTriangle size={16} className="shrink-0 mt-0.5" />
      <div className="flex-1 whitespace-pre-wrap break-words font-mono">{errMsg(error)}</div>
      {onRetry && (
        <Button size="xs" variant="subtle" onClick={onRetry} icon={<RefreshCw size={11} />}>
          Retry
        </Button>
      )}
    </div>
  )
}

export function Callout({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'warn' | 'danger' }): React.JSX.Element {
  const map = { info: 'bg-panel-2 border-border-2 text-muted', warn: 'bg-warn/10 border-warn/30 text-warn-fg', danger: 'bg-danger/10 border-danger/30 text-danger-fg' }
  return <div className={cls('border rounded-md px-3 py-2 text-xs leading-relaxed', map[kind])}>{children}</div>
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

const inputBase = 'w-full bg-bg-2 border border-border-2 rounded-md px-2.5 h-8 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50 placeholder:text-dim'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} {...rest} className={cls(inputBase, mono && 'font-mono', className)} />
})

export function TextArea({ className, mono, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }): React.JSX.Element {
  return <textarea {...rest} className={cls(inputBase, 'h-auto py-2 leading-relaxed resize-y', mono && 'font-mono text-xs', className)} />
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <div className="relative">
      <select {...rest} className={cls(inputBase, 'appearance-none pr-8', className)}>
        {children}
      </select>
      <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
    </div>
  )
}

export function Field({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <label className={cls('block', className)}>
      {label && <div className="text-xs text-muted mb-1.5 font-medium">{label}</div>}
      {children}
      {hint && <div className="text-[11px] text-dim mt-1.5 leading-relaxed">{hint}</div>}
    </label>
  )
}

export function Checkbox({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; className?: string }): React.JSX.Element {
  return (
    <label className={cls('inline-flex items-center gap-2 cursor-pointer select-none text-[13px]', disabled && 'opacity-50 cursor-not-allowed', className)}>
      <span
        onClick={() => !disabled && onChange(!checked)}
        className={cls('w-4 h-4 rounded border flex items-center justify-center transition-colors', checked ? 'bg-accent border-accent' : 'bg-bg-2 border-border-2')}
      >
        {checked && <Check size={12} strokeWidth={3} className="text-on-accent" />}
      </span>
      {label && <span onClick={() => !disabled && onChange(!checked)}>{label}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }): React.JSX.Element {
  return (
    <label className={cls('inline-flex items-center gap-2 cursor-pointer select-none text-[13px]', disabled && 'opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cls('relative w-9 h-5 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-border-2')}
      >
        <span className={cls('absolute top-0.5 w-4 h-4 rounded-full transition-all shadow-sm', checked ? 'left-[18px] bg-on-accent' : 'left-0.5 bg-text')} />
      </button>
      {label}
    </label>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Filter', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }): React.JSX.Element {
  return (
    <div className={cls('relative', className)}>
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cls(inputBase, 'pl-7 h-7 text-xs')} />
      {value && (
        <button onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-text">
          <X size={12} />
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }): React.JSX.Element {
  return (
    <div className={cls('inline-flex items-center gap-1 bg-bg-2 border border-border rounded-md p-0.5', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cls('px-3 h-6 rounded text-xs font-medium transition-colors flex items-center gap-1.5', value === t.id ? 'bg-panel-2 text-text shadow-sm' : 'text-muted hover:text-text')}
        >
          {t.label}
          {t.count !== undefined && <span className="text-[10px] bg-border-2 rounded px-1">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: string
  align?: 'left' | 'right' | 'center'
  mono?: boolean
  sortValue?: (row: T) => string | number
}

export function Table<T>({ columns, rows, rowKey, onRowClick, onRowContextMenu, selected, empty, dense, stickyHeader = true, className, initialSort }: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T, e: React.MouseEvent) => void
  onRowContextMenu?: (row: T, e: React.MouseEvent) => void
  selected?: (row: T) => boolean
  empty?: ReactNode
  dense?: boolean
  stickyHeader?: boolean
  className?: string
  initialSort?: { key: string; dir: 'asc' | 'desc' }
}): React.JSX.Element {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null)
  let sorted = rows
  const sc = sort ? columns.find((c) => c.key === sort.key) : undefined
  if (sort && sc?.sortValue) {
    const sv = sc.sortValue
    sorted = [...rows].sort((a, b) => {
      const va = sv(a)
      const vb = sv(b)
      const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true })
      return sort.dir === 'asc' ? r : -r
    })
  }
  return (
    <div className={cls('overflow-auto', className)}>
      <table className="w-full text-[13px] border-collapse">
        <thead className={cls(stickyHeader && 'sticky top-0 z-10')}>
          <tr className="bg-panel text-muted text-xs text-left">
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width }}
                onClick={() => c.sortValue && setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }))}
                className={cls('font-medium px-3 py-2 border-b border-border whitespace-nowrap select-none', c.sortValue && 'cursor-pointer hover:text-text', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}
              >
                {c.header}
                {sort?.key === c.key && <span className="ml-1 text-dim">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center text-muted py-10">
                {empty ?? 'Nothing to show'}
              </td>
            </tr>
          )}
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={(e) => onRowClick?.(row, e)}
              onContextMenu={(e) => {
                if (onRowContextMenu) {
                  e.preventDefault()
                  onRowContextMenu(row, e)
                }
              }}
              className={cls('border-b border-border/60 transition-colors', (onRowClick || onRowContextMenu) && 'cursor-default hover:bg-panel-2/70', selected?.(row) && 'bg-accent/15 hover:bg-accent/20')}
            >
              {columns.map((c) => (
                <td key={c.key} className={cls('px-3 align-middle', dense ? 'py-1' : 'py-1.5', c.mono && 'font-mono text-xs', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Modal / confirm                                                     */
/* ------------------------------------------------------------------ */

export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg', badge }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; badge?: ReactNode }): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cls('bg-panel border border-border-2 rounded-lg shadow-2xl w-full mx-4 flex flex-col max-h-[90vh]', width)}>
        <header className="flex items-center justify-between px-5 h-12 border-b border-border shrink-0">
          <h2 className="font-semibold text-[14px] flex items-center gap-2">
            {title}
            {badge}
          </h2>
          <button onClick={onClose} className="text-muted hover:text-text">
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-4 overflow-auto min-h-0 flex-1">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 px-5 h-14 border-t border-border shrink-0">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

interface ConfirmOpts {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** Require the user to type this text (e.g. a hostname) before confirming. */
  typeToConfirm?: string
}

let confirmResolver: ((v: boolean) => void) | null = null
let confirmSetter: ((o: ConfirmOpts | null) => void) | null = null

/** Imperative confirm dialog: `if (await confirm({...})) …` */
export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    confirmResolver = resolve
    confirmSetter?.(opts)
  })
}

export function ConfirmHost(): React.JSX.Element | null {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    confirmSetter = (o) => {
      setTyped('')
      setOpts(o)
    }
    return () => {
      confirmSetter = null
    }
  }, [])
  const done = useCallback((v: boolean) => {
    setOpts(null)
    confirmResolver?.(v)
    confirmResolver = null
  }, [])
  if (!opts) return null
  const canConfirm = !opts.typeToConfirm || typed === opts.typeToConfirm
  return (
    <Modal
      open
      onClose={() => done(false)}
      title={opts.title}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant={opts.danger ? 'danger' : 'primary'} disabled={!canConfirm} onClick={() => done(true)} autoFocus>
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed">{opts.message}</div>
      {opts.typeToConfirm && (
        <Field label={<span>Type <b className="font-mono text-text">{opts.typeToConfirm}</b> to confirm</span>} className="mt-4">
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} mono autoFocus />
        </Field>
      )}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  label: ReactNode
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])
  useEffect(() => {
    const close = (): void => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', close)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} className="fixed z-[60] min-w-[180px] bg-panel-2 border border-border-2 rounded-md shadow-xl py-1 fade-in text-[13px]">
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 border-t border-border" />
        ) : (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick?.()
            }}
            className={cls('w-full flex items-center gap-2 px-3 h-7 text-left hover:bg-border-2 disabled:opacity-40 disabled:hover:bg-transparent', it.danger && 'text-danger-fg')}
          >
            <span className="w-4 flex justify-center [&>svg]:w-3.5 [&>svg]:h-3.5">{it.icon}</span>
            {it.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** Dropdown button with a menu. */
export function MenuButton({ label, items, variant = 'default', size = 'sm', icon }: { label: ReactNode; items: MenuItem[]; variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={icon}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setOpen({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {label}
        <ChevronDown size={12} className="opacity-60" />
      </Button>
      {open && <ContextMenu x={open.x} y={open.y} items={items} onClose={() => setOpen(null)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Poll/load helper: runs `fn` on mount and whenever deps change; optional interval refresh.
 * Returns { data, error, loading, reload }.
 */
/** Last successful result per cacheKey, so a page shows its previous data instantly when re-opened. */
const asyncCache = new Map<string, unknown>()

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { intervalMs?: number; enabled?: boolean; cacheKey?: string } = {}): { data: T | undefined; error: unknown; loading: boolean; reload: () => Promise<void>; setData: (d: T) => void } {
  const cacheKey = opts.cacheKey
  const [data, setDataState] = useState<T | undefined>(() => (cacheKey ? (asyncCache.get(cacheKey) as T | undefined) : undefined))
  const [error, setError] = useState<unknown>(undefined)
  const [loading, setLoading] = useState(() => !(cacheKey && asyncCache.has(cacheKey)))
  const alive = useRef(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const keyRef = useRef(cacheKey)
  keyRef.current = cacheKey
  const setData = useCallback((d: T) => {
    if (keyRef.current) asyncCache.set(keyRef.current, d)
    setDataState(d)
  }, [])
  const enabled = opts.enabled ?? true
  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current()
      if (alive.current) {
        setData(d)
        setError(undefined)
      }
    } catch (e) {
      if (alive.current) setError(e)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [setData])
  useEffect(() => {
    alive.current = true
    if (!enabled) return
    // When the deps change (e.g. another server) show that key's cached data or a loader.
    const cached = cacheKey ? (asyncCache.get(cacheKey) as T | undefined) : undefined
    setDataState(cached)
    setLoading(cached === undefined)
    void reload()
    let timer: number | undefined
    if (opts.intervalMs) timer = window.setInterval(() => void reload(), opts.intervalMs)
    return () => {
      alive.current = false
      if (timer) window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, opts.intervalMs])
  return { data, error, loading, reload, setData }
}

/** Run an action with toast on error and optional success message. Returns [run, busy]. */
export function useAction(): { run: <T>(fn: () => Promise<T>, opts?: { success?: string; error?: string }) => Promise<T | undefined>; busy: boolean } {
  const [busy, setBusy] = useState(false)
  const toast = useApp((s) => s.toast)
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, opts?: { success?: string; error?: string }): Promise<T | undefined> => {
      setBusy(true)
      try {
        const r = await fn()
        if (opts?.success) toast({ kind: 'success', title: opts.success })
        return r
      } catch (e) {
        toast({ kind: 'error', title: opts?.error ?? 'Action failed', detail: errMsg(e) })
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [toast]
  )
  return { run, busy }
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function Toaster(): React.JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  const colors = { info: 'border-info/40', success: 'border-ok/40', error: 'border-danger/50', warn: 'border-warn/50' }
  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 w-[360px] pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className={cls('pointer-events-auto bg-panel-2 border rounded-md shadow-xl px-3 py-2.5 fade-in text-[13px]', colors[t.kind])}>
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{t.title}</div>
              {t.detail && <div className="text-muted text-xs mt-0.5 whitespace-pre-wrap break-words max-h-24 overflow-auto font-mono">{t.detail}</div>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-dim hover:text-text">
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function Pre({ children, className, maxH = 'max-h-80' }: { children: ReactNode; className?: string; maxH?: string }): React.JSX.Element {
  return <pre className={cls('bg-bg-2 border border-border rounded-md p-3 text-xs font-mono overflow-auto whitespace-pre-wrap break-words', maxH, className)}>{children}</pre>
}

export function ProgressBar({ value, className, color }: { value: number; className?: string; color?: string }): React.JSX.Element {
  const c = color ?? (value > 90 ? 'bg-danger' : value > 75 ? 'bg-warn' : 'bg-accent')
  return (
    <div className={cls('h-1.5 bg-border rounded overflow-hidden', className)}>
      <div className={cls('h-full rounded transition-all', c)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

export function Row({ icon, title, description, value, valueSub, action, children }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; value?: ReactNode; valueSub?: ReactNode; action?: ReactNode; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border/60 last:border-b-0 min-h-[56px]">
      {icon && <div className="text-muted shrink-0 [&>svg]:w-4 [&>svg]:h-4">{icon}</div>}
      <div className="w-40 shrink-0">
        <div className="font-medium text-[13px]">{title}</div>
        {description && <div className="text-dim text-[11px]">{description}</div>}
      </div>
      <div className="flex-1 min-w-0">
        {value !== undefined && <div className="text-[13px] truncate">{value}</div>}
        {valueSub && <div className="text-muted text-[11px] truncate">{valueSub}</div>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
