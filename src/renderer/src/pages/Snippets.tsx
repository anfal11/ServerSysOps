import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Download, Pencil, Play, Plus, Save, Server, Terminal, Trash2, Upload } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Card, Checkbox, EmptyState, ErrorBox, Field, Input, Loading, Modal, Pre, SearchInput, TextArea, confirm, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { cls, fmtDuration } from '@/lib/format'
import type { Snippet } from '@shared/types'
import type { MultiRunResult, RunResult } from '@shared/modules/snippets'

const HISTORY_MAX = 50
function histKey(serverId: string): string {
  return `sm.cmdhist.${serverId}`
}
function loadHistory(serverId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(histKey(serverId)) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function pushHistory(serverId: string, cmd: string): string[] {
  const list = [cmd, ...loadHistory(serverId).filter((c) => c !== cmd)].slice(0, HISTORY_MAX)
  try {
    localStorage.setItem(histKey(serverId), JSON.stringify(list))
  } catch {
    /* ignore quota */
  }
  return list
}

type Draft = { id?: string; name: string; description: string; command: string; sudo: boolean; tags: string }

export default function Snippets({ serverId }: PageProps): React.JSX.Element {
  const toast = useApp((s) => s.toast)
  const { data: snippets, error, loading, reload } = useAsync(() => api.global<Snippet[]>('snippets:list'), [])
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [output, setOutput] = useState<{ title: string; r: RunResult } | null>(null)
  const [multi, setMulti] = useState<{ command: string; sudo: boolean } | null>(null)

  // ad-hoc command
  const [cmd, setCmd] = useState('')
  const [cmdSudo, setCmdSudo] = useState(false)
  const [history, setHistory] = useState<string[]>(() => loadHistory(serverId))
  useEffect(() => setHistory(loadHistory(serverId)), [serverId])

  const runner = useAction()
  const { run, busy } = useAction()

  const tags = useMemo(() => [...new Set((snippets ?? []).flatMap((s) => s.tags))].sort(), [snippets])
  const list = useMemo(() => {
    const f = search.trim().toLowerCase()
    return (snippets ?? []).filter((s) => (!tag || s.tags.includes(tag)) && (!f || s.name.toLowerCase().includes(f) || s.command.toLowerCase().includes(f) || (s.description ?? '').toLowerCase().includes(f) || s.tags.some((t) => t.includes(f))))
  }, [snippets, search, tag])
  const selected = snippets?.find((s) => s.id === selectedId) ?? null

  const execute = async (title: string, command: string, sudo: boolean): Promise<void> => {
    setOutput(null)
    const r = await runner.run(() => api.call<RunResult>('snippets:run', serverId, { command, sudo }), { error: 'Command failed to run' })
    if (r) setOutput({ title, r })
  }
  const runAdhoc = async (): Promise<void> => {
    const c = cmd.trim()
    if (!c) return
    setHistory(pushHistory(serverId, c))
    await execute(c, c, cmdSudo)
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    const saved = await run(() => api.global<Snippet>('snippets:save', { id: draft.id, name: draft.name.trim(), description: draft.description.trim() || undefined, command: draft.command, sudo: draft.sudo, tags: draft.tags.split(/[,\s]+/).filter(Boolean) }), { success: 'Snippet saved' })
    if (!saved) return
    await reload()
    setDraft(null)
    setSelectedId(saved.id)
  }
  const remove = async (s: Snippet): Promise<void> => {
    if (!(await confirm({ title: 'Delete snippet', message: <>Delete <b>{s.name}</b>?</>, danger: true, confirmLabel: 'Delete' }))) return
    await run(() => api.global('snippets:delete', s.id), { success: 'Deleted' })
    if (selectedId === s.id) setSelectedId(null)
    await reload()
  }

  return (
    <>
      <div className="flex items-center justify-between px-6 h-14 shrink-0">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-semibold">Snippets</h1>
          <span className="text-muted text-xs">{snippets?.length ?? 0} saved commands</span>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<Upload size={13} />} onClick={() => run(() => api.global<number>('snippets:import').then(async (n) => { if (n) { toast({ kind: 'success', title: `Imported ${n} snippet(s)` }); await reload() } }))}>
            Import
          </Button>
          <Button icon={<Download size={13} />} onClick={() => run(() => api.global('snippets:export'))}>
            Export
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setDraft({ name: '', description: '', command: '', sudo: false, tags: '' })}>
            New snippet
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col px-6 pb-6 gap-4">
        {/* ad-hoc command */}
        <Card bodyClass="p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void runAdhoc()
            }}
            className="flex items-center gap-2"
          >
            <Terminal size={14} className="text-muted shrink-0" />
            <Input list="sm-cmdhist" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Run a command on this server… (history: ↓)" mono className="flex-1" autoComplete="off" />
            <datalist id="sm-cmdhist">
              {history.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <Checkbox checked={cmdSudo} onChange={setCmdSudo} label="sudo" />
            <Button type="submit" variant="primary" icon={<Play size={13} />} loading={runner.busy} disabled={!cmd.trim()}>
              Run
            </Button>
            <Button type="button" icon={<Server size={13} />} disabled={!cmd.trim()} onClick={() => setMulti({ command: cmd.trim(), sudo: cmdSudo })} title="Run on several servers">
              Multi-server…
            </Button>
            <Button type="button" icon={<Terminal size={13} />} disabled={!cmd.trim()} onClick={() => useApp.getState().openTerminal(serverId, (cmdSudo ? 'sudo ' : '') + cmd.trim())} title="Open in an interactive terminal">
              Terminal
            </Button>
            <Button type="button" icon={<Save size={13} />} disabled={!cmd.trim()} onClick={() => setDraft({ name: '', description: '', command: cmd.trim(), sudo: cmdSudo, tags: '' })} title="Save as snippet" />
          </form>
        </Card>

        <div className="flex-1 min-h-0 grid grid-cols-[320px_1fr] gap-4">
          {/* list */}
          <Card flush className="min-h-0 flex flex-col">
            <div className="p-2 border-b border-border space-y-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search snippets" />
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  <button onClick={() => setTag('')} className={cls('px-1.5 h-5 rounded text-[11px] border', !tag ? 'bg-accent/15 border-accent/30 text-blue-300' : 'border-border-2 text-muted hover:text-text')}>
                    all
                  </button>
                  {tags.map((t) => (
                    <button key={t} onClick={() => setTag(tag === t ? '' : t)} className={cls('px-1.5 h-5 rounded text-[11px] border', tag === t ? 'bg-accent/15 border-accent/30 text-blue-300' : 'border-border-2 text-muted hover:text-text')}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {error ? (
                <div className="p-2">
                  <ErrorBox error={error} onRetry={reload} />
                </div>
              ) : loading && !snippets ? (
                <Loading />
              ) : list.length === 0 ? (
                <EmptyState title="No snippets" description={search || tag ? 'Nothing matches the filter.' : 'Create one with "New snippet" or save a command from the box above.'} />
              ) : (
                list.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSelectedId(s.id)
                      setDraft(null)
                    }}
                    className={cls('w-full text-left px-3 py-2 border-b border-border/60 hover:bg-panel-2/70', selectedId === s.id && 'bg-accent/15 hover:bg-accent/20')}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[13px] truncate flex-1">{s.name}</span>
                      {s.sudo && <Badge color="warn" className="h-4 text-[9px]">root</Badge>}
                      {s.createdAt === 0 && <Badge className="h-4 text-[9px]">built-in</Badge>}
                    </div>
                    <div className="text-[11px] text-dim font-mono truncate mt-0.5">{s.command}</div>
                  </button>
                ))
              )}
            </div>
          </Card>

          {/* detail / editor / output */}
          <div className="min-h-0 flex flex-col gap-4 overflow-auto">
            {draft ? (
              <Card title={draft.id ? 'Edit snippet' : 'New snippet'}>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Name">
                    <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Restart nginx" autoFocus />
                  </Field>
                  <Field label="Tags" hint="comma or space separated">
                    <Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="web, nginx" />
                  </Field>
                  <Field label="Description" className="col-span-2">
                    <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="optional" />
                  </Field>
                  <Field label="Command" className="col-span-2" hint="Runs through the login shell with a 5 minute timeout. Use && / ; / pipes freely; interactive commands will hang.">
                    <TextArea value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} rows={6} mono spellCheck={false} />
                  </Field>
                  <Checkbox checked={draft.sudo} onChange={(v) => setDraft({ ...draft, sudo: v })} label="Run as root (sudo)" />
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <Button onClick={() => setDraft(null)}>Cancel</Button>
                  <Button variant="primary" icon={<Save size={13} />} loading={busy} disabled={!draft.name.trim() || !draft.command.trim()} onClick={save}>
                    Save
                  </Button>
                </div>
              </Card>
            ) : selected ? (
              <Card
                title={
                  <span className="flex items-center gap-2">
                    {selected.name}
                    {selected.sudo && <Badge color="warn">root</Badge>}
                    {selected.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </span>
                }
                actions={
                  <>
                    <Button size="xs" icon={<Pencil size={11} />} onClick={() => setDraft({ id: selected.id, name: selected.name, description: selected.description ?? '', command: selected.command, sudo: selected.sudo, tags: selected.tags.join(', ') })}>
                      Edit
                    </Button>
                    <Button size="xs" variant="danger" icon={<Trash2 size={11} />} onClick={() => remove(selected)} />
                  </>
                }
              >
                {selected.description && <div className="text-xs text-muted mb-2">{selected.description}</div>}
                <Pre maxH="max-h-48">{selected.command}</Pre>
                <div className="flex items-center gap-2 mt-3">
                  <Button variant="primary" icon={<Play size={13} />} loading={runner.busy} onClick={() => execute(selected.name, selected.command, selected.sudo)}>
                    Run on this server
                  </Button>
                  <Button icon={<Server size={13} />} onClick={() => setMulti({ command: selected.command, sudo: selected.sudo })}>
                    Run on multiple servers…
                  </Button>
                  <Button icon={<Terminal size={13} />} onClick={() => useApp.getState().openTerminal(serverId, (selected.sudo ? 'sudo ' : '') + selected.command)}>
                    Open in terminal
                  </Button>
                  <Button icon={<Copy size={13} />} onClick={() => navigator.clipboard.writeText(selected.command).then(() => toast({ kind: 'success', title: 'Command copied' }))} title="Copy command" />
                </div>
              </Card>
            ) : (
              !output && (
                <Card>
                  <EmptyState icon={<Terminal />} title="Pick a snippet or run a command" description="Snippets are stored locally and can run on one server or on every connected server at once." />
                </Card>
              )
            )}
            {runner.busy && !output && <Loading label="Running…" />}
            {output && <OutputPane title={output.title} r={output.r} onClose={() => setOutput(null)} />}
          </div>
        </div>
      </div>
      {multi && <MultiRunModal serverId={serverId} command={multi.command} sudo={multi.sudo} onClose={() => setMulti(null)} />}
    </>
  )
}

