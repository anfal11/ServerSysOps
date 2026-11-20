/**
 * Colour themes. Each theme overrides the CSS custom properties declared in index.css (@theme),
 * so every Tailwind token (bg-panel, text-muted, …) follows automatically.
 */
export interface ThemeDef {
  id: string
  name: string
  kind: 'dark' | 'light'
  /** Swatch colours for the picker: background, panel, accent, text. */
  swatch: [string, string, string, string]
  vars: Record<string, string>
}

const mk = (id: string, name: string, kind: 'dark' | 'light', v: { bg: string; bg2: string; panel: string; panel2: string; border: string; border2: string; text: string; muted: string; dim: string; accent: string; accent2: string; ok?: string; warn?: string; danger?: string; info?: string }): ThemeDef => ({
  id,
  name,
  kind,
  swatch: [v.bg, v.panel2, v.accent, v.text],
  vars: {
    '--color-bg': v.bg,
    '--color-bg-2': v.bg2,
    '--color-panel': v.panel,
    '--color-panel-2': v.panel2,
    '--color-border': v.border,
    '--color-border-2': v.border2,
    '--color-text': v.text,
    '--color-muted': v.muted,
    '--color-dim': v.dim,
    '--color-accent': v.accent,
    '--color-accent-2': v.accent2,
    '--color-ok': v.ok ?? '#22c55e',
    '--color-warn': v.warn ?? '#f59e0b',
    '--color-danger': v.danger ?? '#ef4444',
    '--color-info': v.info ?? '#38bdf8'
  }
})

