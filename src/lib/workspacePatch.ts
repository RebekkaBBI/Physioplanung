import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/database.types'
import type { WorkspaceDocType } from '@/cloud/workspaceDocTypes'

export type WorkspacePatchResult =
  | { ok: true; updated_at: string }
  | { ok: false; error: string }

/**
 * Atomares Schreiben mit Optimistic Lock (RPC, SECURITY INVOKER + RLS).
 */
export async function applyWorkspaceDocumentPatch(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
  expectedUpdatedAt: string | null,
): Promise<WorkspacePatchResult> {
  const { data, error } = await supabase.rpc('apply_workspace_document_patch', {
    p_organization_id: organizationId,
    p_doc_type: docType,
    p_body: body as Json,
    p_expected_updated_at: expectedUpdatedAt,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const row = data as {
    ok?: boolean
    updated_at?: string
    error?: string
    current_updated_at?: string
    detail?: string
  } | null

  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'Unerwartete Antwort der Datenbank.' }
  }

  if (row.ok === true && typeof row.updated_at === 'string') {
    return { ok: true, updated_at: row.updated_at }
  }

  const detail =
    typeof row.current_updated_at === 'string'
      ? ` (Server-Zeit: ${row.current_updated_at})`
      : ''
  return {
    ok: false,
    error: `Konflikt: Dieses Dokument wurde zwischenzeitlich geändert.${detail} Bitte Seite neu laden (F5).`,
  }
}
