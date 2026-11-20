import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as QRCode from 'qrcode'
import { AlertTriangle, Check, CheckCircle2, Copy, Download, KeyRound, Lock, Package, QrCode, RefreshCw, ShieldCheck, ShieldOff, Smartphone, Trash2, XCircle } from 'lucide-react'
import type { PageProps } from '@/pages'
import { api } from '@/lib/api'
import { Badge, Button, Callout, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, Page, PageHeader, Select, Table, confirm, useAction, useAsync } from '@/components/ui'
import { useApp } from '@/store/app'
import { cls } from '@/lib/format'
import { TFA_MODE_LABEL, type TfaEnforceMode, type TfaEnrollOptions, type TfaEnrollResult, type TfaStatus, type TfaUser } from '@shared/modules/twofactor'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function copyText(s: string): void {
  void navigator.clipboard?.writeText(s).then(
    () => useApp.getState().toast({ kind: 'success', title: 'Copied to clipboard' }),
    () => useApp.getState().toast({ kind: 'error', title: 'Could not copy' })
  )
}

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const MODE_INFO: Record<TfaEnforceMode, { title: string; description: string; strength: 'ok' | 'warn' | 'info' }> = {
  'password+code': {
    title: 'Password + code',
    description: 'Users type their password, then the 6-digit code from the authenticator app. SSH keys alone no longer log in.',
    strength: 'info'
  },
  'key+code': {
    title: 'Key + code',
    description: 'An SSH key AND the code are both required. Passwords are no longer accepted at all. Strongest option.',
    strength: 'ok'
  },
  'key-or-code': {
    title: 'Key or code',
    description: 'An SSH key alone is enough; without a key the user types only the code (no password). Convenient for people without keys.',
    strength: 'warn'
  }
}

