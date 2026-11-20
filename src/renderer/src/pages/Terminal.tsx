import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ChevronDown, ChevronUp, Copy, Eraser, Highlighter, Plus, Search, X, ClipboardPaste } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api, errMsg } from '@/lib/api'
import { useApp } from '@/store/app'
import { Button, Input } from '@/components/ui'
import { cls } from '@/lib/format'

/* ------------------------------------------------------------------ */
/* Persistent terminal registry (survives page switches)                */
/* ------------------------------------------------------------------ */

interface TermTab {
  id: number
  title: string
  ptyId: string | null
  term: XTerm
  fit: FitAddon
  search: SearchAddon
  el: HTMLDivElement
  exited: boolean
  highlight: boolean
}

interface ServerTerms {
  tabs: TermTab[]
  active: number
  seq: number
}

const registry = new Map<string, ServerTerms>()
const byPty = new Map<string, TermTab>()
let listenerInstalled = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function installListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  api.onEvent((e) => {
    if (e.type === 'terminal:data') {
      const t = byPty.get(e.ptyId)
      if (t) t.term.write(t.highlight ? highlightOutput(e.data) : e.data)
    } else if (e.type === 'terminal:exit') {
      const t = byPty.get(e.ptyId)
      if (t) {
        t.exited = true
        t.term.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n')
        byPty.delete(e.ptyId)
        notify()
      }
    }
  })
}

/** Colour obvious error/warning/success words in command output (never touches escape sequences already present). */
function highlightOutput(data: string): string {
  if (data.includes('\x1b[')) return data
  return data
    .replace(/\b(error|failed|fatal|denied|cannot|not found|exception|traceback)\b/gi, '\x1b[31m$1\x1b[0m')
    .replace(/\b(warning|warn|deprecated)\b/gi, '\x1b[33m$1\x1b[0m')
    .replace(/\b(success|successfully|done|ok|active \(running\))\b/gi, '\x1b[32m$1\x1b[0m')
}

function getServerTerms(serverId: string): ServerTerms {
  let s = registry.get(serverId)
  if (!s) {
    s = { tabs: [], active: 0, seq: 0 }
    registry.set(serverId, s)
  }
  return s
}

function createTab(serverId: string, title?: string): TermTab {
  const settings = useApp.getState().settings
  const term = new XTerm({
    cursorBlink: true,
    fontSize: settings.terminalFontSize,
    fontFamily: settings.terminalFontFamily,
    scrollback: settings.terminalScrollback,
    allowProposedApi: true,
    theme: {
      background: '#0f1115',
      foreground: '#e6e8ee',
      cursor: '#e6e8ee',
      selectionBackground: '#3b82f680',
      black: '#1e222b',
      red: '#ef5350',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e6e8ee',
      brightBlack: '#6b7282',
      brightRed: '#f87171',
      brightGreen: '#86efac',
      brightYellow: '#fde68a',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#ffffff'
    }
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)))
  const el = document.createElement('div')
  el.className = 'absolute inset-0'
  const s = getServerTerms(serverId)
  s.seq++
  const tab: TermTab = { id: s.seq, title: title ?? `Shell ${s.seq}`, ptyId: null, term, fit, search, el, exited: false, highlight: false }
  s.tabs.push(tab)
  s.active = tab.id
  term.open(el)
  // Clipboard shortcuts: Ctrl+Shift+C / Ctrl+Shift+V, and Ctrl+C copies when there is a selection.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'c') {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'v') {
      void navigator.clipboard.readText().then((t) => tab.ptyId && api.call('terminal:write', serverId, tab.ptyId, t))
      return false
    }
    if (ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    return true
  })
  term.onData((d) => {
    if (tab.ptyId && !tab.exited) void api.call('terminal:write', serverId, tab.ptyId, d)
  })
  term.onResize(({ cols, rows }) => {
    if (tab.ptyId && !tab.exited) void api.call('terminal:resize', serverId, tab.ptyId, cols, rows)
  })
  term.onTitleChange((t) => {
    if (t && t.length < 60) {
      tab.title = t
      notify()
    }
  })
  return tab
}

async function startPty(serverId: string, tab: TermTab, command?: string): Promise<void> {
  try {
    const { ptyId } = await api.call<{ ptyId: string }>('terminal:open', serverId, { cols: tab.term.cols || 100, rows: tab.term.rows || 30, command })
    tab.ptyId = ptyId
    byPty.set(ptyId, tab)
    // Make sure the server knows the real size once the DOM has laid out.
    setTimeout(() => void api.call('terminal:resize', serverId, ptyId, tab.term.cols, tab.term.rows), 50)
  } catch (e) {
    tab.term.write(`\r\n\x1b[31mCould not open shell: ${errMsg(e)}\x1b[0m\r\n`)
    tab.exited = true
  }
  notify()
}

