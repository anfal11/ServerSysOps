import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Download, ExternalLink, Eye, FileText, FolderOpen, Pencil, Play, Plus, RefreshCw, ScrollText, Trash2, Variable } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'
import { cls, fmtBytes } from '@/lib/format'
import {
  Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorBox, Field, IconButton, Input, Loading, Modal, Page, PageHeader, Pre, Select, Table, Tabs, TextArea, Toggle, confirm, useAction, useAsync
} from '@/components/ui'
import type { CronJob } from '@shared/types'
import type { CronListResult, CronStatus, CronSystemResult, CronVariable, SystemdTimer } from '@shared/modules/cron'
import { looksLikeCronSchedule } from '@shared/modules/cron'

/* ================================================================== */
/* Cron expression evaluator (client side)                             */
/* ================================================================== */

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
}

interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domAny: boolean
  dowAny: boolean
  raw: string[]
}

function parseValue(v: string, names?: string[]): number | null {
  if (/^\d+$/.test(v)) return Number(v)
  if (names) {
    const i = names.indexOf(v.toLowerCase().slice(0, 3))
    if (i >= 0) return names === MONTH_NAMES ? i + 1 : i
  }
  return null
}

function parseField(field: string, min: number, max: number, names?: string[]): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    if (!part) return null
    const [rangeRaw, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (rangeRaw === '*' || rangeRaw === '?') {
      lo = min
      hi = max
    } else if (rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-')
      const pa = parseValue(a, names)
      const pb = parseValue(b, names)
      if (pa === null || pb === null) return null
      lo = pa
      hi = pb
    } else {
      const p = parseValue(rangeRaw, names)
      if (p === null) return null
      lo = p
      hi = stepRaw === undefined ? p : max
    }
    if (names === DAY_NAMES) {
      if (lo === 7) lo = 0
      if (hi === 7) hi = hi === lo ? 0 : 6
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let i = lo; i <= hi; i += step) out.add(i)
  }
  return out.size ? out : null
}

/** Returns parsed fields, 'reboot' for @reboot, or null for an invalid expression. */
function parseCron(expr: string): CronFields | 'reboot' | null {
  let e = expr.trim().replace(/\s+/g, ' ')
  if (!e) return null
  if (e.toLowerCase() === '@reboot') return 'reboot'
  if (e.startsWith('@')) {
    const a = ALIASES[e.toLowerCase()]
    if (!a) return null
    e = a
  }
  const raw = e.split(' ')
  if (raw.length !== 5) return null
  const minute = parseField(raw[0], 0, 59)
  const hour = parseField(raw[1], 0, 23)
  const dom = parseField(raw[2], 1, 31)
  const month = parseField(raw[3], 1, 12, MONTH_NAMES)
  const dow = parseField(raw[4], 0, 7, DAY_NAMES)
  if (!minute || !hour || !dom || !month || !dow) return null
  return { minute, hour, dom, month, dow, domAny: raw[2] === '*' || raw[2] === '?', dowAny: raw[4] === '*' || raw[4] === '?', raw }
}

/** Parse "+0600" / "-0330" into minutes east of UTC. */
function tzOffsetMinutes(tz: string): number {
  const m = tz.match(/^([+-])(\d{2}):?(\d{2})$/)
  if (!m) return 0
  const v = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -v : v
}

/** Next `count` run instants (UTC ms) for a cron expression evaluated in a fixed-offset zone. */
function nextRuns(expr: string, fromMs: number, offsetMin: number, count: number): number[] {
  const f = parseCron(expr)
  if (!f || f === 'reboot') return []
  const off = offsetMin * 60000
  const hours = [...f.hour].sort((a, b) => a - b)
  const minutes = [...f.minute].sort((a, b) => a - b)
  const results: number[] = []
  const d = new Date(fromMs + off)
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() + 1)
  const dayMatches = (x: Date): boolean => {
    const domOk = f.dom.has(x.getUTCDate())
    const dowOk = f.dow.has(x.getUTCDay())
    if (f.domAny && f.dowAny) return true
    if (f.domAny) return dowOk
    if (f.dowAny) return domOk
    return domOk || dowOk
  }
  let guard = 0
  while (results.length < count && guard++ < 366 * 8) {
    if (!f.month.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1)
      d.setUTCHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(d)) {
      d.setUTCDate(d.getUTCDate() + 1)
      d.setUTCHours(0, 0, 0, 0)
      continue
    }
    const ch = d.getUTCHours()
    const cm = d.getUTCMinutes()
    let found = false
    for (const h of hours) {
      if (h < ch) continue
      for (const m of minutes) {
        if (h === ch && m < cm) continue
        d.setUTCHours(h, m, 0, 0)
        results.push(d.getTime() - off)
        d.setUTCMinutes(d.getUTCMinutes() + 1)
        found = true
        break
      }
      if (found) break
    }
    if (!found) {
      d.setUTCDate(d.getUTCDate() + 1)
      d.setUTCHours(0, 0, 0, 0)
    }
  }
  return results
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Compact a sorted list of numbers into "1, 3–5, 8" using a label function. */
function compactList(nums: number[], label: (n: number) => string): string {
  const parts: string[] = []
  let i = 0
  while (i < nums.length) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
    if (j - i >= 2) parts.push(`${label(nums[i])}–${label(nums[j])}`)
    else for (let k = i; k <= j; k++) parts.push(label(nums[k]))
    i = j + 1
  }
  return parts.join(', ')
}

