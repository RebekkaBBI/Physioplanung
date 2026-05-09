import type { RealtimeChannel } from '@supabase/supabase-js'
import {
  upsertWorkspaceDocumentAction,
  fetchWorkspaceDocumentsAction,
  fetchWorkspaceDocumentVersionsOnlyAction,
} from '@/actions/workspace'
import { getSupabaseBrowserClient } from './supabaseClient'
import { isSupabaseConfigured } from './config'
import type { WorkspaceDocType } from './workspaceDocTypes'

export type { WorkspaceDocType } from './workspaceDocTypes'

const SAVE_ERROR_EVENT = 'physio-workspace-save-error'
/** Jemand anderes (anderes Gerät/Tab) hat neuere workspace_documents — UI kann nachladen. */
export const WORKSPACE_REMOTE_STALE_EVENT = 'physio-workspace-remote-stale'

const DOC_TYPES: WorkspaceDocType[] = [
  'slots',
  'panels',
  'ui',
  'role_permissions',
]

const BROADCAST_CHANNEL_NAME = 'physio-workspace-lock-versions'

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

let broadcastChannel: BroadcastChannel | null = null

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null
  }
  if (!broadcastChannel) {
    broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    broadcastChannel.onmessage = (ev: MessageEvent) => {
      const d = ev.data as
        | { orgId?: string; docType?: WorkspaceDocType; updated_at?: string }
        | undefined
      if (!d?.orgId || !d.docType || typeof d.updated_at !== 'string') return
      workspaceDocVersions.set(`${d.orgId}:${d.docType}`, d.updated_at)
    }
  }
  return broadcastChannel
}

/**
 * Sollte einmal pro Seite aufgerufen werden (Cloud-Modus), damit andere Tabs
 * den aktuellen Optimistic-Lock-Zeitstempel mitbekommen.
 */
export function initWorkspaceCrossTabVersionSync(): void {
  getBroadcastChannel()
}

function broadcastDocVersion(
  organizationId: string,
  docType: WorkspaceDocType,
  updated_at: string,
): void {
  try {
    getBroadcastChannel()?.postMessage({
      orgId: organizationId,
      docType,
      updated_at,
    })
  } catch {
    /* ignore */
  }
}

function isConflictMessage(message: string): boolean {
  return message.toLowerCase().includes('konflikt')
}

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

let pendingStaleTypes = new Set<WorkspaceDocType>()
/** Browser: number; vermeidet NodeJS.Timeout vs. number in Next-Build. */
let staleDispatchTimer: number | null = null

function queueRemoteStale(docTypes: WorkspaceDocType[]) {
  if (typeof window === 'undefined') return
  for (const d of docTypes) pendingStaleTypes.add(d)
  if (staleDispatchTimer) return
  staleDispatchTimer = window.setTimeout(() => {
    staleDispatchTimer = null
    const list = [...pendingStaleTypes]
    pendingStaleTypes = new Set()
    if (list.length === 0) return
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_REMOTE_STALE_EVENT, {
        detail: { docTypes: list },
      }),
    )
  }, 650)
}

function serverIsNewerThanLocal(
  serverIso: string | null,
  localIso: string | null,
): boolean {
  if (!serverIso) return false
  if (!localIso) return true
  const ds = Date.parse(serverIso)
  const dl = Date.parse(localIso)
  if (!Number.isFinite(ds) || !Number.isFinite(dl)) return serverIso !== localIso
  return ds > dl + 2
}

async function refreshVersionsFromServer(organizationId: string): Promise<boolean> {
  const res = await fetchWorkspaceDocumentVersionsOnlyAction(organizationId)
  if (!res.ok) return false
  for (const t of DOC_TYPES) {
    workspaceDocVersions.set(`${organizationId}:${t}`, res.versions[t])
  }
  return true
}

async function detectRemoteNewerThanCached(organizationId: string) {
  const res = await fetchWorkspaceDocumentVersionsOnlyAction(organizationId)
  if (!res.ok) return
  const stale: WorkspaceDocType[] = []
  for (const docType of DOC_TYPES) {
    const key = `${organizationId}:${docType}`
    const local = workspaceDocVersions.get(key) ?? null
    const server = res.versions[docType]
    if (serverIsNewerThanLocal(server, local)) stale.push(docType)
  }
  if (stale.length > 0) queueRemoteStale(stale)
}

async function runUpsertOnce(
  organizationId: string,
  docType: WorkspaceDocType,
  body: unknown,
  conflictRetriesLeft: number,
): Promise<void> {
  const key = `${organizationId}:${docType}`
  const base = workspaceDocVersions.get(key) ?? null
  const result = await upsertWorkspaceDocumentAction(
    organizationId,
    docType,
    body,
    base,
  )
  if (result.ok) {
    workspaceDocVersions.set(key, result.updated_at)
    broadcastDocVersion(organizationId, docType, result.updated_at)
    return
  }
  if (isConflictMessage(result.error) && conflictRetriesLeft > 0) {
    const ok = await refreshVersionsFromServer(organizationId)
    if (ok) {
      await runUpsertOnce(
        organizationId,
        docType,
        body,
        conflictRetriesLeft - 1,
      )
      return
    }
  }
  dispatchSaveError(result.error)
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
    .then(() => runUpsertOnce(organizationId, docType, body, 2))
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
  for (const t of DOC_TYPES) {
    workspaceDocVersions.set(`${organizationId}:${t}`, res.versions[t])
  }
  return res.data
}

/**
 * Nach Cloud-Hydration: Versionsabgleich per Intervall + optional Supabase Realtime.
 * Liefert Cleanup (Interval + Channel).
 */
export function startWorkspaceRemoteVersionWatcher(
  organizationId: string,
  intervalMs = 45_000,
): () => void {
  if (!isSupabaseConfigured() || typeof window === 'undefined') {
    return () => {}
  }

  let cancelled = false
  const tick = () => {
    if (cancelled) return
    void detectRemoteNewerThanCached(organizationId)
  }

  const intervalId = window.setInterval(tick, intervalMs)
  queueMicrotask(tick)

  const supabase = getSupabaseBrowserClient()
  let channel: RealtimeChannel | null = null
  if (supabase) {
    channel = supabase
      .channel(`workspace_documents:${organizationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workspace_documents',
          filter: `organization_id=eq.${organizationId}`,
        },
        () => {
          tick()
        },
      )
    channel.subscribe()
  }

  return () => {
    cancelled = true
    window.clearInterval(intervalId)
    if (supabase && channel) {
      void supabase.removeChannel(channel)
    }
  }
}