function StepTitle({ n, children, done }: { n: number; children: React.ReactNode; done?: boolean }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span className={cls('inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold', done ? 'bg-ok/20 text-ok-fg' : 'bg-panel-2 text-muted border border-border-2')}>{done ? <Check size={12} strokeWidth={3} /> : n}</span>
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function TwoFactor({ serverId }: PageProps): React.JSX.Element {
  const status = useAsync(() => api.call<TfaStatus>('tfa:status', serverId), [serverId])
  const { run, busy } = useAction()
  const toast = useApp((s) => s.toast)
  const [enroll, setEnroll] = useState<{ user: TfaUser; force: boolean } | null>(null)
  const [mode, setMode] = useState<TfaEnforceMode>('key+code')
  const [nullok, setNullok] = useState(true)
  const [testCode, setTestCode] = useState('')
  const [testResult, setTestResult] = useState<boolean | null>(null)

  // Reload when a task for this server finishes (install / enable / disable run as tasks).
  const finished = useApp((s) => s.tasks.filter((t) => t.serverId === serverId && t.status !== 'running' && t.status !== 'queued').length)
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    void status.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished])

  const st = status.data
  const me = useMemo(() => st?.users.find((u) => u.name === st.loginUser), [st])

  // Sensible default mode for the way this profile logs in (only before the user picks one).
  const pickedRef = useRef(false)
  useEffect(() => {
    if (!st || pickedRef.current) return
    if (st.mode !== 'off') {
      setMode(st.mode)
      setNullok(st.nullok)
    } else setMode(st.profileAuth === 'password' ? 'password+code' : 'key+code')
  }, [st])

  const act = async (fn: () => Promise<unknown>, success?: string): Promise<void> => {
    await run(fn, { success })
    await status.reload()
  }

  const install = async (): Promise<void> => {
    const id = await run(() => api.call<string>('tfa:install', serverId))
    if (id) toast({ kind: 'info', title: 'Installing the PAM module…', detail: 'Progress is shown in the Tasks drawer.' })
  }

  const remove = async (u: TfaUser): Promise<void> => {
    const ok = await confirm({
      title: `Remove enrollment of ${u.name}`,
      message: (
        <div className="space-y-2">
          <p>
            Delete <code>~{u.name}/.google_authenticator</code>. The authenticator app entry stops working.
          </p>
          {u.self && <Callout kind="warn">This is the account ServerMate uses. The secret is also removed from the server profile. While 2FA is enforced without nullok this is refused to avoid a lock-out.</Callout>}
          {st?.mode !== 'off' && !st?.nullok && !u.self && <Callout kind="danger">2FA is enforced without nullok: {u.name} will not be able to log in until enrolled again.</Callout>}
        </div>
      ),
      danger: true,
      confirmLabel: 'Remove'
    })
    if (!ok) return
    await act(() => api.call('tfa:unenroll', serverId, u.name), `${u.name} unenrolled`)
  }

  const startEnroll = async (u: TfaUser): Promise<void> => {
    if (u.enrolled) {
      const ok = await confirm({
        title: `Re-enroll ${u.name}`,
        message: (
          <div className="space-y-2">
            <p>
              A new secret replaces the current one. <b>The existing entry in the authenticator app stops working</b> and the old emergency codes become invalid.
            </p>
            {u.self && <p>The new secret is saved in this server profile so ServerMate keeps logging in automatically.</p>}
          </div>
        ),
        danger: true,
        confirmLabel: 'Re-enroll'
      })
      if (!ok) return
    }
    setEnroll({ user: u, force: u.enrolled })
  }

  const enableBlockers = (): string[] => {
    if (!st) return ['Loading…']
    const out: string[] = []
    if (!st.pamModuleInstalled) out.push('Install the PAM module first (step 1).')
    if (!me?.enrolled) out.push(`Enroll ${st.loginUser} (you) first (step 2).`)
    else if (!st.profileHasTotp) out.push(`The profile holds no TOTP secret for ${st.loginUser}. Re-enroll it with "Save secret in this app" enabled.`)
    if (mode === 'key+code' && st.profileAuth === 'password') out.push('"Key + code" needs this profile to log in with an SSH key (Edit server → Authentication).')
    if (mode === 'password+code' && st.profileAuth !== 'password' && !st.profileHasPassword) out.push('"Password + code" would make the app\'s key useless and the profile has no stored password.')
    if (mode !== 'key-or-code' && me?.keyOnly) out.push(`${st.loginUser} is key-only in Users, which also disables keyboard-interactive for that account.`)
    if (st.sshdIncludeSupported && st.conflicts.length) out.push(`${st.conflicts[0].file} sets "${st.conflicts[0].line}" before the 2FA drop-in is read.`)
    return out
  }

  const enable = async (): Promise<void> => {
    if (!st) return
    const info = MODE_INFO[mode]
    const ok = await confirm({
      title: st.mode === 'off' ? 'Enforce two-factor authentication' : 'Change two-factor rules',
      message: (
        <div className="space-y-2">
          <p>
            Mode: <b>{info.title}</b> — {info.description}
          </p>
          <ul className="list-disc pl-5 space-y-1 text-muted">
            <li>
              <code>/etc/pam.d/sshd</code> gets <code>auth required pam_google_authenticator.so{nullok ? ' nullok' : ''}</code> (backup in <code>sshd.servermate.bak</code>).
            </li>
            <li>
              <code>{st.sshdIncludeSupported ? '/etc/ssh/sshd_config.d/00-servermate-2fa.conf' : 'a marker block at the top of /etc/ssh/sshd_config'}</code> sets <code>AuthenticationMethods</code>, <code>KbdInteractiveAuthentication yes</code>, <code>UsePAM yes</code>, <code>PasswordAuthentication no</code>.
            </li>
            <li>
              <code>sshd -t</code>, reload, then ServerMate opens a second SSH login with the saved credentials and its stored code.
            </li>
            <li>
              <b>The change is reverted automatically if ServerMate cannot log back in.</b>
            </li>
          </ul>
          {!nullok && <Callout kind="danger">nullok is off: every account without <code>~/.google_authenticator</code> is locked out of SSH immediately.</Callout>}
          <Callout kind="warn">Open terminals stay connected. Keep this window open until the task reports success.</Callout>
        </div>
      ),
      confirmLabel: st.mode === 'off' ? 'Enable 2FA' : 'Apply',
      danger: !nullok
    })
    if (!ok) return
    const id = await run(() => api.call<string>('tfa:enable', serverId, { mode, nullok }))
    if (id) toast({ kind: 'info', title: 'Enabling two-factor authentication…', detail: 'Progress is shown in the Tasks drawer. The configuration is verified before it stays in place.' })
  }

  const disable = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Disable two-factor authentication',
      message: (
        <div className="space-y-2">
          <p>Remove the ServerMate lines from <code>/etc/pam.d/sshd</code> and the sshd drop-in, test, reload and verify the login. Enrollments are kept, so you can re-enable later without new QR codes.</p>
          <p className="text-muted">Password / key logins work as before. Remember to re-check your SSH login rules in Overview.</p>
        </div>
      ),
      confirmLabel: 'Disable 2FA',
      danger: true
    })
    if (!ok) return
    const id = await run(() => api.call<string>('tfa:disable', serverId))
    if (id) toast({ kind: 'info', title: 'Disabling two-factor authentication…', detail: 'Progress is shown in the Tasks drawer.' })
  }

  const test = async (): Promise<void> => {
    const r = await run(() => api.call<boolean>('tfa:testCode', serverId, testCode.trim()))
    if (r === undefined) return
    setTestResult(r)
  }

  const blockers = enableBlockers()
  const enforced = !!st && st.mode !== 'off'
  const changed = !!st && enforced && (st.mode !== mode || st.nullok !== nullok)

  return (
    <>
      <PageHeader
        title="Two-factor auth"
        subtitle={
          st ? (
            <Badge color={enforced ? 'ok' : 'muted'} className="align-middle">
              {TFA_MODE_LABEL[st.mode]}
              {enforced && st.nullok ? ' · nullok' : ''}
            </Badge>
          ) : undefined
        }
        actions={
          <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void status.reload()} loading={status.loading && !!st}>
            Refresh
          </Button>
        }
      />
      <Page>
        {status.error ? (
          <ErrorBox error={status.error} onRetry={status.reload} />
        ) : !st ? (
          <Loading />
        ) : (
          <div className="space-y-4 max-w-5xl">
            <Callout>
              <div className="flex gap-3">
                <ShieldCheck size={16} className="shrink-0 mt-0.5 text-accent" />
                <div className="space-y-1">
                  <p>
                    <b className="text-text">Time-based one-time codes for SSH logins.</b> The Google Authenticator PAM module asks every user for a 6-digit code from their phone in addition to (or instead of) their password or key. Any TOTP app works: Google Authenticator, Authy, Microsoft Authenticator, 1Password, Bitwarden, FreeOTP…
                  </p>
                  <p>
                    ServerMate keeps the secret of its own login account <b className="text-text">{st.loginUser}</b> in this server profile, so it can answer the code prompt itself and keep connecting automatically. Before any rule is enforced, ServerMate verifies its own login and reverts the change if it fails, so you cannot lock yourself out from here.
                  </p>
                </div>
              </div>
            </Callout>

            {/* ---------- Step 1 ---------- */}
            <Card title={<StepTitle n={1} done={st.pamModuleInstalled}>Install PAM module</StepTitle>}>
              <div className="flex items-center gap-4">
                <Package size={18} className="text-muted shrink-0" />
                <div className="flex-1 min-w-0 text-[13px]">
                  {st.pamModuleInstalled ? (
                    <>
                      <div className="flex items-center gap-2">
                        <Badge color="ok">Installed</Badge>
                        <code className="text-xs text-muted truncate">{st.pamModulePath}</code>
                      </div>
                      <div className="text-dim text-[11px] mt-1">
                        {st.pamConfigured ? (
                          <>
                            Referenced in <code>/etc/pam.d/sshd</code>{st.nullok ? ' with nullok' : ' without nullok'}.
                          </>
                        ) : (
                          <>
                            Not yet referenced in <code>/etc/pam.d/sshd</code> (done by step 3).
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <Badge color="warn">Not installed</Badge>
                        <span className="text-muted">
                          Package <code>{st.packageName}</code> via {st.pkgManager}
                          {(st.pkgManager === 'dnf' || st.pkgManager === 'yum') && ' (EPEL repository is enabled automatically on RHEL-family systems)'}
                          {st.pkgManager === 'apk' && ' (also installs openssh-server-pam)'}
                        </span>
                      </div>
                      <div className="text-dim text-[11px] mt-1">Provides <code>pam_google_authenticator.so</code>, the module sshd uses to verify codes.</div>
                    </>
                  )}
                </div>
                {!st.pamModuleInstalled && (
                  <Button variant="primary" icon={<Download size={13} />} onClick={install} loading={busy} disabled={st.pkgManager === 'unknown'}>
                    Install
                  </Button>
                )}
              </div>
            </Card>

            {/* ---------- Step 2 ---------- */}
            <Card
              title={<StepTitle n={2} done={!!me?.enrolled && st.profileHasTotp}>Enroll users</StepTitle>}
              flush
              actions={
                st.profileHasTotp ? (
                  <div className="flex items-center gap-2">
                    <Smartphone size={13} className="text-muted" />
                    <Input
                      value={testCode}
                      onChange={(e) => {
                        setTestCode(e.target.value.replace(/\D/g, '').slice(0, 8))
                        setTestResult(null)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && testCode.length >= 6 && void test()}
                      placeholder="Code from my phone"
                      mono
                      className="w-40 h-7 text-xs"
                      title="Compare a code from your authenticator app with the secret stored in this server profile"
                    />
                    <Button size="xs" onClick={test} disabled={testCode.length < 6} loading={busy}>
                      Test
                    </Button>
                    {testResult === true && <Badge color="ok">matches</Badge>}
                    {testResult === false && <Badge color="danger">no match</Badge>}
                  </div>
                ) : undefined
              }
            >
              <Table<TfaUser>
                rows={st.users}
                rowKey={(u) => u.name}
                empty="No interactive user accounts found"
                columns={[
                  {
                    key: 'name',
                    header: 'User',
                    render: (u) => (
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{u.name}</span>
                        {u.self && <Badge color="accent">you</Badge>}
                        {u.keyOnly && (
                          <span className="cursor-help" title="Password login disabled in Users: the sshd Match block also turns keyboard-interactive off for this account, so codes cannot be asked">
                            <Badge color="info">key-only</Badge>
                          </span>
                        )}
                      </div>
                    )
                  },
                  { key: 'uid', header: 'UID', mono: true, width: '70px', render: (u) => u.uid },
                  {
                    key: 'enrolled',
                    header: 'Enrolled',
                    width: '140px',
                    render: (u) =>
                      u.enrolled ? (
                        <span className="flex items-center gap-1.5">
                          <Badge color="ok">Enrolled</Badge>
                          {u.self &&
                            (st.profileHasTotp ? (
                              <span title="The secret is stored in this server profile">
                                <Badge color="accent">in profile</Badge>
                              </span>
                            ) : (
                              <span title="The profile has no secret: re-enroll with Save secret in this app">
                                <Badge color="warn">no profile secret</Badge>
                              </span>
                            ))}
                        </span>
                      ) : (
                        <Badge>Not enrolled</Badge>
                      )
                  },
                  {
                    key: 'keys',
                    header: 'SSH keys',
                    width: '90px',
                    align: 'center',
                    render: (u) => (
                      <span className={cls('inline-flex items-center gap-1', u.hasKeys ? '' : 'text-dim')}>
                        <KeyRound size={12} /> {u.hasKeys}
                      </span>
                    )
                  },
                  {
                    key: 'act',
                    header: '',
                    align: 'right',
                    render: (u) => (
                      <div className="flex gap-1 justify-end">
                        <Button size="xs" variant={u.enrolled ? 'default' : 'primary'} icon={<QrCode size={11} />} onClick={() => void startEnroll(u)} disabled={!st.pamModuleInstalled && !u.enrolled}>
                          {u.enrolled ? 'Re-enroll' : 'Enroll'}
                        </Button>
                        {u.enrolled && (
                          <Button size="xs" variant="danger" icon={<Trash2 size={11} />} onClick={() => void remove(u)} title="Remove enrollment">
                            Remove
                          </Button>
                        )}
                      </div>
                    )
                  }
                ]}
              />
              <div className="px-4 py-2 text-[11px] text-dim border-t border-border/60">
                Enrolling writes <code>~/.google_authenticator</code> (mode 400) with a fresh secret and 5 emergency codes. Users shown: root and regular accounts (UID ≥ 1000) with a login shell.
                {!st.isRoot && ' Other users’ files are read with sudo.'}
              </div>
            </Card>

            {/* ---------- Step 3 ---------- */}
            <Card title={<StepTitle n={3} done={enforced}>Enforce for SSH</StepTitle>}>
              <div className="space-y-4">
                {enforced && (
                  <div className="flex items-center gap-3 flex-wrap">
                    <Lock size={16} className="text-ok-fg shrink-0" />
                    <div className="flex-1 text-[13px]">
                      <b>{TFA_MODE_LABEL[st.mode]}</b> is active{st.nullok ? ' — users without an enrollment may still log in (nullok)' : ' — every account must be enrolled'}.
                      <div className="text-dim text-[11px] mt-0.5">
                        Effective sshd: AuthenticationMethods <code>{st.sshd.authenticationMethods}</code> · KbdInteractive {st.sshd.kbdInteractive ? 'yes' : 'no'} · UsePAM {st.sshd.usePam ? 'yes' : 'no'} · PasswordAuthentication {st.sshd.passwordAuth ? 'yes' : 'no'}
                      </div>
                    </div>
                    <Button variant="danger" icon={<ShieldOff size={13} />} onClick={disable} loading={busy}>
                      Disable 2FA
                    </Button>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-3">
                  {(Object.keys(MODE_INFO) as TfaEnforceMode[]).map((m) => {
                    const info = MODE_INFO[m]
                    const active = mode === m
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          pickedRef.current = true
                          setMode(m)
                        }}
                        className={cls('text-left rounded-md border p-3 transition-colors', active ? 'border-accent bg-accent/10' : 'border-border bg-bg-2/40 hover:border-border-2')}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-medium text-[13px]">{info.title}</span>
                          {m === 'key+code' && <Badge color="ok">strongest</Badge>}
                          {active && <CheckCircle2 size={14} className="text-accent" />}
                        </div>
                        <div className="text-[11px] text-muted leading-relaxed">{info.description}</div>
                        <div className="text-[10px] text-dim mt-1.5 font-mono">AuthenticationMethods {m === 'password+code' ? 'keyboard-interactive' : m === 'key+code' ? 'publickey,keyboard-interactive' : 'publickey keyboard-interactive'}</div>
                      </button>
                    )
                  })}
                </div>

                <div className="space-y-2">
                  <Checkbox
                    checked={nullok}
                    onChange={(v) => {
                      pickedRef.current = true
                      setNullok(v)
                    }}
                    label={
                      <>
                        Allow users without a code yet (<code>nullok</code>) — accounts with no <code>~/.google_authenticator</code> log in as before
                      </>
                    }
                  />
                  {!nullok && (
                    <Callout kind="warn">
                      <AlertTriangle size={13} className="inline mr-1 -mt-0.5" />
                      Without nullok, <b>every</b> account that is not enrolled is locked out of SSH the moment this is applied: {st.users.filter((u) => !u.enrolled).map((u) => u.name).join(', ') || 'all users are enrolled'}.
                    </Callout>
                  )}
                </div>

                {st.sshdIncludeSupported && st.conflicts.length > 0 && (
                  <Callout kind="danger">
                    <b>Conflicting sshd settings read before the 2FA drop-in:</b>
                    <ul className="list-disc pl-5 mt-1">
                      {st.conflicts.map((c, i) => (
                        <li key={i}>
                          <code>{c.file}</code>: <code>{c.line}</code>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1">sshd keeps the first value it reads. Turn password login back on in Overview → SSH login rules (2FA still blocks plain passwords through AuthenticationMethods) or remove the line.</div>
                  </Callout>
                )}

                <div className="border border-border rounded-md p-3 bg-bg-2/40 text-xs text-muted space-y-1">
                  <div className="font-medium text-text">What happens when you click {enforced ? 'Apply' : 'Enable'}</div>
                  <ol className="list-decimal pl-5 space-y-0.5">
                    <li>
                      Back up <code>/etc/pam.d/sshd</code> → <code>/etc/pam.d/sshd.servermate.bak</code> and <code>/etc/ssh/sshd_config</code>.
                    </li>
                    <li>
                      {mode === 'password+code' ? (
                        <>
                          Add <code>auth required pam_google_authenticator.so{nullok ? ' nullok' : ''}</code> after the password stack (password first, then code).
                        </>
                      ) : (
                        <>
                          Add <code>auth required pam_google_authenticator.so{nullok ? ' nullok' : ''}</code> at the top and comment out the password stack (keyboard-interactive asks for the code only).
                        </>
                      )}
                    </li>
                    <li>
                      Write {st.sshdIncludeSupported ? <code>/etc/ssh/sshd_config.d/00-servermate-2fa.conf</code> : <>a marker block at the top of <code>/etc/ssh/sshd_config</code> (no Include support)</>}: <code>UsePAM yes</code>, <code>KbdInteractiveAuthentication yes</code>, <code>PasswordAuthentication no</code>, <code>AuthenticationMethods …</code>.
                    </li>
                    <li>
                      <code>sshd -t</code>, reload sshd, then open a verification SSH login as <b>{st.loginUser}</b> with the saved {st.profileAuth === 'password' ? 'password' : st.profileAuth === 'key' ? 'key' : 'agent key'} and the stored code.
                    </li>
                    <li>
                      <b className="text-text">If that login fails, both files are restored and sshd reloaded — the change is reverted automatically if ServerMate cannot log back in.</b>
                    </li>
                  </ol>
                </div>

                {blockers.length > 0 && (
                  <Callout kind="warn">
                    <b>Cannot enable yet:</b>
                    <ul className="list-disc pl-5 mt-1">
                      {blockers.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </Callout>
                )}

                <div className="flex items-center gap-2">
                  <Button variant="primary" icon={<ShieldCheck size={13} />} onClick={enable} loading={busy} disabled={blockers.length > 0 || (enforced && !changed)} title={blockers[0]}>
                    {enforced ? 'Apply changes' : 'Enable 2FA'}
                  </Button>
                  {enforced && !changed && <span className="text-[11px] text-dim">Pick another mode or toggle nullok to apply a change.</span>}
                </div>
              </div>
            </Card>

            {/* ---------- Step 4 ---------- */}
            <Card title={<StepTitle n={4}>Clients</StepTitle>}>
              <div className="grid grid-cols-2 gap-4 text-xs text-muted leading-relaxed">
                <div className="space-y-2">
                  <div className="font-medium text-text">Terminal (OpenSSH)</div>
                  <p>
                    Nothing to configure. <code>ssh user@{st.hostname}</code> asks <code>Verification code:</code> {mode === 'password+code' || st.mode === 'password+code' ? 'after the password' : 'after the key is accepted'}; type the 6 digits from the app (or an emergency code, which is deleted after use).
                  </p>
                  <p>
                    If a client has <code>PreferredAuthentications</code> or <code>KbdInteractiveAuthentication no</code> in its ssh_config, remove it. Automation (scp, rsync, Ansible, Git over SSH) must use a key and the <b>key or code</b> mode, or a dedicated account that stays unenrolled with nullok.
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-text">WinSCP, PuTTY, FileZilla, MobaXterm</div>
                  <p>
                    These support keyboard-interactive out of the box and show a “Verification code” prompt. In PuTTY keep <i>Connection → SSH → Auth → Attempt keyboard-interactive</i> enabled; in WinSCP use the SFTP/SCP protocol with the normal login dialog. Saved “password-only” sessions in some tools must be re-created so the extra prompt is shown.
                  </p>
                </div>
                <div className="col-span-2 flex items-start gap-2 border-t border-border pt-3">
                  <Smartphone size={14} className="shrink-0 mt-0.5" />
                  <p>
                    This server profile {st.profileHasTotp ? 'now contains' : 'can contain'} the TOTP secret of <b>{st.loginUser}</b> (Edit server → <i>2FA secret</i>), so ServerMate answers the code prompt by itself. Anyone with access to this computer’s profile store can therefore log in as that account — protect your OS user account accordingly.
                  </p>
                </div>
              </div>
            </Card>
          </div>
        )}
      </Page>

      {enroll && st && (
        <EnrollModal
          serverId={serverId}
          user={enroll.user}
          force={enroll.force}
          hostname={st.hostname}
          onClose={() => setEnroll(null)}
          onDone={() => void status.reload()}
        />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Enroll modal                                                        */
/* ------------------------------------------------------------------ */

function EnrollModal({ serverId, user, force, hostname, onClose, onDone }: { serverId: string; user: TfaUser; force: boolean; hostname: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [opts, setOpts] = useState<Required<Omit<TfaEnrollOptions, 'force'>>>({ rateLimit: true, reuse: false, window: 3, saveToProfile: user.self })
  const [result, setResult] = useState<TfaEnrollResult | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [verified, setVerified] = useState<boolean | null>(null)
  const { run, busy } = useAction()

  useEffect(() => {
    if (!result) return
    let alive = true
    QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 }).then(
      (url) => alive && setQr(url),
      () => alive && setQr(null)
    )
    return () => {
      alive = false
    }
  }, [result])

  const generate = async (): Promise<void> => {
    const r = await run(() => api.call<TfaEnrollResult>('tfa:enroll', serverId, user.name, { ...opts, force }))
    if (!r) return
    setResult(r)
    onDone()
  }

  const verify = async (): Promise<void> => {
    const r = await run(() => api.call<boolean>('tfa:verify', serverId, user.name, code.trim()))
    if (r === undefined) return
    setVerified(r)
  }

  const scratchText = (r: TfaEnrollResult): string =>
    [`ServerMate two-factor emergency codes`, `Account: ${r.account}`, `Generated: ${new Date().toISOString()}`, '', 'Each code works once. Keep this file somewhere safe (not on the server).', '', ...r.scratchCodes].join('\n') + '\n'

  return (
    <Modal
      open
      onClose={onClose}
      title={`${force ? 'Re-enroll' : 'Enroll'} ${user.name}`}
      width="max-w-3xl"
      badge={user.self ? <Badge color="accent">you</Badge> : undefined}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={generate} loading={busy} icon={<QrCode size={13} />}>
              Generate secret
            </Button>
          </>
        )
      }
    >
      {!result ? (
        <div className="space-y-4 text-[13px]">
          <p className="text-muted">
            A random 160-bit secret and 5 emergency codes are written to <code>~{user.name}/.google_authenticator</code> on the server. The QR code to scan is shown next — it is only displayed once.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Window size" hint="How many 30-second steps around the current time are accepted (3 = ±1 step, tolerates small clock drift).">
              <Select value={String(opts.window)} onChange={(e) => setOpts((o) => ({ ...o, window: Number(e.target.value) }))}>
                <option value="1">1 — exact step only</option>
                <option value="3">3 — ±30 s (default)</option>
                <option value="5">5 — ±1 min</option>
                <option value="17">17 — ±4 min (poor clocks)</option>
              </Select>
            </Field>
            <div className="flex flex-col gap-2 pt-5">
              <Checkbox checked={opts.rateLimit} onChange={(v) => setOpts((o) => ({ ...o, rateLimit: v }))} label="Rate limit: max 3 attempts per 30 s" />
              <Checkbox checked={!opts.reuse} onChange={(v) => setOpts((o) => ({ ...o, reuse: !v }))} label="Disallow reusing a code within its time step" />
            </div>
          </div>
          {user.self ? (
            <div className="border border-border rounded-md p-3 bg-bg-2/40 space-y-1">
              <Checkbox checked disabled onChange={() => {}} label="Save secret in this app so ServerMate can log in automatically" />
              <div className="text-[11px] text-dim pl-6">Required for the login account: ServerMate uses it to answer the “Verification code” prompt and to verify the rules before enforcing them. Stored encrypted with the other profile secrets.</div>
            </div>
          ) : (
            <Callout>
              Hand the QR code to <b>{user.name}</b> or scan it on their behalf. The secret is not kept by ServerMate.
            </Callout>
          )}
          {force && <Callout kind="warn">Re-enrolling invalidates the current authenticator entry and emergency codes of {user.name}.</Callout>}
        </div>
      ) : (
        <div className="space-y-4 text-[13px]">
          <Callout kind="warn">
            Scan the QR code now and store the emergency codes — <b>this screen cannot be shown again</b>. Then verify a code below before enforcing anything.
          </Callout>
          <div className="flex gap-5">
            <div className="shrink-0 bg-white rounded-md p-2 w-[236px] h-[236px] flex items-center justify-center">
              {qr ? <img src={qr} alt="Enrollment QR code" width={220} height={220} /> : <span className="text-xs text-dim">Rendering…</span>}
            </div>
            <div className="flex-1 min-w-0 space-y-3">
              <div>
                <div className="text-xs text-muted mb-1 font-medium">Account</div>
                <div className="font-mono text-xs">{result.account}</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1 font-medium">Secret (manual entry, base32)</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-bg-2 border border-border rounded-md px-2.5 py-1.5 font-mono text-xs break-all select-all">{result.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                  <Button size="xs" icon={<Copy size={11} />} onClick={() => copyText(result.secret)} title="Copy secret" />
                </div>
                <div className="text-[11px] text-dim mt-1">Type: time-based · SHA1 · 6 digits · 30 s</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1 font-medium">Emergency scratch codes (one-time)</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {result.scratchCodes.map((c) => (
                    <code key={c} className="bg-bg-2 border border-border rounded px-1.5 py-1 font-mono text-xs text-center">
                      {c}
                    </code>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <Button size="xs" icon={<Copy size={11} />} onClick={() => copyText(result.scratchCodes.join('\n'))}>
                    Copy
                  </Button>
                  <Button size="xs" icon={<Download size={11} />} onClick={() => downloadText(`2fa-emergency-codes-${user.name}@${hostname}.txt`, scratchText(result))}>
                    Download .txt
                  </Button>
                </div>
              </div>
              {result.savedToProfile && (
                <div className="text-[11px] text-ok-fg flex items-center gap-1.5">
                  <Check size={12} /> Secret saved in this server profile; ServerMate will answer code prompts itself.
                </div>
              )}
            </div>
          </div>
          <div className="border-t border-border pt-3">
            <Field label="Verify a code from the authenticator app" hint="Compares the code with the secret just written to the server (accepts ±30 s). A match confirms the app and the server clock agree.">
              <div className="flex items-center gap-2">
                <Input
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 8))
                    setVerified(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && code.length >= 6 && void verify()}
                  placeholder="123456"
                  mono
                  className="w-40"
                  autoFocus
                />
                <Button onClick={verify} disabled={code.length < 6} loading={busy}>
                  Verify
                </Button>
                {verified === true && (
                  <span className="flex items-center gap-1 text-ok-fg text-xs">
                    <CheckCircle2 size={14} /> Code is valid — the app is set up correctly
                  </span>
                )}
                {verified === false && (
                  <span className="flex items-center gap-1 text-danger-fg text-xs">
                    <XCircle size={14} /> Wrong code — rescan the QR or check the phone’s clock
                  </span>
                )}
              </div>
            </Field>
          </div>
        </div>
      )}
    </Modal>
  )
}