function describeCron(expr: string): string {
  const f = parseCron(expr)
  if (f === 'reboot') return 'At every reboot'
  if (!f) return 'Invalid cron expression'
  const [mRaw, hRaw] = f.raw
  const minuteAll = f.minute.size === 60
  const hourAll = f.hour.size === 24
  const mins = [...f.minute].sort((a, b) => a - b)
  const hrs = [...f.hour].sort((a, b) => a - b)
  const mStep = mRaw.match(/^\*\/(\d+)$/)
  const hStep = hRaw.match(/^\*\/(\d+)$/)

  let time: string
  if (minuteAll && hourAll) time = 'Every minute'
  else if (mStep && hourAll) time = `Every ${mStep[1]} minutes`
  else if (mStep) time = `Every ${mStep[1]} minutes during hour${hrs.length > 1 ? 's' : ''} ${compactList(hrs, (h) => pad2(h))}`
  else if (minuteAll) time = `Every minute during hour${hrs.length > 1 ? 's' : ''} ${compactList(hrs, (h) => pad2(h))}`
  else if (hourAll) time = `Every hour at ${mins.map((m) => ':' + pad2(m)).join(', ')}`
  else if (hStep) time = `Every ${hStep[1]} hours at ${mins.map((m) => ':' + pad2(m)).join(', ')}`
  else if (hrs.length * mins.length <= 4) time = `At ${hrs.flatMap((h) => mins.map((m) => `${pad2(h)}:${pad2(m)}`)).join(', ')}`
  else time = `At minute ${compactList(mins, String)} past hour ${compactList(hrs, String)}`

  const days: string[] = []
  const dowList = [...f.dow].sort((a, b) => a - b)
  const domList = [...f.dom].sort((a, b) => a - b)
  const dowText = dowList.length === 7 ? '' : `on ${compactList(dowList, (d) => DAY_LABELS[d])}`
  const domText = domList.length === 31 ? '' : `on day ${compactList(domList, String)} of the month`
  if (!f.domAny && !f.dowAny) days.push([domText, dowText].filter(Boolean).join(' or '))
  else if (!f.dowAny) days.push(dowText)
  else if (!f.domAny) days.push(domText)
  else if (time.startsWith('At')) days.push('every day')
  if (f.month.size !== 12) days.push(`in ${compactList([...f.month].sort((a, b) => a - b), (m) => MONTH_LABELS[m - 1])}`)
  return [time, ...days.filter(Boolean)].join(' ')
}

/** Format a UTC instant as wall-clock time in a fixed-offset zone. */
function fmtInTz(ms: number, offsetMin: number, withDate = true): string {
  const d = new Date(ms + offsetMin * 60000)
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  if (!withDate) return time
  return `${DAY_LABELS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_LABELS[d.getUTCMonth()]} ${time}`
}

function fmtRelative(ms: number, nowMs: number): string {
  const diff = Math.max(0, ms - nowMs)
  const s = Math.round(diff / 1000)
  if (s < 60) return 'in under a minute'
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `in ${d}d ${h % 24}h`
}

/* ================================================================== */
/* Schedule builder                                                     */
/* ================================================================== */

type Preset = 'minute' | 'nmin' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'reboot' | 'custom'

interface Builder {
  preset: Preset
  n: number
  minute: number
  hour: number
  days: number[]
  dom: number
  custom: string
}

const PRESET_LABELS: Record<Preset, string> = {
  minute: 'Every minute',
  nmin: 'Every N minutes',
  hourly: 'Hourly at :MM',
  daily: 'Daily at HH:MM',
  weekly: 'Weekly on days at HH:MM',
  monthly: 'Monthly on day at HH:MM',
  reboot: 'At reboot',
  custom: 'Custom cron expression'
}

function builderToExpr(b: Builder): string {
  switch (b.preset) {
    case 'minute':
      return '* * * * *'
    case 'nmin':
      return `*/${Math.max(1, Math.min(59, b.n))} * * * *`
    case 'hourly':
      return `${b.minute} * * * *`
    case 'daily':
      return `${b.minute} ${b.hour} * * *`
    case 'weekly':
      return `${b.minute} ${b.hour} * * ${b.days.length ? [...b.days].sort((a, c) => a - c).join(',') : '*'}`
    case 'monthly':
      return `${b.minute} ${b.hour} ${b.dom} * *`
    case 'reboot':
      return '@reboot'
    default:
      return b.custom
  }
}

