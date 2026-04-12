import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { AuthContext, type AuthState } from './authContextCore'
import { isSupabaseConfigured } from './config'
import { getSupabaseBrowserClient } from './supabaseClient'
import type { AppRole, UserProfile } from './types'

function parseRole(raw: string | null | undefined): AppRole {
  if (
    raw === 'admin' ||
    raw === 'planung' ||
    raw === 'therapie' ||
    raw === 'viewer'
  ) {
    return raw
  }
  return 'therapie'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthState['session']>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(() => isSupabaseConfigured())
  const [profileError, setProfileError] = useState<string | null>(null)

  const refreshProfile = useCallback(async (userId: string) => {
    const supabase = getSupabaseBrowserClient()
    if (!supabase) {
      setProfile(null)
      return
    }
    setProfileError(null)
    const { data, error } = await supabase
      .from('profiles')
      .select('organization_id, role, display_name')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      setProfile(null)
      setProfileError(error.message)
      return
    }
    if (!data?.organization_id) {
      setProfile(null)
      setProfileError('Kein Profil für dieses Konto.')
      return
    }
    setProfile({
      organization_id: data.organization_id as string,
      role: parseRole(data.role as string | undefined),
      display_name:
        typeof data.display_name === 'string' ? data.display_name : null,
    })
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      return
    }
    const supabase = getSupabaseBrowserClient()
    if (!supabase) {
      queueMicrotask(() => setLoading(false))
      return
    }
    let cancelled = false
    void supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (cancelled) return
      setSession(s)
      setLoading(false)
      if (s?.user?.id) void refreshProfile(s.user.id)
      else setProfile(null)
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (s?.user?.id) void refreshProfile(s.user.id)
      else {
        setProfile(null)
        setProfileError(null)
      }
    })
    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [refreshProfile])

  const signIn = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseBrowserClient()
    if (!supabase) return { error: 'Supabase ist nicht konfiguriert.' }
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    return { error: error?.message ?? null }
  }, [])

  const signOut = useCallback(async () => {
    const supabase = getSupabaseBrowserClient()
    if (supabase) await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
    setProfileError(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      profileError,
      signIn,
      signOut,
    }),
    [session, profile, loading, profileError, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
