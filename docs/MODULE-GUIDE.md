# ServerSysOps module guide (for contributors and code generators)

ServerSysOps is an Electron + React + TypeScript desktop app that manages Linux servers over SSH only (no agent on the server).
Every feature is a **module** made of two files:

| Part | Path | Runs in |
|---|---|---|
| Service (SSH commands, parsing, tasks) | `src/main/services/<module>.ts` | Electron main process (Node) |
| Page (UI) | `src/renderer/src/pages/<Module>.tsx` | Renderer (React 19, Tailwind v4) |

Shared types live in `src/shared/types.ts` (import as `@shared/types`). Add new types there when a module needs them.

## Service contract (main process)

```ts
import type { Ctx } from '../core'
import { shq, assertSafeName, assertPort, assertAbsPath, b64Echo } from '../ssh/shell'

export function register(ctx: Ctx): void {
  // channel names are namespaced "<module>:<action>"; the FIRST argument is always the server id.
  ctx.handle('docker:containers', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)                       // throws if not connected
    const r = await ssh.exec('docker ps -a --format "{{json .}}"')   // never throws on non-zero exit; check r.code
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'docker ps failed')
    return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  })

  // Root commands: use sudo. The wrapper handles the password automatically.
  ctx.handle('docker:restart', async (serverId: string, name: string) => {
    assertSafeName(name)                                // ALWAYS validate / quote user input (shq)
    const ssh = ctx.ssh(serverId)
    await ssh.sudoRun(`docker restart ${shq(name)}`)    // sudoRun / run throw on non-zero exit with stderr
    ctx.audit(serverId, 'docker.restart', name)        // record in the local activity log
  })

  // Long operations => background task with live log (shows in the Tasks drawer). Return the task id.
  ctx.handle('docker:install', async (serverId: string) => {
    const ssh = ctx.ssh(serverId)
    const { id } = ctx.tasks.start('Install Docker', serverId, async (h) => {
      h.log('Downloading…')
      await ssh.sudoRun('curl -fsSL https://get.docker.com | sh', { timeoutMs: 0, signal: h.signal, onStdout: (c) => h.append(c), onStderr: (c) => h.append(c) })
      h.log('Done')
    })
    return id
  })
}
```

Key APIs on `SshClient` (`src/main/ssh/SshClient.ts`):

- `exec(cmd, opts)` → `{code, stdout, stderr}`; opts: `sudo`, `stdin`, `timeoutMs` (default 120 s, `0` = none), `onStdout/onStderr` streaming, `env`, `cwd`, `signal`.
- `run(cmd, opts)` → stdout string, throws on non-zero exit. `sudo(cmd)` / `sudoRun(cmd)` are the root variants. With `sudo` the whole command is wrapped as `sudo … sh -c '<cmd>'`, so multi-statement scripts, pipes and redirections are all elevated.
- `sftp()` → ssh2 `SFTPWrapper` (cached). Use for file transfers; for root-owned files write to a temp path then `sudo install`/`mv`.
- `ssh.os` → `{ id, idLike, prettyName, pkgManager: 'apt'|'dnf'|'yum'|'zypper'|'apk'|'pacman'|'unknown', hasSystemd, isRoot, ... }`.
- Package helpers in `src/main/services/pkg.ts`: `installCmd(ssh, pkgs)`, `removeCmd`, `isInstalled`, `runPkg(ssh, cmd, opts)` (streams, non-interactive env).
- Write root files: `` await ssh.sudoRun(`${b64Echo(content)} > ${shq(path)}`) `` (content is base64-embedded, no quoting issues).
- Services are registered in `src/main/index.ts` (already wired; keep `export function register(ctx)`).

Rules:
1. **Never interpolate raw user input into a shell string.** Use `shq()` or validate with `assertSafeName/assertPort/assertAbsPath`.
2. Commands must be non-interactive (`-y`, `DEBIAN_FRONTEND=noninteractive`, `--noconfirm`).
3. Work on all distros where feasible: branch on `ssh.os.pkgManager` / `ssh.os.hasSystemd`. Fail with a clear message otherwise.
4. Prefer machine-readable output (`--format json`, `ss -H`, `systemctl --output=json`, `getent`), fall back to parsing.
5. Operations that may lock you out or destroy data must be confirmed in the UI (`confirm()`), and where possible staged/verified before committing (see `quickactions.ts` SSH port change).
6. Read-only calls should be cheap: one combined shell script per refresh where possible (see `overview.ts`).

## Page contract (renderer)

```tsx
import React, { useState } from 'react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Page, PageHeader, Card, Table, Button, Badge, Tabs, Modal, Field, Input, Select, Checkbox, Toggle, SearchInput,
         EmptyState, ErrorBox, Loading, Callout, Pre, KV, Row, Stat, ContextMenu, MenuButton, confirm, useAsync, useAction } from '@/components/ui'
import { useApp } from '@/store/app'
import { fmtBytes, fmtDate, cls } from '@/lib/format'

export default function Docker({ serverId }: PageProps): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.call<DockerContainer[]>('docker:containers', serverId), [serverId], { intervalMs: 5000 })
  const { run, busy } = useAction()   // run(() => api.call(...), { success: 'Restarted' }) shows toasts on error
  ...
  return (
    <>
      <PageHeader title="Docker" subtitle="v29.1" actions={<Button variant="primary">Run container</Button>} />
      <Page>
        {error ? <ErrorBox error={error} onRetry={reload} /> : loading ? <Loading /> : <Card flush><Table .../></Card>}
      </Page>
    </>
  )
}
```

- Pages receive `serverId`; the server is guaranteed to be connected while the page is mounted.
- Design: dark theme, dense, calm. Use the UI kit in `src/renderer/src/components/ui/index.tsx` and Tailwind tokens: `bg-bg`, `bg-bg-2`, `bg-panel`, `bg-panel-2`, `border-border`, `text-text`, `text-muted`, `text-dim`, `text-accent`, `bg-ok`/`bg-warn`/`bg-danger`. Icons: `lucide-react`.
- Layout skeleton: `<PageHeader/>` (56px) + `<Page>` (scrolling body). Tables go inside `<Card flush>`.
- Long operations: call the service, get a task id back, and tell the user with `useApp.getState().toast({kind:'info', title:'…'})`; the Tasks drawer opens automatically.
- Confirm destructive actions with `await confirm({ title, message, danger: true, confirmLabel })` (supports `typeToConfirm`).
- Keep each page self-contained in one file (sub-components inside). Export default component.
- TypeScript strict; no `any` unless unavoidable. Use `React.JSX.Element` return types.

## Checklist before finishing a module
- `npm run typecheck` passes.
- Every service handler validates input and handles "tool not installed" gracefully (offer an install button in the UI).
- Reads refresh on an interval or with a Refresh button; writes `reload()` afterwards.
