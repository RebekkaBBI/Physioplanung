import { getSupabaseBrowserClient } from './supabaseClient'

export type WorkspaceDocType = 'slots' | 'panels' | 'ui'

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function runDebounced(
  key: string,
  ms: number,
  fn: () => void,
): void {
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      fn()
    }, ms),
  )
}

export function scheduleWorkspaceUpsert(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
  debounceMs = 700,
): void {
  const supabase = getSupabaseBrowserClient()
  if (!supabase) return
  const key = `${organizationId}:${docType}`
  runDebounced(key, debounceMs, () => {
    void supabase.from('workspace_documents').upsert(
      {
        organization_id: organizationId,
        doc_type: docType,
        body: body as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,doc_type' },
    )
  })
}

export async function fetchWorkspaceDocuments(
  organizationId: string,
): Promise<Partial<Record<WorkspaceDocType, unknown>>> {
  const supabase = getSupabaseBrowserClient()
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('workspace_documents')
    .select('doc_type, body')
    .eq('organization_id', organizationId)
  if (error) {
    console.error('fetchWorkspaceDocuments', error.message)
    return {}
  }
  const out: Partial<Record<WorkspaceDocType, unknown>> = {}
  for (const row of data ?? []) {
    const t = row.doc_type as WorkspaceDocType
    if (t === 'slots' || t === 'panels' || t === 'ui') {
      out[t] = row.body
    }
  }
  return out
}
