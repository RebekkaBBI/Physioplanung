import { createContext } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import type { UserProfile } from './types'

export type AuthState = {
  session: Session | null
  user: User | null
  profile: UserProfile | null
  loading: boolean
  profileError: string | null
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
