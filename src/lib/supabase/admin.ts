import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/database.types'
import { normalizeSupabaseProjectUrl } from '@/lib/supabase/projectUrl'

/**
 * Nur in Server-Routen (ohne NEXT_PUBLIC_*). Nutzt Service Role → umgeht RLS.
 * Env: SUPABASE_SERVICE_ROLE_KEY (Dashboard → API Keys → Secret / service_role).
 */
export function createSupabaseServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url?.trim() || !key?.trim()) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY und NEXT_PUBLIC_SUPABASE_URL müssen gesetzt sein.',
    )
  }
  return createClient<Database>(normalizeSupabaseProjectUrl(url), key.trim())
}
