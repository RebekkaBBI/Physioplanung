import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { WorkspaceDocType } from '@/cloud/workspaceDocTypes'
import { NextResponse } from 'next/server'

function isDocType(v: unknown): v is WorkspaceDocType {
  return v === 'slots' || v === 'panels' || v === 'ui'
}

/**
 * REST-Alternative zur Server Action: Workspace-Dokument speichern (gleiche RLS wie im Client).
 * Auth: Supabase-Session-Cookie. Kein Service-Role-Key.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
    return NextResponse.json({ error: 'Invalid organization_id or doc_type' }, { status: 400 })
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
