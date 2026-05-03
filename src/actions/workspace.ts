'use server'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/database.types'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { applyWorkspaceDocumentPatch } from '@/lib/workspacePatch'
import type { WorkspaceDocType } from '@/cloud/workspaceDocTypes'

export type WorkspaceVersions = Record<WorkspaceDocType, string | null>

async function assertOrgForUser(
  supabase: SupabaseClient<Database>,
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
  expectedUpdatedAt: string | null,
): Promise<
  { ok: true; updated_at: string } | { ok: false; error: string }
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

  return applyWorkspaceDocumentPatch(
    supabase,
    organizationId,
    docType,
    body,
    expectedUpdatedAt,
  )
}

export async function fetchWorkspaceDocumentsAction(
  organizationId: string,
): Promise<
  | { ok: true; data: Partial<Record<WorkspaceDocType, unknown>>; versions: WorkspaceVersions }
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
    .select('doc_type, body, updated_at')
    .eq('organization_id', organizationId)
  if (error) return { ok: false, error: error.message }
  const out: Partial<Record<WorkspaceDocType, unknown>> = {}
  const versions: WorkspaceVersions = {
    slots: null,
    panels: null,
    ui: null,
    role_permissions: null,
  }
  for (const row of data ?? []) {
    const t = row.doc_type as WorkspaceDocType
    if (
      t === 'slots' ||
      t === 'panels' ||
      t === 'ui' ||
      t === 'role_permissions'
    ) {
      out[t] = row.body
      versions[t] = row.updated_at
    }
  }
  return { ok: true, data: out, versions }
}
