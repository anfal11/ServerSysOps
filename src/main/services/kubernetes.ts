import type { Ctx } from '../core'
import type { ExecOptions, SshClient } from '../ssh/SshClient'
import type { ExecResult } from '@shared/types'
import type {
  K8sApplyMode,
  K8sCommandKind,
  K8sConfigMap,
  K8sDistribution,
  K8sEvent,
  K8sHelmRelease,
  K8sInfo,
  K8sIngress,
  K8sIngressRule,
  K8sInstallFlavour,
  K8sKind,
  K8sLogsOpts,
  K8sNamespace,
  K8sNode,
  K8sOverview,
  K8sPod,
  K8sPv,
  K8sPvc,
  K8sSecret,
  K8sService,
  K8sStorageClass,
  K8sWorkload,
  K8sWorkloadKind
} from '@shared/modules/kubernetes'
import { b64Echo, shq } from '../ssh/shell'
import { installCmd, runPkg } from './pkg'

/* ------------------------------------------------------------------ */
/* Per-server command cache                                            */
/* ------------------------------------------------------------------ */

interface Mode {
  kind: K8sCommandKind
  /** kubectl invocation without arguments: `kubectl`, `microk8s kubectl`, `k3s kubectl`. */
  cmd: string
  sudo: boolean
  env?: Record<string, string>
  /** helm invocation (same privilege/env as kubectl), undefined when helm is missing. */
  helm?: string
}

const modes = new Map<string, Mode>()
const K3S_CONFIG = '/etc/rancher/k3s/k3s.yaml'
const REQ_TIMEOUT = '--request-timeout=20s'

const CANDIDATES: Mode[] = [
  { kind: 'kubectl', cmd: 'kubectl', sudo: false },
  { kind: 'kubectl-k3s-config', cmd: 'kubectl', sudo: true, env: { KUBECONFIG: K3S_CONFIG } },
  { kind: 'microk8s', cmd: 'microk8s kubectl', sudo: false },
  { kind: 'microk8s', cmd: 'microk8s kubectl', sudo: true },
  { kind: 'k3s', cmd: 'k3s kubectl', sudo: true }
]

/** Human-readable prefix for the terminal, e.g. `sudo env KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl`. */
function shellPrefix(m: Mode): string {
  const env = m.env ? Object.entries(m.env).map(([k, v]) => `${k}=${shq(v)}`).join(' ') : ''
  if (!env) return `${m.sudo ? 'sudo ' : ''}${m.cmd}`
  return `${m.sudo ? 'sudo ' : ''}env ${env} ${m.cmd}`
}

function canSudo(ssh: SshClient): boolean {
  return Boolean(ssh.os?.isRoot || ssh.os?.sudoAvailable)
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/

/** DNS-1123 subdomain: namespaces, resource names, container names. */
function assertK8sName(s: unknown, what = 'name'): string {
  if (typeof s !== 'string' || s.length === 0 || s.length > 253 || !K8S_NAME.test(s)) throw new Error(`Invalid ${what}: ${String(s)}`)
  return s
}

const KINDS: Record<K8sKind, { res: string; namespaced: boolean }> = {
  node: { res: 'node', namespaced: false },
  namespace: { res: 'namespace', namespaced: false },
  pod: { res: 'pod', namespaced: true },
  deployment: { res: 'deployment', namespaced: true },
  statefulset: { res: 'statefulset', namespaced: true },
  daemonset: { res: 'daemonset', namespaced: true },
  job: { res: 'job', namespaced: true },
  cronjob: { res: 'cronjob', namespaced: true },
  service: { res: 'service', namespaced: true },
  ingress: { res: 'ingress', namespaced: true },
  configmap: { res: 'configmap', namespaced: true },
  secret: { res: 'secret', namespaced: true },
  persistentvolumeclaim: { res: 'persistentvolumeclaim', namespaced: true },
  persistentvolume: { res: 'persistentvolume', namespaced: false },
  storageclass: { res: 'storageclass', namespaced: false }
}

function assertKind(k: unknown): K8sKind {
  if (typeof k !== 'string' || !(k in KINDS)) throw new Error(`Invalid resource kind: ${String(k)}`)
  return k as K8sKind
}

const WORKLOADS: Record<K8sWorkloadKind, string> = { deployment: 'deployments', statefulset: 'statefulsets', daemonset: 'daemonsets', job: 'jobs', cronjob: 'cronjobs' }

function assertWorkloadKind(k: unknown): K8sWorkloadKind {
  if (typeof k !== 'string' || !(k in WORKLOADS)) throw new Error(`Invalid workload kind: ${String(k)}`)
  return k as K8sWorkloadKind
}

function assertImageRef(s: unknown): string {
  if (typeof s !== 'string' || !s.trim()) throw new Error('Image is required')
  const v = s.trim()
  if (v.length > 255 || !/^[a-z0-9][a-z0-9._\-]*(:\d{1,5})?(\/[a-z0-9][a-z0-9._\-]*)*(:[A-Za-z0-9_.\-]+)?(@sha256:[a-f0-9]{64})?$/i.test(v)) throw new Error(`Invalid image reference: ${v}`)
  return v
}

/** `-n <ns>` for a namespace, `-A` for "all" (empty / null). */
function nsArg(ns: unknown): string {
  if (ns === null || ns === undefined || ns === '') return '-A'
  return `-n ${shq(assertK8sName(ns, 'namespace'))}`
}

/** Like nsArg but the operation needs a concrete namespace. */
function nsRequired(ns: unknown): string {
  if (ns === null || ns === undefined || ns === '') throw new Error('A namespace is required for this action')
  return `-n ${shq(assertK8sName(ns, 'namespace'))}`
}

/* ------------------------------------------------------------------ */
/* Exec helpers                                                        */
/* ------------------------------------------------------------------ */

async function mode(ctx: Ctx, serverId: string): Promise<Mode> {
  const cached = modes.get(serverId)
  if (cached) return cached
  const info = await detect(ctx, serverId)
  const m = modes.get(serverId)
  if (!m) throw new Error(info.error ?? 'Kubernetes is not available on this server')
  return m
}

/** Run `kubectl <args>` with the detected command, privilege and kubeconfig. */
async function kx(ctx: Ctx, serverId: string, args: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const ssh = ctx.ssh(serverId)
  const m = await mode(ctx, serverId)
  return ssh.exec(`${m.cmd} ${REQ_TIMEOUT} ${args}`, { timeoutMs: 60000, ...opts, sudo: m.sudo, env: m.env })
}

function failMsg(r: ExecResult, fallback: string): string {
  const msg = (r.stderr || r.stdout || fallback).trim()
  return msg.split('\n').slice(-6).join('\n') || fallback
}

async function kxRun(ctx: Ctx, serverId: string, args: string, opts: ExecOptions = {}): Promise<string> {
  const r = await kx(ctx, serverId, args, opts)
  if (r.code !== 0) throw new Error(failMsg(r, `kubectl exited with code ${r.code}`))
  return r.stdout
}

/** `kubectl get … -o json`, parsed. Returns the `items` array for lists. */
async function kxJson<T = Record<string, unknown>>(ctx: Ctx, serverId: string, args: string, opts: ExecOptions = {}): Promise<T> {
  const out = await kxRun(ctx, serverId, `${args} -o json`, { maxBuffer: 64 * 1024 * 1024, ...opts })
  return parseJson<T>(out)
}

async function kxItems(ctx: Ctx, serverId: string, args: string, opts: ExecOptions = {}): Promise<Obj[]> {
  const j = await kxJson<{ items?: unknown }>(ctx, serverId, args, opts)
  return Array.isArray(j.items) ? (j.items as Obj[]) : []
}

async function helmRun(ctx: Ctx, serverId: string, args: string, opts: ExecOptions = {}): Promise<string> {
  const ssh = ctx.ssh(serverId)
  const m = await mode(ctx, serverId)
  if (!m.helm) throw new Error('Helm is not installed on this server')
  const r = await ssh.exec(`${m.helm} ${args}`, { timeoutMs: 60000, ...opts, sudo: m.sudo, env: m.env })
  if (r.code !== 0) throw new Error(failMsg(r, `helm exited with code ${r.code}`))
  return r.stdout
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>

function parseJson<T>(out: string): T {
  const t = out.trim()
  const start = t.indexOf('{')
  if (start < 0) throw new Error('kubectl returned no JSON')
  try {
    return JSON.parse(t.slice(start)) as T
  } catch {
    throw new Error('Could not parse kubectl JSON output')
  }
}

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}

function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? (v as unknown[]).map(obj) : []
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(str(v))
  return Number.isFinite(n) ? n : 0
}