function builderFromExpr(expr: string): Builder {
  const base: Builder = { preset: 'custom', n: 5, minute: 0, hour: 3, days: [1], dom: 1, custom: expr.trim() || '* * * * *' }
  let e = expr.trim().replace(/\s+/g, ' ')
  if (!e) return { ...base, preset: 'daily' }
  if (e.toLowerCase() === '@reboot') return { ...base, preset: 'reboot' }
  if (e.startsWith('@') && ALIASES[e.toLowerCase()]) e = ALIASES[e.toLowerCase()]
  const p = e.split(' ')
  if (p.length !== 5) return base
  const [m, h, dom, mon, dow] = p
  const num = (s: string): boolean => /^\d+$/.test(s)
  if (mon !== '*') return base
  if (m === '*' && h === '*' && dom === '*' && dow === '*') return { ...base, preset: 'minute' }
  const step = m.match(/^\*\/(\d+)$/)
  if (step && h === '*' && dom === '*' && dow === '*') return { ...base, preset: 'nmin', n: Number(step[1]) }
  if (num(m) && h === '*' && dom === '*' && dow === '*') return { ...base, preset: 'hourly', minute: Number(m) }
  if (num(m) && num(h) && dom === '*' && dow === '*') return { ...base, preset: 'daily', minute: Number(m), hour: Number(h) }
  if (num(m) && num(h) && dom === '*' && /^\d+(,\d+)*$/.test(dow)) return { ...base, preset: 'weekly', minute: Number(m), hour: Number(h), days: dow.split(',').map((d) => (Number(d) === 7 ? 0 : Number(d))) }
  if (num(m) && num(h) && num(dom) && dow === '*') return { ...base, preset: 'monthly', minute: Number(m), hour: Number(h), dom: Number(dom) }
  return base
}

