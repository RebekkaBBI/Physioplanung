export type AppRole = 'admin' | 'planung' | 'therapie' | 'viewer'

export type UserProfile = {
  organization_id: string
  role: AppRole
  display_name: string | null
}
