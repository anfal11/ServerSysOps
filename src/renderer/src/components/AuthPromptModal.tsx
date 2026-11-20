import React, { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { useApp } from '@/store/app'
import { Button, Callout, Field, Input, Modal } from '@/components/ui'
import { api } from '@/lib/api'

/**
 * Shown when a server sends keyboard-interactive prompts the app cannot answer on its own,
 * typically a two-factor "Verification code:" from Google Authenticator / PAM.
 */
export default function AuthPromptModal(): React.JSX.Element | null {
  const prompt = useApp((s) => s.authPrompts[0])
  const [answers, setAnswers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setAnswers(prompt ? prompt.prompts.map(() => '') : [])
    setBusy(false)
  }, [prompt?.requestId])
  if (!prompt) return null
  const unanswered = prompt.prompts.map((p, i) => ({ ...p, i })).filter((p) => !p.prefilled)
  const submit = async (): Promise<void> => {
    setBusy(true)
    await api.global('servers:answerPrompt', prompt.requestId, answers)
  }
  const cancel = async (): Promise<void> => {
    await api.global('servers:answerPrompt', prompt.requestId, null)
  }
  return (
    <Modal
      open
      onClose={cancel}
      title={
        <span className="flex items-center gap-2">
          <KeyRound size={15} /> {prompt.serverName}: {prompt.title}
        </span>
      }
      width="max-w-md"
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={unanswered.some((p) => !answers[p.i])}>
            Continue
          </Button>
        </>
      }
    >
      {prompt.instructions && <Callout>{prompt.instructions}</Callout>}
      <form
        className="space-y-3 mt-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {unanswered.length === 0 && <div className="text-xs text-muted">The server asked for additional confirmation.</div>}
        {unanswered.map((p, idx) => (
          <Field key={p.i} label={p.prompt.replace(/:\s*$/, '')} hint={/code|verification|otp|token/i.test(p.prompt) ? 'Open your authenticator app (Google Authenticator, Authy, …) and type the 6-digit code.' : undefined}>
            <Input
              type={p.echo ? 'text' : 'password'}
              autoFocus={idx === 0}
              value={answers[p.i] ?? ''}
              onChange={(e) => setAnswers((a) => a.map((v, i) => (i === p.i ? e.target.value : v)))}
              mono
              autoComplete="one-time-code"
              inputMode={/code|verification|otp/i.test(p.prompt) ? 'numeric' : undefined}
            />
          </Field>
        ))}
      </form>
      <div className="text-[11px] text-dim mt-4">Tip: store the TOTP secret in the server profile (Edit server → 2FA secret) and ServerMate fills the code automatically.</div>
    </Modal>
  )
}
