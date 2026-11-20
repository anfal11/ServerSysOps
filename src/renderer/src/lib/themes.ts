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

/** Relative luminance (0 = black, 1 = white) of a hex colour. */
function luminance(hex: string): number {
  const s = hex.replace('#', '')
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(f.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** Black or white, whichever reads better on the given colour (used for text on accent buttons). */
function onColor(hex: string): string {
  return luminance(hex) > 0.45 ? '#0b0d12' : '#ffffff'
}

interface ThemeInput {
  bg: string
  bg2: string
  panel: string
  panel2: string
  border: string
  border2: string
  text: string
  muted: string
  dim: string
  accent: string
  accent2: string
  ok?: string
  warn?: string
  danger?: string
  info?: string
}

const mk = (id: string, name: string, kind: 'dark' | 'light', v: ThemeInput): ThemeDef => {
  const ok = v.ok ?? (kind === 'dark' ? '#22c55e' : '#16a34a')
  const warn = v.warn ?? (kind === 'dark' ? '#f59e0b' : '#d97706')
  const danger = v.danger ?? (kind === 'dark' ? '#ef4444' : '#dc2626')
  const info = v.info ?? (kind === 'dark' ? '#38bdf8' : '#0284c7')
  // "-fg" variants are the readable text versions of the status colours: lightened on dark
  // backgrounds, darkened on light ones (replaces the old hard-coded text-green-300 etc.).
  const fg = (c: string): string => (kind === 'dark' ? mix(c, '#ffffff', 0.3) : mix(c, '#000000', 0.22))
  return {
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
      '--color-on-accent': onColor(v.accent),
      '--color-accent-fg': fg(v.accent),
      '--color-ok': ok,
      '--color-warn': warn,
      '--color-danger': danger,
      '--color-info': info,
      '--color-ok-fg': fg(ok),
      '--color-warn-fg': fg(warn),
      '--color-danger-fg': fg(danger),
      '--color-info-fg': fg(info)
    }
  }
}

export const THEMES: ThemeDef[] = [
  // ---- dark
  mk('graphite', 'Graphite (default)', 'dark', { bg: '#0f1115', bg2: '#14171d', panel: '#181b22', panel2: '#1e222b', border: '#262a34', border2: '#2f3440', text: '#e6e8ee', muted: '#9aa1b2', dim: '#6b7282', accent: '#3b82f6', accent2: '#2563eb' }),
  mk('midnight', 'Midnight Blue', 'dark', { bg: '#0b1220', bg2: '#0f1829', panel: '#121d33', panel2: '#17253f', border: '#1f2f4d', border2: '#2a3d60', text: '#e2e8f0', muted: '#94a3b8', dim: '#64748b', accent: '#38bdf8', accent2: '#0ea5e9', info: '#7dd3fc' }),
  mk('tokyo', 'Tokyo Night', 'dark', { bg: '#16161e', bg2: '#1a1b26', panel: '#1f2335', panel2: '#24283b', border: '#2f3449', border2: '#3b4261', text: '#c0caf5', muted: '#9aa5ce', dim: '#565f89', accent: '#7aa2f7', accent2: '#6a8fe6', ok: '#9ece6a', warn: '#e0af68', danger: '#f7768e', info: '#7dcfff' }),
  mk('onedark', 'One Dark', 'dark', { bg: '#21252b', bg2: '#282c34', panel: '#2c313a', panel2: '#333842', border: '#3e4451', border2: '#4b5263', text: '#abb2bf', muted: '#8b93a3', dim: '#5c6370', accent: '#61afef', accent2: '#4d9ee0', ok: '#98c379', warn: '#e5c07b', danger: '#e06c75', info: '#56b6c2' }),
  mk('gruvbox', 'Gruvbox Dark', 'dark', { bg: '#1d2021', bg2: '#282828', panel: '#32302f', panel2: '#3c3836', border: '#504945', border2: '#665c54', text: '#ebdbb2', muted: '#bdae93', dim: '#928374', accent: '#fe8019', accent2: '#d65d0e', ok: '#b8bb26', warn: '#fabd2f', danger: '#fb4934', info: '#83a598' }),
  mk('dracula', 'Dracula', 'dark', { bg: '#1e1f29', bg2: '#242631', panel: '#282a36', panel2: '#2f3242', border: '#3b3e52', border2: '#44475a', text: '#f8f8f2', muted: '#b4b8cf', dim: '#7c7f99', accent: '#bd93f9', accent2: '#a97ff2', ok: '#50fa7b', warn: '#f1fa8c', danger: '#ff5555', info: '#8be9fd' }),
  mk('nord', 'Nord', 'dark', { bg: '#242933', bg2: '#2a3040', panel: '#2e3440', panel2: '#3b4252', border: '#434c5e', border2: '#4c566a', text: '#eceff4', muted: '#b8c0d2', dim: '#7b869c', accent: '#88c0d0', accent2: '#81a1c1', ok: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a', info: '#8fbcbb' }),
  mk('mocha', 'Catppuccin Mocha', 'dark', { bg: '#11111b', bg2: '#181825', panel: '#1e1e2e', panel2: '#262637', border: '#313244', border2: '#45475a', text: '#cdd6f4', muted: '#a6adc8', dim: '#6c7086', accent: '#cba6f7', accent2: '#b48be8', ok: '#a6e3a1', warn: '#f9e2af', danger: '#f38ba8', info: '#89dceb' }),
  mk('rosepine', 'Rosé Pine', 'dark', { bg: '#191724', bg2: '#1f1d2e', panel: '#26233a', panel2: '#2a2740', border: '#393552', border2: '#4a4664', text: '#e0def4', muted: '#908caa', dim: '#6e6a86', accent: '#c4a7e7', accent2: '#b092d9', ok: '#9ccfd8', warn: '#f6c177', danger: '#eb6f92', info: '#31748f' }),
  mk('solarized', 'Solarized Dark', 'dark', { bg: '#00212b', bg2: '#002b36', panel: '#073642', panel2: '#0b4050', border: '#114b5c', border2: '#1c5a6b', text: '#eee8d5', muted: '#93a1a1', dim: '#657b83', accent: '#268bd2', accent2: '#1f7bbd', ok: '#859900', warn: '#b58900', danger: '#dc322f', info: '#2aa198' }),
  mk('ocean', 'Deep Ocean', 'dark', { bg: '#0a1628', bg2: '#0d1b33', panel: '#11223f', panel2: '#162a4d', border: '#1e3761', border2: '#294877', text: '#dbe7f5', muted: '#9bb3cf', dim: '#6a84a3', accent: '#2dd4bf', accent2: '#14b8a6', ok: '#4ade80', warn: '#fbbf24', danger: '#fb7185', info: '#60a5fa' }),
  mk('forest', 'Forest', 'dark', { bg: '#0e1512', bg2: '#121b17', panel: '#17221d', panel2: '#1d2b24', border: '#263830', border2: '#31483e', text: '#e4ece7', muted: '#9fb3a8', dim: '#6c8276', accent: '#34d399', accent2: '#10b981', ok: '#4ade80', warn: '#fbbf24', danger: '#f87171', info: '#67e8f9' }),
  mk('ember', 'Ember', 'dark', { bg: '#141010', bg2: '#1a1413', panel: '#201917', panel2: '#28201d', border: '#352a26', border2: '#453832', text: '#f1e9e4', muted: '#bba79d', dim: '#857368', accent: '#f97316', accent2: '#ea580c', ok: '#4ade80', warn: '#facc15', danger: '#ef4444', info: '#38bdf8' }),
  mk('aurora', 'Aurora', 'dark', { bg: '#120f1c', bg2: '#171326', panel: '#1d1830', panel2: '#241e3b', border: '#32294f', border2: '#413664', text: '#ece7fb', muted: '#b3a9d6', dim: '#7d729f', accent: '#e879f9', accent2: '#d946ef', ok: '#34d399', warn: '#fbbf24', danger: '#fb7185', info: '#22d3ee' }),
  mk('monochrome', 'Monochrome', 'dark', { bg: '#0a0a0a', bg2: '#111111', panel: '#161616', panel2: '#1f1f1f', border: '#2a2a2a', border2: '#383838', text: '#f2f2f2', muted: '#a3a3a3', dim: '#6f6f6f', accent: '#e5e5e5', accent2: '#cfcfcf', info: '#a3a3a3' }),
  mk('contrast', 'High Contrast', 'dark', { bg: '#000000', bg2: '#050505', panel: '#0a0a0a', panel2: '#141414', border: '#3f3f3f', border2: '#6b6b6b', text: '#ffffff', muted: '#d4d4d4', dim: '#a3a3a3', accent: '#ffd400', accent2: '#e6bf00', ok: '#3dff7a', warn: '#ffb020', danger: '#ff5c5c', info: '#5ac8ff' }),
  // ---- light
  mk('light', 'Light', 'light', { bg: '#f5f6f8', bg2: '#ffffff', panel: '#ffffff', panel2: '#f1f3f6', border: '#e3e6eb', border2: '#cfd4dc', text: '#1b1f27', muted: '#5b6472', dim: '#8a93a3', accent: '#2563eb', accent2: '#1d4ed8', ok: '#16a34a', warn: '#d97706', danger: '#dc2626', info: '#0284c7' }),
  mk('github', 'GitHub Light', 'light', { bg: '#f6f8fa', bg2: '#ffffff', panel: '#ffffff', panel2: '#f6f8fa', border: '#d0d7de', border2: '#afb8c1', text: '#1f2328', muted: '#57606a', dim: '#8c959f', accent: '#0969da', accent2: '#0550ae', ok: '#1a7f37', warn: '#9a6700', danger: '#cf222e', info: '#0969da' }),
  mk('paper', 'Paper (warm light)', 'light', { bg: '#f7f3ec', bg2: '#fffdf8', panel: '#fffdf8', panel2: '#f2ece2', border: '#e6dfd2', border2: '#d4cbb9', text: '#2b2520', muted: '#6b6158', dim: '#978b7f', accent: '#b45309', accent2: '#92400e', ok: '#15803d', warn: '#b45309', danger: '#b91c1c', info: '#0369a1' }),
  mk('solarized-light', 'Solarized Light', 'light', { bg: '#eee8d5', bg2: '#fdf6e3', panel: '#fdf6e3', panel2: '#f3ecd8', border: '#d9d2bd', border2: '#c4bca3', text: '#073642', muted: '#586e75', dim: '#839496', accent: '#268bd2', accent2: '#1f7bbd', ok: '#859900', warn: '#b58900', danger: '#dc322f', info: '#2aa198' }),
  mk('latte', 'Catppuccin Latte', 'light', { bg: '#e6e9ef', bg2: '#eff1f5', panel: '#eff1f5', panel2: '#e6e9ef', border: '#ccd0da', border2: '#bcc0cc', text: '#4c4f69', muted: '#6c6f85', dim: '#8c8fa1', accent: '#8839ef', accent2: '#7a2fe0', ok: '#40a02b', warn: '#df8e1d', danger: '#d20f39', info: '#209fb5' }),
  mk('mint', 'Mint', 'light', { bg: '#eef6f2', bg2: '#ffffff', panel: '#ffffff', panel2: '#e8f2ec', border: '#d2e3da', border2: '#b7cfc2', text: '#14281f', muted: '#4b6558', dim: '#7e9488', accent: '#0f9f6e', accent2: '#0b835a', ok: '#15803d', warn: '#b45309', danger: '#b91c1c', info: '#0e7490' }),
  mk('rose', 'Rosé Pine Dawn', 'light', { bg: '#f2e9e1', bg2: '#faf4ed', panel: '#faf4ed', panel2: '#f4ede4', border: '#dfdad9', border2: '#cecacd', text: '#575279', muted: '#797593', dim: '#9893a5', accent: '#907aa9', accent2: '#7d679a', ok: '#286983', warn: '#ea9d34', danger: '#b4637a', info: '#56949f' }),
  mk('slate', 'Slate (cool grey)', 'light', { bg: '#e9edf2', bg2: '#f8fafc', panel: '#f8fafc', panel2: '#eef2f6', border: '#d4dbe3', border2: '#b9c3cf', text: '#0f172a', muted: '#475569', dim: '#7c8aa0', accent: '#475569', accent2: '#334155', ok: '#15803d', warn: '#b45309', danger: '#b91c1c', info: '#0369a1' })
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
  root.dataset.kind = t.kind
  root.style.colorScheme = t.kind
  window.dispatchEvent(new CustomEvent('servermate:theme', { detail: t }))
  return t
}

/** Read a theme colour as currently rendered (for canvas/xterm consumers). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
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
    black: dark ? mix(v['--color-border-2'], '#000000', 0.2) : '#1f2937',
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
