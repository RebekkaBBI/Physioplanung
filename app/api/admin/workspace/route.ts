import type { Json } from '@/database.types'
import type { WorkspaceDocType } from '@/cloud/workspaceDocTypes'
import { createSupabaseServiceRoleClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

function isDocType(v: unknown): v is WorkspaceDocType {
  return v === 'slots' || v === 'panels' || v === 'ui'
}

/**
 * Admin: Workspace-Dokument ohne RLS schreiben (Service Role).
 * Header: x-workspace-admin-secret = WORKSPACE_ADMIN_SECRET (nur Server-Env auf Vercel).
 * JSON: { organization_id, doc_type, body }
 */
export async function POST(request: Request) {
  const secret = process.env.WORKSPACE_ADMIN_SECRET?.trim()
  if (!secret) {
    return NextResponse.json(
      { error: 'WORKSPACE_ADMIN_SECRET nicht gesetzt.' },
      { status: 503 },
    )
  }
  if (request.headers.get('x-workspace-admin-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let json: {
    organization_id?: unknown
    doc_type?: unknown
    body?: unknown
  }
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

  try {
    const supabase = createSupabaseServiceRoleClient()
    const { error } = await supabase.from('workspace_documents').upsert(
      {
        organization_id: organizationId,
        doc_type: docType,
        body: (json.body ?? {}) as Json,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,doc_type' },
    )
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Serverfehler'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
