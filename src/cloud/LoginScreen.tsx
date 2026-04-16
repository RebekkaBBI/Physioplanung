import { useState, type FormEvent } from 'react'
import { useAuth } from './useAuth'
import { getSupabaseBrowserClient } from './supabaseClient'

export function LoginScreen() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recoverySent, setRecoverySent] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setRecoverySent(false)
    setBusy(true)
    const { error: err } = await signIn(email, password)
    setBusy(false)
    if (err) setError(err)
  }

  const onSendRecovery = async () => {
    setError(null)
    setRecoverySent(false)
    const supabase = getSupabaseBrowserClient()
    if (!supabase) {
      setError('Supabase ist nicht konfiguriert.')
      return
    }
    const toEmail = email.trim()
    if (!toEmail) {
      setError('Bitte zuerst die E-Mail-Adresse eintragen.')
      return
    }
    setBusy(true)
    const { error: err } = await supabase.auth.resetPasswordForEmail(toEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setBusy(false)
    if (err) {
      setError(err.message)
      return
    }
    setRecoverySent(true)
  }

  return (
    <div className="login-cloud">
      <div className="login-cloud-card">
        <h1 className="login-cloud-title">Physio PlanungsApp</h1>
        <p className="login-cloud-hint">Anmeldung (Cloud)</p>
        <form className="login-cloud-form" onSubmit={(e) => void onSubmit(e)}>
          <label className="login-cloud-field">
            E-Mail
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              required
            />
          </label>
          <label className="login-cloud-field">
            Passwort
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              required
            />
          </label>
          {error ? <p className="login-cloud-error">{error}</p> : null}
          {recoverySent ? (
            <p className="login-cloud-hint" role="status">
              E-Mail zum Zurücksetzen wurde gesendet. Bitte Posteingang prüfen.
            </p>
          ) : null}
          <button type="submit" className="login-cloud-submit" disabled={busy}>
            {busy ? 'Anmelden …' : 'Anmelden'}
          </button>
          <button
            type="button"
            className="login-cloud-submit login-cloud-submit--secondary"
            onClick={() => void onSendRecovery()}
            disabled={busy}
          >
            Passwort vergessen
          </button>
        </form>
      </div>
    </div>
  )
}
