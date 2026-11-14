import { Button, Codicon, host, useValue } from '@hermes/plugin-sdk'

import { openPrivacySettings } from '../api/client.js'
import { ACCESS } from '../lib/access.js'
import { classifyError, PROBLEMS } from '../lib/state.js'
import { HELPER_STATES } from './helper-state.js'
import { useHelperSetup } from './useHelperSetup.js'

export function ConnectStep({ onRetry, pending, scope, view }) {
  const profile = useValue(host.state.profile) || 'default'
  const helper = useHelperSetup(scope, Boolean(view.helperStatus), onRetry)
  return <ConnectionStatus helper={helper} onRetry={onRetry} pending={pending} profile={profile} view={view} />
}

export function ConnectionStatus({ helper, onRetry, pending, profile, view }) {
  const hermesUp = Boolean(view.envelope)
  const copy = view.helperStatus ? HELPER_STATES[helper.status ?? view.helperStatus] ?? HELPER_STATES.setup_failed : null
  const busy = pending || helper.pending
  const kind = helper.error && classifyError(helper.error).kind
  const error = kind && kind !== 'superseded' ? (PROBLEMS[kind] ?? PROBLEMS.unavailable_host).title : null
  const working = busy ? helper.action === 'prepare' ? 'Setting up…' : helper.action === 'install_tools' ? 'Opening installer…' : 'Checking…' : null
  const recovery = view.denied || Boolean(copy)
  const retry = () => view.helperStatus ? helper.run('check') : onRetry()

  return (
    <>
      <div className="rk-setup-head">
        <h2 id="rk-setup-title">{copy?.title ?? (view.denied ? ACCESS.title : 'Connecting to Reminders')}</h2>
        {(copy || view.denied) && <p>{copy?.body ?? ACCESS.body}</p>}
      </div>
      <ul aria-busy={busy} className="rk-checks">
        <CheckRow label="Hermes" spinning={!hermesUp} state={hermesUp ? `Connected · ${profile}` : 'Checking…'} tone={hermesUp ? 'ok' : undefined} />
        <CheckRow
          label="Reminders access"
          spinning={busy || !recovery}
          state={working ?? copy?.state ?? (view.denied ? "Can't read" : 'Checking…')}
          tone={busy ? undefined : copy?.state === 'Ready' ? 'ok' : recovery ? 'bad' : undefined}
        />
      </ul>
      {error && <p className="rk-setup-error" role="alert">{error}</p>}
      {recovery && (
        <div className="rk-setup-footer">
          {view.denied && <Button aria-disabled={busy} className="rk-connect-secondary" onClick={() => !busy && openPrivacySettings()} size="sm" variant="outline">Open Privacy Settings</Button>}
          {copy?.action && <Button aria-disabled={busy} className="rk-connect-primary" onClick={() => !busy && helper.run(copy.action)} size="sm">{working ?? copy.label}</Button>}
          <Button aria-disabled={busy} className={copy?.action ? 'rk-connect-secondary' : 'rk-connect-primary'} onClick={() => !busy && retry()} size="sm" variant={copy?.action ? 'outline' : undefined}>
            {busy ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      )}
    </>
  )
}

function CheckRow({ label, state, tone, spinning }) {
  return (
    <li>
      <span className="rk-check-label">{label}</span>
      <span aria-live="polite" className="rk-check-state" data-tone={tone}>
        <Codicon name={spinning ? 'loading' : tone === 'ok' ? 'pass-filled' : tone === 'bad' ? 'error' : 'circle-large'} size="0.85rem" spinning={spinning} />
        {state}
      </span>
    </li>
  )
}
