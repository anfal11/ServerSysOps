import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ChevronDown, ChevronUp, Copy, Eraser, Highlighter, Keyboard, MessageSquareText, Plus, Search, X, ClipboardPaste } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api, errMsg } from '@/lib/api'
import { useApp } from '@/store/app'
import { Button, ContextMenu, Input } from '@/components/ui'
import { cls } from '@/lib/format'
import { terminalTheme } from '@/lib/themes'

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)

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
  window.addEventListener('serversysops:theme', () => {
    const theme = terminalTheme()
    for (const s of registry.values()) for (const tab of s.tabs) tab.term.options.theme = theme
  })
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
    theme: terminalTheme()
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
  // Any native paste event (Win+V clipboard history, Edit menu, drag & drop) goes through our paste
  // path so bracketed-paste handling and chunking are consistent and nothing is sent twice.
  el.addEventListener(
    'paste',
    (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const text = ev.clipboardData?.getData('text/plain') ?? ''
      if (text) pasteText(serverId, tab, text)
    },
    true
  )
  // Clipboard shortcuts: Ctrl+Shift+C / Ctrl+Shift+V, and Ctrl+C copies when there is a selection.
  // macOS uses Cmd+C / Cmd+V, which the browser handles itself (xterm copies on the copy event and our
  // paste listener above takes the paste event), so Ctrl keeps its terminal meaning there.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'c') {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
      return false
    }
    const isPasteKey = (!IS_MAC && ev.ctrlKey && ev.key.toLowerCase() === 'v') || (ev.shiftKey && ev.key === 'Insert')
    if (isPasteKey) {
      // preventDefault stops the browser's own "paste" event, which xterm also listens to; without
      // it the text arrived twice (once from us, once from xterm's native paste handler).
      ev.preventDefault()
      ev.stopPropagation()
      void pasteClipboard(serverId, tab)
      return false
    }
    if (ev.ctrlKey && ev.key === 'Insert') {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
      return false
    }
    if (!IS_MAC && ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
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

/** Write raw text to a tab's shell. Normalises Windows line endings. */
function sendText(serverId: string, tab: TermTab, text: string): void {
  if (!tab.ptyId || tab.exited) return
  const t = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r')
  // Chunk large pastes so the IPC channel and the remote pty keep up.
  const CHUNK = 4096
  for (let i = 0; i < t.length; i += CHUNK) void api.call('terminal:write', serverId, tab.ptyId, t.slice(i, i + CHUNK))
}

/** Paste text into a tab: bracketed paste when the remote app asked for it, raw otherwise. */
function pasteText(serverId: string, tab: TermTab, text: string): void {
  if (!text) return
  if (tab.term.modes.bracketedPasteMode) tab.term.paste(text)
  else sendText(serverId, tab, text)
}

async function pasteClipboard(serverId: string, tab: TermTab): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return
    pasteText(serverId, tab, text)
  } catch {
    useApp.getState().toast({ kind: 'warn', title: 'Clipboard is empty or not readable' })
  }
}

/** Named key sequences for the shortcut bar. */
const KEYS: { label: string; seq: string; title: string }[] = [
  { label: 'Esc', seq: '\x1b', title: 'Escape' },
  { label: 'Tab', seq: '\t', title: 'Tab (completion)' },
  { label: '^C', seq: '\x03', title: 'Ctrl+C – interrupt' },
  { label: '^D', seq: '\x04', title: 'Ctrl+D – end of input / logout' },
  { label: '^Z', seq: '\x1a', title: 'Ctrl+Z – suspend' },
  { label: '^L', seq: '\x0c', title: 'Ctrl+L – clear screen' },
  { label: '^R', seq: '\x12', title: 'Ctrl+R – search history' },
  { label: '^A', seq: '\x01', title: 'Ctrl+A – line start' },
  { label: '^E', seq: '\x05', title: 'Ctrl+E – line end' },
  { label: '^U', seq: '\x15', title: 'Ctrl+U – delete line' },
  { label: '^W', seq: '\x17', title: 'Ctrl+W – delete word' },
  { label: '↑', seq: '\x1b[A', title: 'Arrow up (previous command)' },
  { label: '↓', seq: '\x1b[B', title: 'Arrow down' },
  { label: '←', seq: '\x1b[D', title: 'Arrow left' },
  { label: '→', seq: '\x1b[C', title: 'Arrow right' },
  { label: 'Home', seq: '\x1b[H', title: 'Home' },
  { label: 'End', seq: '\x1b[F', title: 'End' },
  { label: 'PgUp', seq: '\x1b[5~', title: 'Page up' },
  { label: 'PgDn', seq: '\x1b[6~', title: 'Page down' },
  { label: 'F1', seq: '\x1bOP', title: 'F1' },
  { label: 'F2', seq: '\x1bOQ', title: 'F2' },
  { label: 'F5', seq: '\x1b[15~', title: 'F5' },
  { label: 'F10', seq: '\x1b[21~', title: 'F10' }
]