export const THEMES: ThemeDef[] = [
  mk('graphite', 'Graphite (default)', 'dark', { bg: '#0f1115', bg2: '#14171d', panel: '#181b22', panel2: '#1e222b', border: '#262a34', border2: '#2f3440', text: '#e6e8ee', muted: '#9aa1b2', dim: '#6b7282', accent: '#3b82f6', accent2: '#2563eb' }),
  mk('midnight', 'Midnight Blue', 'dark', { bg: '#0b1220', bg2: '#0f1829', panel: '#121d33', panel2: '#17253f', border: '#1f2f4d', border2: '#2a3d60', text: '#e2e8f0', muted: '#94a3b8', dim: '#64748b', accent: '#38bdf8', accent2: '#0ea5e9', info: '#7dd3fc' }),
  mk('dracula', 'Dracula', 'dark', { bg: '#1e1f29', bg2: '#242631', panel: '#282a36', panel2: '#2f3242', border: '#3b3e52', border2: '#44475a', text: '#f8f8f2', muted: '#b4b8cf', dim: '#7c7f99', accent: '#bd93f9', accent2: '#a97ff2', ok: '#50fa7b', warn: '#f1fa8c', danger: '#ff5555', info: '#8be9fd' }),
  mk('nord', 'Nord', 'dark', { bg: '#242933', bg2: '#2a3040', panel: '#2e3440', panel2: '#3b4252', border: '#434c5e', border2: '#4c566a', text: '#eceff4', muted: '#b8c0d2', dim: '#7b869c', accent: '#88c0d0', accent2: '#81a1c1', ok: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a', info: '#8fbcbb' }),
  mk('mocha', 'Catppuccin Mocha', 'dark', { bg: '#11111b', bg2: '#181825', panel: '#1e1e2e', panel2: '#262637', border: '#313244', border2: '#45475a', text: '#cdd6f4', muted: '#a6adc8', dim: '#6c7086', accent: '#cba6f7', accent2: '#b48be8', ok: '#a6e3a1', warn: '#f9e2af', danger: '#f38ba8', info: '#89dceb' }),
  mk('solarized', 'Solarized Dark', 'dark', { bg: '#00212b', bg2: '#002b36', panel: '#073642', panel2: '#0b4050', border: '#114b5c', border2: '#1c5a6b', text: '#eee8d5', muted: '#93a1a1', dim: '#657b83', accent: '#268bd2', accent2: '#1f7bbd', ok: '#859900', warn: '#b58900', danger: '#dc322f', info: '#2aa198' }),
  mk('forest', 'Forest', 'dark', { bg: '#0e1512', bg2: '#121b17', panel: '#17221d', panel2: '#1d2b24', border: '#263830', border2: '#31483e', text: '#e4ece7', muted: '#9fb3a8', dim: '#6c8276', accent: '#34d399', accent2: '#10b981', ok: '#4ade80', warn: '#fbbf24', danger: '#f87171', info: '#67e8f9' }),
  mk('ember', 'Ember', 'dark', { bg: '#141010', bg2: '#1a1413', panel: '#201917', panel2: '#28201d', border: '#352a26', border2: '#453832', text: '#f1e9e4', muted: '#bba79d', dim: '#857368', accent: '#f97316', accent2: '#ea580c', ok: '#4ade80', warn: '#facc15', danger: '#ef4444', info: '#38bdf8' }),
  mk('monochrome', 'Monochrome', 'dark', { bg: '#0a0a0a', bg2: '#111111', panel: '#161616', panel2: '#1f1f1f', border: '#2a2a2a', border2: '#383838', text: '#f2f2f2', muted: '#a3a3a3', dim: '#6f6f6f', accent: '#e5e5e5', accent2: '#cfcfcf', info: '#a3a3a3' }),
  mk('light', 'Light', 'light', { bg: '#f5f6f8', bg2: '#ffffff', panel: '#ffffff', panel2: '#f1f3f6', border: '#e3e6eb', border2: '#cfd4dc', text: '#1b1f27', muted: '#5b6472', dim: '#8a93a3', accent: '#2563eb', accent2: '#1d4ed8', ok: '#16a34a', warn: '#d97706', danger: '#dc2626', info: '#0284c7' }),
  mk('paper', 'Paper (warm light)', 'light', { bg: '#f7f3ec', bg2: '#fffdf8', panel: '#fffdf8', panel2: '#f2ece2', border: '#e6dfd2', border2: '#d4cbb9', text: '#2b2520', muted: '#6b6158', dim: '#978b7f', accent: '#b45309', accent2: '#92400e', ok: '#15803d', warn: '#b45309', danger: '#b91c1c', info: '#0369a1' })
]

export const DEFAULT_THEME_ID = 'graphite'

export function getTheme(id: string | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** Apply a theme to the document and notify listeners (terminal, charts). */
export function applyTheme(id: string | undefined): ThemeDef {
  const t = getTheme(id)
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v)
  root.dataset.theme = t.id
  root.style.colorScheme = t.kind
  window.dispatchEvent(new CustomEvent('servermate:theme', { detail: t }))
  return t
}

/** Read a theme colour as currently rendered (for canvas/xterm consumers). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function mix(hex: string, target: string, amount: number): string {
  const p = (h: string): [number, number, number] => {
    const s = h.replace('#', '')
    const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
    return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
  }
  const a = p(hex)
  const b = p(target)
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * amount))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** xterm.js theme derived from the active colour theme. */
export function terminalTheme(): Record<string, string> {
  const t = getTheme(document.documentElement.dataset.theme)
  const v = t.vars
  const dark = t.kind === 'dark'
  const fg = v['--color-text']
  const bg = v['--color-bg']
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: v['--color-accent'] + '66',
    black: dark ? v['--color-panel-2'] : '#1f2937',
    red: v['--color-danger'],
    green: v['--color-ok'],
    yellow: v['--color-warn'],
    blue: v['--color-accent'],
    magenta: dark ? '#c084fc' : '#7e22ce',
    cyan: v['--color-info'],
    white: dark ? fg : '#374151',
    brightBlack: v['--color-dim'],
    brightRed: mix(v['--color-danger'], dark ? '#ffffff' : '#000000', 0.2),
    brightGreen: mix(v['--color-ok'], dark ? '#ffffff' : '#000000', 0.2),
    brightYellow: mix(v['--color-warn'], dark ? '#ffffff' : '#000000', 0.2),
    brightBlue: mix(v['--color-accent'], dark ? '#ffffff' : '#000000', 0.2),
    brightMagenta: dark ? '#d8b4fe' : '#6b21a8',
    brightCyan: mix(v['--color-info'], dark ? '#ffffff' : '#000000', 0.2),
    brightWhite: dark ? '#ffffff' : '#111827'
  }
}