function ScheduleBuilder({ value, onChange, offsetMin, nowMs }: { value: string; onChange: (expr: string) => void; offsetMin: number; nowMs: number }): React.JSX.Element {
  const [b, setB] = useState<Builder>(() => builderFromExpr(value))
  const update = (patch: Partial<Builder>): void => {
    const next = { ...b, ...patch }
    setB(next)
    onChange(builderToExpr(next))
  }
  const expr = builderToExpr(b)
  const valid = parseCron(expr) !== null
  const runs = useMemo(() => (valid ? nextRuns(expr, nowMs, offsetMin, 3) : []), [expr, valid, nowMs, offsetMin])
  const timeInputs = (
    <>
      {(b.preset === 'daily' || b.preset === 'weekly' || b.preset === 'monthly') && (
        <Field label="Hour" className="w-24">
          <Input type="number" min={0} max={23} value={b.hour} onChange={(e) => update({ hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })} mono />
        </Field>
      )}
      <Field label="Minute" className="w-24">
        <Input type="number" min={0} max={59} value={b.minute} onChange={(e) => update({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} mono />
      </Field>
    </>
  )
  return (
    <div className="space-y-3">
      <Field label="Schedule">
        <Select value={b.preset} onChange={(e) => update({ preset: e.target.value as Preset })}>
          {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-3 items-end">
        {b.preset === 'nmin' && (
          <Field label="Every N minutes" className="w-32">
            <Input type="number" min={1} max={59} value={b.n} onChange={(e) => update({ n: Math.max(1, Math.min(59, Number(e.target.value) || 1)) })} mono />
          </Field>
        )}
        {(b.preset === 'hourly' || b.preset === 'daily' || b.preset === 'weekly' || b.preset === 'monthly') && timeInputs}
        {b.preset === 'monthly' && (
          <Field label="Day of month" className="w-28">
            <Input type="number" min={1} max={31} value={b.dom} onChange={(e) => update({ dom: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })} mono />
          </Field>
        )}
        {b.preset === 'weekly' && (
          <Field label="Days" className="w-full">
            <div className="flex flex-wrap gap-3">
              {DAY_LABELS.map((d, i) => (
                <Checkbox key={d} checked={b.days.includes(i)} label={d} onChange={(on) => update({ days: on ? [...b.days, i] : b.days.filter((x) => x !== i) })} />
              ))}
            </div>
          </Field>
        )}
        {b.preset === 'custom' && (
          <Field label="Cron expression" className="w-full" hint="minute hour day-of-month month day-of-week — or @reboot, @hourly, @daily, @weekly, @monthly, @yearly">
            <Input value={b.custom} onChange={(e) => update({ custom: e.target.value })} mono placeholder="*/15 2-6 * * 1-5" />
          </Field>
        )}
      </div>
      <div className={cls('rounded-md border px-3 py-2 text-xs', valid ? 'bg-bg-2 border-border' : 'bg-danger/10 border-danger/30 text-danger-fg')}>
        <div className="flex items-center gap-2">
          <code className="font-mono text-text">{expr}</code>
          <span className="text-muted">— {describeCron(expr)}</span>
        </div>
        {valid && b.preset !== 'reboot' && (
          <div className="mt-1.5 text-dim">
            Next runs (server time):{' '}
            {runs.length ? runs.map((r) => fmtInTz(r, offsetMin)).join(' · ') : 'never (no matching date in the next years)'}
          </div>
        )}
      </div>
    </div>
  )
}

/* ================================================================== */
/* Page                                                                 */
/* ================================================================== */

type TabId = 'user' | 'system' | 'timers'

export default function Cron({ serverId }: PageProps): React.JSX.Element {
  const status = useAsync(() => api.call<CronStatus>('cron:status', serverId), [serverId], { intervalMs: 60000 })
  const [tab, setTab] = useState<TabId>('user')
  const [logOpen, setLogOpen] = useState(false)
  const { run } = useAction()
  const st = status.data
  const offsetMin = tzOffsetMinutes(st?.serverTz ?? '+0000')
  const tzLabel = st ? (st.serverTzName && !/^[+-]\d/.test(st.serverTzName) ? `${st.serverTzName} (${st.serverTz.slice(0, 3)}${st.serverTz.slice(3) !== '00' ? ':' + st.serverTz.slice(3) : ''})` : st.serverTz.slice(0, 3) + (st.serverTz.slice(3) !== '00' ? ':' + st.serverTz.slice(3) : '')) : ''

  const install = async (): Promise<void> => {
    const id = await run(() => api.call<string>('cron:install', serverId))
    if (id) useApp.getState().toast({ kind: 'info', title: 'Installing cron… see Tasks' })
  }
  const startService = async (): Promise<void> => {
    await run(() => api.call('cron:startService', serverId), { success: 'cron service started' })
    await status.reload()
  }

  return (
    <>
      <PageHeader
        title="Cron jobs"
        subtitle={
          st && (
            <span className="inline-flex items-center gap-2">
              <Badge color={st.cronActive ? 'ok' : 'danger'}>{st.cronActive ? 'cron active' : st.installed ? 'cron inactive' : 'cron missing'}</Badge>
              <span>Server time zone: {tzLabel}</span>
            </span>
          )
        }
        actions={
          <>
            <Button icon={<ScrollText size={13} />} onClick={() => setLogOpen(true)}>
              Log
            </Button>
            <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void status.reload()} />
          </>
        }
      />
      <Page>
        {status.error ? (
          <ErrorBox error={status.error} onRetry={status.reload} />
        ) : !st ? (
          <Loading />
        ) : (
          <>
            {!st.installed && (
              <div className="mb-4">
                <Callout kind="warn">
                  <div className="flex items-center gap-3">
                    <span className="flex-1">
                      <b>crontab is not installed on this server.</b> User crontabs cannot be listed or edited until cron is installed.
                    </span>
                    <Button size="xs" variant="primary" icon={<Download size={12} />} onClick={install}>
                      Install cron
                    </Button>
                  </div>
                </Callout>
              </div>
            )}
            {st.installed && !st.cronActive && (
              <div className="mb-4">
                <Callout kind="warn">
                  <div className="flex items-center gap-3">
                    <span className="flex-1">
                      <b>The cron daemon is not running.</b> Jobs will not execute until it is started.
                    </span>
                    <Button size="xs" variant="primary" icon={<Play size={12} />} onClick={startService}>
                      Start cron
                    </Button>
                  </div>
                </Callout>
              </div>
            )}
            <div className="flex items-center justify-between mb-4">
              <Tabs<TabId> tabs={[{ id: 'user', label: 'User crontabs' }, { id: 'system', label: 'System cron' }, { id: 'timers', label: 'Timers' }]} value={tab} onChange={setTab} />
            </div>
            {tab === 'user' && <UserCrontabs serverId={serverId} status={st} offsetMin={offsetMin} />}
            {tab === 'system' && <SystemCron serverId={serverId} />}
            {tab === 'timers' && <TimersTab serverId={serverId} />}
          </>
        )}
      </Page>
      {logOpen && <LogModal serverId={serverId} onClose={() => setLogOpen(false)} />}
    </>
  )
}

/* ================================================================== */
/* User crontabs                                                        */
/* ================================================================== */

function UserCrontabs({ serverId, status, offsetMin }: { serverId: string; status: CronStatus; offsetMin: number }): React.JSX.Element {
  const [user, setUser] = useState(status.loginUser)
  const canSwitch = status.isRoot || status.sudoAvailable
  const list = useAsync(() => api.call<CronListResult>('cron:list', serverId, user), [serverId, user], { enabled: status.installed })
  const { run, busy } = useAction()
  const [editing, setEditing] = useState<CronJob | 'new' | null>(null)
  const [varsOpen, setVarsOpen] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const drift = useMemo(() => {
    const t = Date.parse(status.serverNow)
    return Number.isNaN(t) ? 0 : t - Date.now()
  }, [status.serverNow])
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(t)
  }, [])
  const nowServer = now + drift

  const save = useCallback(
    async (jobs: CronJob[], variables: CronVariable[], success?: string): Promise<boolean> => {
      const r = await run(
        () => api.call('cron:save', serverId, user, { jobs: jobs.map((j) => ({ schedule: j.schedule, command: j.command, comment: j.comment, enabled: j.enabled })), variables }),
        { success, error: 'Crontab not saved' }
      )
      await list.reload()
      return r !== undefined
    },
    [run, serverId, user, list]
  )

  const jobs = list.data?.jobs ?? []
  const variables = list.data?.variables ?? []

  const toggle = (job: CronJob, enabled: boolean): void => {
    void save(jobs.map((j) => (j.index === job.index ? { ...j, enabled } : j)), variables)
  }
  const remove = async (job: CronJob): Promise<void> => {
    if (!(await confirm({ title: 'Delete cron job', message: <>Delete the job <code className="font-mono text-text">{job.command}</code> from the crontab of <b>{user}</b>?</>, danger: true, confirmLabel: 'Delete' }))) return
    await save(jobs.filter((j) => j.index !== job.index), variables, 'Job deleted')
  }
  const runNow = async (command: string): Promise<void> => {
    const id = await run(() => api.call<string>('cron:runNow', serverId, user, command))
    if (id) useApp.getState().toast({ kind: 'info', title: 'Running job… output is in the Tasks drawer' })
  }

  const columns = [
    {
      key: 'enabled',
      header: '',
      width: '56px',
      render: (j: CronJob) => <Toggle checked={j.enabled} onChange={(v) => toggle(j, v)} disabled={busy} />
    },
    {
      key: 'schedule',
      header: 'Schedule',
      width: '260px',
      sortValue: (j: CronJob) => nextRuns(j.schedule, nowServer, offsetMin, 1)[0] ?? Number.MAX_SAFE_INTEGER,
      render: (j: CronJob) => (
        <div className="min-w-0">
          <div className="font-mono text-xs">{j.schedule}</div>
          <div className="text-dim text-[11px] truncate" title={describeCron(j.schedule)}>
            {describeCron(j.schedule)}
          </div>
        </div>
      )
    },
    {
      key: 'command',
      header: 'Command',
      sortValue: (j: CronJob) => j.command,
      render: (j: CronJob) => (
        <div className="min-w-0 max-w-[560px]">
          <div className="font-mono text-xs truncate" title={j.command}>
            {j.command}
          </div>
          {j.comment && (
            <div className="text-dim text-[11px] truncate" title={j.comment}>
              {j.comment}
            </div>
          )}
        </div>
      )
    },
    {
      key: 'next',
      header: 'Next run',
      width: '200px',
      sortValue: (j: CronJob) => nextRuns(j.schedule, nowServer, offsetMin, 1)[0] ?? Number.MAX_SAFE_INTEGER,
      render: (j: CronJob) => {
        if (!j.enabled) return <span className="text-dim text-xs">disabled</span>
        const p = parseCron(j.schedule)
        if (p === 'reboot') return <span className="text-muted text-xs">at reboot</span>
        if (!p) return <Badge color="danger">invalid</Badge>
        const n = nextRuns(j.schedule, nowServer, offsetMin, 1)[0]
        if (!n) return <span className="text-dim text-xs">never</span>
        return (
          <div>
            <div className="text-xs">{fmtInTz(n, offsetMin)}</div>
            <div className="text-dim text-[11px]">{fmtRelative(n, nowServer)}</div>
          </div>
        )
      }
    },
    {
      key: 'actions',
      header: '',
      width: '110px',
      align: 'right' as const,
      render: (j: CronJob) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton size="xs" title="Edit" icon={<Pencil size={13} />} onClick={() => setEditing(j)} />
          <IconButton size="xs" title="Run now" icon={<Play size={13} />} onClick={() => void runNow(j.command)} />
          <IconButton size="xs" title="Delete" icon={<Trash2 size={13} />} className="hover:text-danger-fg" onClick={() => void remove(j)} />
        </div>
      )
    }
  ]

  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <div className="w-56">
          <Select value={user} onChange={(e) => setUser(e.target.value)} disabled={!canSwitch && status.users.length > 1}>
            {status.users.map((u) => (
              <option key={u} value={u}>
                {u}
                {u === status.loginUser ? ' (login user)' : ''}
              </option>
            ))}
          </Select>
        </div>
        {!canSwitch && status.users.length > 1 && <span className="text-dim text-xs">Other users need sudo</span>}
        {variables.length > 0 && (
          <span className="text-dim text-xs font-mono truncate max-w-[360px]" title={variables.map((v) => `${v.key}=${v.value}`).join('\n')}>
            {variables.map((v) => v.key).join(', ')}
          </span>
        )}
        <div className="flex-1" />
        <IconButton title="Refresh" icon={<RefreshCw size={14} />} onClick={() => void list.reload()} />
        <Button icon={<FileText size={13} />} onClick={() => setRawOpen(true)} disabled={!status.installed}>
          Edit raw
        </Button>
        <Button icon={<Variable size={13} />} onClick={() => setVarsOpen(true)} disabled={!status.installed}>
          Variable
        </Button>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')} disabled={!status.installed}>
          Add job
        </Button>
      </div>
      {!status.installed ? (
        <Card>
          <EmptyState icon={<Clock />} title="cron is not installed" description="Install cron to manage user crontabs." />
        </Card>
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Clock />}
            title={`No cron jobs for ${user}`}
            description="Scheduled commands for this user appear here. Add a job to run a script on a schedule."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
                Add job
              </Button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <Table<CronJob> columns={columns} rows={jobs} rowKey={(j) => String(j.index)} />
        </Card>
      )}
      {editing && (
        <JobModal
          job={editing === 'new' ? null : editing}
          user={user}
          offsetMin={offsetMin}
          nowMs={nowServer}
          busy={busy}
          onRunNow={runNow}
          onClose={() => setEditing(null)}
          onSave={async (j) => {
            const next = editing === 'new' ? [...jobs, { ...j, index: jobs.length, user }] : jobs.map((x) => (x.index === editing.index ? { ...x, ...j } : x))
            if (await save(next, variables, editing === 'new' ? 'Job added' : 'Job saved')) setEditing(null)
          }}
        />
      )}
      {varsOpen && <VariablesModal variables={variables} busy={busy} onClose={() => setVarsOpen(false)} onSave={async (v) => (await save(jobs, v, 'Variables saved')) && setVarsOpen(false)} />}
      {rawOpen && <RawModal serverId={serverId} user={user} raw={list.data?.raw ?? ''} onClose={() => setRawOpen(false)} onSaved={() => void list.reload()} />}
    </>
  )
}

