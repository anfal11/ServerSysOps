// Kubernetes module types. Everything is produced by `kubectl … -o json` on the connected server and
// reduced to flat rows in the main process; the renderer never sees raw manifests except in "Get YAML".

/** Which kubectl invocation works on this server. */
export type K8sCommandKind = 'kubectl' | 'kubectl-k3s-config' | 'microk8s' | 'k3s'

export type K8sDistribution = 'k3s' | 'microk8s' | 'kubeadm' | 'other'

export type K8sState =
  /** Neither kubectl nor k3s/microk8s binaries were found. */
  | 'missing'
  /** A kubectl binary exists but no cluster could be reached with any known kubeconfig. */
  | 'no-cluster'
  | 'ok'

export interface K8sInfo {
  state: K8sState
  /** Human-readable command prefix that works, e.g. `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl`. */
  shellPrefix?: string
  commandKind?: K8sCommandKind
  needsSudo: boolean
  clientVersion?: string
  serverVersion?: string
  distribution?: K8sDistribution
  nodeCount?: number
  helm: boolean
  helmPrefix?: string
  metrics: boolean
  namespaces: string[]
  /** Last error from the probe when state !== 'ok' (e.g. "connection refused"). */
  error?: string
  /** Binaries found on PATH (for the install / hint panels). */
  found: { kubectl: boolean; k3s: boolean; microk8s: boolean; snap: boolean }
  pkgManager: string
}

export interface K8sNode {
  name: string
  ready: boolean
  /** Raw Ready condition reason/message when not ready. */
  readyMessage?: string
  unschedulable: boolean
  roles: string[]
  version: string
  internalIP: string
  os: string
  kernel: string
  containerRuntime: string
  /** Capacity in millicores / bytes. */
  cpuCapacity: number
  memCapacity: number
  /** Usage from metrics.k8s.io, when available (millicores / bytes). */
  cpuUsage?: number
  memUsage?: number
  created: string
  taints: number
}

export interface K8sOverview {
  nodes: K8sNode[]
  nodesReady: number
  pods: { running: number; pending: number; failed: number; succeeded: number; other: number; total: number }
  deployments: { available: number; total: number }
  namespaces: number
  metrics: boolean
}

export type K8sWorkloadKind = 'deployment' | 'statefulset' | 'daemonset' | 'job' | 'cronjob'

export interface K8sWorkload {
  kind: K8sWorkloadKind
  name: string
  namespace: string
  /** Deployments / StatefulSets: readyReplicas; DaemonSets: numberReady; Jobs: succeeded. */
  ready: number
  /** Deployments / StatefulSets: spec.replicas; DaemonSets: desired; Jobs: completions. */
  desired: number
  upToDate?: number
  available?: number
  images: string[]
  containers: string[]
  created: string
  // Jobs
  status?: string
  active?: number
  // CronJobs
  schedule?: string
  suspend?: boolean
  lastSchedule?: string
}

export interface K8sPod {
  name: string
  namespace: string
  readyCount: number
  containerCount: number
  /** Printer-style status: Running, Pending, ContainerCreating, CrashLoopBackOff, Completed, Terminating… */
  status: string
  phase: string
  restarts: number
  node: string
  ip: string
  created: string
  containers: string[]
  initContainers: string[]
  /** Owner kind/name (e.g. ReplicaSet/web-abc) for display. */
  owner?: string
}

export interface K8sLogsOpts {
  container?: string
  tail: number
  previous?: boolean
  timestamps?: boolean
}

export interface K8sService {
  name: string
  namespace: string
  type: string
  clusterIP: string
  externalIPs: string[]
  /** "80:8080/TCP" or "80:8080/TCP (nodePort 30080)". */
  ports: string[]
  selector: Record<string, string>
  created: string
}

export interface K8sIngressRule {
  host: string
  path: string
  pathType: string
  backend: string
}

export interface K8sIngress {
  name: string
  namespace: string
  className: string
  hosts: string[]
  rules: K8sIngressRule[]
  tls: boolean
  addresses: string[]
  created: string
}

export interface K8sConfigMap {
  name: string
  namespace: string
  keys: string[]
  binaryKeys: string[]
  created: string
}

export interface K8sSecret {
  name: string
  namespace: string
  type: string
  keys: string[]
  created: string
}

export interface K8sPvc {
  name: string
  namespace: string
  status: string
  volume: string
  capacity: string
  accessModes: string[]
  storageClass: string
  created: string
}

export interface K8sPv {
  name: string
  capacity: string
  status: string
  claim: string
  reclaimPolicy: string
  storageClass: string
  accessModes: string[]
  created: string
}

export interface K8sStorageClass {
  name: string
  provisioner: string
  reclaimPolicy: string
  bindingMode: string
  isDefault: boolean
  created: string
}

export interface K8sNamespace {
  name: string
  status: string
  pods: number
  created: string
}

export interface K8sEvent {
  type: string
  reason: string
  object: string
  message: string
  count: number
  /** Last seen (ISO) — lastTimestamp, eventTime or creationTimestamp. */
  last: string
  namespace: string
}

export interface K8sHelmRelease {
  name: string
  namespace: string
  revision: string
  updated: string
  status: string
  chart: string
  appVersion: string
}

export type K8sApplyMode = 'dry-run' | 'apply' | 'delete'

/** Resource kinds that the generic handlers (get YAML / describe / delete) accept. */
export type K8sKind =
  | 'node'
  | 'namespace'
  | 'pod'
  | 'deployment'
  | 'statefulset'
  | 'daemonset'
  | 'job'
  | 'cronjob'
  | 'service'
  | 'ingress'
  | 'configmap'
  | 'secret'
  | 'persistentvolumeclaim'
  | 'persistentvolume'
  | 'storageclass'

export type K8sInstallFlavour = 'k3s' | 'microk8s' | 'kubectl'
