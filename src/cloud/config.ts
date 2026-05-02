export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  return Boolean(
    typeof url === 'string' &&
      url.trim().length > 0 &&
      typeof key === 'string' &&
      key.trim().length > 0,
  )
}
