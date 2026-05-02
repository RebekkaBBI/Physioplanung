import { createSupabaseServerClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * Geschützter Endpunkt: liefert nur Daten, wenn eine gültige Supabase-Session (Cookie) vorliegt.
 * Nützlich für Monitoring, externe Tools oder eigene Clients — ohne Secrets im Browser.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }
  return NextResponse.json({
    authenticated: true,
    userId: user.id,
    email: user.email ?? null,
  })
}