const QUICK_COMMANDS: { label: string; cmd: string }[] = [
  { label: 'sudo -i', cmd: 'sudo -i\n' },
  { label: 'exit', cmd: 'exit\n' },
  { label: 'htop', cmd: 'htop\n' },
  { label: 'df -h', cmd: 'df -h\n' },
  { label: 'free -h', cmd: 'free -h\n' },
  { label: 'journalctl -f', cmd: 'journalctl -f\n' },
  { label: 'docker ps', cmd: 'docker ps\n' },
  { label: 'ls -la', cmd: 'ls -la\n' }
]

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
  const [keysOpen, setKeysOpen] = useState(() => localStorage.getItem('sm.term.keys') === '1')
  const [composeOpen, setComposeOpen] = useState(false)
  const [compose, setCompose] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => localStorage.setItem('sm.term.keys', keysOpen ? '1' : '0'), [keysOpen])
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
    if (active) void pasteClipboard(serverId, active)
  }
  const send = (seq: string): void => {
    if (active) {
      sendText(serverId, active, seq)
      active.term.focus()
    }
  }
  const sendCompose = (mode: 'raw' | 'enter' | 'lines'): void => {
    if (!active || !compose) return
    if (mode === 'raw') sendText(serverId, active, compose)
    else if (mode === 'enter') sendText(serverId, active, compose.replace(/\n?$/, '\n'))
    else {
      // one line at a time with a short gap so each command runs before the next is typed
      const lines = compose.split(/\r?\n/).filter((l) => l.length)
      lines.forEach((l, i) => setTimeout(() => sendText(serverId, active, l + '\n'), i * 120))
    }
    setCompose('')
    active.term.focus()
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
        <Button size="xs" variant={keysOpen ? 'primary' : 'ghost'} icon={<Keyboard size={12} />} onClick={() => setKeysOpen((v) => !v)} title="Show shortcut keys (Esc, Tab, Ctrl+C, arrows…)">
          Keys
        </Button>
        <Button size="xs" variant={composeOpen ? 'primary' : 'ghost'} icon={<MessageSquareText size={12} />} onClick={() => setComposeOpen((v) => !v)} title="Compose: paste or type long / multi-line text and send it to the shell">
          Compose
        </Button>
        <Button size="xs" variant="ghost" icon={<Search size={12} />} onClick={() => setSearchOpen((v) => !v)} title="Search (Ctrl+F)" />
        <Button size="xs" variant="ghost" icon={<Copy size={12} />} onClick={copyAll} title="Copy whole buffer" />
        <Button size="xs" variant="ghost" icon={<ClipboardPaste size={12} />} onClick={paste} title="Paste (Ctrl+V, Shift+Insert, right-click)" />
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
      {keysOpen && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-bg-2 overflow-x-auto">
          {KEYS.map((k) => (
            <button key={k.label} title={k.title} onMouseDown={(e) => e.preventDefault()} onClick={() => send(k.seq)} className="h-6 min-w-[30px] px-1.5 rounded border border-border-2 bg-panel-2 hover:bg-border-2 text-[11px] font-mono shrink-0">
              {k.label}
            </button>
          ))}
          <span className="w-px h-5 bg-border mx-1 shrink-0" />
          {QUICK_COMMANDS.map((c) => (
            <button key={c.label} onMouseDown={(e) => e.preventDefault()} onClick={() => send(c.cmd)} className="h-6 px-2 rounded border border-border bg-bg hover:bg-panel-2 text-[11px] font-mono text-muted hover:text-text shrink-0">
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div
        className="flex-1 min-h-0 relative bg-bg"
        onKeyDown={(e) => {
          if ((IS_MAC ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            setSearchOpen(true)
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            paste()
          }
        }}
      >
        <div ref={hostRef} className="absolute inset-0" />
      </div>
      {composeOpen && (
        <div className="border-t border-border bg-bg-2 p-2 flex gap-2 items-stretch">
          <textarea
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                sendCompose('enter')
              }
            }}
            placeholder="Paste or type text here (multi-line is fine). Ctrl+Enter = send + Enter. Nothing is sent until you click a button."
            spellCheck={false}
            className="flex-1 h-24 bg-bg border border-border-2 rounded-md p-2 text-xs font-mono outline-none focus:border-accent resize-y"
          />
          <div className="flex flex-col gap-1 w-40">
            <Button size="xs" variant="primary" onClick={() => sendCompose('enter')} disabled={!compose} title="Send the text followed by Enter">
              Send + Enter
            </Button>
            <Button size="xs" onClick={() => sendCompose('raw')} disabled={!compose} title="Send exactly as typed (no Enter)">
              Send as typed
            </Button>
            <Button size="xs" onClick={() => sendCompose('lines')} disabled={!compose} title="Send each line as its own command">
              Run line by line
            </Button>
            <Button size="xs" variant="ghost" onClick={() => navigator.clipboard.readText().then((t) => setCompose((c) => c + t)).catch(() => {})} title="Insert clipboard contents into the box">
              Paste into box
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setCompose('')} disabled={!compose}>
              Clear
            </Button>
          </div>
        </div>
      )}
      {menu && active && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Copy', icon: <Copy />, disabled: !active.term.hasSelection(), onClick: () => void navigator.clipboard.writeText(active.term.getSelection()) },
            { label: 'Paste', icon: <ClipboardPaste />, onClick: paste },
            { label: 'Select all', onClick: () => active.term.selectAll() },
            { label: 'Copy whole buffer', onClick: copyAll },
            { separator: true, label: '' },
            { label: 'Send Ctrl+C', onClick: () => send('\x03') },
            { label: 'Send Ctrl+D', onClick: () => send('\x04') },
            { label: 'Clear screen', icon: <Eraser />, onClick: () => active.term.clear() },
            { separator: true, label: '' },
            { label: keysOpen ? 'Hide shortcut keys' : 'Show shortcut keys', icon: <Keyboard />, onClick: () => setKeysOpen((v) => !v) },
            { label: composeOpen ? 'Hide compose box' : 'Compose / paste long text', icon: <MessageSquareText />, onClick: () => setComposeOpen((v) => !v) },
            { label: 'New shell', icon: <Plus />, onClick: () => newTab() }
          ]}
        />
      )}
    </div>
  )
}
