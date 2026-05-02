/**
 * ============================================================================
 * YELLOW_BACKUP — automatische Voll-Backups (localStorage)
 * Im Editor suchen: YELLOW_BACKUP
 *
 * Speicherort:
 *   • Ringpuffer: BACKUP_RING_KEY_PREFIX + "00" … "19" (je ein JSON-String)
 *   • Meta:       BACKUP_META_KEY  → { writeIndex: 0…19 }
 *   • Laufwerk:   BACKUP_LAST_SUNDAY_KEY  → letztes Sonntags-Backup (YYYY-MM-DD)
 * Nach 20 Backups wird der jeweils älteste Slot überschrieben (FIFO-Ring).
 * Zeit: jeder Sonntag 23:00 Uhr (lokale Systemzeit), nur wenn die App läuft.
 * ============================================================================
 */

export const BACKUP_RING_KEY_PREFIX = 'physio-planung-autobackup-'

/** Meta: nächster Schreibindex im Ring (0–19) */
export const BACKUP_META_KEY = 'physio-planung-autobackup-meta'

/** Merker: an welchem Sonntag (Datum) zuletzt das wöchentliche Backup lief */
export const BACKUP_LAST_SUNDAY_KEY = 'physio-planung-autobackup-last-sunday'

const SLOTS_KEY = 'physio-planung-slots-v2'
const PANELS_KEY = 'physio-planung-panels-v1'
const UI_KEY = 'physio-planung-ui-v1'

const RING_SIZE = 20

function dateKeyLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function buildFullBackupPayload(): string {
  const slotsJson = localStorage.getItem(SLOTS_KEY) ?? '{}'
  const panelsJson = localStorage.getItem(PANELS_KEY) ?? '{}'
  const uiJson = localStorage.getItem(UI_KEY)
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    slotsJson,
    panelsJson,
    uiJson: uiJson ?? null,
  })
}

/** Schreibt ein Backup in den Ring; überschreibt nach 20 Läufen den ältesten Slot. */
export function writeRotatingBackup(payload: string): void {
  let meta: { writeIndex: number }
  try {
    meta = JSON.parse(
      localStorage.getItem(BACKUP_META_KEY) ?? '{"writeIndex":0}',
    ) as { writeIndex: number }
  } catch {
    meta = { writeIndex: 0 }
  }
  const idx =
    typeof meta.writeIndex === 'number' &&
    Number.isFinite(meta.writeIndex) &&
    meta.writeIndex >= 0 &&
    meta.writeIndex < RING_SIZE
      ? meta.writeIndex
      : 0

  const key = `${BACKUP_RING_KEY_PREFIX}${String(idx).padStart(2, '0')}`
  localStorage.setItem(key, payload)
  meta.writeIndex = (idx + 1) % RING_SIZE
  localStorage.setItem(BACKUP_META_KEY, JSON.stringify(meta))
}

/**
 * Wöchentliches Backup: Sonntag, lokale Uhrzeit 23:00–23:59, höchstens einmal pro Sonntag.
 */
export function tryRunWeeklyBackup(): void {
  const now = new Date()
  if (now.getDay() !== 0) return
  if (now.getHours() !== 23) return

  const dk = dateKeyLocal(now)
  if (localStorage.getItem(BACKUP_LAST_SUNDAY_KEY) === dk) return

  setTimeout(() => {
    if (localStorage.getItem(BACKUP_LAST_SUNDAY_KEY) === dk) return
    try {
      const payload = buildFullBackupPayload()
      writeRotatingBackup(payload)
      localStorage.setItem(BACKUP_LAST_SUNDAY_KEY, dk)
    } catch (e) {
      console.warn('[YELLOW_BACKUP] wöchentliches Backup fehlgeschlagen', e)
    }
  }, 0)
}

let backupIntervalId: ReturnType<typeof setInterval> | undefined

/** Intervall 1 min + Visibility: prüft Sonntag 23:00. Rückgabe = Cleanup für useEffect. */
export function startWeeklyBackupScheduler(): () => void {
  const tick = () => {
    tryRunWeeklyBackup()
  }
  tick()
  backupIntervalId = setInterval(tick, 60_000)
  const onVis = () => {
    if (document.visibilityState === 'visible') tick()
  }
  document.addEventListener('visibilitychange', onVis)
  return () => {
    if (backupIntervalId !== undefined) clearInterval(backupIntervalId)
    backupIntervalId = undefined
    document.removeEventListener('visibilitychange', onVis)
  }
}
