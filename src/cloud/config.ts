export function isSupabaseConfigured(): boolean {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  return Boolean(
    typeof url === 'string' &&
      url.trim().length > 0 &&
      typeof key === 'string' &&
      key.trim().length > 0,
  )
}
