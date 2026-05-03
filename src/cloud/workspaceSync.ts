import { upsertWorkspaceDocumentAction, fetchWorkspaceDocumentsAction } from '@/actions/workspace'
import { isSupabaseConfigured } from './config'
import type { WorkspaceDocType } from './workspaceDocTypes'

export type { WorkspaceDocType } from './workspaceDocTypes'

const SAVE_ERROR_EVENT = 'physio-workspace-save-error'

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Letzter bekannter updated_at pro Org+Dokument (Optimistic Lock) */
const workspaceDocVersions = new Map<string, string | null>()
/** Serielle Ausführung pro Key — verhindert parallele Upserts mit veraltetem base */
const upsertTailByKey = new Map<string, Promise<void>>()
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

async function runUpsertOnce(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
): Promise<void> {
  const key = `${organizationId}:${docType}`
  const base = workspaceDocVersions.get(key) ?? null
  const result = await upsertWorkspaceDocumentAction(
    organizationId,
    docType,
    body,
    base,
  )
  if (!result.ok) {
    dispatchSaveError(result.error)
    return
  }
  workspaceDocVersions.set(key, result.updated_at)
}

/** Reiht Upserts pro Org+Dokument hintereinander (kein paralleles „stale base“). */
function enqueueUpsert(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
): Promise<void> {
  const key = `${organizationId}:${docType}`
  const prev = upsertTailByKey.get(key) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(() => runUpsertOnce(organizationId, docType, body))
  upsertTailByKey.set(key, next)
  return next
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
 * Speichert workspace_documents mit Debounce über Server Action (Session aus Cookie).
 */
export function scheduleWorkspaceUpsert(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
  debounceMs = 400,
): void {
  if (!isSupabaseConfigured()) return
  const key = `${organizationId}:${docType}`
  pendingBodies.set(key, { organizationId, docType, body })
  runDebounced(key, debounceMs, () => {
    const row = pendingBodies.get(key)
    if (!row) return
    void enqueueUpsert(row.organizationId, row.docType, row.body)
  })
}

export async function flushPendingWorkspaceWrites(): Promise<void> {
  const keys = [...timers.keys()]
  const tasks: Promise<void>[] = []
  for (const key of keys) {
    const t = timers.get(key)
    if (t) clearTimeout(t)
    timers.delete(key)
    const row = pendingBodies.get(key)
    if (row) {
      tasks.push(
        enqueueUpsert(row.organizationId, row.docType, row.body),
      )
    }
  }
  await Promise.all(tasks)
}

export async function fetchWorkspaceDocuments(
  organizationId: string,
): Promise<Partial<Record<WorkspaceDocType, unknown>>> {
  const res = await fetchWorkspaceDocumentsAction(organizationId)
  if (!res.ok) {
    console.error('fetchWorkspaceDocuments', res.error)
    return {}
  }
  for (const t of ['slots', 'panels', 'ui'] as const) {
    workspaceDocVersions.set(`${organizationId}:${t}`, res.versions[t])
  }
  return res.data
}
