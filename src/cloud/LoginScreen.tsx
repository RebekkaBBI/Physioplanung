import { useState, type FormEvent } from 'react'
import { useAuth } from './useAuth'

export function LoginScreen() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const { error: err } = await signIn(email, password)
    setBusy(false)
    if (err) setError(err)
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
          <button type="submit" className="login-cloud-submit" disabled={busy}>
            {busy ? 'Anmelden …' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  )
}
