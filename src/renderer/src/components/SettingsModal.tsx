import React, { useEffect, useState } from 'react'
import { useApp } from '@/store/app'
import { Button, Checkbox, Field, Input, Modal } from '@/components/ui'
import type { AppSettings } from '@shared/types'
import { api } from '@/lib/api'
import { THEMES, applyTheme } from '@/lib/themes'
import { cls } from '@/lib/format'
import { Check, Download, Upload } from 'lucide-react'
import { errMsg } from '@/lib/api'

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const save = useApp((s) => s.saveSettings)
  const version = useApp((s) => s.appVersion)
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [updateMsg, setUpdateMsg] = useState('')
  useEffect(() => {
    if (open) setDraft(settings)
  }, [open, settings])
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]): void => setDraft((d) => ({ ...d, [k]: v }))
  const num = (k: keyof AppSettings) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      width="max-w-2xl"
      footer={
        <>
          <span className="text-dim text-xs mr-auto">Central Server v{version}</span>
          <Button
            onClick={() => {
              applyTheme(settings.theme)
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await save(draft)
              onClose()
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Metrics refresh (ms)">
          <Input type="number" min={1000} step={500} value={draft.metricsIntervalMs} onChange={num('metricsIntervalMs')} />
        </Field>
        <Field label="Terminal font size">
          <Input type="number" min={9} max={24} value={draft.terminalFontSize} onChange={num('terminalFontSize')} />
        </Field>
        <Field label="Terminal font family" className="col-span-2">
          <Input value={draft.terminalFontFamily} onChange={(e) => set('terminalFontFamily', e.target.value)} mono />
        </Field>
        <Field label="Terminal scrollback (lines)">
          <Input type="number" min={500} step={500} value={draft.terminalScrollback} onChange={num('terminalScrollback')} />
        </Field>
        <div className="col-span-2">
          <div className="text-xs text-muted mb-1.5 font-medium">Colour theme</div>
          {(['dark', 'light'] as const).map((kind) => (
            <div key={kind} className="mb-2">
              <div className="text-[11px] text-dim uppercase tracking-wide mb-1">{kind === 'dark' ? 'Dark' : 'Light'}</div>
              <div className="grid grid-cols-4 gap-2">
                {THEMES.filter((t) => t.kind === kind).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      set('theme', t.id)
                      applyTheme(t.id)
                    }}
                    className={cls('relative rounded-md border p-2 text-left transition-colors', draft.theme === t.id ? 'border-accent ring-2 ring-accent/30' : 'border-border-2 hover:border-muted')}
                    style={{ background: t.swatch[0], color: t.swatch[3] }}
                  >
                    <div className="flex gap-1 mb-1.5">
                      <span className="h-3 flex-1 rounded-sm" style={{ background: t.swatch[1] }} />
                      <span className="h-3 w-5 rounded-sm" style={{ background: t.swatch[2] }} />
                    </div>
                    <div className="text-[11px] font-medium truncate">{t.name}</div>
                    {draft.theme === t.id && <Check size={12} className="absolute top-1.5 right-1.5" style={{ color: t.swatch[2] }} />}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="text-[11px] text-dim mt-1.5">Previews immediately; Cancel restores the saved theme.</div>
        </div>
        <div className="col-span-2 flex flex-col gap-2 pt-1">
          <Checkbox checked={draft.autoReconnect} onChange={(v) => set('autoReconnect', v)} label="Reconnect automatically after drops or sleep" />
          <Checkbox checked={draft.confirmDangerous} onChange={(v) => set('confirmDangerous', v)} label="Ask before dangerous actions (delete, reboot, kill…)" />
          <Checkbox checked={draft.checkForUpdates} onChange={(v) => set('checkForUpdates', v)} label="Check for app updates on start" />
        </div>
        <div className="col-span-2 border-t border-border pt-3 mt-1">
          <div className="text-xs font-semibold mb-2">Alerts (for connected servers)</div>
          <Checkbox checked={draft.alertsEnabled} onChange={(v) => set('alertsEnabled', v)} label="Enable resource alerts" className="mb-3" />
          <div className="grid grid-cols-3 gap-3">
            <Field label="CPU %">
              <Input type="number" min={50} max={100} value={draft.alertCpuPct} onChange={num('alertCpuPct')} />
            </Field>
            <Field label="Memory %">
              <Input type="number" min={50} max={100} value={draft.alertMemPct} onChange={num('alertMemPct')} />
            </Field>
            <Field label="Disk %">
              <Input type="number" min={50} max={100} value={draft.alertDiskPct} onChange={num('alertDiskPct')} />
            </Field>
          </div>
        </div>
        <BackupSection />
        <div className="col-span-2 border-t border-border pt-3 flex items-center gap-3">
          <Button
            onClick={async () => {
              setUpdateMsg('Checking…')
              const r = await api.global<{ status: string; error?: string; info?: { version?: string } }>('update:check')
              setUpdateMsg(r.status === 'unavailable' ? 'Updates are only available in the installed app.' : r.status === 'error' ? `Update check failed: ${r.error}` : r.info?.version ? `Latest: ${r.info.version}` : 'You are up to date.')
            }}
          >
            Check for updates
          </Button>
          <span className="text-xs text-muted">{updateMsg}</span>
        </div>
      </div>
    </Modal>
  )
}

interface BackupInfo {
  path: string
  version: string
  createdAt: number
  encrypted: boolean
  counts: { servers: number; snippets: number; secrets: number }
}

/** Export / import of servers (optionally with encrypted passwords and keys), settings and snippets. */
function BackupSection(): React.JSX.Element {
  const toast = useApp((s) => s.toast)
  const [pass, setPass] = useState('')
  const [withSecrets, setWithSecrets] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<BackupInfo | null>(null)
  const [importPass, setImportPass] = useState('')
  const doExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const ok = await api.global<boolean>('backup:export', { passphrase: pass, includeSecrets: withSecrets })
      if (ok) toast({ kind: 'success', title: 'Backup saved', detail: withSecrets ? 'Passwords and keys are encrypted with your passphrase.' : 'Saved without passwords or keys.' })
    } catch (e) {
      toast({ kind: 'error', title: 'Backup failed', detail: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  const pick = async (): Promise<void> => {
    try {
      const info = await api.global<BackupInfo | null>('backup:inspect')
      if (info) setPending(info)
    } catch (e) {
      toast({ kind: 'error', title: 'Cannot read backup', detail: errMsg(e) })
    }
  }
  const doImport = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    try {
      const r = await api.global<{ servers: number; secrets: number; snippets: number; settings: boolean }>('backup:import', { path: pending.path, passphrase: importPass })
      toast({ kind: 'success', title: 'Backup restored', detail: `${r.servers} servers (${r.secrets} with passwords/keys), ${r.snippets} snippets. Reloading…` })
      setPending(null)
      setTimeout(() => window.location.reload(), 900)
    } catch (e) {
      toast({ kind: 'error', title: 'Restore failed', detail: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="col-span-2 border-t border-border pt-3">
      <div className="text-xs font-semibold mb-1">Backup &amp; restore</div>
      <div className="text-[11px] text-dim mb-3">One file with all servers, settings and snippets. With a passphrase the passwords, key passphrases, sudo passwords and 2FA secrets are included, encrypted (AES-256-GCM), so you can move to another PC.</div>
      <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
        <Field label={withSecrets ? 'Passphrase (min. 8 characters, needed to restore)' : 'Passphrase (optional)'}>
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" placeholder={withSecrets ? 'Choose a strong passphrase' : 'Leave empty for an unencrypted file'} />
        </Field>
        <Button icon={<Download size={13} />} variant="primary" loading={busy} disabled={withSecrets && pass.trim().length < 8} onClick={doExport}>
          Export backup
        </Button>
      </div>
      <div className="flex items-center justify-between mt-2">
        <Checkbox checked={withSecrets} onChange={setWithSecrets} label="Include passwords, keys and 2FA secrets (encrypted)" />
        <Button icon={<Upload size={13} />} onClick={pick} disabled={busy}>
          Restore from backup…
        </Button>
      </div>
      {pending && (
        <div className="mt-3 border border-border-2 rounded-md p-3 bg-bg-2 space-y-2">
          <div className="text-xs">
            <b>{pending.path.split(/[\\/]/).pop()}</b> · created {new Date(pending.createdAt).toLocaleString()} by version {pending.version} · {pending.counts.servers} servers, {pending.counts.snippets} snippets{pending.encrypted ? `, ${pending.counts.secrets} with secrets (encrypted)` : ' (no secrets)'}
          </div>
          {pending.encrypted && (
            <Field label="Passphrase of this backup">
              <Input type="password" value={importPass} onChange={(e) => setImportPass(e.target.value)} autoFocus autoComplete="off" />
            </Field>
          )}
          <div className="text-[11px] text-warn-fg">Servers with the same id are updated, others are added; settings and snippets from the file replace the current ones. The app reloads afterwards.</div>
          <div className="flex gap-2 justify-end">
            <Button size="xs" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button size="xs" variant="primary" loading={busy} disabled={pending.encrypted && !importPass} onClick={doImport}>
              Restore
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