function meta(o: Obj): { name: string; namespace: string; created: string; labels: Record<string, string>; annotations: Record<string, string>; deleting: boolean; owner?: string } {
  const m = obj(o.metadata)
  const owners = arr(m.ownerReferences)
  return {
    name: str(m.name),
    namespace: str(m.namespace),
    created: str(m.creationTimestamp),
    labels: obj(m.labels) as Record<string, string>,
    annotations: obj(m.annotations) as Record<string, string>,
    deleting: Boolean(m.deletionTimestamp),
    owner: owners[0] ? `${str(owners[0].kind)}/${str(owners[0].name)}` : undefined
  }
}

/** Kubernetes CPU quantity → millicores ("4" → 4000, "250m" → 250, "123456789n" → 123). */
export function parseCpu(q: unknown): number {
  const s = str(q).trim()
  if (!s) return 0
  const m = s.match(/^([\d.]+)([a-zA-Z]*)$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  switch (m[2]) {
    case '':
      return Math.round(n * 1000)
    case 'm':
      return Math.round(n)
    case 'u':
      return Math.round(n / 1000)
    case 'n':
      return Math.round(n / 1e6)
    case 'k':
      return Math.round(n * 1e6)
    default:
      return Math.round(n * 1000)
  }
}

/** Kubernetes memory quantity → bytes ("16Gi", "2048Ki", "1500M", "123456"). */
export function parseMem(q: unknown): number {
  const s = str(q).trim()
  if (!s) return 0
  const m = s.match(/^([\d.]+)([a-zA-Z]*)$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  const mult: Record<string, number> = { '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, m: 1 / 1000 }
  return Math.round(n * (mult[m[2]] ?? 1))
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

async function probe(ssh: SshClient, m: Mode): Promise<{ ok: boolean; client?: string; server?: string; error?: string }> {
  if (m.sudo && !canSudo(ssh)) return { ok: false, error: 'sudo is not available' }
  if (m.env?.KUBECONFIG) {
    const f = await ssh.exec(`test -r ${shq(m.env.KUBECONFIG)} && echo yes`, { timeoutMs: 15000, sudo: m.sudo }).catch((): ExecResult => ({ code: 1, stdout: '', stderr: '' }))
    if (!f.stdout.includes('yes')) return { ok: false, error: `${m.env.KUBECONFIG} not found` }
  }
  let r: ExecResult
  try {
    r = await ssh.exec(`${m.cmd} version -o json ${REQ_TIMEOUT} 2>&1`, { timeoutMs: 45000, sudo: m.sudo, env: m.env })
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) }
  }
  // kubectl prints the client version JSON even when the server is unreachable (then exits 1 with the error after it).
  let j: Obj | null = null
  try {
    const start = r.stdout.indexOf('{')
    const end = r.stdout.lastIndexOf('}')
    if (start >= 0 && end > start) j = JSON.parse(r.stdout.slice(start, end + 1)) as Obj
  } catch {
    j = null
  }
  const client = j ? str(obj(j.clientVersion).gitVersion) : undefined
  const server = j ? str(obj(j.serverVersion).gitVersion) : undefined
  if (r.code === 0 && server) return { ok: true, client, server }
  const text = r.stdout.replace(/\{[\s\S]*\}/, '').trim() || r.stderr.trim()
  return { ok: false, client, error: text.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || `exit code ${r.code}` }
}

async function foundBinaries(ssh: SshClient): Promise<{ have: Set<string>; found: K8sInfo['found'] }> {
  const bins = await ssh.exec('for b in kubectl k3s microk8s snap helm; do command -v $b >/dev/null 2>&1 && echo "$b"; done', { timeoutMs: 15000 })
  const have = new Set(bins.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
  return { have, found: { kubectl: have.has('kubectl'), k3s: have.has('k3s'), microk8s: have.has('microk8s'), snap: have.has('snap') } }
}

function baseInfo(ssh: SshClient, have: Set<string>, found: K8sInfo['found']): K8sInfo {
  return { state: 'missing', needsSudo: false, helm: have.has('helm'), metrics: false, namespaces: [], found, pkgManager: ssh.os?.pkgManager ?? 'unknown' }
}

/** Distribution, node count, metrics and namespaces for a working mode, in one round-trip. */
async function infoForMode(ssh: SshClient, m: Mode, base: K8sInfo, versions: { client?: string; server?: string }): Promise<K8sInfo> {
  const info: K8sInfo = { ...base, state: 'ok', shellPrefix: shellPrefix(m), commandKind: m.kind, needsSudo: m.sudo, clientVersion: versions.client, serverVersion: versions.server, helm: Boolean(m.helm), helmPrefix: m.helm ? `${m.sudo ? 'sudo ' : ''}${m.helm}` : undefined }
  const extra = await ssh.exec(
    [
      `echo __NODES; ${m.cmd} ${REQ_TIMEOUT} get nodes -o json 2>/dev/null`,
      `echo __NS; ${m.cmd} ${REQ_TIMEOUT} get namespaces -o json 2>/dev/null`,
      `echo __TOP; ${m.cmd} ${REQ_TIMEOUT} top nodes >/dev/null 2>&1 && echo ok`,
      `echo __KUBEADM; test -e /etc/kubernetes/admin.conf && echo yes`,
      'echo __END'
    ].join('; '),
    { timeoutMs: 60000, sudo: m.sudo, env: m.env, maxBuffer: 32 * 1024 * 1024 }
  )
  const s = sections(extra.stdout)
  const server = versions.server ?? ''
  try {
    const nodes = arr(obj(JSON.parse(s.NODES ?? '{}')).items)
    info.nodeCount = nodes.length
    const labels = nodes.map((n) => meta(n).labels)
    if (m.kind === 'microk8s' || labels.some((l) => 'microk8s.io/cluster' in l)) info.distribution = 'microk8s'
    else if (m.kind === 'k3s' || m.kind === 'kubectl-k3s-config' || /k3s/.test(server) || labels.some((l) => l['node.kubernetes.io/instance-type'] === 'k3s')) info.distribution = 'k3s'
    else if ((s.KUBEADM ?? '').includes('yes') || nodes.some((n) => 'kubeadm.alpha.kubernetes.io/cri-socket' in meta(n).annotations)) info.distribution = 'kubeadm'
    else info.distribution = 'other'
  } catch {
    info.distribution = /k3s/.test(server) ? 'k3s' : m.kind === 'microk8s' ? 'microk8s' : 'other'
  }
  try {
    info.namespaces = arr(obj(JSON.parse(s.NS ?? '{}')).items)
      .map((n) => meta(n).name)
      .filter(Boolean)
      .sort()
  } catch {
    info.namespaces = []
  }
  info.metrics = (s.TOP ?? '').includes('ok')
  return info
}

/** Full detection: find a working kubectl invocation (in the documented order) and remember it. */
async function detect(ctx: Ctx, serverId: string): Promise<K8sInfo> {
  const ssh = ctx.ssh(serverId)
  modes.delete(serverId)
  const { have, found } = await foundBinaries(ssh)
  const base = baseInfo(ssh, have, found)
  if (!found.kubectl && !found.k3s && !found.microk8s) return base

  const errors: string[] = []
  let clientVersion: string | undefined
  for (const cand of CANDIDATES) {
    if (cand.cmd === 'kubectl' && !found.kubectl) continue
    if (cand.kind === 'microk8s' && !found.microk8s) continue
    if (cand.kind === 'k3s' && !found.k3s) continue
    if (cand.kind === 'kubectl-k3s-config' && !found.k3s && !(await ssh.exec(`test -e ${K3S_CONFIG} && echo yes`, { timeoutMs: 10000 })).stdout.includes('yes')) continue
    const p = await probe(ssh, cand)
    if (p.client && !clientVersion) clientVersion = p.client
    if (!p.ok) {
      errors.push(`${shellPrefix(cand)}: ${p.error ?? 'failed'}`)
      continue
    }
    const m: Mode = { ...cand }
    // helm: plain binary with the same env/sudo, or microk8s' bundled helm3.
    if (have.has('helm')) m.helm = 'helm'
    else if (cand.kind === 'microk8s') {
      const h = await ssh.exec('microk8s helm3 version --short 2>/dev/null', { timeoutMs: 20000, sudo: cand.sudo }).catch((): ExecResult => ({ code: 1, stdout: '', stderr: '' }))
      if (h.code === 0) m.helm = 'microk8s helm3'
    }
    modes.set(serverId, m)
    return infoForMode(ssh, m, base, p)
  }
  return { ...base, state: 'no-cluster', clientVersion, error: errors.filter(Boolean).join('\n') || 'No working kubectl configuration found' }
}

function sections(out: string): Record<string, string> {
  const res: Record<string, string> = {}
  let cur = ''
  const buf: string[] = []
  const flush = (): void => {
    if (cur) res[cur] = buf.join('\n')
    buf.length = 0
  }
  for (const line of out.split('\n')) {
    const m = line.match(/^__([A-Z0-9]+)$/)
    if (m) {
      flush()
      cur = m[1]
      continue
    }
    if (cur) buf.push(line)
  }
  flush()
  return res
}

/* ------------------------------------------------------------------ */
/* Row builders                                                       */
/* ------------------------------------------------------------------ */

function nodeRow(n: Obj, usage?: Map<string, { cpu: number; mem: number }>): K8sNode {
  const m = meta(n)
  const status = obj(n.status)
  const spec = obj(n.spec)
  const ready = arr(status.conditions).find((c) => str(c.type) === 'Ready')
  const nodeInfo = obj(status.nodeInfo)
  const cap = obj(status.capacity)
  const roles = Object.keys(m.labels)
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean)
  if (m.labels['kubernetes.io/role'] && !roles.includes(m.labels['kubernetes.io/role'])) roles.push(m.labels['kubernetes.io/role'])
  const u = usage?.get(m.name)
  return {
    name: m.name,
    ready: str(ready?.status) === 'True',
    readyMessage: ready && str(ready.status) !== 'True' ? `${str(ready.reason)}: ${str(ready.message)}` : undefined,
    unschedulable: Boolean(spec.unschedulable),
    roles: roles.length ? roles : ['<none>'],
    version: str(nodeInfo.kubeletVersion),
    internalIP: str(arr(status.addresses).find((a) => str(a.type) === 'InternalIP')?.address),
    os: str(nodeInfo.osImage),
    kernel: str(nodeInfo.kernelVersion),
    containerRuntime: str(nodeInfo.containerRuntimeVersion),
    cpuCapacity: parseCpu(cap.cpu),
    memCapacity: parseMem(cap.memory),
    cpuUsage: u?.cpu,
    memUsage: u?.mem,
    created: m.created,
    taints: arr(spec.taints).length
  }
}

/** kubectl's pod STATUS column logic, simplified. */
function podStatus(p: Obj): { status: string; ready: number; total: number; restarts: number } {
  const m = meta(p)
  const spec = obj(p.spec)
  const status = obj(p.status)
  const containers = arr(spec.containers)
  const cs = arr(status.containerStatuses)
  const ics = arr(status.initContainerStatuses)
  let label = str(status.reason) || str(status.phase)
  let restarts = 0
  for (const c of cs) restarts += num(c.restartCount)
  for (const c of ics) restarts += num(c.restartCount)
  // Init containers first.
  let initializing = false
  for (let i = 0; i < ics.length; i++) {
    const st = obj(ics[i].state)
    const term = obj(st.terminated)
    const wait = obj(st.waiting)
    if (Object.keys(term).length && num(term.exitCode) === 0) continue
    initializing = true
    if (Object.keys(term).length) label = `Init:${str(term.reason) || (term.signal ? `Signal:${str(term.signal)}` : `ExitCode:${str(term.exitCode)}`)}`
    else if (Object.keys(wait).length && str(wait.reason) && str(wait.reason) !== 'PodInitializing') label = `Init:${str(wait.reason)}`
    else label = `Init:${i}/${ics.length}`
    break
  }
  let ready = 0
  if (!initializing) {
    let hasRunning = false
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i]
      if (c.ready === true) ready++
      const st = obj(c.state)
      const wait = obj(st.waiting)
      const term = obj(st.terminated)
      if (Object.keys(wait).length && str(wait.reason)) label = str(wait.reason)
      else if (Object.keys(term).length) label = str(term.reason) || (term.signal ? `Signal:${str(term.signal)}` : `ExitCode:${str(term.exitCode)}`)
      else if (Object.keys(obj(st.running)).length) hasRunning = true
    }
    if (label === 'Completed' && hasRunning) label = ready > 0 ? 'Running' : 'NotReady'
  } else {
    ready = 0
  }
  if (m.deleting) label = str(status.reason) === 'NodeLost' ? 'Unknown' : 'Terminating'
  return { status: label || 'Unknown', ready, total: containers.length, restarts }
}