function closeTab(serverId: string, tab: TermTab): void {
  const s = getServerTerms(serverId)
  if (tab.ptyId) {
    void api.call('terminal:close', serverId, tab.ptyId)
    byPty.delete(tab.ptyId)
  }
  tab.term.dispose()
  tab.el.remove()
  s.tabs = s.tabs.filter((t) => t !== tab)
  if (s.active === tab.id) s.active = s.tabs[s.tabs.length - 1]?.id ?? 0
  notify()
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function Terminal({ serverId }: PageProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)
  const rerender = useCallback(() => force((n) => n + 1), [])
  const pending = useApp((s) => s.pendingTerminal[serverId])
  const takePending = useApp((s) => s.takePendingTerminal)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const s = getServerTerms(serverId)
  const active = s.tabs.find((t) => t.id === s.active)

  useEffect(() => {
    installListener()
    listeners.add(rerender)
    return () => {
      listeners.delete(rerender)
    }
  }, [rerender])

  const newTab = useCallback(
    (command?: string, title?: string) => {
      const tab = createTab(serverId, title)
      void startPty(serverId, tab, command)
      rerender()
      return tab
    },
    [serverId, rerender]
  )

  // Open the first shell automatically, and consume commands queued from other pages.
  useEffect(() => {
    const cmds = takePending(serverId)
    if (cmds.length) {
      for (const c of cmds) newTab(c, c.split(/\s+/).slice(0, 2).join(' ').slice(0, 24))
    } else if (getServerTerms(serverId).tabs.length === 0) newTab()
  }, [serverId, newTab, takePending, pending])

  // Attach active terminal element to the host and fit.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !active) return
    host.innerHTML = ''
    host.appendChild(active.el)
    const doFit = (): void => {
      try {
        active.fit.fit()
      } catch {
        /* ignore until laid out */
      }
    }
    doFit()
    active.term.focus()
    const ro = new ResizeObserver(() => doFit())
    ro.observe(host)
    return () => {
      ro.disconnect()
      active.el.remove()
    }
  }, [active])

  const copyAll = (): void => {
    if (!active) return
    const buf = active.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    void navigator.clipboard.writeText(lines.join('\n').replace(/\n+$/, ''))
  }
  const paste = (): void => {
    void navigator.clipboard.readText().then((t) => active?.ptyId && api.call('terminal:write', serverId, active.ptyId, t))
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-11 flex items-center border-b border-border px-3 gap-1 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto">
          {s.tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => {
                s.active = t.id
                rerender()
              }}
              onAuxClick={(e) => e.button === 1 && closeTab(serverId, t)}
              className={cls('group flex items-center gap-2 h-7 px-3 rounded-md text-xs cursor-default select-none border', t.id === s.active ? 'bg-panel-2 border-border-2 text-text' : 'border-transparent text-muted hover:text-text hover:bg-panel')}
            >
              <span className={cls('truncate max-w-[160px]', t.exited && 'line-through opacity-60')}>{t.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(serverId, t)
                }}
                className="text-dim hover:text-text"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => newTab()} title="New shell" />
        </div>
        <div className="flex-1" />
        {active?.exited && (
          <Button size="xs" variant="primary" onClick={() => active && void startPty(serverId, Object.assign(active, { exited: false }))}>
            Reconnect shell
          </Button>
        )}
        <Button
          size="xs"
          variant={active?.highlight ? 'primary' : 'ghost'}
          icon={<Highlighter size={12} />}
          title="Colour errors, warnings and successes in plain command output"
          onClick={() => {
            if (active) {
              active.highlight = !active.highlight
              rerender()
            }
          }}
        >
          Highlight output
        </Button>
        <Button size="xs" variant="ghost" icon={<Search size={12} />} onClick={() => setSearchOpen((v) => !v)} title="Search (Ctrl+F)" />
        <Button size="xs" variant="ghost" icon={<Copy size={12} />} onClick={copyAll} title="Copy whole buffer" />
        <Button size="xs" variant="ghost" icon={<ClipboardPaste size={12} />} onClick={paste} title="Paste (Ctrl+Shift+V)" />
        <Button size="xs" variant="ghost" icon={<Eraser size={12} />} onClick={() => active?.term.clear()} title="Clear" />
      </div>
      {searchOpen && active && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-bg-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              active.search.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.shiftKey ? active.search.findPrevious(query) : active.search.findNext(query)
              if (e.key === 'Escape') setSearchOpen(false)
            }}
            placeholder="Find in terminal"
            className="h-7 text-xs w-72"
          />
          <Button size="xs" variant="ghost" icon={<ChevronUp size={12} />} onClick={() => active.search.findPrevious(query)} />
          <Button size="xs" variant="ghost" icon={<ChevronDown size={12} />} onClick={() => active.search.findNext(query)} />
          <Button size="xs" variant="ghost" icon={<X size={12} />} onClick={() => setSearchOpen(false)} />
        </div>
      )}
      <div
        className="flex-1 min-h-0 relative bg-bg"
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            setSearchOpen(true)
          }
        }}
      >
        <div ref={hostRef} className="absolute inset-0" />
      </div>
    </div>
  )
}