function OutputPane({ title, r, onClose }: { title: string; r: RunResult; onClose: () => void }): React.JSX.Element {
  const toast = useApp((s) => s.toast)
  const copy = (): void => {
    void navigator.clipboard.writeText((r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim()).then(() => toast({ kind: 'success', title: 'Output copied' }))
  }
  return (
    <Card
      title={
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate font-mono text-xs">{title}</span>
          <Badge color={r.code === 0 ? 'ok' : 'danger'}>exit {r.code}</Badge>
          <span className="text-dim text-[11px] font-normal">{fmtDuration(r.ms)}</span>
        </span>
      }
      actions={
        <>
          <Button size="xs" icon={<Copy size={11} />} onClick={copy}>
            Copy output
          </Button>
          <Button size="xs" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {r.stdout.trim() === '' && r.stderr.trim() === '' ? (
        <div className="text-xs text-muted">(no output)</div>
      ) : (
        <>
          {r.stdout && <Pre maxH="max-h-[50vh]">{r.stdout}</Pre>}
          {r.stderr && (
            <Pre maxH="max-h-60" className={cls('mt-2', r.code !== 0 ? 'text-red-200 border-danger/30' : 'text-amber-200')}>
              {r.stderr}
            </Pre>
          )}
        </>
      )}
    </Card>
  )
}

function MultiRunModal({ serverId, command, sudo, onClose }: { serverId: string; command: string; sudo: boolean; onClose: () => void }): React.JSX.Element {
  const servers = useApp((s) => s.servers)
  const connections = useApp((s) => s.connections)
  const connected = servers.filter((s) => connections[s.id]?.status === 'connected')
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(connected.map((s) => [s.id, true])))
  const [results, setResults] = useState<MultiRunResult[] | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const { run, busy } = useAction()
  const ids = connected.filter((s) => picked[s.id]).map((s) => s.id)
  const go = async (): Promise<void> => {
    setResults(null)
    const r = await run(() => api.global<MultiRunResult[]>('snippets:runMany', { serverIds: ids, command, sudo }))
    if (r) {
      setResults(r)
      setOpen(Object.fromEntries(r.map((x) => [x.serverId, !x.ok || r.length <= 3])))
    }
  }
  void serverId
  return (
    <Modal
      open
      onClose={onClose}
      title="Run on multiple servers"
      width="max-w-3xl"
      badge={sudo ? <Badge color="warn">root</Badge> : undefined}
      footer={
        <>
          <span className="text-xs text-muted mr-auto">{results ? `${results.filter((r) => r.ok).length}/${results.length} succeeded` : `${ids.length} server(s) selected · runs in parallel`}</span>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Play size={13} />} loading={busy} disabled={!ids.length} onClick={go}>
            {results ? 'Run again' : 'Run'}
          </Button>
        </>
      }
    >
      <Pre maxH="max-h-32">{command}</Pre>
      <div className="mt-3 flex items-center justify-between">
        <div className="text-xs text-muted font-medium">Connected servers</div>
        <div className="flex gap-2">
          <Button size="xs" variant="ghost" onClick={() => setPicked(Object.fromEntries(connected.map((s) => [s.id, true])))}>
            Select all
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setPicked({})}>
            None
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 mt-2">
        {connected.length === 0 && <div className="text-xs text-muted col-span-2">No connected servers. Connect servers from the Servers tab first.</div>}
        {connected.map((s) => (
          <Checkbox key={s.id} checked={!!picked[s.id]} onChange={(v) => setPicked((p) => ({ ...p, [s.id]: v }))} label={<span>{s.name} <span className="text-dim font-mono text-[11px]">{s.host}</span></span>} />
        ))}
      </div>
      {results && (
        <div className="mt-4 space-y-2">
          {results.map((r) => (
            <div key={r.serverId} className="border border-border rounded-md">
              <button onClick={() => setOpen((o) => ({ ...o, [r.serverId]: !o[r.serverId] }))} className="w-full flex items-center gap-2 px-3 h-8 text-left hover:bg-panel-2">
                {open[r.serverId] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="font-medium text-[13px] flex-1 truncate">{r.serverName}</span>
                {r.error ? <Badge color="danger">error</Badge> : <Badge color={r.ok ? 'ok' : 'danger'}>exit {r.code}</Badge>}
                <span className="text-dim text-[11px]">{fmtDuration(r.ms)}</span>
              </button>
              {open[r.serverId] && (
                <div className="px-3 pb-3">
                  {r.error && <div className="text-xs text-red-300 font-mono mb-2">{r.error}</div>}
                  {r.stdout && <Pre maxH="max-h-60">{r.stdout}</Pre>}
                  {r.stderr && <Pre maxH="max-h-40" className="mt-2 text-amber-200">{r.stderr}</Pre>}
                  {!r.stdout && !r.stderr && !r.error && <div className="text-xs text-muted">(no output)</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
