/**
 * Supabase-Clients erwarten die **Projekt-Root-URL** (`https://<ref>.supabase.co`).
 * Ein versehentlich angehängter Pfad (`/rest/v1`, `/auth/v1`, …) führt zu
 * PostgREST PGRST125 / „Invalid path specified in request URL“.
 */
export function normalizeSupabaseProjectUrl(url: string): string {
  const raw = url.trim()
  if (!raw) return raw
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}`
  } catch {
    return raw
  }
}