function podRow(p: Obj): K8sPod {
  const m = meta(p)
  const spec = obj(p.spec)
  const status = obj(p.status)
  const s = podStatus(p)
  return {
    name: m.name,
    namespace: m.namespace,
    readyCount: s.ready,
    containerCount: s.total,
    status: s.status,
    phase: str(status.phase),
    restarts: s.restarts,
    node: str(spec.nodeName),
    ip: str(status.podIP),
    created: m.created,
    containers: arr(spec.containers).map((c) => str(c.name)),
    initContainers: arr(spec.initContainers).map((c) => str(c.name)),
    owner: m.owner
  }
}

function templateContainers(spec: Obj): { names: string[]; images: string[] } {
  const tpl = obj(obj(spec.template).spec)
  const cs = arr(tpl.containers)
  return { names: cs.map((c) => str(c.name)), images: cs.map((c) => str(c.image)) }
}

function workloadRow(kind: K8sWorkloadKind, o: Obj): K8sWorkload {
  const m = meta(o)
  const spec = obj(o.spec)
  const status = obj(o.status)
  const base: K8sWorkload = { kind, name: m.name, namespace: m.namespace, ready: 0, desired: 0, images: [], containers: [], created: m.created }
  switch (kind) {
    case 'deployment':
    case 'statefulset': {
      const tc = templateContainers(spec)
      return { ...base, ready: num(status.readyReplicas), desired: spec.replicas === undefined ? 1 : num(spec.replicas), upToDate: num(status.updatedReplicas), available: num(status.availableReplicas), ...tc, containers: tc.names }
    }
    case 'daemonset': {
      const tc = templateContainers(spec)
      return { ...base, ready: num(status.numberReady), desired: num(status.desiredNumberScheduled), upToDate: num(status.updatedNumberScheduled), available: num(status.numberAvailable), images: tc.images, containers: tc.names }
    }
    case 'job': {
      const tc = templateContainers(spec)
      const conds = arr(status.conditions)
      const failed = conds.find((c) => str(c.type) === 'Failed' && str(c.status) === 'True')
      const complete = conds.find((c) => str(c.type) === 'Complete' && str(c.status) === 'True')
      const st = failed ? 'Failed' : complete ? 'Complete' : num(status.active) > 0 ? 'Running' : str(status.succeeded) ? 'Complete' : 'Pending'
      return { ...base, ready: num(status.succeeded), desired: spec.completions === undefined ? 1 : num(spec.completions), status: st, active: num(status.active), images: tc.images, containers: tc.names }
    }
    case 'cronjob': {
      const jt = obj(obj(spec.jobTemplate).spec)
      const tc = templateContainers(jt)
      return { ...base, schedule: str(spec.schedule), suspend: Boolean(spec.suspend), active: arr(status.active).length, lastSchedule: str(status.lastScheduleTime), images: tc.images, containers: tc.names }
    }
  }
}

