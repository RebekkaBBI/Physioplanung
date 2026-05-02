'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { WorkspaceDocType } from '@/cloud/workspaceDocTypes'

async function assertOrgForUser(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', userId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data?.organization_id || data.organization_id !== organizationId) {
    return { ok: false, error: 'Keine Berechtigung für diese Organisation.' }
  }
  return { ok: true }
}

export async function upsertWorkspaceDocumentAction(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return { ok: false, error: 'Nicht angemeldet.' }
  }
  const gate = await assertOrgForUser(supabase, user.id, organizationId)
  if (!gate.ok) return gate

  const { error } = await supabase.from('workspace_documents').upsert(
    {
      organization_id: organizationId,
      doc_type: docType,
      body: body as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,doc_type' },
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function fetchWorkspaceDocumentsAction(
  organizationId: string,
): Promise<
  | { ok: true; data: Partial<Record<WorkspaceDocType, unknown>> }
  | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    return { ok: false, error: 'Nicht angemeldet.' }
  }
  const gate = await assertOrgForUser(supabase, user.id, organizationId)
  if (!gate.ok) return gate

  const { data, error } = await supabase
    .from('workspace_documents')
    .select('doc_type, body')
    .eq('organization_id', organizationId)
  if (error) return { ok: false, error: error.message }
  const out: Partial<Record<WorkspaceDocType, unknown>> = {}
  for (const row of data ?? []) {
    const t = row.doc_type as WorkspaceDocType
    if (t === 'slots' || t === 'panels' || t === 'ui') {
      out[t] = row.body
    }
  }
  return { ok: true, data: out }
}
