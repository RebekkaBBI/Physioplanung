import App from './App'
import { useAuth } from './cloud/useAuth'
import { isSupabaseConfigured } from './cloud/config'
import { LoginScreen } from './cloud/LoginScreen'
import { ResetPasswordScreen } from './cloud/ResetPasswordScreen'

function isPasswordRecoveryFlow(): boolean {
  if (typeof window === 'undefined') return false
  const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/'
  if (normalizedPath === '/reset-password') return true
  const h = window.location.hash || ''
  const q = window.location.search || ''
  return (
    /(?:^|[&#?])type=recovery(?:$|[&#])/.test(h) ||
    /(?:^|[&#?])type=recovery(?:$|[&#])/.test(q)
  )
}

export function AppRoot() {
  const configured = isSupabaseConfigured()
  const { session, loading, profile, profileError } = useAuth()
  const allowLocalMode = process.env.NODE_ENV === 'development'

  if (!configured) {
    if (allowLocalMode) {
      return <App cloudSyncEnabled={false} />
    }
    return (
      <div className="app cloud-loading">
        <p className="cloud-loading-text">
          Cloud-Anmeldung ist nicht konfiguriert. Bitte NEXT_PUBLIC_SUPABASE_URL
          und NEXT_PUBLIC_SUPABASE_ANON_KEY im Hosting setzen.
        </p>
      </div>
    )
  }

  // Supabase Password-Recovery Link: User soll ein neues Passwort setzen können.
  if (isPasswordRecoveryFlow()) {
    return <ResetPasswordScreen />
  }

  if (loading) {
    return (
      <div className="app cloud-loading">
        <p className="cloud-loading-text">Sitzung wird geprüft …</p>
      </div>
    )
  }

  if (!session) {
    return <LoginScreen />
  }

  if (profileError || !profile) {
    return (
      <div className="app cloud-loading">
        <p className="cloud-loading-text">
          {profileError ||
            'Kein Benutzerprofil gefunden. Bitte SQL-Migration ausführen und ggf. Profil in der Datenbank prüfen.'}
        </p>
      </div>
    )
  }

  return <App cloudSyncEnabled />
}
