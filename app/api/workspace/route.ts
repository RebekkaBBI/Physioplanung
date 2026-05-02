import { fetchWorkspaceDocumentsAction } from '@/actions/workspace'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { WorkspaceDocType } from '@/cloud/workspaceDocTypes'
import {
  checkRateLimit,
  getRequestClientKey,
} from '@/lib/simpleRateLimit'
import { NextResponse } from 'next/server'

/** Pro IP / Minute (alle Instanzen: nur best-effort) */
const GET_IP_MAX_PER_MIN = 180
const POST_IP_MAX_PER_MIN = 90
/** Pro angemeldetem User / Minute */
const POST_USER_MAX_PER_MIN = 120

function isDocType(v: unknown): v is WorkspaceDocType {
  return v === 'slots' || v === 'panels' || v === 'ui'
}

/**
 * Workspace-Dokumente lesen (slots / panels / ui-Körper).
 * Query: ?organization_id=<uuid>
 */
export async function GET(request: Request) {
  const ip = getRequestClientKey(request)
  if (!checkRateLimit(`workspace:get:ip:${ip}`, GET_IP_MAX_PER_MIN, 60_000)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const organizationId = searchParams.get('organization_id')
  if (!organizationId) {
    return NextResponse.json(
      { error: 'Query parameter organization_id is required' },
      { status: 400 },
    )
  }

  const res = await fetchWorkspaceDocumentsAction(organizationId)
  if (!res.ok) {
    if (res.error === 'Nicht angemeldet.') {
      return NextResponse.json({ error: res.error }, { status: 401 })
    }
    if (res.error.includes('Berechtigung')) {
      return NextResponse.json({ error: res.error }, { status: 403 })
    }
    return NextResponse.json({ error: res.error }, { status: 400 })
  }
  return NextResponse.json(res.data)
}

/**
 * Workspace-Dokument speichern (gleiche RLS wie im Client).
 * Auth: Supabase-Session-Cookie. Kein Service-Role-Key.
 */
export async function POST(request: Request) {
  const ip = getRequestClientKey(request)
  if (!checkRateLimit(`workspace:post:ip:${ip}`, POST_IP_MAX_PER_MIN, 60_000)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (
    !checkRateLimit(
      `workspace:post:user:${user.id}`,
      POST_USER_MAX_PER_MIN,
      60_000,
    )
  ) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  let json: { organization_id?: unknown; doc_type?: unknown; body?: unknown }
  try {
    json = (await request.json()) as typeof json
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const organizationId =
    typeof json.organization_id === 'string' ? json.organization_id : null
  const docType = json.doc_type
  if (!organizationId || !isDocType(docType)) {
    return NextResponse.json(
      { error: 'Invalid organization_id or doc_type' },
      { status: 400 },
    )
  }

  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle()
  if (pErr || profile?.organization_id !== organizationId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error } = await supabase.from('workspace_documents').upsert(
    {
      organization_id: organizationId,
      doc_type: docType,
      body: (json.body ?? {}) as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,doc_type' },
  )
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
