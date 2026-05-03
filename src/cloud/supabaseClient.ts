import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/database.types'
import { normalizeSupabaseProjectUrl } from '@/lib/supabase/projectUrl'
import { isSupabaseConfigured } from './config'

let client: SupabaseClient<Database> | null = null

/**
 * Browser-Client mit Cookie-Sync (über @supabase/ssr), passend zu Middleware + Server Actions.
 */
export function getSupabaseBrowserClient(): SupabaseClient<Database> | null {
  if (!isSupabaseConfigured()) return null
  if (typeof window === 'undefined') return null
  if (client) return client
  const url = normalizeSupabaseProjectUrl(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  )
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
  client = createBrowserClient<Database>(url, anon.trim())
  return client
}