function serviceRow(o: Obj): K8sService {
  const m = meta(o)
  const spec = obj(o.spec)
  const status = obj(o.status)
  const lb = arr(obj(status.loadBalancer).ingress).map((i) => str(i.ip) || str(i.hostname)).filter(Boolean)
  const ext = (Array.isArray(spec.externalIPs) ? (spec.externalIPs as unknown[]).map(str) : []).concat(lb)
  if (str(spec.type) === 'ExternalName' && spec.externalName) ext.push(str(spec.externalName))
  return {
    name: m.name,
    namespace: m.namespace,
    type: str(spec.type),
    clusterIP: str(spec.clusterIP),
    externalIPs: ext,
    ports: arr(spec.ports).map((p) => `${str(p.port)}${p.targetPort !== undefined && str(p.targetPort) !== str(p.port) ? `→${str(p.targetPort)}` : ''}/${str(p.protocol) || 'TCP'}${p.nodePort ? ` (node ${str(p.nodePort)})` : ''}`),
    selector: obj(spec.selector) as Record<string, string>,
    created: m.created
  }
}

function ingressRow(o: Obj): K8sIngress {
  const m = meta(o)
  const spec = obj(o.spec)
  const status = obj(o.status)
  const rules: K8sIngressRule[] = []
  const hosts = new Set<string>()
  const backendStr = (b: Obj): string => {
    const svc = obj(b.service)
    if (Object.keys(svc).length) {
      const port = obj(svc.port)
      return `${str(svc.name)}:${str(port.number) || str(port.name)}`
    }
    const res = obj(b.resource)
    if (Object.keys(res).length) return `${str(res.kind)}/${str(res.name)}`
    return ''
  }
  for (const r of arr(spec.rules)) {
    const host = str(r.host) || '*'
    hosts.add(host)
    const paths = arr(obj(r.http).paths)
    if (!paths.length) rules.push({ host, path: '/', pathType: '', backend: '' })
    for (const p of paths) rules.push({ host, path: str(p.path) || '/', pathType: str(p.pathType), backend: backendStr(obj(p.backend)) })
  }
  const def = obj(spec.defaultBackend)
  if (Object.keys(def).length) rules.push({ host: '*', path: '(default)', pathType: '', backend: backendStr(def) })
  return {
    name: m.name,
    namespace: m.namespace,
    className: str(spec.ingressClassName) || str(m.annotations['kubernetes.io/ingress.class']),
    hosts: [...hosts],
    rules,
    tls: arr(spec.tls).length > 0,
    addresses: arr(obj(status.loadBalancer).ingress).map((i) => str(i.ip) || str(i.hostname)).filter(Boolean),
    created: m.created
  }
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export function register(ctx: Ctx): void {
  ctx.sessions.on('state', (s: { serverId: string; status: string }) => {
    if (s.status !== 'connected') modes.delete(s.serverId)
  })

  // ---------------- detect ----------------
  ctx.handle('k8s:detect', async (serverId: string, force?: boolean): Promise<K8sInfo> => {
    const cached = modes.get(serverId)
    if (!force && cached) {
      // Fast path: the command is known; just re-probe it and refresh versions / namespaces / metrics.
      const ssh = ctx.ssh(serverId)
      const p = await probe(ssh, cached)
      if (p.ok) {
        const { have, found } = await foundBinaries(ssh)
        if (have.has('helm') && !cached.helm) cached.helm = 'helm'
        return infoForMode(ssh, cached, baseInfo(ssh, have, found), p)
      }
    }
    return detect(ctx, serverId)
  })

  // ---------------- overview ----------------
  ctx.handle('k8s:overview', async (serverId: string): Promise<K8sOverview> => {
    const m = await mode(ctx, serverId)
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(
      [
        `echo __NODES; ${m.cmd} ${REQ_TIMEOUT} get nodes -o json; echo "__RC=$?"`,
        `echo __PODS; ${m.cmd} ${REQ_TIMEOUT} get pods -A -o json 2>/dev/null`,
        `echo __DEPLOY; ${m.cmd} ${REQ_TIMEOUT} get deployments -A -o json 2>/dev/null`,
        `echo __NS; ${m.cmd} ${REQ_TIMEOUT} get namespaces -o json 2>/dev/null`,
        `echo __METRICS; ${m.cmd} ${REQ_TIMEOUT} get --raw /apis/metrics.k8s.io/v1beta1/nodes 2>/dev/null`,
        'echo __END'
      ].join('; '),
      { timeoutMs: 90000, sudo: m.sudo, env: m.env, maxBuffer: 128 * 1024 * 1024 }
    )
    const s = sections(r.stdout)
    const rc = Number(r.stdout.match(/__RC=(\d+)/)?.[1] ?? '1')
    const nodesRaw = (s.NODES ?? '').replace(/__RC=\d+\s*$/, '')
    if (rc !== 0 || !nodesRaw.trim().startsWith('{')) throw new Error(failMsg({ code: rc, stdout: nodesRaw, stderr: r.stderr }, 'kubectl get nodes failed'))
    const safe = (t: string | undefined): Obj => {
      try {
        return t?.trim().startsWith('{') ? (JSON.parse(t) as Obj) : {}
      } catch {
        return {}
      }
    }
    const usage = new Map<string, { cpu: number; mem: number }>()
    const metricsItems = arr(safe(s.METRICS).items)
    for (const it of metricsItems) usage.set(meta(it).name, { cpu: parseCpu(obj(it.usage).cpu), mem: parseMem(obj(it.usage).memory) })
    const nodes = arr(safe(nodesRaw).items).map((n) => nodeRow(n, metricsItems.length ? usage : undefined))
    const pods = { running: 0, pending: 0, failed: 0, succeeded: 0, other: 0, total: 0 }
    for (const p of arr(safe(s.PODS).items)) {
      pods.total++
      const st = podStatus(p).status
      if (st === 'Running') pods.running++
      else if (st === 'Pending' || st === 'ContainerCreating' || st === 'PodInitializing' || st.startsWith('Init:')) pods.pending++
      else if (st === 'Succeeded' || st === 'Completed') pods.succeeded++
      else if (/Failed|Error|CrashLoopBackOff|ImagePull|OOMKilled|Evicted/i.test(st)) pods.failed++
      else pods.other++
    }
    const deps = arr(safe(s.DEPLOY).items)
    const deployments = { total: deps.length, available: deps.filter((d) => num(obj(d.status).availableReplicas) >= (obj(d.spec).replicas === undefined ? 1 : num(obj(d.spec).replicas))).length }
    return { nodes, nodesReady: nodes.filter((n) => n.ready).length, pods, deployments, namespaces: arr(safe(s.NS).items).length, metrics: metricsItems.length > 0 }
  })

  ctx.handle('k8s:nodeAction', async (serverId: string, name: string, action: 'cordon' | 'uncordon') => {
    assertK8sName(name, 'node name')
    if (action !== 'cordon' && action !== 'uncordon') throw new Error('Invalid node action')
    await kxRun(ctx, serverId, `${action} ${shq(name)}`)
    ctx.audit(serverId, `k8s.node.${action}`, name)
  })

  ctx.handle('k8s:drain', async (serverId: string, name: string) => {
    assertK8sName(name, 'node name')
    const { id } = ctx.tasks.start(`Drain node ${name}`, serverId, async (h) => {
      h.log(`$ kubectl drain ${name} --ignore-daemonsets --delete-emptydir-data --force`)
      await kxRun(ctx, serverId, `drain ${shq(name)} --ignore-daemonsets --delete-emptydir-data --force --timeout=600s`, { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      h.log('Node drained. It stays cordoned until you uncordon it.')
      ctx.audit(serverId, 'k8s.node.drain', name)
    })
    return id
  })

  // ---------------- generic: describe / yaml / delete ----------------
  ctx.handle('k8s:describe', async (serverId: string, kind: K8sKind, name: string, ns?: string): Promise<string> => {
    const k = assertKind(kind)
    assertK8sName(name, 'name')
    const r = await kx(ctx, serverId, `describe ${KINDS[k].res} ${shq(name)} ${KINDS[k].namespaced ? nsRequired(ns) : ''} 2>&1`)
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(failMsg(r, 'kubectl describe failed'))
    return r.stdout
  })

  ctx.handle('k8s:getYaml', async (serverId: string, kind: K8sKind, name: string, ns?: string): Promise<string> => {
    const k = assertKind(kind)
    assertK8sName(name, 'name')
    return kxRun(ctx, serverId, `get ${KINDS[k].res} ${shq(name)} ${KINDS[k].namespaced ? nsRequired(ns) : ''} -o yaml`)
  })

  ctx.handle('k8s:delete', async (serverId: string, kind: K8sKind, name: string, ns?: string, force?: boolean) => {
    const k = assertKind(kind)
    assertK8sName(name, 'name')
    if (k === 'namespace' && ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(name)) throw new Error(`Refusing to delete the ${name} namespace`)
    await kxRun(ctx, serverId, `delete ${KINDS[k].res} ${shq(name)} ${KINDS[k].namespaced ? nsRequired(ns) : ''} ${force ? '--grace-period=0 --force' : ''} --wait=false`, { timeoutMs: 120000 })
    ctx.audit(serverId, `k8s.${k}.delete`, ns ? `${ns}/${name}` : name)
  })

  // ---------------- workloads ----------------
  ctx.handle('k8s:workloads', async (serverId: string, kind: K8sWorkloadKind, ns?: string): Promise<K8sWorkload[]> => {
    const k = assertWorkloadKind(kind)
    const items = await kxItems(ctx, serverId, `get ${WORKLOADS[k]} ${nsArg(ns)}`)
    return items.map((o) => workloadRow(k, o))
  })

  ctx.handle('k8s:scale', async (serverId: string, kind: K8sWorkloadKind, name: string, ns: string, replicas: number) => {
    const k = assertWorkloadKind(kind)
    if (k !== 'deployment' && k !== 'statefulset') throw new Error('Only deployments and statefulsets can be scaled')
    assertK8sName(name, 'name')
    const n = Number(replicas)
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('Replicas must be an integer between 0 and 1000')
    await kxRun(ctx, serverId, `scale ${k} ${shq(name)} ${nsRequired(ns)} --replicas=${n}`)
    ctx.audit(serverId, `k8s.${k}.scale`, `${ns}/${name} → ${n}`)
  })

  ctx.handle('k8s:rolloutRestart', async (serverId: string, kind: K8sWorkloadKind, name: string, ns: string) => {
    const k = assertWorkloadKind(kind)
    if (k !== 'deployment' && k !== 'statefulset' && k !== 'daemonset') throw new Error('Rollout restart applies to deployments, statefulsets and daemonsets')
    assertK8sName(name, 'name')
    await kxRun(ctx, serverId, `rollout restart ${k} ${shq(name)} ${nsRequired(ns)}`)
    ctx.audit(serverId, `k8s.${k}.restart`, `${ns}/${name}`)
  })

  ctx.handle('k8s:rolloutStatus', async (serverId: string, kind: K8sWorkloadKind, name: string, ns: string): Promise<string> => {
    const k = assertWorkloadKind(kind)
    if (k !== 'deployment' && k !== 'statefulset' && k !== 'daemonset') throw new Error('Rollout status applies to deployments, statefulsets and daemonsets')
    assertK8sName(name, 'name')
    const r = await kx(ctx, serverId, `rollout status ${k} ${shq(name)} ${nsRequired(ns)} --timeout=15s 2>&1`, { timeoutMs: 40000 })
    const hist = await kx(ctx, serverId, `rollout history ${k} ${shq(name)} ${nsRequired(ns)} 2>&1`, { timeoutMs: 30000 })
    return `${r.stdout.trim()}\n\n${hist.stdout.trim()}`.trim()
  })

  ctx.handle('k8s:setImage', async (serverId: string, kind: K8sWorkloadKind, name: string, ns: string, container: string, image: string) => {
    const k = assertWorkloadKind(kind)
    if (k === 'cronjob' || k === 'job') throw new Error('Set image is not supported for jobs')
    assertK8sName(name, 'name')
    assertK8sName(container, 'container name')
    const img = assertImageRef(image)
    await kxRun(ctx, serverId, `set image ${k}/${shq(name)} ${nsRequired(ns)} ${shq(`${container}=${img}`)}`)
    ctx.audit(serverId, `k8s.${k}.setImage`, `${ns}/${name} ${container}=${img}`)
  })

  ctx.handle('k8s:cronjobSuspend', async (serverId: string, name: string, ns: string, suspend: boolean) => {
    assertK8sName(name, 'name')
    const patch = JSON.stringify({ spec: { suspend: Boolean(suspend) } })
    await kxRun(ctx, serverId, `patch cronjob ${shq(name)} ${nsRequired(ns)} -p ${shq(patch)}`)
    ctx.audit(serverId, suspend ? 'k8s.cronjob.suspend' : 'k8s.cronjob.resume', `${ns}/${name}`)
  })

  ctx.handle('k8s:cronjobTrigger', async (serverId: string, name: string, ns: string): Promise<string> => {
    assertK8sName(name, 'name')
    const ts = Math.floor(Date.now() / 1000)
    const jobName = `${name}-manual-${ts}`.slice(0, 63).replace(/-+$/, '')
    assertK8sName(jobName, 'job name')
    await kxRun(ctx, serverId, `create job --from=cronjob/${shq(name)} ${shq(jobName)} ${nsRequired(ns)}`)
    ctx.audit(serverId, 'k8s.cronjob.trigger', `${ns}/${name} → ${jobName}`)
    return jobName
  })

  // ---------------- pods ----------------
  ctx.handle('k8s:pods', async (serverId: string, ns?: string): Promise<K8sPod[]> => {
    const items = await kxItems(ctx, serverId, `get pods ${nsArg(ns)}`)
    return items.map(podRow)
  })

  ctx.handle('k8s:podLogs', async (serverId: string, ns: string, pod: string, opts: K8sLogsOpts): Promise<string> => {
    assertK8sName(pod, 'pod name')
    const tail = Math.max(1, Math.min(20000, Math.floor(Number(opts?.tail) || 200)))
    const args = [`logs ${shq(pod)} ${nsRequired(ns)} --tail=${tail}`]
    if (opts?.container) args.push(`-c ${shq(assertK8sName(opts.container, 'container name'))}`)
    if (opts?.previous) args.push('-p')
    if (opts?.timestamps) args.push('--timestamps')
    const r = await kx(ctx, serverId, `${args.join(' ')} 2>&1`, { timeoutMs: 60000, maxBuffer: 16 * 1024 * 1024 })
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(failMsg(r, 'kubectl logs failed'))
    return r.stdout
  })

  // ---------------- services / ingress ----------------
  ctx.handle('k8s:services', async (serverId: string, ns?: string): Promise<K8sService[]> => (await kxItems(ctx, serverId, `get services ${nsArg(ns)}`)).map(serviceRow))

  ctx.handle('k8s:ingresses', async (serverId: string, ns?: string): Promise<K8sIngress[]> => {
    const r = await kx(ctx, serverId, `get ingresses ${nsArg(ns)} -o json`, { maxBuffer: 64 * 1024 * 1024 })
    if (r.code !== 0) {
      if (/doesn't have a resource type|the server could not find the requested resource/i.test(r.stderr)) return []
      throw new Error(failMsg(r, 'kubectl get ingresses failed'))
    }
    return arr(parseJson<Obj>(r.stdout).items).map(ingressRow)
  })

  // ---------------- config & storage ----------------
  ctx.handle('k8s:configmaps', async (serverId: string, ns?: string): Promise<K8sConfigMap[]> =>
    (await kxItems(ctx, serverId, `get configmaps ${nsArg(ns)}`)).map((o) => {
      const m = meta(o)
      return { name: m.name, namespace: m.namespace, keys: Object.keys(obj(o.data)).sort(), binaryKeys: Object.keys(obj(o.binaryData)).sort(), created: m.created }
    })
  )

  ctx.handle('k8s:configmapData', async (serverId: string, ns: string, name: string): Promise<Record<string, string>> => {
    assertK8sName(name, 'name')
    const o = await kxJson<Obj>(ctx, serverId, `get configmap ${shq(name)} ${nsRequired(ns)}`)
    const data: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj(o.data))) data[k] = str(v)
    for (const k of Object.keys(obj(o.binaryData))) data[k] = '<binary data>'
    return data
  })

  ctx.handle('k8s:secrets', async (serverId: string, ns?: string): Promise<K8sSecret[]> =>
    (await kxItems(ctx, serverId, `get secrets ${nsArg(ns)}`)).map((o) => {
      const m = meta(o)
      return { name: m.name, namespace: m.namespace, type: str(o.type), keys: Object.keys(obj(o.data)).sort(), created: m.created }
    })
  )

  ctx.handle('k8s:secretReveal', async (serverId: string, ns: string, name: string): Promise<Record<string, string>> => {
    assertK8sName(name, 'name')
    const o = await kxJson<Obj>(ctx, serverId, `get secret ${shq(name)} ${nsRequired(ns)}`)
    const data: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj(o.data))) {
      const buf = Buffer.from(str(v), 'base64')
      const text = buf.toString('utf8')
      data[k] = /[\u0000-\u0008\u000e-\u001f]/.test(text) ? `<binary, ${buf.length} bytes>` : text
    }
    ctx.audit(serverId, 'k8s.secret.reveal', `${ns}/${name}`)
    return data
  })

  ctx.handle('k8s:pvcs', async (serverId: string, ns?: string): Promise<K8sPvc[]> =>
    (await kxItems(ctx, serverId, `get persistentvolumeclaims ${nsArg(ns)}`)).map((o) => {
      const m = meta(o)
      const spec = obj(o.spec)
      const status = obj(o.status)
      return {
        name: m.name,
        namespace: m.namespace,
        status: str(status.phase),
        volume: str(spec.volumeName),
        capacity: str(obj(status.capacity).storage) || str(obj(obj(spec.resources).requests).storage),
        accessModes: Array.isArray(spec.accessModes) ? (spec.accessModes as unknown[]).map(str) : [],
        storageClass: str(spec.storageClassName),
        created: m.created
      }
    })
  )

  ctx.handle('k8s:pvs', async (serverId: string): Promise<K8sPv[]> =>
    (await kxItems(ctx, serverId, 'get persistentvolumes')).map((o) => {
      const m = meta(o)
      const spec = obj(o.spec)
      const claim = obj(spec.claimRef)
      return {
        name: m.name,
        capacity: str(obj(spec.capacity).storage),
        status: str(obj(o.status).phase),
        claim: claim.name ? `${str(claim.namespace)}/${str(claim.name)}` : '',
        reclaimPolicy: str(spec.persistentVolumeReclaimPolicy),
        storageClass: str(spec.storageClassName),
        accessModes: Array.isArray(spec.accessModes) ? (spec.accessModes as unknown[]).map(str) : [],
        created: m.created
      }
    })
  )

  ctx.handle('k8s:storageclasses', async (serverId: string): Promise<K8sStorageClass[]> =>
    (await kxItems(ctx, serverId, 'get storageclasses')).map((o) => {
      const m = meta(o)
      return {
        name: m.name,
        provisioner: str(o.provisioner),
        reclaimPolicy: str(o.reclaimPolicy),
        bindingMode: str(o.volumeBindingMode),
        isDefault: m.annotations['storageclass.kubernetes.io/is-default-class'] === 'true' || m.annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true',
        created: m.created
      }
    })
  )

  // ---------------- namespaces ----------------
  ctx.handle('k8s:namespaces', async (serverId: string): Promise<K8sNamespace[]> => {
    const m = await mode(ctx, serverId)
    const ssh = ctx.ssh(serverId)
    const r = await ssh.exec(`echo __NS; ${m.cmd} ${REQ_TIMEOUT} get namespaces -o json; echo "__RC=$?"; echo __PODS; ${m.cmd} ${REQ_TIMEOUT} get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\\n"}{end}' 2>/dev/null; echo __END`, {
      timeoutMs: 60000,
      sudo: m.sudo,
      env: m.env,
      maxBuffer: 32 * 1024 * 1024
    })
    const s = sections(r.stdout)
    const rc = Number(r.stdout.match(/__RC=(\d+)/)?.[1] ?? '1')
    const nsRaw = (s.NS ?? '').replace(/__RC=\d+\s*$/, '')
    if (rc !== 0) throw new Error(failMsg({ code: rc, stdout: nsRaw, stderr: r.stderr }, 'kubectl get namespaces failed'))
    const counts = new Map<string, number>()
    for (const line of (s.PODS ?? '').split('\n')) {
      const n = line.trim()
      if (n) counts.set(n, (counts.get(n) ?? 0) + 1)
    }
    return arr(parseJson<Obj>(nsRaw).items).map((o) => {
      const m2 = meta(o)
      return { name: m2.name, status: str(obj(o.status).phase), pods: counts.get(m2.name) ?? 0, created: m2.created }
    })
  })

  ctx.handle('k8s:createNamespace', async (serverId: string, name: string) => {
    assertK8sName(name, 'namespace')
    if (name.length > 63) throw new Error('Namespace names are limited to 63 characters')
    await kxRun(ctx, serverId, `create namespace ${shq(name)}`)
    ctx.audit(serverId, 'k8s.namespace.create', name)
  })

  // ---------------- events ----------------
  ctx.handle('k8s:events', async (serverId: string, ns?: string, objectKind?: string, objectName?: string): Promise<K8sEvent[]> => {
    const sel: string[] = []
    if (objectName) {
      sel.push(`involvedObject.name=${assertK8sName(objectName, 'object name')}`)
      if (objectKind) {
        if (!/^[A-Za-z]{1,40}$/.test(objectKind)) throw new Error('Invalid object kind')
        sel.push(`involvedObject.kind=${objectKind}`)
      }
    }
    const items = await kxItems(ctx, serverId, `get events ${nsArg(ns)} ${sel.length ? `--field-selector ${shq(sel.join(','))}` : ''}`)
    const rows: K8sEvent[] = items.map((e) => {
      const m = meta(e)
      const io = obj(e.involvedObject)
      const series = obj(e.series)
      return {
        type: str(e.type),
        reason: str(e.reason),
        object: `${str(io.kind)}/${str(io.name)}`,
        message: str(e.message).trim(),
        count: num(e.count) || num(series.count) || 1,
        last: str(e.lastTimestamp) || str(series.lastObservedTime) || str(e.eventTime) || m.created,
        namespace: m.namespace
      }
    })
    rows.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    return rows.slice(0, 500)
  })

  // ---------------- apply ----------------
  ctx.handle('k8s:apply', async (serverId: string, manifest: string, applyMode: K8sApplyMode): Promise<string> => {
    if (typeof manifest !== 'string' || !manifest.trim()) throw new Error('Manifest is empty')
    if (manifest.length > 4 * 1024 * 1024) throw new Error('Manifest is too large (4 MB limit)')
    const sub = applyMode === 'dry-run' ? 'apply --dry-run=server -f -' : applyMode === 'apply' ? 'apply -f -' : applyMode === 'delete' ? 'delete -f - --wait=false' : null
    if (!sub) throw new Error('Invalid apply mode')
    const r = await kx(ctx, serverId, `${sub} 2>&1`, { stdin: manifest.endsWith('\n') ? manifest : manifest + '\n', timeoutMs: 120000 })
    if (applyMode !== 'dry-run') ctx.audit(serverId, applyMode === 'apply' ? 'k8s.apply' : 'k8s.deleteManifest', r.stdout.trim().split('\n').slice(0, 5).join('; ').slice(0, 300), r.code === 0)
    if (r.code !== 0) throw new Error(failMsg(r, `kubectl ${applyMode} failed`))
    return r.stdout.trim() || '(no output)'
  })

  // ---------------- helm ----------------
  ctx.handle('k8s:helmReleases', async (serverId: string, ns?: string): Promise<K8sHelmRelease[]> => {
    const out = await helmRun(ctx, serverId, `list ${nsArg(ns)} -o json`)
    const t = out.trim()
    const start = t.indexOf('[')
    const list = start >= 0 ? (JSON.parse(t.slice(start)) as unknown) : []
    return (Array.isArray(list) ? (list as Obj[]) : []).map((r) => ({
      name: str(r.name),
      namespace: str(r.namespace),
      revision: str(r.revision),
      updated: str(r.updated),
      status: str(r.status),
      chart: str(r.chart),
      appVersion: str(r.app_version)
    }))
  })

  ctx.handle('k8s:helmHistory', async (serverId: string, name: string, ns: string): Promise<string> => {
    assertK8sName(name, 'release name')
    const out = await helmRun(ctx, serverId, `history ${shq(name)} ${nsRequired(ns)} -o json`)
    const t = out.trim()
    const start = t.indexOf('[')
    const list = start >= 0 ? (JSON.parse(t.slice(start)) as Obj[]) : []
    const lines = ['REVISION  UPDATED                         STATUS        CHART                    APP VERSION   DESCRIPTION']
    for (const h of list) lines.push(`${str(h.revision).padEnd(9)} ${str(h.updated).slice(0, 30).padEnd(31)} ${str(h.status).padEnd(13)} ${str(h.chart).padEnd(24)} ${str(h.app_version).padEnd(13)} ${str(h.description)}`)
    return lines.join('\n')
  })

  ctx.handle('k8s:helmUninstall', async (serverId: string, name: string, ns: string) => {
    assertK8sName(name, 'release name')
    await helmRun(ctx, serverId, `uninstall ${shq(name)} ${nsRequired(ns)}`, { timeoutMs: 300000 })
    ctx.audit(serverId, 'k8s.helm.uninstall', `${ns}/${name}`)
  })

  ctx.handle('k8s:helmInstall', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Install Helm', serverId, async (h) => {
      const stream: ExecOptions = { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) }
      h.log('Downloading the official get-helm-3 script…')
      await ssh.sudoRun('curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 -o /tmp/get_helm.sh && bash /tmp/get_helm.sh; rc=$?; rm -f /tmp/get_helm.sh; exit $rc', stream)
      const m = modes.get(serverId)
      if (m) m.helm = 'helm'
      h.log('Helm installed.')
      ctx.audit(serverId, 'k8s.helm.install')
    })
    return id
  })

  // ---------------- install / uninstall ----------------
  ctx.handle('k8s:install', async (serverId: string, flavour: K8sInstallFlavour) => {
    const ssh = ctx.ssh(serverId)
    if (!['k3s', 'microk8s', 'kubectl'].includes(flavour)) throw new Error('Invalid install flavour')
    if (!canSudo(ssh)) throw new Error('Installing Kubernetes requires root (sudo) on the server')
    const user = ssh.os?.user ?? ''
    const home = ssh.os?.homeDir ?? ''
    const isRoot = Boolean(ssh.os?.isRoot)
    const titles: Record<K8sInstallFlavour, string> = { k3s: 'Install k3s', microk8s: 'Install MicroK8s', kubectl: 'Install kubectl' }
    const { id } = ctx.tasks.start(titles[flavour], serverId, async (h) => {
      const stream: ExecOptions = { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) }
      const kubeDir = home ? `${home}/.kube` : ''
      if (flavour === 'k3s') {
        h.log('Installing prerequisites (curl)…')
        await runPkg(ssh, installCmd(ssh, ['curl']), stream).catch((e) => h.log(`(prerequisites: ${String(e)})`))
        h.log('Running the official k3s installer (https://get.k3s.io)…')
        await ssh.sudoRun('curl -sfL https://get.k3s.io -o /tmp/get-k3s.sh && sh /tmp/get-k3s.sh; rc=$?; rm -f /tmp/get-k3s.sh; exit $rc', { ...stream, env: { INSTALL_K3S_EXEC: 'server --write-kubeconfig-mode 600' } })
        h.log('Waiting for the node to become Ready…')
        await ssh.sudoRun('for i in $(seq 1 60); do k3s kubectl get nodes 2>/dev/null | grep -q " Ready" && exit 0; sleep 2; done; echo "node not Ready yet (continuing)"', stream)
        if (kubeDir && user && !isRoot) {
          h.log(`Copying ${K3S_CONFIG} to ${kubeDir}/config for ${user} so plain kubectl works…`)
          await ssh.sudoRun(`mkdir -p ${shq(kubeDir)} && cp ${K3S_CONFIG} ${shq(kubeDir + '/config')} && chown -R ${shq(user)}: ${shq(kubeDir)} && chmod 700 ${shq(kubeDir)} && chmod 600 ${shq(kubeDir + '/config')}`, stream)
        } else if (kubeDir) {
          await ssh.sudoRun(`mkdir -p ${shq(kubeDir)} && cp ${K3S_CONFIG} ${shq(kubeDir + '/config')} && chmod 600 ${shq(kubeDir + '/config')}`, stream)
        }
        h.log('k3s installed. kubectl is provided by k3s (/usr/local/bin/kubectl).')
      } else if (flavour === 'microk8s') {
        const snap = await ssh.exec('command -v snap >/dev/null 2>&1 && echo yes')
        if (!snap.stdout.includes('yes')) {
          if (ssh.os?.pkgManager === 'apt') {
            h.log('Installing snapd…')
            await runPkg(ssh, installCmd(ssh, ['snapd']), stream)
          } else throw new Error('MicroK8s needs snapd, which is not available on this distribution. Install k3s instead.')
        }
        h.log('Installing MicroK8s (snap install microk8s --classic)…')
        await ssh.sudoRun('snap install microk8s --classic', stream)
        if (user && !isRoot) {
          h.log(`Adding ${user} to the microk8s group…`)
          await ssh.sudoRun(`usermod -aG microk8s ${shq(user)}`, stream).catch((e) => h.log(String(e)))
        }
        h.log('Waiting for MicroK8s to be ready…')
        await ssh.sudoRun('microk8s status --wait-ready', { ...stream, timeoutMs: 600000 })
        h.log('Enabling dns and storage add-ons…')
        await ssh.sudoRun('microk8s enable dns && (microk8s enable hostpath-storage || microk8s enable storage)', stream)
        if (kubeDir && user) {
          h.log(`Writing ${kubeDir}/config from "microk8s config" so plain kubectl works too…`)
          await ssh
            .sudoRun(`mkdir -p ${shq(kubeDir)} && microk8s config > ${shq(kubeDir + '/config')} && chown -R ${shq(user)}: ${shq(kubeDir)} && chmod 700 ${shq(kubeDir)} && chmod 600 ${shq(kubeDir + '/config')}`, stream)
            .catch((e) => h.log(String(e)))
        }
        h.log('MicroK8s installed. Group membership takes effect after you reconnect; until then commands run through sudo.')
      } else {
        const pm = ssh.os?.pkgManager ?? 'unknown'
        const arch = ssh.os?.arch === 'aarch64' || ssh.os?.arch === 'arm64' ? 'arm64' : ssh.os?.arch === 'armv7l' ? 'arm' : 'amd64'
        h.log('Installing prerequisites…')
        if (pm === 'apt') {
          await runPkg(ssh, installCmd(ssh, ['apt-transport-https', 'ca-certificates', 'curl', 'gnupg']), stream)
          h.log('Adding the official pkgs.k8s.io apt repository…')
          await ssh.sudoRun(
            [
              'set -e',
              'V=$(curl -Ls https://dl.k8s.io/release/stable.txt | sed -E "s/^(v[0-9]+\\.[0-9]+).*/\\1/")',
              '[ -n "$V" ] || V=v1.31',
              'mkdir -p -m 755 /etc/apt/keyrings',
              'curl -fsSL "https://pkgs.k8s.io/core:/stable:/$V/deb/Release.key" | gpg --dearmor --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg',
              'chmod 644 /etc/apt/keyrings/kubernetes-apt-keyring.gpg',
              'echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/$V/deb/ /" > /etc/apt/sources.list.d/kubernetes.list',
              'chmod 644 /etc/apt/sources.list.d/kubernetes.list',
              'echo "Repository: pkgs.k8s.io $V"'
            ].join('\n'),
            stream
          )
          await runPkg(ssh, installCmd(ssh, ['kubectl']), stream)
        } else if (pm === 'dnf' || pm === 'yum') {
          await runPkg(ssh, installCmd(ssh, ['curl']), stream).catch(() => undefined)
          h.log('Adding the official pkgs.k8s.io yum repository…')
          const v = (await ssh.exec('curl -Ls https://dl.k8s.io/release/stable.txt 2>/dev/null', { timeoutMs: 30000 })).stdout.trim().match(/^v\d+\.\d+/)?.[0] ?? 'v1.31'
          const repo = `[kubernetes]\nname=Kubernetes\nbaseurl=https://pkgs.k8s.io/core:/stable:/${v}/rpm/\nenabled=1\ngpgcheck=1\ngpgkey=https://pkgs.k8s.io/core:/stable:/${v}/rpm/repodata/repomd.xml.key\n`
          await ssh.sudoRun(`${b64Echo(repo)} > /etc/yum.repos.d/kubernetes.repo`, stream)
          await runPkg(ssh, installCmd(ssh, ['kubectl']), stream)
        } else {
          h.log(`Downloading the latest stable kubectl binary for linux/${arch} from dl.k8s.io…`)
          await ssh.sudoRun(
            [
              'set -e',
              'V=$(curl -Ls https://dl.k8s.io/release/stable.txt)',
              `curl -fsSL "https://dl.k8s.io/release/$V/bin/linux/${arch}/kubectl" -o /tmp/kubectl`,
              `curl -fsSL "https://dl.k8s.io/release/$V/bin/linux/${arch}/kubectl.sha256" -o /tmp/kubectl.sha256`,
              'echo "$(cat /tmp/kubectl.sha256)  /tmp/kubectl" | sha256sum -c -',
              'install -o root -g root -m 0755 /tmp/kubectl /usr/local/bin/kubectl',
              'rm -f /tmp/kubectl /tmp/kubectl.sha256',
              'echo "Installed kubectl $V"'
            ].join('\n'),
            stream
          )
        }
        h.log('kubectl installed. Point it at a cluster with ~/.kube/config or KUBECONFIG.')
      }
      modes.delete(serverId)
      const v = await ssh.exec('kubectl version --client -o json 2>/dev/null || sudo -n kubectl version --client -o json 2>/dev/null || true', { timeoutMs: 30000 })
      const gv = v.stdout.match(/"gitVersion":\s*"([^"]+)"/)?.[1]
      h.log(`Done.${gv ? ` kubectl ${gv}` : ''}`)
      ctx.audit(serverId, `k8s.install.${flavour}`)
    })
    return id
  })

  ctx.handle('k8s:uninstallK3s', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    if (!canSudo(ssh)) throw new Error('Uninstalling k3s requires root (sudo) on the server')
    const { id } = ctx.tasks.start('Uninstall k3s', serverId, async (h) => {
      const stream: ExecOptions = { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) }
      h.log('Running k3s-uninstall.sh (removes the cluster, all workloads and local data)…')
      await ssh.sudoRun('if [ -x /usr/local/bin/k3s-uninstall.sh ]; then /usr/local/bin/k3s-uninstall.sh; elif [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then /usr/local/bin/k3s-agent-uninstall.sh; else echo "k3s-uninstall.sh not found" >&2; exit 1; fi', stream)
      modes.delete(serverId)
      h.log('k3s removed.')
      ctx.audit(serverId, 'k8s.uninstall.k3s')
    })
    return id
  })
}