/* ------------------------------------------------------------------ */

function JobModal({ job, user, offsetMin, nowMs, busy, onClose, onSave, onRunNow }: {
  job: CronJob | null
  user: string
  offsetMin: number
  nowMs: number
  busy: boolean
  onClose: () => void
  onSave: (j: Pick<CronJob, 'schedule' | 'command' | 'comment' | 'enabled'>) => Promise<void>
  onRunNow: (command: string) => Promise<void>
}): React.JSX.Element {
  const [schedule, setSchedule] = useState(job?.schedule ?? '0 3 * * *')
  const [command, setCommand] = useState(job?.command ?? '')
  const [comment, setComment] = useState(job?.comment ?? '')
  const [enabled, setEnabled] = useState(job?.enabled ?? true)
  const valid = parseCron(schedule) !== null && looksLikeCronSchedule(schedule) && command.trim().length > 0
  return (
    <Modal
      open
      onClose={onClose}
      title={job ? 'Edit cron job' : 'Add cron job'}
      badge={<Badge>{user}</Badge>}
      width="max-w-2xl"
      footer={
        <>
          {command.trim() && (
            <Button icon={<Play size={13} />} onClick={() => void onRunNow(command.trim())} title="Run the command now as this user (does not save)">
              Run now
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void onSave({ schedule: schedule.trim().replace(/\s+/g, ' '), command: command.trim(), comment: comment.trim() || undefined, enabled })}>
            {job ? 'Save' : 'Add job'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ScheduleBuilder value={schedule} onChange={setSchedule} offsetMin={offsetMin} nowMs={nowMs} />
        <Field label="Command" hint="Runs with the user's cron environment (minimal PATH). Use absolute paths and redirect output, e.g. >> /var/log/job.log 2>&1">
          <Input value={command} onChange={(e) => setCommand(e.target.value)} mono placeholder="/usr/local/bin/backup.sh >> /var/log/backup.log 2>&1" />
        </Field>
        <Field label="Comment (optional)">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Nightly database backup" />
        </Field>
        <Toggle checked={enabled} onChange={setEnabled} label={enabled ? 'Enabled' : 'Disabled (kept in the crontab as a comment)'} />
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */

const VAR_SUGGESTIONS: { key: string; value: string; hint: string }[] = [
  { key: 'PATH', value: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', hint: 'Search path for commands' },
  { key: 'MAILTO', value: '', hint: 'Who receives job output (empty = nobody)' },
  { key: 'SHELL', value: '/bin/bash', hint: 'Shell used to run commands' },
  { key: 'HOME', value: '', hint: 'Working directory' },
  { key: 'CRON_TZ', value: 'UTC', hint: 'Time zone for schedules (cronie)' }
]

function VariablesModal({ variables, busy, onClose, onSave }: { variables: CronVariable[]; busy: boolean; onClose: () => void; onSave: (v: CronVariable[]) => Promise<unknown> }): React.JSX.Element {
  const [rows, setRows] = useState<CronVariable[]>(variables.length ? variables : [])
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const keyOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(newKey)
  const add = (): void => {
    if (!keyOk) return
    setRows((r) => [...r.filter((x) => x.key !== newKey), { key: newKey, value: newValue }])
    setNewKey('')
    setNewValue('')
  }
  const allValid = rows.every((r) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key))
  return (
    <Modal
      open
      onClose={onClose}
      title="Crontab variables"
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!allValid} onClick={() => void onSave(rows)}>
            Save
          </Button>
        </>
      }
    >
      <Callout>
        Variables are written at the top of the crontab as <code>KEY=value</code> and apply to every job. Common ones: PATH, MAILTO, SHELL.
      </Callout>
      <div className="mt-4 space-y-2">
        {rows.length === 0 && <div className="text-muted text-xs">No variables defined.</div>}
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={r.key} mono className="w-40" onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <span className="text-dim">=</span>
            <Input value={r.value} mono onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <IconButton title="Remove" icon={<Trash2 size={13} />} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
          </div>
        ))}
      </div>
      <div className="mt-4 pt-4 border-t border-border">
        <div className="text-xs text-muted font-medium mb-1.5">Add variable</div>
        <div className="flex items-center gap-2">
          <Input value={newKey} mono className="w-40" placeholder="KEY" list="sm-cron-vars" onChange={(e) => setNewKey(e.target.value.toUpperCase())} />
          <datalist id="sm-cron-vars">
            {VAR_SUGGESTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.hint}
              </option>
            ))}
          </datalist>
          <span className="text-dim">=</span>
          <Input value={newValue} mono placeholder="value" onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Button icon={<Plus size={13} />} disabled={!keyOk} onClick={add}>
            Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {VAR_SUGGESTIONS.filter((s) => !rows.some((r) => r.key === s.key)).map((s) => (
            <button
              key={s.key}
              className="text-[11px] px-1.5 h-5 rounded border border-border-2 bg-panel-2 text-muted hover:text-text font-mono"
              title={s.hint}
              onClick={() => {
                setNewKey(s.key)
                setNewValue(s.value)
              }}
            >
              {s.key}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */

function RawModal({ serverId, user, raw, onClose, onSaved }: { serverId: string; user: string; raw: string; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [text, setText] = useState(raw)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    if (!text.trim() && !(await confirm({ title: 'Remove crontab', message: <>The editor is empty. Saving removes <b>every</b> cron job of {user} (a backup is kept in /var/backups/servermate).</>, danger: true, confirmLabel: 'Remove all jobs' }))) return
    setBusy(true)
    setError(null)
    try {
      await api.call('cron:saveRaw', serverId, user, text)
      useApp.getState().toast({ kind: 'success', title: 'Crontab saved' })
      onSaved()
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit crontab"
      badge={<Badge>{user}</Badge>}
      width="max-w-3xl"
      footer={
        <>
          <span className="text-dim text-xs flex-1">Validated by <code>crontab</code> on the server; a backup of the previous version is kept in /var/backups/servermate.</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {error ? (
        <div className="mb-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
      <TextArea mono value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false} className="min-h-[320px]" />
    </Modal>
  )
}

/* ================================================================== */
/* System cron                                                          */
/* ================================================================== */

const DIR_LABELS: Record<string, string> = {
  '/etc/cron.d': 'Drop-in crontab fragments (with a user column)',
  '/etc/cron.hourly': 'Scripts run every hour',
  '/etc/cron.daily': 'Scripts run every day',
  '/etc/cron.weekly': 'Scripts run every week',
  '/etc/cron.monthly': 'Scripts run every month'
}

function SystemCron({ serverId }: { serverId: string }): React.JSX.Element {
  const sys = useAsync(() => api.call<CronSystemResult>('cron:system', serverId), [serverId])
  const [view, setView] = useState<{ path: string; preview?: string } | null>(null)
  const openFiles = (): void => useApp.getState().setPage(serverId, 'files')
  if (sys.error) return <ErrorBox error={sys.error} onRetry={sys.reload} />
  if (!sys.data) return <Loading />
  const d = sys.data
  const fileRow = (name: string, path: string, extra: React.ReactNode, preview?: string): React.JSX.Element => (
    <div key={path} className="flex items-center gap-3 px-4 py-2 border-b border-border/60 last:border-b-0">
      <FileText size={14} className="text-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs truncate">{name}</div>
      </div>
      {extra}
      <Button size="xs" icon={<Eye size={11} />} onClick={() => setView({ path, preview })}>
        View
      </Button>
      <Button size="xs" variant="ghost" icon={<ExternalLink size={11} />} onClick={openFiles} title={`Open ${path} in Files`}>
        Open in Files
      </Button>
    </div>
  )
  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title={<span className="font-mono">/etc (crontab)</span>} actions={<span className="text-dim text-[11px]">System-wide crontab with a user column</span>} flush>
          {d.crontab.exists ? (
            fileRow('crontab', d.crontab.path, <Badge>{d.crontab.jobs} job{d.crontab.jobs === 1 ? '' : 's'}</Badge>, d.crontab.preview)
          ) : (
            <div className="px-4 py-6 text-center text-muted text-xs">/etc/crontab does not exist</div>
          )}
        </Card>
        {d.dirs.map((dir) => (
          <Card key={dir.dir} title={<span className="font-mono">{dir.dir}</span>} actions={<span className="text-dim text-[11px]">{DIR_LABELS[dir.dir]}</span>} flush>
            {!dir.exists ? (
              <div className="px-4 py-6 text-center text-muted text-xs">Directory does not exist</div>
            ) : dir.files.length === 0 ? (
              <div className="px-4 py-6 text-center text-muted text-xs">No files</div>
            ) : (
              dir.files.map((f) =>
                fileRow(
                  f.name,
                  f.path,
                  <>
                    <span className="text-dim text-[11px] w-14 text-right">{fmtBytes(f.size)}</span>
                    {dir.dir !== '/etc/cron.d' && (f.executable ? <Badge color="ok">executable</Badge> : <Badge color="warn" className="cursor-help">not executable</Badge>)}
                  </>
                )
              )
            )}
          </Card>
        ))}
      </div>
      {view && <ViewFileModal serverId={serverId} path={view.path} preview={view.preview} onClose={() => setView(null)} onOpenFiles={openFiles} />}
    </>
  )
}

function ViewFileModal({ serverId, path, preview, onClose, onOpenFiles }: { serverId: string; path: string; preview?: string; onClose: () => void; onOpenFiles: () => void }): React.JSX.Element {
  const content = useAsync<string>(async () => (preview !== undefined ? preview : api.call<string>('cron:readFile', serverId, path)), [serverId, path])
  return (
    <Modal
      open
      onClose={onClose}
      title={<span className="font-mono text-[13px]">{path}</span>}
      badge={<Badge>read-only</Badge>}
      width="max-w-3xl"
      footer={
        <>
          <Button icon={<FolderOpen size={13} />} onClick={onOpenFiles}>
            Open in Files
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {content.error ? <ErrorBox error={content.error} onRetry={content.reload} /> : content.data === undefined ? <Loading /> : <Pre maxH="max-h-[60vh]">{content.data || '(empty file)'}</Pre>}
    </Modal>
  )
}

/* ================================================================== */
/* systemd timers                                                       */
/* ================================================================== */

function TimersTab({ serverId }: { serverId: string }): React.JSX.Element {
  const timers = useAsync(() => api.call<SystemdTimer[]>('cron:systemdTimers', serverId), [serverId], { intervalMs: 30000 })
  if (timers.error) return <ErrorBox error={timers.error} onRetry={timers.reload} />
  if (!timers.data) return <Loading />
  const rows = timers.data
  return (
    <Card flush title="systemd timers" actions={<IconButton title="Refresh" icon={<RefreshCw size={13} />} onClick={() => void timers.reload()} />}>
      <Table<SystemdTimer>
        rows={rows}
        rowKey={(t) => t.unit}
        empty="No systemd timers (or systemd is not available)"
        columns={[
          { key: 'unit', header: 'Timer', sortValue: (t) => t.unit, render: (t) => <span className="font-mono text-xs">{t.unit}</span> },
          { key: 'activates', header: 'Activates', sortValue: (t) => t.activates, render: (t) => <span className="font-mono text-xs text-muted">{t.activates}</span> },
          { key: 'next', header: 'Next', sortValue: (t) => t.next, render: (t) => <span className="text-xs">{t.next || '—'}</span> },
          { key: 'left', header: 'Left', render: (t) => <span className="text-xs text-muted">{t.left || '—'}</span> },
          { key: 'last', header: 'Last', sortValue: (t) => t.last, render: (t) => <span className="text-xs">{t.last || '—'}</span> },
          { key: 'passed', header: 'Passed', render: (t) => <span className="text-xs text-muted">{t.passed || '—'}</span> }
        ]}
      />
    </Card>
  )
}

/* ================================================================== */
/* Log modal                                                            */
/* ================================================================== */

function LogModal({ serverId, onClose }: { serverId: string; onClose: () => void }): React.JSX.Element {
  const [lines, setLines] = useState(200)
  const log = useAsync(() => api.call<string[]>('cron:log', serverId, lines), [serverId, lines])
  return (
    <Modal
      open
      onClose={onClose}
      title="Cron log"
      width="max-w-4xl"
      footer={
        <>
          <div className="w-32">
            <Select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
              <option value={100}>100 lines</option>
              <option value={200}>200 lines</option>
              <option value={500}>500 lines</option>
              <option value={2000}>2000 lines</option>
            </Select>
          </div>
          <Button icon={<RefreshCw size={13} />} onClick={() => void log.reload()} loading={log.loading}>
            Refresh
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {log.error ? (
        <ErrorBox error={log.error} onRetry={log.reload} />
      ) : !log.data ? (
        <Loading />
      ) : log.data.length === 0 ? (
        <EmptyState icon={<ScrollText />} title="No cron log entries" description="Nothing from journalctl (cron/crond) or /var/log/syslog, /var/log/cron. Cron may log elsewhere or logging may be disabled." />
      ) : (
        <Pre maxH="max-h-[65vh]">{log.data.join('\n')}</Pre>
      )}
    </Modal>
  )
}
