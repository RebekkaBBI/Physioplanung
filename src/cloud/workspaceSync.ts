import { getSupabaseBrowserClient } from './supabaseClient'

export type WorkspaceDocType = 'slots' | 'panels' | 'ui'

const SAVE_ERROR_EVENT = 'physio-workspace-save-error'

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Letzter Stand pro Dokument — für Debounce und Flush beim Tab-Schließen */
const pendingBodies = new Map<
  string,
  { organizationId: string; docType: WorkspaceDocType; body: unknown }
>()

function dispatchSaveError(message: string) {
  try {
    window.dispatchEvent(
      new CustomEvent(SAVE_ERROR_EVENT, { detail: { message } }),
    )
  } catch {
    /* ignore */
  }
  console.error('workspace_documents upsert:', message)
}

async function runUpsert(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
): Promise<void> {
  const supabase = getSupabaseBrowserClient()
  if (!supabase) return
  const { error } = await supabase.from('workspace_documents').upsert(
    {
      organization_id: organizationId,
      doc_type: docType,
      body: body as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,doc_type' },
  )
  if (error) {
    dispatchSaveError(error.message)
  }
}

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

/**
 * Speichert workspace_documents mit Debounce. Fehler (z. B. RLS) werden geloggt
 * und als Event gemeldet — vorher wurden Fehler still verschluckt.
 */
export function scheduleWorkspaceUpsert(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
  debounceMs = 400,
): void {
  const supabase = getSupabaseBrowserClient()
  if (!supabase) return
  const key = `${organizationId}:${docType}`
  pendingBodies.set(key, { organizationId, docType, body })
  runDebounced(key, debounceMs, () => {
    const row = pendingBodies.get(key)
    if (!row) return
    void runUpsert(row.organizationId, row.docType, row.body)
  })
}

/**
 * Alle ausstehenden (noch nicht ausgeführten) Speicherungen sofort ausführen.
 * Wichtig vor Tab-Schließen / Logout, damit kein Debounce Daten verwirft.
 */
export async function flushPendingWorkspaceWrites(): Promise<void> {
  const keys = [...timers.keys()]
  const tasks: Promise<void>[] = []
  for (const key of keys) {
    const t = timers.get(key)
    if (t) clearTimeout(t)
    timers.delete(key)
    const row = pendingBodies.get(key)
    if (row) {
      tasks.push(runUpsert(row.organizationId, row.docType, row.body))
    }
  }
  await Promise.all(tasks)
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
