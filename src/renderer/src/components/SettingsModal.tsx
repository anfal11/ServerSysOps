import React, { useEffect, useState } from 'react'
import { useApp } from '@/store/app'
import { Button, Checkbox, Field, Input, Modal, Select } from '@/components/ui'
import type { AppSettings } from '@shared/types'
import { api } from '@/lib/api'

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
      footer={
        <>
          <span className="text-dim text-xs mr-auto">ServerMate v{version}</span>
          <Button onClick={onClose}>Cancel</Button>
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
        <Field label="Theme">
          <Select value={draft.theme} onChange={(e) => set('theme', e.target.value as AppSettings['theme'])}>
            <option value="dark">Dark</option>
          </Select>
        </Field>
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
