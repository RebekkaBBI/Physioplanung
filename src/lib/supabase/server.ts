import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/database.types'
import { normalizeSupabaseProjectUrl } from '@/lib/supabase/projectUrl'

/**
 * Supabase-Client für Server Actions, Route Handlers und Server Components.
 * Nutzt die Session aus Cookies (nach Middleware-Refresh).
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    normalizeSupabaseProjectUrl(process.env.NEXT_PUBLIC_SUPABASE_URL!),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            /* Server Component: Cookies ggf. read-only — Refresh läuft über Middleware */
          }
        },
      },
    },
  )
}
