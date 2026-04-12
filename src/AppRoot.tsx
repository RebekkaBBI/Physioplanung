import App from './App'
import { useAuth } from './cloud/useAuth'
import { isSupabaseConfigured } from './cloud/config'
import { LoginScreen } from './cloud/LoginScreen'

export function AppRoot() {
  const configured = isSupabaseConfigured()
  const { session, loading, profile, profileError } = useAuth()

  if (!configured) {
    return <App cloudSyncEnabled={false} />
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
