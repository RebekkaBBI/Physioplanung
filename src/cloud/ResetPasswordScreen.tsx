import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { getSupabaseBrowserClient } from './supabaseClient'

function hasRecoveryInUrlHash(): boolean {
  // Supabase Recovery Links nutzen typischerweise einen Hash:
  //   #access_token=...&refresh_token=...&type=recovery
  const h = window.location.hash || ''
  return /(?:^|[&#?])type=recovery(?:$|[&#])/.test(h)
}

export function ResetPasswordScreen() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    // Nach erfolgreicher Session-Erkennung aus URL Hash aufräumen
    if (!hasRecoveryInUrlHash()) return
    // nicht sofort löschen, damit Supabase detectSessionInUrl laufen kann
    const t = window.setTimeout(() => {
      try {
        if (hasRecoveryInUrlHash()) {
          history.replaceState(null, document.title, window.location.pathname + window.location.search)
        }
      } catch {
        /* ignore */
      }
    }, 800)
    return () => window.clearTimeout(t)
  }, [])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!supabase) {
      setError('Supabase ist nicht konfiguriert.')
      return
    }
    const p1 = password.trim()
    if (p1.length < 8) {
      setError('Bitte ein Passwort mit mindestens 8 Zeichen wählen.')
      return
    }
    if (p1 !== password2.trim()) {
      setError('Die Passwörter stimmen nicht überein.')
      return
    }
    setBusy(true)
    const { error: err } = await supabase.auth.updateUser({ password: p1 })
    setBusy(false)
    if (err) {
      setError(err.message)
      return
    }
    setDone(true)
  }

  return (
    <div className="login-cloud">
      <div className="login-cloud-card">
        <h1 className="login-cloud-title">Physio PlanungsApp</h1>
        <p className="login-cloud-hint">Neues Passwort setzen</p>
        {done ? (
          <>
            <p className="login-cloud-hint">
              Passwort wurde gespeichert. Du kannst dich jetzt mit dem neuen Passwort anmelden.
            </p>
            <button
              type="button"
              className="login-cloud-submit"
              onClick={() => (window.location.href = window.location.pathname)}
            >
              Zur Anmeldung
            </button>
          </>
        ) : (
          <form className="login-cloud-form" onSubmit={(ev) => void onSubmit(ev)}>
            <label className="login-cloud-field">
              Neues Passwort
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                required
              />
            </label>
            <label className="login-cloud-field">
              Passwort wiederholen
              <input
                type="password"
                autoComplete="new-password"
                value={password2}
                onChange={(ev) => setPassword2(ev.target.value)}
                required
              />
            </label>
            {error ? <p className="login-cloud-error">{error}</p> : null}
            <button type="submit" className="login-cloud-submit" disabled={busy}>
              {busy ? 'Speichern …' : 'Passwort speichern'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

