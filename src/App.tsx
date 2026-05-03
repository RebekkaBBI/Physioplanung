import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import Image from 'next/image'
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib'
import JSZip from 'jszip'
import './App.css'
// YELLOW_BACKUP: automatische Voll-Backups — Schlüssel & Ring in ./backup.ts (Suche: YELLOW_BACKUP)
import { startWeeklyBackupScheduler } from './backup'
// YELLOW_AI: KI-API (Chat) — siehe src/ai/ (Suche: YELLOW_AI)
import { useAuth } from './cloud/useAuth'
import { can } from './cloud/permissions'
import {
  fetchWorkspaceDocuments,
  flushPendingWorkspaceWrites,
  scheduleWorkspaceUpsert,
} from './cloud/workspaceSync'

const ROOMS = [
  'Physio 1',
  'Physio 2',
  'Gym Area',
  'Cardio',
  'Behandlung',
  'Patientenzimmer',
] as const

type Room = (typeof ROOMS)[number]
type ViewMode = 'day' | 'week'

const SLOT_MINUTES = 30
const DAY_START_HOUR = 8
const DAY_END_HOUR = 20

const MIME_PHYSIO = 'application/x-physio-planung+json'

const WEEKDAY_SHORT_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

/** id = interne Technik-ID (Drag); name + patientCode = fachliche Angaben */
type PatientItem = { id: string; name: string; patientCode: string }
type BelegungsartItem = {
  id: string
  label: string
  color: string
  /** Anzahl 30-Min-Slots bei Drop */
  slots: number
  /** Teammeeting: kein Patient; Teilnehmer als teamStaffIds; erscheint in deren Kalendern */
  teamMeeting?: boolean
}
/** Pro Slot im Muster-Editor; Schlüssel `woche|wd|Raum|slot` (woche 0–2, wd 0=Mo … 6=So). Ältere Daten `wd|Raum|slot` = Woche 0. */
type MusterTemplateCell = {
  art?: string
  artId?: string
  artColor?: string
}

type BelegungsmusterItem = {
  id: string
  label: string
  templateCells: Record<string, MusterTemplateCell>
  /** 1 = nur eine Woche im Editor; Standard 3 Wochen wenn fehlend */
  templateWeekCount?: 1 | 3
}

type StaffAbsenceKind = 'urlaub' | 'abwesend'

type StaffAbsencePeriod = {
  id: string
  fromDk: string
  toDk: string
  kind: StaffAbsenceKind
  /** true oder fehlend: ganztägig (alle Slots) an jedem Tag im Bereich */
  allDay?: boolean
  /** Nur wenn allDay === false: inklusive Slot-Indizes (pro Kalendertag im Bereich gleich) */
  startSlot?: number
  endSlot?: number
}

type MitarbeiterItem = {
  id: string
  name: string
  /** Mo=0 … So=6, Slot 0 = 08:00 — Schlüssel `${w}|${slot}` */
  availability: Record<string, boolean>
  /**
   * true: gerade ISO-Kalenderwoche → `availability`, ungerade KW → `availabilityOddWeek`.
   * Ermöglicht abwechselnde Wochenpläne.
   */
  alternatingWeeklyAvailability?: boolean
  /** Wochenplan für ungerade ISO-Kalenderwochen (gleiche Schlüssel wie `availability`) */
  availabilityOddWeek?: Record<string, boolean>
  /** Freigegebene Belegungsarten (IDs) */
  allowedArtIds: string[]
  /** Urlaub / Abwesenheit — nicht verfügbar (ganztägig oder stundenweise) */
  absences?: StaffAbsencePeriod[]
}

type DragPayload =
  | { kind: 'patient'; id: string }
  | { kind: 'art'; id: string }
  | { kind: 'muster'; id: string }
  | { kind: 'staff'; id: string }
  | {
      kind: 'moveBlock'
      fromDk: string
      fromRoom: Room
      fromSlot: number
    }
  | {
      kind: 'resizeBlock'
      fromDk: string
      fromRoom: Room
      edge: 'top' | 'bottom'
      /** Beliebiger Slot des Termins (für findBlockBounds) */
      anchorSlot: number
    }

type PanelDragPayload = Exclude<
  DragPayload,
  { kind: 'moveBlock' } | { kind: 'resizeBlock' }
>

type CellData = {
  patient?: string
  patientCode?: string
  art?: string
  artId?: string
  artColor?: string
  muster?: string
  musterColor?: string
  staff?: string
  staffId?: string
  /** Teammeeting: mehrere Teilnehmer-IDs (erscheinen jeweils im MA-Kalender) */
  teamStaffIds?: string[]
  /** Belegungsmuster auf Patient: keine freie Lage, erzwungene Buchung */
  terminKollision?: boolean
  /** Interne Notiz (wird nicht mit Terminen exportiert) */
  notiz?: string
}

/**
 * Keine doppelten Dialoge: (1) mehrere Aufrufe im selben Task werden zu einem Microtask
 * zusammengefasst; (2) gleicher Text innerhalb kurzer Zeit wird unterdrückt (z. B. doppelte
 * State-Updater). React StrictMode am Root ist dafür deaktiviert — sonst werden Updater in
 * der Entwicklung zweimal ausgeführt und `alert` im Updater erscheint doppelt.
 */
let lastAlertDedupe: { message: string; at: number } = { message: '', at: 0 }
const ALERT_DEDUPE_MS = 750
let pendingAlertMessage: string | null = null
let alertFlushScheduled = false

function alertOnce(message: string) {
  pendingAlertMessage = message
  if (alertFlushScheduled) return
  alertFlushScheduled = true
  queueMicrotask(() => {
    alertFlushScheduled = false
    const m = pendingAlertMessage
    pendingAlertMessage = null
    if (m === null) return
    const now = Date.now()
    if (
      m === lastAlertDedupe.message &&
      now - lastAlertDedupe.at < ALERT_DEDUPE_MS
    ) {
      return
    }
    lastAlertDedupe = { message: m, at: now }
    window.alert(m)
  })
}

function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function calendarDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0)
}

function startOfWeekMonday(d: Date): Date {
  const x = calendarDate(d)
  const day = x.getDay()
  const diff = day === 0 ? -6 : 1 - day
  x.setDate(x.getDate() + diff)
  return x
}

function addDays(d: Date, n: number): Date {
  const x = calendarDate(d)
  x.setDate(x.getDate() + n)
  return x
}

function addCalendarMonths(d: Date, delta: number): Date {
  const x = calendarDate(d)
  x.setMonth(x.getMonth() + delta)
  return x
}

function slotCount(): number {
  return ((DAY_END_HOUR - DAY_START_HOUR) * 60) / SLOT_MINUTES
}

function slotIndexToLabel(i: number): string {
  const mins = DAY_START_HOUR * 60 + i * SLOT_MINUTES
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function makeSlotKey(dateKeyStr: string, room: string, slotIndex: number): string {
  return `${dateKeyStr}|${room}|${slotIndex}`
}

function parseDateKey(dk: string): Date {
  const [y, m, d] = dk.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0)
}

function defaultPatientExportDateRange(): { from: string; to: string } {
  const weekStart = startOfWeekMonday(new Date())
  const weekEnd = addDays(weekStart, 6)
  return { from: dateKey(weekStart), to: dateKey(weekEnd) }
}

/** Montag = 0 … Sonntag = 6 */
function weekdayMon0FromDate(d: Date): number {
  const day = d.getDay()
  return day === 0 ? 6 : day - 1
}

function staffAvailKey(weekdayMon0: number, slotIndex: number): string {
  return `${weekdayMon0}|${slotIndex}`
}

/** ISO-8601-Kalenderwoche (1–53), Woche beginnt montags */
function getWeekNumber(d: Date): number {
  const target = new Date(d.valueOf())
  const dayNr = (d.getDay() + 6) % 7
  target.setDate(target.getDate() - dayNr + 3)
  const firstThursday = target.valueOf()
  target.setMonth(0, 1)
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7))
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000)
}

/** Effektives Wochen-Raster für ein konkretes Datum (eine vs. wechselnde KW) */
function staffAvailabilityMapForDate(
  s: MitarbeiterItem,
  dk: string,
): Record<string, boolean> {
  if (!s.alternatingWeeklyAvailability || !s.availabilityOddWeek) {
    return s.availability
  }
  const wn = getWeekNumber(parseDateKey(dk))
  const evenWeek = wn % 2 === 0
  return evenWeek ? s.availability : s.availabilityOddWeek
}

function isStaffSlotAvailable(
  s: MitarbeiterItem,
  weekdayMon0: number,
  slotIndex: number,
  dk?: string,
): boolean {
  const map = dk ? staffAvailabilityMapForDate(s, dk) : s.availability
  return map[staffAvailKey(weekdayMon0, slotIndex)] === true
}

function isDateInInclusiveRange(dk: string, fromDk: string, toDk: string): boolean {
  return dk >= fromDk && dk <= toDk
}

/** Abwesenheit für genau diesen Kalendertag und Slot (gilt für alle Räume) */
function isStaffAbsentAtSlot(
  s: MitarbeiterItem,
  dk: string,
  slotIndex: number,
): boolean {
  const abs = s.absences
  if (!abs || abs.length === 0) return false
  const max = slotCount()
  for (const p of abs) {
    if (!isDateInInclusiveRange(dk, p.fromDk, p.toDk)) continue
    const allDay = p.allDay !== false
    if (allDay) return true
    const start =
      typeof p.startSlot === 'number' && Number.isFinite(p.startSlot)
        ? Math.max(0, Math.min(max - 1, Math.floor(p.startSlot)))
        : 0
    const end =
      typeof p.endSlot === 'number' && Number.isFinite(p.endSlot)
        ? Math.max(0, Math.min(max - 1, Math.floor(p.endSlot)))
        : max - 1
    if (start <= end && slotIndex >= start && slotIndex <= end) return true
  }
  return false
}

/** Wochenplan + ggf. Abwesenheit an konkretem Kalendertag und Slot */
function isStaffSlotAvailableForDate(
  s: MitarbeiterItem,
  dk: string,
  weekdayMon0: number,
  slotIndex: number,
): boolean {
  if (isStaffAbsentAtSlot(s, dk, slotIndex)) return false
  return isStaffSlotAvailable(s, weekdayMon0, slotIndex, dk)
}

function newStaffAbsenceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function normalizeStaffAbsences(raw: unknown): StaffAbsencePeriod[] {
  if (!Array.isArray(raw)) return []
  const out: StaffAbsencePeriod[] = []
  const max = slotCount()
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : ''
    const fromDk = typeof o.fromDk === 'string' ? o.fromDk : ''
    const toDk = typeof o.toDk === 'string' ? o.toDk : ''
    const kind = o.kind === 'urlaub' || o.kind === 'abwesend' ? o.kind : null
    if (
      !id ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fromDk) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(toDk) ||
      fromDk > toDk ||
      !kind
    ) {
      continue
    }
    const allDay = o.allDay === false ? false : true
    if (allDay) {
      out.push({ id, fromDk, toDk, kind, allDay: true })
      continue
    }
    const startSlot =
      typeof o.startSlot === 'number' && Number.isFinite(o.startSlot)
        ? Math.max(0, Math.min(max - 1, Math.floor(o.startSlot)))
        : null
    const endSlot =
      typeof o.endSlot === 'number' && Number.isFinite(o.endSlot)
        ? Math.max(0, Math.min(max - 1, Math.floor(o.endSlot)))
        : null
    if (startSlot === null || endSlot === null || startSlot > endSlot) continue
    out.push({
      id,
      fromDk,
      toDk,
      kind,
      allDay: false,
      startSlot,
      endSlot,
    })
  }
  return out
}

function findArtIdForCell(
  cur: CellData | undefined,
  artenList: BelegungsartItem[],
): string | undefined {
  if (!cur) return undefined
  if (cur.artId) return cur.artId
  if (cur.art) return artenList.find((a) => a.label === cur.art)?.id
  return undefined
}

/** Patient im Termin, aber noch keine gültige Belegungsart aus dem Katalog. */
function patientTerminNeedsArtChoice(
  cur: CellData | undefined,
  artenList: BelegungsartItem[],
): boolean {
  if (!cur?.patient?.trim()) return false
  return !findArtIdForCell(cur, artenList)
}

function findStaffForCell(
  cur: CellData | undefined,
  staffList: MitarbeiterItem[],
): MitarbeiterItem | undefined {
  if (!cur) return undefined
  if (cur.staffId) return staffList.find((x) => x.id === cur.staffId)
  if (cur.staff) return staffList.find((x) => x.name === cur.staff)
  return undefined
}

function isTeamMeetingArt(a: BelegungsartItem | undefined): boolean {
  return !!a?.teamMeeting
}

/** Teammeeting vom Panel: nur Pause + freier Bereich (Teilnehmer wählt das Modal). */
function teamMeetingFromPanelBlockedReason(
  cells: Record<string, CellData>,
  dk: string,
  room: Room,
  startSlot: number,
  a: BelegungsartItem,
): string | null {
  if (!isTeamMeetingArt(a)) return 'Interner Fehler: keine Teammeeting-Art.'
  const max = slotCount()
  const span = Math.min(Math.max(1, a.slots), max - startSlot)
  if (slotRangeOverlapsMusterPause(startSlot, span)) {
    return 'Zwischen 12:00 und 13:30 ist Pause — hier kann keine Belegungsart liegen.'
  }
  for (let i = 0; i < span; i++) {
    const cur = cells[makeSlotKey(dk, room, startSlot + i)]
    if (cur?.patient?.trim()) {
      return 'Im gewählten Zeitraum ist bereits ein Patient eingetragen.'
    }
    if (isCellBooked(cur)) {
      return 'Der Bereich ist bereits belegt.'
    }
  }
  return null
}

function someStaffEligibleForTeamMeetingSlot(
  staffList: MitarbeiterItem[],
  artId: string,
  dk: string,
  wd: number,
  slotIndex: number,
): boolean {
  return staffList.some(
    (s) =>
      staffHasArtAllowed(s, artId) &&
      isStaffSlotAvailableForDate(s, dk, wd, slotIndex) &&
      !isStaffAbsentAtSlot(s, dk, slotIndex),
  )
}

/** MA hat diese Belegungsart im Profil freigeschaltet (explizite Liste). */
function staffHasArtAllowed(s: MitarbeiterItem, artId: string): boolean {
  return Array.isArray(s.allowedArtIds) && s.allowedArtIds.includes(artId)
}

/**
 * Alle Slots [startSlot, startSlot+span) müssen von **demselben** Mitarbeiter
 * belegbar sein: Freigabe für die Art + in jedem Slot im Wochenplan als verfügbar.
 */
function staffWhoCanPerformArtOnWholeSpan(
  staffList: MitarbeiterItem[],
  artId: string,
  dk: string,
  wd: number,
  startSlot: number,
  span: number,
): MitarbeiterItem[] {
  return staffList.filter((s) => {
    if (!staffHasArtAllowed(s, artId)) return false
    for (let i = 0; i < span; i++) {
      if (!isStaffSlotAvailableForDate(s, dk, wd, startSlot + i)) return false
    }
    return true
  })
}

/** Mindestens ein MA mit Freigabe für die Art an genau diesem Slot (für Vorschau „nur 30 Min.“). */
function someStaffCanTreatArtAtSingleSlot(
  staffList: MitarbeiterItem[],
  artId: string,
  dk: string,
  wd: number,
  slotIndex: number,
): boolean {
  return staffList.some(
    (s) =>
      staffHasArtAllowed(s, artId) &&
      isStaffSlotAvailableForDate(s, dk, wd, slotIndex),
  )
}

/**
 * Art-Drop vom Panel: gleiche Prüfung wie Vorschau — keine Pausenzeit 12:00–13:30,
 * mindestens ein Mitarbeiter mit Freigabe für die Art und Verfügbarkeit auf **jedem**
 * Slot der Spanne (ein MA für die ganze Behandlung); bereits zugewiesene Mitarbeiter
 * müssen zu dieser Menge passen; unauflösbare MA-Zuordnung blockiert.
 */
function artFromPanelBlockedReason(
  cells: Record<string, CellData>,
  dk: string,
  room: Room,
  startSlot: number,
  a: BelegungsartItem,
  staffList: MitarbeiterItem[],
): string | null {
  const wd = weekdayMon0FromDate(parseDateKey(dk))
  const max = slotCount()
  const span = Math.min(Math.max(1, a.slots), max - startSlot)
  if (slotRangeOverlapsMusterPause(startSlot, span)) {
    return 'Zwischen 12:00 und 13:30 ist Pause — hier kann keine Belegungsart liegen.'
  }

  const startK = makeSlotKey(dk, room, startSlot)
  const startCur = cells[startK]
  const pname = startCur?.patient?.trim() || null

  if (pname) {
    for (let i = 0; i < span; i++) {
      const cur = cells[makeSlotKey(dk, room, startSlot + i)]
      if (cur?.patient && cur.patient !== pname) {
        return 'Im gewählten Zeitraum ist bereits ein anderer Patient eingetragen.'
      }
    }
  } else {
    for (let i = 0; i < span; i++) {
      const cur = cells[makeSlotKey(dk, room, startSlot + i)]
      if (cur?.patient?.trim()) {
        return 'Im gewählten Zeitraum ist bereits ein Patient eingetragen.'
      }
    }
  }

  for (let i = 0; i < span; i++) {
    const cur = cells[makeSlotKey(dk, room, startSlot + i)]
    const hasStaffRef = !!(cur?.staffId?.trim() || cur?.staff?.trim())
    if (hasStaffRef && !findStaffForCell(cur, staffList)) {
      return 'Im Termin ist ein Mitarbeiter eingetragen, der in den Stammdaten nicht zugeordnet werden kann.'
    }
  }

  const staffIdsOnSpan: string[] = []
  for (let i = 0; i < span; i++) {
    const cur = cells[makeSlotKey(dk, room, startSlot + i)]
    const st = findStaffForCell(cur, staffList)
    if (st) staffIdsOnSpan.push(st.id)
  }
  const uniqueStaff = new Set(staffIdsOnSpan)
  if (uniqueStaff.size > 1) {
    return 'Im gewählten Zeitraum sind mehrere Mitarbeiter eingetragen — die Belegungsart kann hier nicht einheitlich platziert werden.'
  }

  for (let i = 0; i < span; i++) {
    const cur = cells[makeSlotKey(dk, room, startSlot + i)]
    const st = findStaffForCell(cur, staffList)
    if (st) {
      if (isStaffAbsentAtSlot(st, dk, startSlot + i)) {
        return 'Der Mitarbeiter ist in diesem Zeitraum als abwesend (Urlaub/Abwesenheit) eingetragen.'
      }
      if (!isStaffSlotAvailable(st, wd, startSlot + i, dk)) {
        return 'Zu dieser Zeit ist der Mitarbeiter in seinem Wochenplan nicht verfügbar.'
      }
      if (!staffHasArtAllowed(st, a.id)) {
        return 'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.'
      }
    }
  }

  const canTreat = staffWhoCanPerformArtOnWholeSpan(
    staffList,
    a.id,
    dk,
    wd,
    startSlot,
    span,
  )
  if (canTreat.length === 0) {
    return 'Kein Mitarbeiter mit Freigabe für diese Belegungsart ist in diesem Zeitraum durchgehend verfügbar.'
  }

  if (uniqueStaff.size === 1) {
    const sid = [...uniqueStaff][0]!
    if (!canTreat.some((c) => c.id === sid)) {
      return 'Der eingetragene Mitarbeiter ist für diese Belegungsart oder den gewählten Zeitraum nicht geeignet.'
    }
  }

  return null
}

function cellIsValidArtPanelDropPreview(
  cells: Record<string, CellData>,
  dk: string,
  room: Room,
  startSlot: number,
  a: BelegungsartItem,
  staffList: MitarbeiterItem[],
): boolean {
  if (isTeamMeetingArt(a)) {
    return (
      teamMeetingFromPanelBlockedReason(cells, dk, room, startSlot, a) === null
    )
  }
  return artFromPanelBlockedReason(cells, dk, room, startSlot, a, staffList) === null
}

/** Frei + Mitarbeiter/Art-Regeln für neu belegte Slots beim Verlängern. */
function extensionSlotError(
  prev: Record<string, CellData>,
  dk: string,
  room: Room,
  slot: number,
  template: CellData,
  wd: number,
  artenList: BelegungsartItem[],
  staffList: MitarbeiterItem[],
): string | null {
  const key = makeSlotKey(dk, room, slot)
  if (isCellBooked(prev[key])) return 'Zielbereich ist belegt.'
  const teamIds = template.teamStaffIds
  if (teamIds?.length) {
    const artId = findArtIdForCell(template, artenList)
    for (const tid of teamIds) {
      const st = staffList.find((s) => s.id === tid)
      if (!st) continue
      if (isStaffAbsentAtSlot(st, dk, slot)) {
        return 'Ein Teamteilnehmer ist in diesem Zeitraum als abwesend (Urlaub/Abwesenheit) eingetragen.'
      }
      if (!isStaffSlotAvailable(st, wd, slot, dk)) {
        return 'Ein Teamteilnehmer ist zu dieser Zeit in seinem Wochenplan nicht verfügbar.'
      }
      if (artId && !st.allowedArtIds.includes(artId)) {
        return 'Die Belegungsart ist für einen Teamteilnehmer in seinem Profil nicht freigegeben.'
      }
    }
    return null
  }
  const st = findStaffForCell(template, staffList)
  if (st) {
    if (isStaffAbsentAtSlot(st, dk, slot)) {
      return 'Der Mitarbeiter ist in diesem Zeitraum als abwesend (Urlaub/Abwesenheit) eingetragen.'
    }
    if (!isStaffSlotAvailable(st, wd, slot, dk)) {
      return 'Zu dieser Zeit ist der Mitarbeiter in seinem Wochenplan nicht verfügbar.'
    }
    const artId = findArtIdForCell(template, artenList)
    if (artId && !st.allowedArtIds.includes(artId)) {
      return 'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.'
    }
  }
  return null
}

/** Zusammenhängende Slots mit identischem Termin (Patient, Art, Mitarbeiter, Muster). */
function blockSignature(c: CellData | undefined): string {
  if (!c || !isCellBooked(c)) return '__empty__'
  const parts = [
    c.patient ?? '',
    c.patientCode ?? '',
    c.artId ?? '',
    c.art ?? '',
    c.staffId ?? '',
    c.staff ?? '',
    c.muster ?? '',
    c.terminKollision ? '1' : '0',
    c.notiz ?? '',
  ]
  if (c.teamStaffIds?.length) {
    parts.push([...c.teamStaffIds].sort().join(','))
  }
  return parts.join('\x1f')
}

function findBlockBounds(
  cells: Record<string, CellData>,
  dk: string,
  room: Room,
  slotIndex: number,
): { start: number; end: number } {
  const key = (s: number) => makeSlotKey(dk, room, s)
  const cur = cells[key(slotIndex)]
  if (!cur || !isCellBooked(cur)) {
    return { start: slotIndex, end: slotIndex }
  }
  const sig = blockSignature(cur)
  let start = slotIndex
  while (start > 0 && blockSignature(cells[key(start - 1)]) === sig) start--
  const max = slotCount()
  let end = slotIndex
  while (end + 1 < max && blockSignature(cells[key(end + 1)]) === sig) end++
  return { start, end }
}

/**
 * Gleiche Lage wie blockSignature, aber ohne Mitarbeiter — für Zuteilung per Drag/Dialog,
 * wenn Slots durch frühere Teil-Updates unterschiedliche staff/staffId haben und sonst
 * findBlockBounds nur noch einen Slot fände (fragmentierte Darstellung).
 */
function terminBlockSignatureIgnoringStaff(c: CellData | undefined): string {
  if (!c || !isCellBooked(c)) return '__empty__'
  const parts = [
    c.patient ?? '',
    c.patientCode ?? '',
    c.artId ?? '',
    c.art ?? '',
    c.muster ?? '',
    c.terminKollision ? '1' : '0',
    c.notiz ?? '',
  ]
  if (c.teamStaffIds?.length) {
    parts.push([...c.teamStaffIds].sort().join(','))
  }
  return parts.join('\x1f')
}

function findTerminBlockBoundsIgnoringStaff(
  cells: Record<string, CellData>,
  dk: string,
  room: Room,
  slotIndex: number,
): { start: number; end: number } {
  const key = (s: number) => makeSlotKey(dk, room, s)
  const cur = cells[key(slotIndex)]
  if (!cur || !isCellBooked(cur)) {
    return { start: slotIndex, end: slotIndex }
  }
  const sig = terminBlockSignatureIgnoringStaff(cur)
  let start = slotIndex
  while (
    start > 0 &&
    terminBlockSignatureIgnoringStaff(cells[key(start - 1)]) === sig
  ) {
    start--
  }
  const max = slotCount()
  let end = slotIndex
  while (
    end + 1 < max &&
    terminBlockSignatureIgnoringStaff(cells[key(end + 1)]) === sig
  ) {
    end++
  }
  return { start, end }
}

type DaySlotBlockSegment = 'single' | 'start' | 'middle' | 'end'

/** Position innerhalb eines zusammenhängenden Termins in einer Raum-Spalte (Tagesansicht). */
function daySlotBlockSegment(
  cells: Record<string, CellData>,
  dk: string,
  room: Room,
  slotIndex: number,
  slotMax: number,
): DaySlotBlockSegment | null {
  const data = cells[makeSlotKey(dk, room, slotIndex)]
  if (!isCellBooked(data)) return null
  const sig = blockSignature(data)
  const prev =
    slotIndex > 0 ? cells[makeSlotKey(dk, room, slotIndex - 1)] : undefined
  const next =
    slotIndex + 1 < slotMax
      ? cells[makeSlotKey(dk, room, slotIndex + 1)]
      : undefined
  const samePrev = isCellBooked(prev) && blockSignature(prev) === sig
  const sameNext = isCellBooked(next) && blockSignature(next) === sig
  if (!samePrev && !sameNext) return 'single'
  if (!samePrev && sameNext) return 'start'
  if (samePrev && sameNext) return 'middle'
  return 'end'
}

function emptyStaffAvailability(slotsN: number): Record<string, boolean> {
  const o: Record<string, boolean> = {}
  for (let w = 0; w < 7; w++) {
    for (let sl = 0; sl < slotsN; sl++) {
      o[staffAvailKey(w, sl)] = false
    }
  }
  return o
}

function migrateMitarbeiter(
  raw: { id: string; name: string } & Partial<MitarbeiterItem>,
  allArtIds: string[],
  slotsN: number,
): MitarbeiterItem {
  const hasAvail =
    raw.availability &&
    typeof raw.availability === 'object' &&
    Object.keys(raw.availability).length > 0
  let availability: Record<string, boolean>
  if (hasAvail) {
    availability = { ...raw.availability }
    for (let w = 0; w < 7; w++) {
      for (let sl = 0; sl < slotsN; sl++) {
        const k = staffAvailKey(w, sl)
        if (availability[k] === undefined) availability[k] = false
      }
    }
  } else {
    availability = {}
    for (let w = 0; w < 7; w++) {
      for (let sl = 0; sl < slotsN; sl++) {
        availability[staffAvailKey(w, sl)] = true
      }
    }
  }
  /* Nur wenn das Feld in den Stammdaten fehlt (ältere Daten): alle Arten. Explizit [] bleibt []. */
  const allowedArtIds = Array.isArray(raw.allowedArtIds)
    ? [...raw.allowedArtIds]
    : [...allArtIds]
  if (!allowedArtIds.includes(TEAM_MEETING_ART_ID)) {
    allowedArtIds.push(TEAM_MEETING_ART_ID)
  }
  const alternating = raw.alternatingWeeklyAvailability === true
  let availabilityOddWeek: Record<string, boolean> | undefined
  if (alternating) {
    availabilityOddWeek = emptyStaffAvailability(slotsN)
    if (
      raw.availabilityOddWeek &&
      typeof raw.availabilityOddWeek === 'object' &&
      Object.keys(raw.availabilityOddWeek).length > 0
    ) {
      for (let w = 0; w < 7; w++) {
        for (let sl = 0; sl < slotsN; sl++) {
          const k = staffAvailKey(w, sl)
          if (raw.availabilityOddWeek[k] === true) availabilityOddWeek[k] = true
        }
      }
    } else {
      availabilityOddWeek = { ...availability }
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    availability,
    alternatingWeeklyAvailability: alternating ? true : undefined,
    availabilityOddWeek,
    allowedArtIds,
    absences: normalizeStaffAbsences(raw.absences),
  }
}

function ensureTeamMeetingArtInCatalog(
  list: BelegungsartItem[],
): BelegungsartItem[] {
  if (list.some((a) => a.id === TEAM_MEETING_ART_ID)) return list
  const tm = DEFAULT_ARTEN.find((a) => a.id === TEAM_MEETING_ART_ID)
  return tm ? [...list, tm] : list
}

function isCellBooked(data: CellData | undefined): boolean {
  if (!data) return false
  return !!(
    data.patient ||
    data.art ||
    data.muster ||
    data.staff ||
    (data.teamStaffIds && data.teamStaffIds.length > 0)
  )
}

const STORAGE_KEY_V1 = 'physio-planung-bookings-v1'
const STORAGE_KEY_V2 = 'physio-planung-slots-v2'
const STORAGE_PANELS = 'physio-planung-panels-v1'
/** Ansicht & Kalenderdatum (Auto-Save bei jeder Änderung) */
const STORAGE_UI = 'physio-planung-ui-v1'
/** Erhöhen, wenn sich die feste Belegungsarten-Liste ändert (Migration aus localStorage). */
const ARTEN_CATALOG_VERSION = 4

const OP_BELEGUNGSART_ID = 'art-op'
const TEAM_MEETING_ART_ID = 'art-team-meeting'

/** Mittagspause im Muster-Editor — keine echte Belegungsart, wird nicht in den Hauptkalender übernommen. */
const MUSTER_PAUSE_ART_ID = '__muster_pause__'
/** 08:00 = Slot 0 → Slot 8 = 12:00 */
const PAUSE_START_SLOT = ((12 - DAY_START_HOUR) * 60) / SLOT_MINUTES
/** 12:00–13:30 = drei 30-Min-Slots */
const PAUSE_SLOT_COUNT = 3

function pauseCellData(): CellData {
  return {
    art: 'Pause',
    artId: MUSTER_PAUSE_ART_ID,
    artColor: '#94a3b8',
  }
}

function isMusterPauseCell(d: CellData | undefined): boolean {
  return d?.artId === MUSTER_PAUSE_ART_ID
}

/** Liegt [startSlot, startSlot+span) in der festen Pausenzeit? */
function slotRangeOverlapsMusterPause(startSlot: number, span: number): boolean {
  const end = startSlot + span - 1
  const p0 = PAUSE_START_SLOT
  const p1 = PAUSE_START_SLOT + PAUSE_SLOT_COUNT - 1
  return startSlot <= p1 && end >= p0
}

/** Hauptkalender: 12:00–13:30 — für automatische Muster-Buchungen gesperrt, manuell weiterhin nutzbar. */
function slotIndexInCalendarLunchPause(slot: number): boolean {
  return (
    slot >= PAUSE_START_SLOT &&
    slot < PAUSE_START_SLOT + PAUSE_SLOT_COUNT
  )
}

/**
 * Jeden Tag 12:00–13:30 in allen Räumen mit Pause belegen (überschreibt ggf. frühere Art nur in diesem Fenster).
 */
function injectMusterPauseSlots(
  virt: Record<string, CellData>,
  templateWeekCount: number,
): Record<string, CellData> {
  const out = { ...virt }
  const dayCount = templateWeekCount * 7
  const max = slotCount()
  const p = pauseCellData()
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const dk = templateDkForDayIndex(dayIndex)
    for (const room of ROOMS) {
      for (let sl = PAUSE_START_SLOT; sl < PAUSE_START_SLOT + PAUSE_SLOT_COUNT && sl < max; sl++) {
        out[makeSlotKey(dk, room, sl)] = { ...p }
      }
    }
  }
  return out
}

const DEFAULT_PATIENTS: PatientItem[] = [
  { id: 'p1', name: 'Max Mustermann', patientCode: 'P-24001' },
  { id: 'p2', name: 'Anna Schmidt', patientCode: 'P-24002' },
  { id: 'p3', name: 'Thomas Weber', patientCode: 'P-24003' },
]

/** 60 min = 2×30-Min-Slots, 120 min = 4 Slots; je Art eigene Farbe. */
const DEFAULT_ARTEN: BelegungsartItem[] = [
  { id: 'art-physiotherapy', label: 'Physiotherapy', color: '#0d9488', slots: 2 },
  {
    id: 'art-physio-videocall',
    label: 'Physiotherapy Videocall',
    color: '#0284c7',
    slots: 2,
  },
  { id: 'art-coping', label: 'Coping', color: '#4f46e5', slots: 2 },
  { id: 'art-massage-mld', label: 'Massage/MLD', color: '#db2777', slots: 2 },
  { id: 'art-sturfer', label: 'Sturfer', color: '#ca8a04', slots: 2 },
  { id: 'art-gait-training', label: 'Gait training', color: '#16a34a', slots: 2 },
  { id: 'art-gymarea', label: 'GymArea', color: '#9333ea', slots: 2 },
  { id: 'art-shockwave', label: 'Shockwave', color: '#dc2626', slots: 2 },
  { id: 'art-op', label: 'OP', color: '#991b1b', slots: 1 },
  { id: 'art-hbot', label: 'HBOT', color: '#0891b2', slots: 2 },
  { id: 'art-clicking', label: 'Clicking', color: '#a855f7', slots: 4 },
  { id: 'art-stretching-1', label: 'Stretching 1', color: '#ea580c', slots: 2 },
  { id: 'art-stretching-2', label: 'Stretching 2', color: '#059669', slots: 2 },
  { id: 'art-stretching-3', label: 'Stretching 3', color: '#c026d3', slots: 2 },
  {
    id: TEAM_MEETING_ART_ID,
    label: 'Teammeeting',
    color: '#475569',
    slots: 2,
    teamMeeting: true,
  },
]

/**
 * Woche 1, gewählter Wochentag (Mo=0 … So=6), ab 08:00 Uhr, alle Räume mit Art OP.
 * @param slotToExclusive Erster Slot nach dem Block (je 30 Min); 8 = bis 12:00, 4 = bis 10:00.
 */
function buildOberschenkelOpWeekdayTemplate(
  opArt: BelegungsartItem,
  weekdayMon0: number,
  slotToExclusive: number = 8,
): Record<string, MusterTemplateCell> {
  const cell: MusterTemplateCell = {
    art: opArt.label,
    artId: opArt.id,
    artColor: opArt.color,
  }
  const max = slotCount()
  const weekIndex = 0
  const slotFrom = 0
  const slotTo = Math.min(slotToExclusive, max)
  const out: Record<string, MusterTemplateCell> = {}
  for (const room of ROOMS) {
    for (let sl = slotFrom; sl < slotTo; sl++) {
      out[`${weekIndex}|${weekdayMon0}|${room}|${sl}`] = { ...cell }
    }
  }
  return out
}

const _defaultOpArt = DEFAULT_ARTEN.find((a) => a.id === OP_BELEGUNGSART_ID)!

const DEFAULT_MUSTER: BelegungsmusterItem[] = [
  {
    id: 'muster-oberschenkel-op-dienstag',
    label: 'Oberschenkelverlängerung OP Tag Dienstag',
    templateCells: buildOberschenkelOpWeekdayTemplate(_defaultOpArt, 1),
  },
  {
    id: 'muster-unterschenkel-op-dienstag',
    label: 'Unterschenkelverlängerung OP Tag Dienstag',
    templateCells: buildOberschenkelOpWeekdayTemplate(_defaultOpArt, 1),
  },
  {
    id: 'muster-oberschenkel-op-mittwoch',
    label: 'Oberschenkelverlängerung OP Tag Mittwoch',
    templateCells: buildOberschenkelOpWeekdayTemplate(_defaultOpArt, 2),
  },
  {
    id: 'muster-unterschenkel-op-mittwoch',
    label: 'Unterschenkelverlängerung OP Tag Mittwoch',
    templateCells: buildOberschenkelOpWeekdayTemplate(_defaultOpArt, 2),
  },
  {
    id: 'muster-oberschenkel-op-freitag',
    label: 'Oberschenkelverlängerung OP Tag Freitag',
    templateCells: buildOberschenkelOpWeekdayTemplate(_defaultOpArt, 4, 4),
  },
  {
    id: 'muster-verlaengerungswoche',
    label: 'Verlängerungswoche',
    templateCells: {},
    templateWeekCount: 1,
  },
  { id: 'm1', label: 'Kurzblock 30 Min', templateCells: {} },
  { id: 'm2', label: 'Standard 60 Min', templateCells: {} },
  { id: 'm3', label: 'Intensiv 90 Min', templateCells: {} },
  { id: 'm4', label: 'Doppelstunde', templateCells: {} },
]

const DEFAULT_MITARBEITER: MitarbeiterItem[] = [
  migrateMitarbeiter(
    { id: 'st-1', name: 'Dr. Weber' },
    DEFAULT_ARTEN.map((a) => a.id),
    slotCount(),
  ),
  migrateMitarbeiter(
    { id: 'st-2', name: 'M. Schneider' },
    DEFAULT_ARTEN.map((a) => a.id),
    slotCount(),
  ),
  migrateMitarbeiter(
    { id: 'st-3', name: 'A. Fischer' },
    DEFAULT_ARTEN.map((a) => a.id),
    slotCount(),
  ),
]

function loadSlotCells(): Record<string, CellData> {
  try {
    const v2 = localStorage.getItem(STORAGE_KEY_V2)
    if (v2) {
      const o = JSON.parse(v2) as Record<string, CellData>
      return o && typeof o === 'object' ? o : {}
    }
    const v1 = localStorage.getItem(STORAGE_KEY_V1)
    if (v1) {
      const arr = JSON.parse(v1) as string[]
      const out: Record<string, CellData> = {}
      if (Array.isArray(arr)) {
        for (const k of arr) {
          out[k] = { art: 'Belegung' }
        }
      }
      return out
    }
  } catch {
    /* ignore */
  }
  return {}
}

function saveSlotCells(next: Record<string, CellData>) {
  localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(next))
}

function parseSlotCellsFromUnknown(parsed: unknown): Record<string, CellData> {
  if (!parsed || typeof parsed !== 'object') return {}
  return parsed as Record<string, CellData>
}

function normalizeMusterUsageCountById(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = Math.floor(v)
    }
  }
  return out
}

type LoadedPanels = {
  patients: PatientItem[]
  arten: BelegungsartItem[]
  muster: BelegungsmusterItem[]
  mitarbeiter: MitarbeiterItem[]
  musterUsageCountById: Record<string, number>
}

function parsePanelsFromJsonObject(parsed: unknown): LoadedPanels | null {
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as {
    patients?: PatientItem[]
    arten?: BelegungsartItem[]
    muster?: BelegungsmusterItem[]
    mitarbeiter?: MitarbeiterItem[]
    artenCatalogVersion?: number
    musterUsageCountById?: unknown
  }
  const catalogOk =
    (o.artenCatalogVersion ?? 0) >= ARTEN_CATALOG_VERSION &&
    Array.isArray(o.arten) &&
    o.arten.length > 0
  const resolvedArten = ensureTeamMeetingArtInCatalog(
    catalogOk ? o.arten! : DEFAULT_ARTEN,
  )
  const artIdsForMigrate = resolvedArten.map((a) => a.id)
  return {
    patients: Array.isArray(o.patients)
      ? o.patients.map((p: PatientItem) => ({
          ...p,
          patientCode:
            typeof p.patientCode === 'string' ? p.patientCode : '',
        }))
      : DEFAULT_PATIENTS,
    arten: resolvedArten,
    muster: ensureVerlaengerungswocheMusterPreset(
      ensureOberschenkelOpMusterPreset(
        Array.isArray(o.muster)
          ? o.muster.map(normalizeMusterItem)
          : DEFAULT_MUSTER,
        resolvedArten,
      ),
    ),
    mitarbeiter: Array.isArray(o.mitarbeiter)
      ? o.mitarbeiter
          .filter(
            (s) => s && typeof s.id === 'string' && typeof s.name === 'string',
          )
          .map((s) =>
            migrateMitarbeiter(
              s as { id: string; name: string } & Partial<MitarbeiterItem>,
              artIdsForMigrate,
              slotCount(),
            ),
          )
      : DEFAULT_MITARBEITER,
    musterUsageCountById: normalizeMusterUsageCountById(o.musterUsageCountById),
  }
}

function loadPanels(): LoadedPanels | null {
  try {
    const raw = localStorage.getItem(STORAGE_PANELS)
    if (!raw) return null
    return parsePanelsFromJsonObject(JSON.parse(raw))
  } catch {
    return null
  }
}

function savePanelsState(p: {
  patients: PatientItem[]
  arten: BelegungsartItem[]
  muster: BelegungsmusterItem[]
  mitarbeiter: MitarbeiterItem[]
  musterUsageCountById: Record<string, number>
}) {
  localStorage.setItem(
    STORAGE_PANELS,
    JSON.stringify({
      ...p,
      artenCatalogVersion: ARTEN_CATALOG_VERSION,
    }),
  )
}

function parseUiFromUnknown(parsed: unknown): {
  viewMode: ViewMode
  anchorDateKey: string
} | null {
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as { viewMode?: unknown; anchorDateKey?: unknown }
  const vm =
    o.viewMode === 'day' || o.viewMode === 'week' ? o.viewMode : null
  const ak =
    typeof o.anchorDateKey === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.anchorDateKey)
      ? o.anchorDateKey
      : null
  if (!vm || !ak) return null
  return { viewMode: vm, anchorDateKey: ak }
}

function loadUiState(): { viewMode: ViewMode; anchorDateKey: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_UI)
    if (!raw) return null
    return parseUiFromUnknown(JSON.parse(raw))
  } catch {
    return null
  }
}

function saveUiState(viewMode: ViewMode, anchorDate: Date) {
  localStorage.setItem(
    STORAGE_UI,
    JSON.stringify({
      viewMode,
      anchorDateKey: dateKey(anchorDate),
    }),
  )
}

function icsUtcStampNow(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
}

function icsEscapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

function formatIcsLocalDateTime(dk: string, slotIndex: number): string {
  const [y, m, d] = dk.split('-').map(Number)
  const mins = DAY_START_HOUR * 60 + slotIndex * SLOT_MINUTES
  const hh = Math.floor(mins / 60)
  const mm = mins % 60
  return `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`
}

function formatIcsLocalDateTimeEnd(dk: string, endSlotInclusive: number): string {
  const n = slotCount()
  const ex = endSlotInclusive + 1
  if (ex >= n) {
    const [y, m, d] = dk.split('-').map(Number)
    return `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}T${String(DAY_END_HOUR).padStart(2, '0')}0000`
  }
  return formatIcsLocalDateTime(dk, ex)
}

type PatientAppointmentExportRow = {
  dk: string
  room: Room
  startSlot: number
  endSlot: number
  staffLabel: string
  artLabel?: string
}

type StaffAppointmentExportRow = {
  dk: string
  room: Room
  startSlot: number
  endSlot: number
  artLabel?: string
  patientLabel: string
}

function slotEndTimeLabelExclusive(endSlotInclusive: number): string {
  const n = slotCount()
  const ex = endSlotInclusive + 1
  if (ex >= n) {
    return `${String(DAY_END_HOUR).padStart(2, '0')}:00`
  }
  return slotIndexToLabel(ex)
}

/**
 * Vorlage A4 (595×842 pt). Maske: Bereich für Einleitung + Tabelle; Kopfzeile der Vorlage bleibt sichtbar.
 */
const PDF_TEMPLATE_BODY_MASK = { x: 45, y: 42, width: 505, height: 493 } as const

const PATIENT_EXPORT_INTRO_DE = `Anbei erhalten Sie Ihre persönliche Trainings- und Terminübersicht aus dem BeckerBetzInstitute. Zusätzlich senden wir Ihnen die Termine auch als .ICS-Dateien, damit Sie diese bequem in Ihren Kalender übernehmen können.

Wir bitten Sie höflich um Einhaltung der Termine sowie um Pünktlichkeit, um einen reibungslosen Ablauf zu gewährleisten. Sollte sich einmal ein Termin verschieben, informieren wir Sie selbstverständlich so früh wie möglich und bitten hierfür um Ihr Verständnis.`

const PATIENT_EXPORT_INTRO_EN = `Please find attached your personal training and appointment schedule from the BeckerBetzInstitute. In addition, we are sending you the appointments as .ICS files so that you can easily add them to your calendar.

We kindly ask you to adhere to the scheduled appointments and to arrive on time in order to ensure a smooth process. Should any appointment need to be rescheduled, we will inform you as early as possible and kindly ask for your understanding.`

const PDF_BODY_X = PDF_TEMPLATE_BODY_MASK.x
const PDF_BODY_W = PDF_TEMPLATE_BODY_MASK.width
/** Oberkante des weißen Inhaltsbereichs (unterhalb der sichtbaren Kopfzeile). */
const PDF_BODY_TOP_Y =
  PDF_TEMPLATE_BODY_MASK.y + PDF_TEMPLATE_BODY_MASK.height
/** Vier gleich breite Spalten über die Textbreite */
const PDF_COL_W = PDF_BODY_W / 4
function pdfColLeft(i: 0 | 1 | 2 | 3): number {
  return PDF_BODY_X + i * PDF_COL_W
}
/** Abstand zur Kopfzeile: genau zwei Zeilen bis zur ersten Überschrift */
const PDF_EXPORT_LINE = 11
/** Fortsetzungsseiten ohne Einleitungstext */
const PDF_TABLE_CONT = {
  headerY: 448,
  firstRowY: 432,
} as const
/** Zeilenhöhe, wenn Name / Belegungsart / Mitarbeiter untereinander stehen */
const PDF_TERM_STACK_ROW_H = 28
const PDF_TERM_STACK_FS = 7
const PDF_TERM_STACK_MAX_W = PDF_COL_W - 8
/** Patienten-PDF: weniger Zeilen pro Seite wegen Einleitung + höherer Terminzeilen */
const PDF_ROWS_PATIENT_TERM_STACK_PAGE = 10
const PDF_ROWS_STAFF_TERM_STACK_PAGE = 12


/** Pro Absatz eine Liste von Zeilen (für Blocksatz: letzte Zeile links, übrige gestreckt). */
function wrapPdfParagraphsToLines(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[][] {
  const out: string[][] = []
  const paragraphs = text.split(/\n\s*\n/)
  for (const raw of paragraphs) {
    const para = raw.replace(/\s+/g, ' ').trim()
    if (!para) continue
    const words = para.split(/\s+/)
    const lines: string[] = []
    let line = ''
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(test, fontSize) <= maxWidth) {
        line = test
      } else {
        if (line) lines.push(line)
        line = w
      }
    }
    if (line) lines.push(line)
    out.push(lines)
  }
  return out
}

function drawPdfLineJustified(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  font: PDFFont,
  fontSize: number,
  color: ReturnType<typeof rgb>,
): void {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return
  if (words.length === 1) {
    page.drawText(words[0], { x, y, size: fontSize, font, color })
    return
  }
  let sumW = 0
  for (const w of words) {
    sumW += font.widthOfTextAtSize(w, fontSize)
  }
  const gaps = words.length - 1
  const extra = maxWidth - sumW
  if (extra <= 0) {
    page.drawText(
      truncatePdfLineToWidth(text, font, fontSize, maxWidth),
      { x, y, size: fontSize, font, color },
    )
    return
  }
  const gapW = extra / gaps
  let cx = x
  for (let i = 0; i < words.length; i++) {
    page.drawText(words[i], { x: cx, y, size: fontSize, font, color })
    cx += font.widthOfTextAtSize(words[i], fontSize)
    if (i < words.length - 1) cx += gapW
  }
}

/** Zeichnet einen Absatz; letzte Zeile links, übrige Blocksatz. Gibt y unter der letzten Zeile zurück. */
function drawPdfParagraphJustified(
  page: PDFPage,
  lines: string[],
  x: number,
  yStart: number,
  lineHeight: number,
  maxWidth: number,
  font: PDFFont,
  fontSize: number,
  color: ReturnType<typeof rgb>,
): number {
  let y = yStart
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const isLastLine = li === lines.length - 1
    const useJustify =
      lines.length === 1
        ? line.split(/\s+/).filter(Boolean).length > 1
        : !isLastLine
    if (useJustify) {
      drawPdfLineJustified(page, line, x, y, maxWidth, font, fontSize, color)
    } else {
      page.drawText(line, { x, y, size: fontSize, font, color })
    }
    y -= lineHeight
  }
  return y
}

function truncatePdfLineToWidth(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string {
  const t = text.trim() || '—'
  if (font.widthOfTextAtSize(t, fontSize) <= maxWidth) return t
  let lo = 0
  let hi = t.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const s = `${t.slice(0, mid)}…`
    if (font.widthOfTextAtSize(s, fontSize) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${t.slice(0, lo)}…` : '…'
}

/** Name, Belegungsart, Mitarbeiter jeweils eigene Zeile (oberste Baseline = topBaselineY). */
function drawPdfTerminThreeLines(
  page: PDFPage,
  x: number,
  topBaselineY: number,
  line1: string,
  line2: string,
  line3: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
  color: ReturnType<typeof rgb>,
): void {
  const lh = fontSize + 2
  let y = topBaselineY
  for (const raw of [line1, line2, line3]) {
    const t = truncatePdfLineToWidth(raw, font, fontSize, maxWidth)
    page.drawText(t, { x, y, size: fontSize, font, color })
    y -= lh
  }
}

function pdfRgbFromHex(hex: string | undefined): { r: number; g: number; b: number } {
  const h = (hex ?? '#cbd5e1').trim()
  const m = /^#?([0-9a-f]{6})$/i.exec(h)
  if (!m) return { r: 0.85, g: 0.87, b: 0.9 }
  const n = parseInt(m[1], 16)
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  }
}

/** Alle Kalenderwochen (Montag-Datum), die den Zeitraum [fromDk, toDk] schneiden. */
function listWeekMondaysBetween(fromDk: string, toDk: string): string[] {
  const out: string[] = []
  let mon = dateKey(startOfWeekMonday(parseDateKey(fromDk)))
  const toD = parseDateKey(toDk)
  while (parseDateKey(mon) <= toD) {
    out.push(mon)
    mon = dateKey(addDays(parseDateKey(mon), 7))
  }
  return out
}

async function downloadPatientAppointmentsPdf(
  patient: PatientItem,
  rows: PatientAppointmentExportRow[],
  fileBase: string,
) {
  const templateUrl = '/BBI.pdf'
  let templateBytes: ArrayBuffer
  try {
    const res = await fetch(templateUrl)
    if (!res.ok) throw new Error(String(res.status))
    templateBytes = await res.arrayBuffer()
  } catch {
    alertOnce(
      'Die PDF-Vorlage konnte nicht geladen werden (BBI.pdf im Ordner public).',
    )
    return
  }

  const templateDoc = await PDFDocument.load(templateBytes)
  const outDoc = await PDFDocument.create()
  const font = await outDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold)

  const chunks: PatientAppointmentExportRow[][] = []
  for (let i = 0; i < rows.length; i += PDF_ROWS_PATIENT_TERM_STACK_PAGE) {
    chunks.push(rows.slice(i, i + PDF_ROWS_PATIENT_TERM_STACK_PAGE))
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const [embedded] = await outDoc.copyPages(templateDoc, [0])
    outDoc.addPage(embedded)
    const page = outDoc.getPage(outDoc.getPageCount() - 1)

    page.drawRectangle({
      x: PDF_TEMPLATE_BODY_MASK.x,
      y: PDF_TEMPLATE_BODY_MASK.y,
      width: PDF_TEMPLATE_BODY_MASK.width,
      height: PDF_TEMPLATE_BODY_MASK.height,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    })

    const sub = `${patient.name}${patient.patientCode.trim() ? ` · ${patient.patientCode}` : ''} · ${rows.length} Termin${rows.length === 1 ? '' : 'e'}`

    let termY: number
    let subY: number
    let headerRowY: number
    let firstDataRowY: number

    if (ci === 0) {
      const introW = PDF_BODY_W
      let introSize = 8
      let introLineH = 10
      let paragraphsDe = wrapPdfParagraphsToLines(
        PATIENT_EXPORT_INTRO_DE,
        font,
        introSize,
        introW,
      )
      let paragraphsEn = wrapPdfParagraphsToLines(
        PATIENT_EXPORT_INTRO_EN,
        font,
        introSize,
        introW,
      )
      const countParaLines = (pars: string[][]) =>
        pars.reduce((s, p) => s + p.length, 0)
      const nIntroLines =
        countParaLines(paragraphsDe) + 2 + countParaLines(paragraphsEn)
      termY = PDF_BODY_TOP_Y - 2 * PDF_EXPORT_LINE
      subY = termY - 14
      let introStartY = subY - 14
      let yAfterIntro = introStartY - nIntroLines * introLineH
      if (yAfterIntro < 300) {
        introSize = 7
        introLineH = 9
        paragraphsDe = wrapPdfParagraphsToLines(
          PATIENT_EXPORT_INTRO_DE,
          font,
          introSize,
          introW,
        )
        paragraphsEn = wrapPdfParagraphsToLines(
          PATIENT_EXPORT_INTRO_EN,
          font,
          introSize,
          introW,
        )
        const n2 =
          countParaLines(paragraphsDe) + 2 + countParaLines(paragraphsEn)
        termY = PDF_BODY_TOP_Y - 2 * PDF_EXPORT_LINE
        subY = termY - 14
        introStartY = subY - 12
        yAfterIntro = introStartY - n2 * introLineH
      }
      page.drawText('Terminübersicht/Appointment overview', {
        x: PDF_BODY_X,
        y: termY,
        size: 11,
        font: fontBold,
        color: rgb(0.15, 0.15, 0.15),
      })
      page.drawText(sub, {
        x: PDF_BODY_X,
        y: subY,
        size: 9,
        font,
        color: rgb(0.25, 0.25, 0.25),
      })
      const introColor = rgb(0.22, 0.22, 0.22)
      let y = introStartY
      for (const para of paragraphsDe) {
        y = drawPdfParagraphJustified(
          page,
          para,
          PDF_BODY_X,
          y,
          introLineH,
          introW,
          font,
          introSize,
          introColor,
        )
      }
      y -= 2 * introLineH
      for (const para of paragraphsEn) {
        y = drawPdfParagraphJustified(
          page,
          para,
          PDF_BODY_X,
          y,
          introLineH,
          introW,
          font,
          introSize,
          introColor,
        )
      }
      headerRowY = y - 10
      firstDataRowY = headerRowY - 14
    } else {
      termY = PDF_TABLE_CONT.headerY + 52
      subY = PDF_TABLE_CONT.headerY + 34
      headerRowY = PDF_TABLE_CONT.headerY
      firstDataRowY = PDF_TABLE_CONT.firstRowY
      page.drawText('Terminübersicht/Appointment overview', {
        x: PDF_BODY_X,
        y: termY,
        size: 11,
        font: fontBold,
        color: rgb(0.15, 0.15, 0.15),
      })
      page.drawText(`${sub} · Fortsetzung`, {
        x: PDF_BODY_X,
        y: subY,
        size: 9,
        font,
        color: rgb(0.25, 0.25, 0.25),
      })
    }

    const cellW = PDF_COL_W - 2
    page.drawText('Datum/Date', {
      x: pdfColLeft(0),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })
    page.drawText('Uhrzeit/Time', {
      x: pdfColLeft(1),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })
    page.drawText('Raum/Room', {
      x: pdfColLeft(2),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })
    page.drawText('Termin/Appointment', {
      x: pdfColLeft(3),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })

    let rowY = firstDataRowY
    for (const r of chunk) {
      if (rowY < 72) break
      const dStr = parseDateKey(r.dk).toLocaleDateString('de-DE', {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
      const tStr = `${slotIndexToLabel(r.startSlot)}–${slotEndTimeLabelExclusive(r.endSlot)}`
      const nameLine = `${patient.name}${patient.patientCode.trim() ? ` (${patient.patientCode})` : ''}`
      const artLine = (r.artLabel || '—').trim() || '—'
      const staffLine = (r.staffLabel || '—').trim() || '—'
      page.drawText(truncatePdfLineToWidth(dStr, font, 8, cellW), {
        x: pdfColLeft(0),
        y: rowY,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      })
      page.drawText(truncatePdfLineToWidth(tStr, font, 8, cellW), {
        x: pdfColLeft(1),
        y: rowY,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      })
      page.drawText(truncatePdfLineToWidth(r.room, font, 8, cellW), {
        x: pdfColLeft(2),
        y: rowY,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      })
      drawPdfTerminThreeLines(
        page,
        pdfColLeft(3),
        rowY,
        nameLine,
        artLine,
        staffLine,
        font,
        PDF_TERM_STACK_FS,
        PDF_TERM_STACK_MAX_W,
        rgb(0, 0, 0),
      )
      rowY -= PDF_TERM_STACK_ROW_H
    }
  }

  const pdfBytes = await outDoc.save()
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileBase}.pdf`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function downloadStaffAppointmentsPdf(
  staff: MitarbeiterItem,
  rows: StaffAppointmentExportRow[],
  fileBase: string,
) {
  const templateUrl = '/BBI.pdf'
  let templateBytes: ArrayBuffer
  try {
    const res = await fetch(templateUrl)
    if (!res.ok) throw new Error(String(res.status))
    templateBytes = await res.arrayBuffer()
  } catch {
    alertOnce(
      'Die PDF-Vorlage konnte nicht geladen werden (BBI.pdf im Ordner public).',
    )
    return
  }

  const templateDoc = await PDFDocument.load(templateBytes)
  const outDoc = await PDFDocument.create()
  const font = await outDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold)

  const chunks: StaffAppointmentExportRow[][] = []
  for (let i = 0; i < rows.length; i += PDF_ROWS_STAFF_TERM_STACK_PAGE) {
    chunks.push(rows.slice(i, i + PDF_ROWS_STAFF_TERM_STACK_PAGE))
  }

  const subAll = `${staff.name} · ${rows.length} Termin${rows.length === 1 ? '' : 'e'}`

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const [embedded] = await outDoc.copyPages(templateDoc, [0])
    outDoc.addPage(embedded)
    const page = outDoc.getPage(outDoc.getPageCount() - 1)

    page.drawRectangle({
      x: PDF_TEMPLATE_BODY_MASK.x,
      y: PDF_TEMPLATE_BODY_MASK.y,
      width: PDF_TEMPLATE_BODY_MASK.width,
      height: PDF_TEMPLATE_BODY_MASK.height,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    })

    const termY = PDF_TABLE_CONT.headerY + 52
    const subY = PDF_TABLE_CONT.headerY + 34
    const headerRowY = PDF_TABLE_CONT.headerY
    const firstDataRowY = PDF_TABLE_CONT.firstRowY

    page.drawText('Terminübersicht Mitarbeiter', {
      x: PDF_BODY_X,
      y: termY,
      size: 11,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.15),
    })
    page.drawText(ci === 0 ? subAll : `${subAll} · Fortsetzung`, {
      x: PDF_BODY_X,
      y: subY,
      size: 9,
      font,
      color: rgb(0.25, 0.25, 0.25),
    })

    const staffCellW = PDF_COL_W - 2
    page.drawText('Datum/Date', {
      x: pdfColLeft(0),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })
    page.drawText('Uhrzeit/Time', {
      x: pdfColLeft(1),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })
    page.drawText('Raum/Room', {
      x: pdfColLeft(2),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })
    page.drawText('Termin/Appointment', {
      x: pdfColLeft(3),
      y: headerRowY,
      size: 8,
      font: fontBold,
      color: rgb(0, 0, 0),
    })

    let rowY = firstDataRowY
    for (const r of chunk) {
      if (rowY < 72) break
      const dStr = parseDateKey(r.dk).toLocaleDateString('de-DE', {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
      const tStr = `${slotIndexToLabel(r.startSlot)}–${slotEndTimeLabelExclusive(r.endSlot)}`
      const nameLine = (r.patientLabel || '—').trim() || '—'
      const artLine = (r.artLabel || '—').trim() || '—'
      const staffLine = staff.name.trim() || '—'
      page.drawText(truncatePdfLineToWidth(dStr, font, 8, staffCellW), {
        x: pdfColLeft(0),
        y: rowY,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      })
      page.drawText(truncatePdfLineToWidth(tStr, font, 8, staffCellW), {
        x: pdfColLeft(1),
        y: rowY,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      })
      page.drawText(truncatePdfLineToWidth(r.room, font, 8, staffCellW), {
        x: pdfColLeft(2),
        y: rowY,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      })
      drawPdfTerminThreeLines(
        page,
        pdfColLeft(3),
        rowY,
        nameLine,
        artLine,
        staffLine,
        font,
        PDF_TERM_STACK_FS,
        PDF_TERM_STACK_MAX_W,
        rgb(0, 0, 0),
      )
      rowY -= PDF_TERM_STACK_ROW_H
    }
  }

  const pdfBytes = await outDoc.save()
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileBase}.pdf`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function downloadRoomWeekLandscapePdf(
  cells: Record<string, CellData>,
  room: Room,
  fromDk: string,
  toDk: string,
  fileBase: string,
) {
  const weeks = listWeekMondaysBetween(fromDk, toDk)
  if (weeks.length === 0) {
    alertOnce('Kein gültiger Zeitraum.')
    return
  }

  const outDoc = await PDFDocument.create()
  const font = await outDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold)

  const W = 842
  const H = 595
  const M = 32
  const timeColW = 38
  const titleBlockH = 42
  const dayHeaderH = 20
  const slotsN = slotCount()
  const gridTop = H - M - titleBlockH - dayHeaderH
  const gridBottom = M
  const gridH = gridTop - gridBottom
  const slotH = gridH / slotsN
  const gridX0 = M + timeColW
  const gridW = W - 2 * M - timeColW
  const dayColW = gridW / 7
  const lineGray = rgb(0.78, 0.78, 0.82)
  const gridMuted = rgb(0.94, 0.94, 0.95)
  const textDark = rgb(0.12, 0.12, 0.14)

  for (let wi = 0; wi < weeks.length; wi++) {
    const weekMon = weeks[wi]
    const page = outDoc.addPage([W, H])
    const monD = parseDateKey(weekMon)
    const sunD = addDays(monD, 6)
    const title = `Raum ${room}`
    const subtitle = `${monD.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} – ${sunD.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}${weeks.length > 1 ? ` · Woche ${wi + 1}/${weeks.length}` : ''}`

    page.drawText(title, {
      x: M,
      y: H - M - 18,
      size: 14,
      font: fontBold,
      color: textDark,
    })
    page.drawText(subtitle, {
      x: M,
      y: H - M - 34,
      size: 8,
      font,
      color: rgb(0.38, 0.38, 0.42),
    })

    const dayHeaderBaseline = gridTop + 6

    for (let di = 0; di < 7; di++) {
      const dk = dateKey(addDays(monD, di))
      const colLeft = gridX0 + di * dayColW
      const label = parseDateKey(dk).toLocaleDateString('de-DE', {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
      })
      const lw = fontBold.widthOfTextAtSize(label, 8)
      page.drawText(label, {
        x: colLeft + (dayColW - lw) / 2,
        y: dayHeaderBaseline,
        size: 8,
        font: fontBold,
        color: textDark,
      })
      if (dk < fromDk || dk > toDk) {
        page.drawRectangle({
          x: colLeft + 0.5,
          y: gridBottom,
          width: dayColW - 1,
          height: gridTop - gridBottom,
          color: gridMuted,
          borderWidth: 0,
        })
      }
    }

    for (let sl = 0; sl <= slotsN; sl++) {
      const y = gridTop - sl * slotH
      page.drawLine({
        start: { x: M, y },
        end: { x: gridX0 + gridW, y },
        thickness: sl % 2 === 0 ? 0.6 : 0.25,
        color: lineGray,
      })
    }
    for (let di = 0; di <= 7; di++) {
      const x = gridX0 + di * dayColW
      page.drawLine({
        start: { x, y: gridBottom },
        end: { x, y: gridTop },
        thickness: 0.6,
        color: lineGray,
      })
    }
    page.drawLine({
      start: { x: M, y: gridBottom },
      end: { x: M, y: gridTop },
      thickness: 0.6,
      color: lineGray,
    })

    for (let sl = 0; sl < slotsN; sl += 2) {
      const lab = slotIndexToLabel(sl)
      const y = gridTop - sl * slotH - slotH * 0.35
      page.drawText(lab, {
        x: M + 2,
        y,
        size: 6,
        font,
        color: rgb(0.35, 0.35, 0.4),
      })
    }

    for (let di = 0; di < 7; di++) {
      const dk = dateKey(addDays(monD, di))
      if (dk < fromDk || dk > toDk) continue
      const colLeft = gridX0 + di * dayColW
      for (let sl = 0; sl < slotsN; sl++) {
        const seg = daySlotBlockSegment(cells, dk, room, sl, slotsN)
        if (seg !== 'start' && seg !== 'single') continue
        const anchor = cells[makeSlotKey(dk, room, sl)]
        if (!isCellBooked(anchor)) continue
        const { start, end } = findBlockBounds(cells, dk, room, sl)
        const topY = gridTop - start * slotH
        const bottomY = gridTop - (end + 1) * slotH
        const h = topY - bottomY
        const hex = cellAccentColor(anchor)
        const { r: rr, g: gg, b: bb } = pdfRgbFromHex(hex)
        const fill = rgb(0.7 + 0.3 * rr, 0.7 + 0.3 * gg, 0.7 + 0.3 * bb)
        page.drawRectangle({
          x: colLeft + 1.5,
          y: bottomY + 0.5,
          width: dayColW - 3,
          height: h - 1,
          color: fill,
          borderColor: rgb(0.45, 0.45, 0.5),
          borderWidth: 0.35,
        })
        const parts = cellTerminLabelParts(anchor)
        const l1 = parts.patient ?? '—'
        const l2 = parts.art ?? '—'
        const l3 =
          parts.staffName ??
          (anchor.artId === TEAM_MEETING_ART_ID
            ? 'Teilnehmer wählen'
            : 'Mitarbeiter zuteilen')
        const maxW = dayColW - 6
        const innerH = h - 4
        const topInsetFor = (f: number) => 6 + f * 0.45
        let fs = 5.5
        let lh = fs + 2
        while (fs > 3.75 && topInsetFor(fs) + 3 * lh > innerH) {
          fs -= 0.35
          lh = fs + 2
        }
        const topBaseline = topY - topInsetFor(fs)
        drawPdfTerminThreeLines(
          page,
          colLeft + 3,
          topBaseline,
          l1,
          l2,
          l3,
          font,
          fs,
          maxW,
          textDark,
        )
      }
    }
  }

  const pdfBytes = await outDoc.save()
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileBase}.pdf`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function safeIcsZipPathSegment(s: string, maxLen = 80): string {
  const t = s
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
  return t.length > maxLen ? t.slice(0, maxLen) : t
}

function buildSingleAppointmentIcsContent(
  patient: PatientItem,
  r: PatientAppointmentExportRow,
  dtStamp: string,
  eventUid: string,
): string {
  const dtStart = formatIcsLocalDateTime(r.dk, r.startSlot)
  const dtEnd = formatIcsLocalDateTimeEnd(r.dk, r.endSlot)
  const sum = `Termin: ${patient.name}`
  const descParts = [
    `Patient: ${patient.name}`,
    patient.patientCode.trim() ? `Patienten-ID: ${patient.patientCode}` : '',
    `Raum: ${r.room}`,
    `Behandler: ${r.staffLabel}`,
    r.artLabel?.trim() ? `Belegungsart: ${r.artLabel.trim()}` : 'Belegungsart: —',
  ].filter(Boolean)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Physioplanung//Patientexport//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${eventUid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscapeText(sum)}`,
    `DESCRIPTION:${icsEscapeText(descParts.join('\n'))}`,
    `LOCATION:${icsEscapeText(r.room)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n') + '\r\n'
}

function cellDataToPatientExportPair(
  cells: Record<string, CellData>,
  dk: string,
  room: Room,
  anchorSlot: number,
  staffList?: MitarbeiterItem[],
): { patient: PatientItem; row: PatientAppointmentExportRow } | null {
  const { start, end } = findBlockBounds(cells, dk, room, anchorSlot)
  const anchor = cells[makeSlotKey(dk, room, start)]
  if (!anchor || !isCellBooked(anchor)) return null
  let teamStaffLabel: string | undefined
  if (anchor.teamStaffIds?.length && staffList?.length) {
    const names = anchor.teamStaffIds
      .map((id) => staffList.find((s) => s.id === id)?.name)
      .filter(Boolean) as string[]
    if (names.length) teamStaffLabel = names.join(', ')
  }
  const patient: PatientItem = {
    id: 'ics-export',
    name:
      anchor.patient?.trim() ||
      (anchor.artId === TEAM_MEETING_ART_ID || teamStaffLabel
        ? 'Teammeeting'
        : 'Termin'),
    patientCode: anchor.patientCode?.trim() ?? '',
  }
  const row: PatientAppointmentExportRow = {
    dk,
    room,
    startSlot: start,
    endSlot: end,
    staffLabel: (teamStaffLabel ?? anchor.staff?.trim()) || '—',
    artLabel: anchor.art?.trim() || undefined,
  }
  return { patient, row }
}

function downloadSingleTerminIcsFile(
  patient: PatientItem,
  row: PatientAppointmentExportRow,
  fileBase: string,
) {
  const dtStamp = icsUtcStampNow()
  const uid = `physio-${row.dk}-s${row.startSlot}-ics-${row.room.replace(/\s+/g, '')}@physioplanung`
  const body = buildSingleAppointmentIcsContent(patient, row, dtStamp, uid)
  const blob = new Blob([body], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileBase}.ics`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function downloadPatientAppointmentsIcsZipFolder(
  patient: PatientItem,
  rows: PatientAppointmentExportRow[],
  fileBase: string,
) {
  const dtStamp = icsUtcStampNow()
  const zip = new JSZip()
  const folderLabel = safeIcsZipPathSegment(
    `${patient.name}_${patient.patientCode.trim() || 'Patient'}`,
    72,
  )
  const folder = zip.folder(`Termine_${folderLabel}`)
  if (!folder) return
  rows.forEach((r, i) => {
    const n = String(i + 1).padStart(3, '0')
    const uid = `physio-${r.dk}-s${r.startSlot}-${n}-${r.room.replace(/\s+/g, '')}@physioplanung`
    const fileName = `${safeIcsZipPathSegment(`termin-${n}-${r.dk}-${r.room}`, 100)}.ics`
    const body = buildSingleAppointmentIcsContent(patient, r, dtStamp, uid)
    folder.file(fileName, body)
  })
  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileBase}-termine-ics.zip`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function bookingsForDayRoom(
  cells: Record<string, CellData>,
  dk: string,
  room: string,
): number[] {
  const n = slotCount()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const k = makeSlotKey(dk, room, i)
    if (isCellBooked(cells[k])) out.push(i)
  }
  return out
}

function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6)
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  const a = weekStart.toLocaleDateString('de-DE', opts)
  const b = end.toLocaleDateString('de-DE', { ...opts, year: 'numeric' })
  return `${a} – ${b}`
}

function isRoomString(x: unknown): x is Room {
  return typeof x === 'string' && (ROOMS as readonly string[]).includes(x)
}

/** Fiktiver Start (1970) für Muster-Editor: aufeinanderfolgende Tage wie im Plan */
const MUSTER_TEMPLATE_MONDAY = calendarDate(new Date(1970, 0, 5))
const MUSTER_TEMPLATE_WEEK_COUNT = 3
const MUSTER_TEMPLATE_DAY_COUNT = MUSTER_TEMPLATE_WEEK_COUNT * 7

function effectiveMusterTemplateWeekCount(m: BelegungsmusterItem): number {
  return m.templateWeekCount === 1 ? 1 : MUSTER_TEMPLATE_WEEK_COUNT
}

function templateDkForDayIndex(dayIndex: number): string {
  return dateKey(addDays(MUSTER_TEMPLATE_MONDAY, dayIndex))
}

function templateWeekAndDayFromDk(
  dk: string,
): { weekIndex: number; wd: number } | null {
  for (let i = 0; i < MUSTER_TEMPLATE_DAY_COUNT; i++) {
    if (templateDkForDayIndex(i) === dk) {
      return { weekIndex: Math.floor(i / 7), wd: i % 7 }
    }
  }
  return null
}

function parseMusterTemplateKey(
  key: string,
): { weekIndex: number; wd: number; room: Room; slot: number } | null {
  const parts = key.split('|')
  const n = slotCount()
  if (parts.length === 4) {
    const weekIndex = Number(parts[0])
    const wd = Number(parts[1])
    const room = parts[2] as Room
    const slot = Number(parts[3])
    if (
      !Number.isInteger(weekIndex) ||
      weekIndex < 0 ||
      weekIndex >= MUSTER_TEMPLATE_WEEK_COUNT
    ) {
      return null
    }
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null
    if (!isRoomString(room) || !Number.isInteger(slot) || slot < 0 || slot >= n) {
      return null
    }
    return { weekIndex, wd, room, slot }
  }
  if (parts.length === 3) {
    const wd = Number(parts[0])
    const room = parts[1] as Room
    const slot = Number(parts[2])
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null
    if (!isRoomString(room) || !Number.isInteger(slot) || slot < 0 || slot >= n) {
      return null
    }
    return { weekIndex: 0, wd, room, slot }
  }
  return null
}

function musterTemplateToVirtual(
  tpl: Record<string, MusterTemplateCell>,
): Record<string, CellData> {
  const out: Record<string, CellData> = {}
  for (const [key, cell] of Object.entries(tpl)) {
    const p = parseMusterTemplateKey(key)
    if (!p) continue
    const dayIndex = p.weekIndex * 7 + p.wd
    const dk = templateDkForDayIndex(dayIndex)
    out[makeSlotKey(dk, p.room, p.slot)] = { ...cell }
  }
  return out
}

function virtualToMusterTemplate(
  virt: Record<string, CellData>,
): Record<string, MusterTemplateCell> {
  const out: Record<string, MusterTemplateCell> = {}
  for (const [fullKey, data] of Object.entries(virt)) {
    const parts = fullKey.split('|')
    if (parts.length < 3) continue
    const dk = parts[0]
    const slot = Number(parts[parts.length - 1])
    const room = parts[parts.length - 2] as Room
    const pos = templateWeekAndDayFromDk(dk)
    if (pos === null || !isRoomString(room)) continue
    if (!data.art && !data.artId) continue
    out[`${pos.weekIndex}|${pos.wd}|${room}|${slot}`] = {
      art: data.art,
      artId: data.artId,
      artColor: data.artColor,
    }
  }
  return out
}

/** OP nur zur Markierung im Muster-Editor — nicht in den Hauptkalender übernehmen. */
function musterBlockIsOpOnly(
  cells: CellData[],
  artenList: BelegungsartItem[],
): boolean {
  const probe = cells[0]
  if (!probe) return false
  const id = probe.artId ?? findArtIdForCell(probe, artenList)
  return id === OP_BELEGUNGSART_ID
}

function musterBlockIsPauseOnly(cells: CellData[]): boolean {
  const probe = cells[0]
  if (!probe) return false
  return probe.artId === MUSTER_PAUSE_ART_ID
}

/** Alle Katalog-Belegungsarten mit Slot-Anzahl im Muster; fehlende = 0. OP nicht enthalten; je id nur einmal. */
function musterTemplateArtSlotCountsFullCatalog(
  templateCells: Record<string, MusterTemplateCell>,
  artenList: BelegungsartItem[],
): { id: string; label: string; count: number; color: string }[] {
  const map = new Map<string, number>()
  for (const cell of Object.values(templateCells)) {
    if (!cell.art?.trim() && !cell.artId) continue
    const id =
      cell.artId ??
      artenList.find((a) => a.label === cell.art)?.id ??
      null
    if (!id || id === OP_BELEGUNGSART_ID || id === MUSTER_PAUSE_ART_ID) continue
    map.set(id, (map.get(id) ?? 0) + 1)
  }
  const seen = new Set<string>()
  const out: { id: string; label: string; count: number; color: string }[] = []
  for (const a of artenList) {
    if (a.id === OP_BELEGUNGSART_ID) continue
    if (a.id === MUSTER_PAUSE_ART_ID) continue
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push({
      id: a.id,
      label: a.label,
      color: a.color,
      count: map.get(a.id) ?? 0,
    })
  }
  return out
}

function tryApplyMusterWeekToSlots(
  prev: Record<string, CellData>,
  weekStart: Date,
  templateCells: Record<string, MusterTemplateCell>,
  artenList: BelegungsartItem[],
  templateWeekCount: number,
  musterStamp: MusterApplyStamp | null,
): { next: Record<string, CellData> } | { error: string } {
  const virt = musterTemplateToVirtual(templateCells)
  const seen = new Set<string>()
  type Op = { targetKeys: string[]; cells: CellData[] }
  const ops: Op[] = []
  const max = slotCount()
  const dayCount = templateWeekCount * 7

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const vdk = templateDkForDayIndex(dayIndex)
    for (const room of ROOMS) {
      for (let sl = 0; sl < max; sl++) {
        const k = makeSlotKey(vdk, room, sl)
        const d = virt[k]
        if (!isCellBooked(d)) continue
        if (seen.has(k)) continue
        const { start, end } = findBlockBounds(virt, vdk, room, sl)
        const tDk = dateKey(addDays(weekStart, dayIndex))
        const cells: CellData[] = []
        const targetKeys: string[] = []
        for (let s = start; s <= end; s++) {
          const vk = makeSlotKey(vdk, room, s)
          seen.add(vk)
          cells.push({ ...virt[vk]! })
          targetKeys.push(makeSlotKey(tDk, room, s))
        }
        if (
          musterBlockIsOpOnly(cells, artenList) ||
          musterBlockIsPauseOnly(cells)
        ) {
          continue
        }
        ops.push({ targetKeys, cells })
      }
    }
  }

  const next = { ...prev }
  const reserved = new Set<string>()
  const remappedOps: { targetKeys: string[]; cells: CellData[] }[] = []

  for (const op of ops) {
    const firstK = op.targetKeys[0]!
    const parts = firstK.split('|')
    const tDk = parts[0]!
    const room = parts[parts.length - 2] as Room
    const startSlot = Number(parts[parts.length - 1])
    const span = op.cells.length
    const placedKeys = findAutoMusterSpanForTryApply(
      next,
      reserved,
      tDk,
      room,
      startSlot,
      span,
    )
    if (placedKeys === null) {
      return {
        error:
          'Kein freier Bereich außerhalb der Mittagspause (12:00–13:30) für ein automatisches Muster-Platzieren.',
      }
    }
    remappedOps.push({ targetKeys: placedKeys, cells: op.cells })
    for (const tk of placedKeys) {
      reserved.add(tk)
    }
  }

  for (const op of remappedOps) {
    for (const tk of op.targetKeys) {
      if (isCellBooked(next[tk])) {
        return {
          error:
            templateWeekCount === 1
              ? 'In der Zielwoche sind Zellen bereits belegt. Bitte freie Bereiche wählen oder Zellen leeren.'
              : 'In den Zielwochen des Musters sind Zellen bereits belegt. Bitte freie Bereiche wählen oder Zellen leeren.',
        }
      }
    }
  }
  for (const op of remappedOps) {
    for (let i = 0; i < op.targetKeys.length; i++) {
      const src = op.cells[i]!
      const placed: CellData = { ...src }
      if (musterStamp) {
        placed.muster = musterStamp.label
        const ac = src.artColor
        if (ac) placed.musterColor = ac
      }
      next[op.targetKeys[i]] = placed
    }
  }
  return { next }
}

/** Automatisches Muster: Spanne ohne Überschneidung mit Pause; bei Konflikt nächstbeste Lage (nächster Termin oft nach 13:30). */
function findAutoMusterSpanForTryApply(
  base: Record<string, CellData>,
  reserved: Set<string>,
  tDk: string,
  room: Room,
  idealStart: number,
  span: number,
): string[] | null {
  const max = slotCount()
  const isFree = (s: number) => {
    if (s < 0 || s + span > max) return false
    if (slotRangeOverlapsMusterPause(s, span)) return false
    for (let i = 0; i < span; i++) {
      const k = makeSlotKey(tDk, room, s + i)
      if (isCellBooked(base[k])) return false
      if (reserved.has(k)) return false
    }
    return true
  }
  if (isFree(idealStart)) {
    return Array.from({ length: span }, (_, i) =>
      makeSlotKey(tDk, room, idealStart + i),
    )
  }
  const candidates: number[] = []
  for (let s = 0; s + span <= max; s++) {
    if (isFree(s)) candidates.push(s)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => Math.abs(a - idealStart) - Math.abs(b - idealStart))
  const s = candidates[0]!
  return Array.from({ length: span }, (_, i) =>
    makeSlotKey(tDk, room, s + i),
  )
}

function rangeFullyFree(
  cells: Record<string, CellData>,
  tDk: string,
  room: Room,
  start: number,
  span: number,
  respectLunchPause = false,
): boolean {
  const max = slotCount()
  if (start < 0 || start + span > max) return false
  for (let i = 0; i < span; i++) {
    const slot = start + i
    if (respectLunchPause && slotIndexInCalendarLunchPause(slot)) return false
    if (isCellBooked(cells[makeSlotKey(tDk, room, slot)])) return false
  }
  return true
}

/** Nächster freier Bereich direkt vor/nach dem blockierenden Termin (Schnitt mit Idealfenster). */
function findSlotBesideConflict(
  cells: Record<string, CellData>,
  tDk: string,
  room: Room,
  span: number,
  idealStart: number,
  respectLunchPause: boolean,
): number | null {
  const max = slotCount()
  if (rangeFullyFree(cells, tDk, room, idealStart, span, respectLunchPause)) {
    return idealStart
  }

  let firstOcc = -1
  for (let i = 0; i < span && idealStart + i < max; i++) {
    const slot = idealStart + i
    if (
      respectLunchPause &&
      slotIndexInCalendarLunchPause(slot)
    ) {
      firstOcc = slot
      break
    }
    if (isCellBooked(cells[makeSlotKey(tDk, room, slot)])) {
      firstOcc = slot
      break
    }
  }
  if (firstOcc < 0) return null
  const { start: bs, end: be } = findBlockBounds(cells, tDk, room, firstOcc)

  const candidates: number[] = []
  for (let s = be + 1; s + span <= max; s++) {
    if (rangeFullyFree(cells, tDk, room, s, span, respectLunchPause)) {
      candidates.push(s)
    }
  }
  for (let s = bs - span; s >= 0; s--) {
    if (rangeFullyFree(cells, tDk, room, s, span, respectLunchPause)) {
      candidates.push(s)
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => Math.abs(a - idealStart) - Math.abs(b - idealStart))
  return candidates[0]!
}

function findFreeSpanWaveSameRoom(
  cells: Record<string, CellData>,
  tDk: string,
  room: Room,
  span: number,
  idealStart: number,
  respectLunchPause: boolean,
): number | null {
  const max = slotCount()
  if (span > max) return null
  if (rangeFullyFree(cells, tDk, room, idealStart, span, respectLunchPause)) {
    return idealStart
  }
  const maxDist = Math.max(idealStart + 1, max - span - idealStart) + max
  for (let d = 1; d <= maxDist; d++) {
    const left = idealStart - d
    if (
      left >= 0 &&
      rangeFullyFree(cells, tDk, room, left, span, respectLunchPause)
    ) {
      return left
    }
    const right = idealStart + d
    if (
      right + span <= max &&
      rangeFullyFree(cells, tDk, room, right, span, respectLunchPause)
    ) {
      return right
    }
  }
  return null
}

function findFreeSpanAnyRoom(
  cells: Record<string, CellData>,
  tDk: string,
  span: number,
  preferRoom: Room,
  respectLunchPause: boolean,
): { room: Room; start: number } | null {
  const max = slotCount()
  if (span > max) return null
  const order: Room[] = [preferRoom, ...ROOMS.filter((r) => r !== preferRoom)]
  for (const r of order) {
    for (let s = 0; s + span <= max; s++) {
      if (rangeFullyFree(cells, tDk, r, s, span, respectLunchPause)) {
        return { room: r, start: s }
      }
    }
  }
  return null
}

/** Erzwungene Lage: möglichst direkt nach/vor dem Konfliktblock (Muster-Raum). */
function pickCollisionPlacement(
  cells: Record<string, CellData>,
  tDk: string,
  room: Room,
  span: number,
  idealStart: number,
  respectLunchPause: boolean,
): { room: Room; start: number } {
  const max = slotCount()
  const clampStart = (s: number) =>
    Math.max(0, Math.min(s, Math.max(0, max - span)))

  if (rangeFullyFree(cells, tDk, room, idealStart, span, respectLunchPause)) {
    return { room, start: idealStart }
  }

  let probe = idealStart
  while (probe < max) {
    if (respectLunchPause && slotIndexInCalendarLunchPause(probe)) break
    if (isCellBooked(cells[makeSlotKey(tDk, room, probe)])) break
    probe++
  }
  if (probe >= max) {
    return { room, start: clampStart(idealStart) }
  }
  const { start: bs, end: be } = findBlockBounds(cells, tDk, room, probe)
  if (
    be + 1 + span <= max &&
    rangeFullyFree(cells, tDk, room, be + 1, span, respectLunchPause)
  ) {
    return { room, start: be + 1 }
  }
  if (
    bs - span >= 0 &&
    rangeFullyFree(cells, tDk, room, bs - span, span, respectLunchPause)
  ) {
    return { room, start: bs - span }
  }
  return { room, start: clampStart(be + 1) }
}

function staffAllowsMusterPlacement(
  templateCells: CellData[],
  start: number,
  tDk: string,
  wd: number,
  artenList: BelegungsartItem[],
  staffList: MitarbeiterItem[],
): boolean {
  for (let i = 0; i < templateCells.length; i++) {
    const tpl = templateCells[i]!
    const st = findStaffForCell(tpl, staffList)
    if (!st) continue
    const slotIdx = start + i
    if (!isStaffSlotAvailableForDate(st, tDk, wd, slotIdx)) return false
    const artId = findArtIdForCell(tpl, artenList)
    if (artId && !st.allowedArtIds.includes(artId)) return false
  }
  return true
}

type MusterApplyStamp = { label: string }

function mergePatientIntoMusterCell(
  tpl: CellData,
  patientName: string,
  patientCode: string | undefined,
  terminKollision: boolean,
  musterStamp: MusterApplyStamp | null,
): CellData {
  const out: CellData = { ...tpl }
  if (patientName?.trim()) {
    out.patient = patientName
    out.patientCode = patientCode
  } else {
    delete out.patient
    delete out.patientCode
  }
  if (terminKollision) out.terminKollision = true
  else delete out.terminKollision
  if (musterStamp) {
    out.muster = musterStamp.label
    const ac = tpl.artColor
    if (ac) out.musterColor = ac
  }
  return out
}

/** Muster auf Kalender mit Anker-Patient: Anker-Termin wird entfernt, dann freie Slots / Ausweichlage / Kollision (rot). */
function applyMusterWithPatientWeek(
  prev: Record<string, CellData>,
  weekStart: Date,
  templateCells: Record<string, MusterTemplateCell>,
  patientName: string,
  patientCode: string | undefined,
  artenList: BelegungsartItem[],
  staffList: MitarbeiterItem[],
  clearAnchor: { dk: string; room: Room; slotIndex: number },
  templateWeekCount: number,
  musterStamp: MusterApplyStamp | null,
): Record<string, CellData> {
  const virt = musterTemplateToVirtual(templateCells)
  const seen = new Set<string>()
  type Op = {
    tDk: string
    wd: number
    templateRoom: Room
    idealStart: number
    cells: CellData[]
  }
  const ops: Op[] = []
  const max = slotCount()
  const dayCount = templateWeekCount * 7

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const vdk = templateDkForDayIndex(dayIndex)
    const tDk = dateKey(addDays(weekStart, dayIndex))
    const wd = weekdayMon0FromDate(parseDateKey(tDk))
    for (const room of ROOMS) {
      for (let sl = 0; sl < max; sl++) {
        const k = makeSlotKey(vdk, room, sl)
        const d = virt[k]
        if (!isCellBooked(d)) continue
        if (seen.has(k)) continue
        const { start, end } = findBlockBounds(virt, vdk, room, sl)
        const cells: CellData[] = []
        for (let s = start; s <= end; s++) {
          const vk = makeSlotKey(vdk, room, s)
          seen.add(vk)
          cells.push({ ...virt[vk]! })
        }
        if (
          musterBlockIsOpOnly(cells, artenList) ||
          musterBlockIsPauseOnly(cells)
        ) {
          continue
        }
        ops.push({ tDk, wd, templateRoom: room, idealStart: start, cells })
      }
    }
  }

  const next = { ...prev }
  const { start: anchorStart, end: anchorEnd } = findBlockBounds(
    next,
    clearAnchor.dk,
    clearAnchor.room,
    clearAnchor.slotIndex,
  )
  for (let s = anchorStart; s <= anchorEnd; s++) {
    delete next[makeSlotKey(clearAnchor.dk, clearAnchor.room, s)]
  }

  for (const op of ops) {
    const span = op.cells.length
    const { tDk, wd, templateRoom: tr, idealStart } = op

    let chosenRoom: Room = tr
    let chosenStart: number
    let collision: boolean

    if (rangeFullyFree(next, tDk, tr, idealStart, span, true)) {
      chosenStart = idealStart
      collision = false
    } else {
      const beside = findSlotBesideConflict(
        next,
        tDk,
        tr,
        span,
        idealStart,
        true,
      )
      if (beside !== null) {
        chosenStart = beside
        collision = false
      } else {
        const wave = findFreeSpanWaveSameRoom(
          next,
          tDk,
          tr,
          span,
          idealStart,
          true,
        )
        if (wave !== null) {
          chosenStart = wave
          collision = false
        } else {
          const anyR = findFreeSpanAnyRoom(next, tDk, span, tr, true)
          if (anyR) {
            chosenRoom = anyR.room
            chosenStart = anyR.start
            collision = false
          } else {
            const col = pickCollisionPlacement(
              next,
              tDk,
              tr,
              span,
              idealStart,
              true,
            )
            chosenRoom = col.room
            chosenStart = col.start
            collision = true
          }
        }
      }
    }

    if (
      !collision &&
      !staffAllowsMusterPlacement(
        op.cells,
        chosenStart,
        tDk,
        wd,
        artenList,
        staffList,
      )
    ) {
      const col = pickCollisionPlacement(
        next,
        tDk,
        tr,
        span,
        idealStart,
        true,
      )
      chosenRoom = col.room
      chosenStart = col.start
      collision = true
    }

    for (let i = 0; i < span; i++) {
      delete next[makeSlotKey(tDk, chosenRoom, chosenStart + i)]
    }
    for (let i = 0; i < span; i++) {
      next[makeSlotKey(tDk, chosenRoom, chosenStart + i)] =
        mergePatientIntoMusterCell(
          op.cells[i]!,
          patientName,
          patientCode,
          collision,
          musterStamp,
        )
    }
  }

  return next
}

/** Muster-Editor: Arten beliebig platzieren — überlappende reine Art-Termine werden ersetzt. */
function applyArtDropNoPatient(
  prev: Record<string, CellData>,
  dk: string,
  room: Room,
  startSlot: number,
  a: BelegungsartItem,
): Record<string, CellData> | null {
  const max = slotCount()
  const span = Math.min(Math.max(1, a.slots), max - startSlot)
  if (slotRangeOverlapsMusterPause(startSlot, span)) {
    alertOnce(
      'Zwischen 12:00 und 13:30 ist Pause — hier kann keine Belegungsart liegen.',
    )
    return null
  }
  const next = { ...prev }

  for (let i = 0; i < span; i++) {
    const k = makeSlotKey(dk, room, startSlot + i)
    const c = next[k]
    if (c?.patient?.trim() || c?.staff?.trim()) {
      alertOnce(
        'Im Muster sind nur Belegungsarten ohne Patient/Mitarbeiter vorgesehen.',
      )
      return null
    }
  }

  let cleared = true
  while (cleared) {
    cleared = false
    for (let i = 0; i < span; i++) {
      const sl = startSlot + i
      const k = makeSlotKey(dk, room, sl)
      if (!isCellBooked(next[k])) continue
      const { start, end } = findBlockBounds(next, dk, room, sl)
      for (let s = start; s <= end; s++) {
        delete next[makeSlotKey(dk, room, s)]
      }
      cleared = true
      break
    }
  }

  for (let i = 0; i < span; i++) {
    const k = makeSlotKey(dk, room, startSlot + i)
    if (isCellBooked(next[k])) {
      alertOnce(
        'Der Bereich kollidiert nach dem Freiräumen noch mit einem Termin.',
      )
      return null
    }
  }

  for (let i = 0; i < span; i++) {
    const k = makeSlotKey(dk, room, startSlot + i)
    next[k] = { art: a.label, artId: a.id, artColor: a.color }
  }
  return next
}

function cellMapApplyMove(
  prev: Record<string, CellData>,
  fromDk: string,
  fromRoom: Room,
  fromSlot: number,
  toDk: string,
  toRoom: Room,
  toStartSlot: number,
  arten: BelegungsartItem[],
  mitarbeiter: MitarbeiterItem[],
  options?: { blockLunchPauseAsMoveTarget?: boolean },
): Record<string, CellData> | null {
  const max = slotCount()
  const { start, end } = findBlockBounds(prev, fromDk, fromRoom, fromSlot)
  const startK = makeSlotKey(fromDk, fromRoom, start)
  if (!isCellBooked(prev[startK])) return prev

  if (musterBlockIsPauseOnly([prev[startK]!])) {
    alertOnce('Die Pause lässt sich nicht verschieben.')
    return null
  }

  const len = end - start + 1
  if (toStartSlot < 0 || toStartSlot + len > max) {
    alertOnce('Termin passt an diese Position nicht (Tagesende).')
    return null
  }

  if (
    options?.blockLunchPauseAsMoveTarget &&
    slotRangeOverlapsMusterPause(toStartSlot, len)
  ) {
    alertOnce(
      'In der Pausenzeit (12:00–13:30) kann keine Belegungsart liegen.',
    )
    return null
  }

  const sourceKeys = Array.from({ length: len }, (_, i) =>
    makeSlotKey(fromDk, fromRoom, start + i),
  )
  const sourceSet = new Set(sourceKeys)
  const snapshot: CellData[] = sourceKeys.map((sk) => ({ ...prev[sk] }))

  const wdTo = weekdayMon0FromDate(parseDateKey(toDk))

  for (let i = 0; i < len; i++) {
    const tk = makeSlotKey(toDk, toRoom, toStartSlot + i)
    if (sourceSet.has(tk)) continue
    const occ = prev[tk]
    if (isCellBooked(occ)) {
      alertOnce('Zielbereich ist belegt.')
      return null
    }
    const cell = snapshot[i]
    const teamIds = cell.teamStaffIds
    if (teamIds?.length) {
      const artId = findArtIdForCell(cell, arten)
      for (const tid of teamIds) {
        const st = mitarbeiter.find((x) => x.id === tid)
        if (!st) continue
        if (isStaffAbsentAtSlot(st, toDk, toStartSlot + i)) {
          alertOnce(
            'Ein Teamteilnehmer ist in diesem Zeitraum als abwesend (Urlaub/Abwesenheit) eingetragen.',
          )
          return null
        }
        if (!isStaffSlotAvailable(st, wdTo, toStartSlot + i, toDk)) {
          alertOnce(
            'Ein Teamteilnehmer ist zu dieser Zeit in seinem Wochenplan nicht verfügbar.',
          )
          return null
        }
        if (artId && !st.allowedArtIds.includes(artId)) {
          alertOnce(
            'Die Belegungsart ist für einen Teamteilnehmer in seinem Profil nicht freigegeben.',
          )
          return null
        }
      }
    } else {
      const st = findStaffForCell(cell, mitarbeiter)
      if (st) {
        if (isStaffAbsentAtSlot(st, toDk, toStartSlot + i)) {
          alertOnce(
            'Der Mitarbeiter ist in diesem Zeitraum als abwesend (Urlaub/Abwesenheit) eingetragen.',
          )
          return null
        }
        if (!isStaffSlotAvailable(st, wdTo, toStartSlot + i, toDk)) {
          alertOnce(
            'Zu dieser Zeit ist der Mitarbeiter in seinem Wochenplan nicht verfügbar.',
          )
          return null
        }
        const artId = findArtIdForCell(cell, arten)
        if (artId && !st.allowedArtIds.includes(artId)) {
          alertOnce(
            'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.',
          )
          return null
        }
      }
    }
  }

  const next = { ...prev }
  const clearKeys = new Set<string>()
  for (const sk of sourceKeys) clearKeys.add(sk)
  for (let i = 0; i < len; i++) {
    clearKeys.add(makeSlotKey(toDk, toRoom, toStartSlot + i))
  }
  for (const ck of clearKeys) {
    delete next[ck]
  }
  for (let i = 0; i < len; i++) {
    const tk = makeSlotKey(toDk, toRoom, toStartSlot + i)
    next[tk] = { ...snapshot[i] }
  }
  return next
}

function cellMapApplyResize(
  prev: Record<string, CellData>,
  dropDk: string,
  dropRoom: Room,
  targetSlot: number,
  payload: {
    fromDk: string
    fromRoom: Room
    edge: 'top' | 'bottom'
    anchorSlot: number
  },
  arten: BelegungsartItem[],
  mitarbeiter: MitarbeiterItem[],
): Record<string, CellData> | null {
  const { start, end } = findBlockBounds(
    prev,
    payload.fromDk,
    payload.fromRoom,
    payload.anchorSlot,
  )
  const startK = makeSlotKey(payload.fromDk, payload.fromRoom, start)
  if (!isCellBooked(prev[startK])) return prev

  if (isMusterPauseCell(prev[startK])) {
    alertOnce('Die Pause lässt sich nicht in der Dauer ändern.')
    return null
  }

  if (dropDk !== payload.fromDk || dropRoom !== payload.fromRoom) {
    alertOnce(
      'Die Dauer kann nur am selben Tag und im selben Raum geändert werden.',
    )
    return null
  }

  const wd = weekdayMon0FromDate(parseDateKey(payload.fromDk))
  const template = { ...prev[startK] }

  if (payload.edge === 'bottom') {
    if (targetSlot < start) {
      alertOnce('Ungültige Position.')
      return null
    }
    if (targetSlot > end) {
      for (let s = end + 1; s <= targetSlot; s++) {
        const err = extensionSlotError(
          prev,
          payload.fromDk,
          payload.fromRoom,
          s,
          template,
          wd,
          arten,
          mitarbeiter,
        )
        if (err) {
          alertOnce(err)
          return null
        }
      }
      const next = { ...prev }
      for (let s = end + 1; s <= targetSlot; s++) {
        next[makeSlotKey(payload.fromDk, payload.fromRoom, s)] = {
          ...template,
        }
      }
      return next
    }
    if (targetSlot < end) {
      const next = { ...prev }
      for (let s = targetSlot + 1; s <= end; s++) {
        delete next[makeSlotKey(payload.fromDk, payload.fromRoom, s)]
      }
      return next
    }
    return prev
  }

  if (payload.edge === 'top') {
    if (targetSlot > end) {
      alertOnce('Ungültige Position.')
      return null
    }
    if (targetSlot < start) {
      for (let s = targetSlot; s < start; s++) {
        const err = extensionSlotError(
          prev,
          payload.fromDk,
          payload.fromRoom,
          s,
          template,
          wd,
          arten,
          mitarbeiter,
        )
        if (err) {
          alertOnce(err)
          return null
        }
      }
      const next = { ...prev }
      for (let s = targetSlot; s < start; s++) {
        next[makeSlotKey(payload.fromDk, payload.fromRoom, s)] = {
          ...template,
        }
      }
      return next
    }
    if (targetSlot > start) {
      const next = { ...prev }
      for (let s = start; s < targetSlot; s++) {
        delete next[makeSlotKey(payload.fromDk, payload.fromRoom, s)]
      }
      return next
    }
    return prev
  }

  return prev
}

function normalizeMusterItem(raw: unknown): BelegungsmusterItem {
  const r = raw as {
    id?: string
    label?: string
    templateCells?: Record<string, MusterTemplateCell>
    templateWeekCount?: unknown
  }
  if (!r || typeof r.id !== 'string' || typeof r.label !== 'string') {
    return {
      id: `muster-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      label: 'Muster',
      templateCells: {},
    }
  }
  const tw =
    r.templateWeekCount === 1 || r.templateWeekCount === 3
      ? r.templateWeekCount
      : undefined
  if (r.templateCells && typeof r.templateCells === 'object') {
    return {
      id: r.id,
      label: r.label,
      templateCells: { ...r.templateCells },
      ...(tw !== undefined ? { templateWeekCount: tw } : {}),
    }
  }
  return {
    id: r.id,
    label: r.label,
    templateCells: {},
    ...(tw !== undefined ? { templateWeekCount: tw } : {}),
  }
}

/** Fehlende Standard-Muster nachziehen (z. B. nach Update), sofern Belegungsart OP existiert */
function ensureOberschenkelOpMusterPreset(
  list: BelegungsmusterItem[],
  artenList: BelegungsartItem[],
): BelegungsmusterItem[] {
  const opArt = artenList.find((a) => a.id === OP_BELEGUNGSART_ID)
  if (!opArt) return list
  const prefix: BelegungsmusterItem[] = []
  if (!list.some((m) => m.id === 'muster-oberschenkel-op-dienstag')) {
    prefix.push({
      id: 'muster-oberschenkel-op-dienstag',
      label: 'Oberschenkelverlängerung OP Tag Dienstag',
      templateCells: buildOberschenkelOpWeekdayTemplate(opArt, 1),
    })
  }
  if (!list.some((m) => m.id === 'muster-unterschenkel-op-dienstag')) {
    prefix.push({
      id: 'muster-unterschenkel-op-dienstag',
      label: 'Unterschenkelverlängerung OP Tag Dienstag',
      templateCells: buildOberschenkelOpWeekdayTemplate(opArt, 1),
    })
  }
  if (!list.some((m) => m.id === 'muster-oberschenkel-op-mittwoch')) {
    prefix.push({
      id: 'muster-oberschenkel-op-mittwoch',
      label: 'Oberschenkelverlängerung OP Tag Mittwoch',
      templateCells: buildOberschenkelOpWeekdayTemplate(opArt, 2),
    })
  }
  if (!list.some((m) => m.id === 'muster-unterschenkel-op-mittwoch')) {
    prefix.push({
      id: 'muster-unterschenkel-op-mittwoch',
      label: 'Unterschenkelverlängerung OP Tag Mittwoch',
      templateCells: buildOberschenkelOpWeekdayTemplate(opArt, 2),
    })
  }
  if (!list.some((m) => m.id === 'muster-oberschenkel-op-freitag')) {
    prefix.push({
      id: 'muster-oberschenkel-op-freitag',
      label: 'Oberschenkelverlängerung OP Tag Freitag',
      templateCells: buildOberschenkelOpWeekdayTemplate(opArt, 4, 4),
    })
  }
  return prefix.length > 0 ? [...prefix, ...list] : list
}

function ensureVerlaengerungswocheMusterPreset(
  list: BelegungsmusterItem[],
): BelegungsmusterItem[] {
  if (list.some((m) => m.id === 'muster-verlaengerungswoche')) return list
  const entry: BelegungsmusterItem = {
    id: 'muster-verlaengerungswoche',
    label: 'Verlängerungswoche',
    templateCells: {},
    templateWeekCount: 1,
  }
  const m1Idx = list.findIndex((m) => m.id === 'm1')
  if (m1Idx >= 0) {
    return [...list.slice(0, m1Idx), entry, ...list.slice(m1Idx)]
  }
  return [...list, entry]
}

function parseDragPayload(dt: DataTransfer): DragPayload | null {
  try {
    const raw = dt.getData(MIME_PHYSIO) || dt.getData('text/plain')
    if (!raw) return null
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object' || typeof o.kind !== 'string') return null
    if (o.kind === 'moveBlock') {
      const fromDk = o.fromDk
      const fromRoom = o.fromRoom
      const fromSlot = o.fromSlot
      if (
        typeof fromDk !== 'string' ||
        !isRoomString(fromRoom) ||
        typeof fromSlot !== 'number' ||
        !Number.isInteger(fromSlot) ||
        fromSlot < 0 ||
        fromSlot >= slotCount()
      ) {
        return null
      }
      return { kind: 'moveBlock', fromDk, fromRoom, fromSlot }
    }
    if (o.kind === 'resizeBlock') {
      const fromDk = o.fromDk
      const fromRoom = o.fromRoom
      const edge = o.edge
      const anchorSlot = o.anchorSlot
      if (
        typeof fromDk !== 'string' ||
        !isRoomString(fromRoom) ||
        (edge !== 'top' && edge !== 'bottom') ||
        typeof anchorSlot !== 'number' ||
        !Number.isInteger(anchorSlot) ||
        anchorSlot < 0 ||
        anchorSlot >= slotCount()
      ) {
        return null
      }
      return { kind: 'resizeBlock', fromDk, fromRoom, edge, anchorSlot }
    }
    return o as DragPayload
  } catch {
    return null
  }
}

function cellTerminLabelParts(
  data: CellData | undefined,
  staffList?: MitarbeiterItem[],
): {
  patient: string | null
  art: string | null
  staffName: string | null
  notiz: string | null
} {
  if (!data) return { patient: null, art: null, staffName: null, notiz: null }
  const patient = data.patient
    ? data.patientCode
      ? `${data.patient} (${data.patientCode})`
      : data.patient
    : null
  let art = data.art ?? data.muster ?? null
  if (data.terminKollision && art) {
    art = `${art} · Terminkollision`
  } else if (data.terminKollision) {
    art = 'Terminkollision'
  }
  let staffName: string | null = data.staff?.trim() ? data.staff : null
  if (data.teamStaffIds?.length && staffList?.length) {
    const names = data.teamStaffIds
      .map((id) => staffList.find((s) => s.id === id)?.name)
      .filter(Boolean) as string[]
    if (names.length) staffName = names.join(', ')
  }
  if (!staffName && data.teamStaffIds?.length) {
    staffName = `${data.teamStaffIds.length} Teilnehmer`
  }
  const notiz = data.notiz?.trim() ? data.notiz.trim() : null
  return { patient, art, staffName, notiz }
}

function cellDisplayLine(
  data: CellData | undefined,
  staffList?: MitarbeiterItem[],
): string {
  const { patient, art, staffName } = cellTerminLabelParts(data, staffList)
  const teamMeeting =
    data?.artId === TEAM_MEETING_ART_ID || (data?.teamStaffIds?.length ?? 0) > 0
  const third = teamMeeting
    ? staffName ?? 'Teilnehmer wählen'
    : staffName ?? 'Mitarbeiter zuteilen'
  return [patient ?? '—', art ?? '—', third].join(' · ')
}

/** Mitarbeiter-Wochenraster: wie Hauptkalender (Patient, Art), dritte Zeile = Raum. */
function StaffWeekTerminLabels({
  data,
  room,
  mitarbeiter,
}: {
  data: CellData | undefined
  room: Room
  mitarbeiter: MitarbeiterItem[]
}) {
  const terminParts = cellTerminLabelParts(data, mitarbeiter)
  return (
    <>
      <span
        className={`slot-cell-termin-line slot-cell-termin-patient ${terminParts.patient ? '' : 'slot-cell-termin-placeholder'}`}
      >
        {terminParts.patient ?? '—'}
      </span>
      <span
        className={`slot-cell-termin-line slot-cell-termin-art ${terminParts.art ? '' : 'slot-cell-termin-placeholder'}`}
      >
        {terminParts.art ?? '—'}
      </span>
      <span className="slot-cell-termin-line slot-cell-termin-staff">
        {room}
      </span>
      {terminParts.notiz ? (
        <span className="slot-cell-termin-line slot-cell-termin-notiz">
          {terminParts.notiz}
        </span>
      ) : null}
    </>
  )
}

function TerminModalNotizFields({
  draft,
  onDraftChange,
  onSave,
}: {
  draft: string
  onDraftChange: (v: string) => void
  onSave: () => void
}) {
  return (
    <div className="termin-notiz-editor">
      <label className="staff-modal-label" htmlFor="termin-notiz-input">
        Notiz
      </label>
      <textarea
        id="termin-notiz-input"
        className="staff-modal-name-input termin-notiz-textarea"
        rows={3}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder="Nur intern sichtbar; wird bei Terminexport nicht mitgesendet."
        aria-label="Notiz zum Termin"
      />
      <button
        type="button"
        className="btn-edit-save termin-notiz-save"
        onClick={onSave}
      >
        Notiz speichern
      </button>
    </div>
  )
}

type KollisionPanelItem = {
  anchorKey: string
  summary: string
  kind:
    | 'termin-kollision'
    | 'termin-unvollständig'
    | 'termin-ohne-patient'
    | 'termin-ohne-mitarbeiter'
}

function parseSlotCellKey(
  fullKey: string,
): { dk: string; room: Room; slot: number } | null {
  const parts = fullKey.split('|')
  if (parts.length < 3) return null
  const dk = parts[0]!
  const room = parts[parts.length - 2]!
  const slot = Number(parts[parts.length - 1])
  if (!isRoomString(room) || !Number.isInteger(slot)) return null
  return { dk, room, slot }
}

/** Les-only-Detailmodal im Mitarbeiter-Wochenkalender (ein Tag, ein oder mehrere Terminblöcke). */
type StaffTerminDetailModalState = {
  dk: string
  blocks: { room: Room; anchorSlot: number }[]
}

/** Wie `parseSlotCellKey`, aber ohne harte Raum-Prüfung — für Navigation aus dem Kollisions-Panel. */
function parseKollisionAnchorKey(
  anchorKey: string,
): { dk: string; slot: number } | null {
  const strict = parseSlotCellKey(anchorKey)
  if (strict) return { dk: strict.dk, slot: strict.slot }
  const parts = anchorKey.split('|')
  if (parts.length < 3) return null
  const dk = parts[0]!
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return null
  const slot = Number(parts[parts.length - 1])
  if (!Number.isInteger(slot) || slot < 0 || slot >= slotCount()) return null
  return { dk, slot }
}

function cellMatchesPatientRecord(c: CellData, p: PatientItem): boolean {
  if (!c?.patient?.trim()) return false
  if (c.patient.trim() !== p.name.trim()) return false
  const cc = (c.patientCode ?? '').trim()
  const pc = (p.patientCode ?? '').trim()
  if (pc === '') return true
  return cc === pc
}

function collectPatientAppointmentsInRange(
  cells: Record<string, CellData>,
  patient: PatientItem,
  fromDk: string,
  toDk: string,
): PatientAppointmentExportRow[] {
  const seen = new Set<string>()
  const out: PatientAppointmentExportRow[] = []
  for (const [key, data] of Object.entries(cells)) {
    if (!isCellBooked(data)) continue
    if (!cellMatchesPatientRecord(data, patient)) continue
    const pos = parseSlotCellKey(key)
    if (!pos) continue
    if (pos.dk < fromDk || pos.dk > toDk) continue
    const { start, end } = findBlockBounds(cells, pos.dk, pos.room, pos.slot)
    const canon = `${pos.dk}|${pos.room}|${start}`
    if (seen.has(canon)) continue
    seen.add(canon)
    const anchor = cells[makeSlotKey(pos.dk, pos.room, start)]
    const staffLabel = anchor?.staff?.trim() || '—'
    out.push({
      dk: pos.dk,
      room: pos.room,
      startSlot: start,
      endSlot: end,
      staffLabel,
      artLabel: anchor?.art?.trim() || undefined,
    })
  }
  out.sort((a, b) => {
    if (a.dk !== b.dk) return a.dk.localeCompare(b.dk)
    if (a.room !== b.room) return a.room.localeCompare(b.room)
    return a.startSlot - b.startSlot
  })
  return out
}

function cellMatchesStaffRecord(
  data: CellData | undefined,
  staff: MitarbeiterItem,
): boolean {
  if (!data) return false
  if (data.teamStaffIds?.length) {
    return data.teamStaffIds.includes(staff.id)
  }
  const sid = (data.staffId ?? '').trim()
  if (sid !== '') return sid === staff.id
  const sn = (data.staff ?? '').trim()
  return sn !== '' && sn === staff.name.trim()
}

/** Termine des MA an Tag+Slot über alle Räume (Hauptkalender-Daten) */
function staffBookingsAtSlot(
  cells: Record<string, CellData>,
  dk: string,
  slotIndex: number,
  staff: MitarbeiterItem,
): { room: Room; data: CellData }[] {
  const out: { room: Room; data: CellData }[] = []
  for (const room of ROOMS) {
    const k = makeSlotKey(dk, room, slotIndex)
    const d = cells[k]
    if (!isCellBooked(d)) continue
    if (!cellMatchesStaffRecord(d!, staff)) continue
    out.push({ room, data: d! })
  }
  return out
}

function formatAbsencePeriodSummary(p: StaffAbsencePeriod): string {
  const datePart =
    p.fromDk === p.toDk ? p.fromDk : `${p.fromDk} → ${p.toDk}`
  if (p.allDay !== false) return `${datePart} · ganztägig`
  const a = p.startSlot ?? 0
  const b = p.endSlot ?? slotCount() - 1
  return `${datePart} · ${slotIndexToLabel(a)}–${slotIndexToLabel(b)}`
}

/** Gefilterte Kopie: nur Slots mit zugewiesenem MA (gleiche Datenbasis wie Hauptkalender). */
function projectCellsForCalendarTab(
  cells: Record<string, CellData>,
  tab: 'main' | string,
  staffList: MitarbeiterItem[],
): Record<string, CellData> {
  if (tab === 'main') return cells
  const staff = staffList.find((s) => s.id === tab)
  if (!staff) return cells
  const next: Record<string, CellData> = {}
  for (const [k, d] of Object.entries(cells)) {
    if (!d || !isCellBooked(d)) continue
    if (cellMatchesStaffRecord(d, staff)) next[k] = d
  }
  return next
}

function collectStaffAppointmentsInRange(
  cells: Record<string, CellData>,
  staff: MitarbeiterItem,
  fromDk: string,
  toDk: string,
): StaffAppointmentExportRow[] {
  const seen = new Set<string>()
  const out: StaffAppointmentExportRow[] = []
  for (const [key, data] of Object.entries(cells)) {
    if (!isCellBooked(data)) continue
    if (!cellMatchesStaffRecord(data, staff)) continue
    const pos = parseSlotCellKey(key)
    if (!pos) continue
    if (pos.dk < fromDk || pos.dk > toDk) continue
    const { start, end } = findBlockBounds(cells, pos.dk, pos.room, pos.slot)
    const canon = `${pos.dk}|${pos.room}|${start}`
    if (seen.has(canon)) continue
    seen.add(canon)
    const anchor = cells[makeSlotKey(pos.dk, pos.room, start)]
    out.push({
      dk: pos.dk,
      room: pos.room,
      startSlot: start,
      endSlot: end,
      artLabel: anchor?.art?.trim() || undefined,
      patientLabel:
        anchor?.patient?.trim() ||
        (anchor?.artId === TEAM_MEETING_ART_ID ? 'Teammeeting' : '—'),
    })
  }
  out.sort((a, b) => {
    if (a.dk !== b.dk) return a.dk.localeCompare(b.dk)
    if (a.room !== b.room) return a.room.localeCompare(b.room)
    return a.startSlot - b.startSlot
  })
  return out
}

/** Summe (Tag × Raum × Slot), an denen der MA im Wochenplan als verfügbar markiert ist. */
function countStaffAvailableSlotsInRange(
  s: MitarbeiterItem,
  fromDk: string,
  toDk: string,
): number {
  const slotsN = slotCount()
  let n = 0
  let d = parseDateKey(fromDk)
  while (true) {
    const dk = dateKey(d)
    if (dk > toDk) break
    const wd = weekdayMon0FromDate(d)
    for (const _room of ROOMS) {
      for (let sl = 0; sl < slotsN; sl++) {
        if (isStaffSlotAvailableForDate(s, dk, wd, sl)) n++
      }
    }
    if (dk === toDk) break
    d = addDays(d, 1)
  }
  return n
}

/** Belegte Kalenderzellen (30-Min-Slots) mit diesem MA im Zeitraum [fromDk, toDk]. */
function countStaffBookedSlotsInRange(
  cells: Record<string, CellData>,
  staff: MitarbeiterItem,
  fromDk: string,
  toDk: string,
): number {
  let n = 0
  for (const [key, data] of Object.entries(cells)) {
    if (!isCellBooked(data)) continue
    if (!cellMatchesStaffRecord(data, staff)) continue
    const pos = parseSlotCellKey(key)
    if (!pos) continue
    if (pos.dk < fromDk || pos.dk > toDk) continue
    n++
  }
  return n
}

function formatKollisionDatumZeile(dk: string, room: Room, startSlot: number) {
  const d = parseDateKey(dk)
  const dateStr = d.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
  return `${dateStr} · ${room} · ${slotIndexToLabel(startSlot)}`
}

function kollisionPanelKindOrder(
  k: KollisionPanelItem['kind'],
): number {
  if (k === 'termin-kollision') return 0
  if (k === 'termin-unvollständig') return 1
  if (k === 'termin-ohne-patient') return 2
  return 3
}

/** Terminkollisionen (Muster) sowie Patiententermine ohne Mitarbeiter (inkl. „Mitarbeiter zuteilen“). */
function listKollisionPanelItems(
  cells: Record<string, CellData>,
  artenList: BelegungsartItem[],
  staffList: MitarbeiterItem[],
): KollisionPanelItem[] {
  const seen = new Set<string>()
  const out: KollisionPanelItem[] = []

  for (const [key, data] of Object.entries(cells)) {
    if (!data?.terminKollision) continue
    const p = parseSlotCellKey(key)
    if (!p) continue
    const { start } = findBlockBounds(cells, p.dk, p.room, p.slot)
    const anchorKey = makeSlotKey(p.dk, p.room, start)
    if (seen.has(anchorKey)) continue
    seen.add(anchorKey)
    const anchor = cells[anchorKey]
    const when = formatKollisionDatumZeile(p.dk, p.room, start)
    const summary = `Terminkollision · ${when} — ${cellDisplayLine(anchor, staffList)}`
    out.push({ anchorKey, kind: 'termin-kollision', summary })
  }

  for (const [key, data] of Object.entries(cells)) {
    if (!data?.patient?.trim() || !isCellBooked(data)) continue
    const p = parseSlotCellKey(key)
    if (!p) continue
    const { start } = findBlockBounds(cells, p.dk, p.room, p.slot)
    const anchorKey = makeSlotKey(p.dk, p.room, start)
    if (seen.has(anchorKey)) continue
    const anchor = cells[anchorKey]
    if (!anchor?.patient?.trim()) continue
    if (findStaffForCell(anchor, staffList)) continue
    const needsArt = patientTerminNeedsArtChoice(anchor, artenList)
    const kind: KollisionPanelItem['kind'] = needsArt
      ? 'termin-unvollständig'
      : 'termin-ohne-mitarbeiter'
    const tag = needsArt
      ? 'Ohne Belegungsart & Mitarbeiter'
      : 'Mitarbeiter zuteilen'
    seen.add(anchorKey)
    const when = formatKollisionDatumZeile(p.dk, p.room, start)
    const summary = `${tag} · ${when} — ${cellDisplayLine(anchor, staffList)}`
    out.push({ anchorKey, kind, summary })
  }

  for (const [key, data] of Object.entries(cells)) {
    if (!isCellBooked(data)) continue
    const p = parseSlotCellKey(key)
    if (!p) continue
    const { start } = findBlockBounds(cells, p.dk, p.room, p.slot)
    const anchorKey = makeSlotKey(p.dk, p.room, start)
    if (seen.has(anchorKey)) continue
    const anchor = cells[anchorKey]
    if (anchor?.patient?.trim()) continue
    if (anchor?.terminKollision) continue
    if (findArtIdForCell(anchor, artenList) === TEAM_MEETING_ART_ID) continue
    seen.add(anchorKey)
    const when = formatKollisionDatumZeile(p.dk, p.room, start)
    const summary = `Ohne Patient · ${when} — ${cellDisplayLine(anchor, staffList)}`
    out.push({ anchorKey, kind: 'termin-ohne-patient', summary })
  }

  out.sort((a, b) => {
    const loc = a.anchorKey.localeCompare(b.anchorKey, 'de')
    if (loc !== 0) return loc
    return kollisionPanelKindOrder(a.kind) - kollisionPanelKindOrder(b.kind)
  })
  return out
}

function cellAccentColor(data: CellData | undefined): string | undefined {
  if (!data) return undefined
  if (data.terminKollision) return '#b91c1c'
  return data.musterColor || data.artColor
}

const SLOT_UNDO_MAX = 50

type MusterWeekEditorGridProps = {
  weekCount: number
  draftCells: Record<string, CellData>
  dragOverKey: string | null
  setDragOverKey: Dispatch<SetStateAction<string | null>>
  onEditorDrop: (e: DragEvent, dk: string, room: Room, sl: number) => void
  onCellPickRequest: (dk: string, room: Room, sl: number) => void
  endPanelOrCellDrag: () => void
  startCellMoveDrag: (
    e: DragEvent,
    dk: string,
    room: Room,
    sl: number,
  ) => void
  startResizeDrag: (
    e: DragEvent,
    dk: string,
    room: Room,
    edge: 'top' | 'bottom',
    anchorSlot: number,
  ) => void
  suppressClickAfterDrag: MutableRefObject<number>
  dragSourceRef: MutableRefObject<'panel' | 'cell' | 'resize' | null>
  availabilityHighlightKeys: Set<string> | null
  availabilityHighlightColor: string | undefined
}

function MusterWeekEditorGrid({
  weekCount,
  draftCells,
  dragOverKey,
  setDragOverKey,
  onEditorDrop,
  onCellPickRequest,
  endPanelOrCellDrag,
  startCellMoveDrag,
  startResizeDrag,
  suppressClickAfterDrag,
  dragSourceRef,
  availabilityHighlightKeys,
  availabilityHighlightColor,
}: MusterWeekEditorGridProps) {
  const slotsN = slotCount()
  return (
    <div className="muster-three-weeks-editor">
      {Array.from({ length: weekCount }, (_, weekIndex) => (
        <div key={weekIndex} className="muster-week-block">
          <div className="muster-week-block-head">
            Woche {weekIndex + 1}
          </div>
          <div className="muster-week-editor-row">
            {Array.from({ length: 7 }, (_, wd) => {
              const dayIndex = weekIndex * 7 + wd
              const dayDk = templateDkForDayIndex(dayIndex)
              return (
          <div key={dayDk} className="muster-day-column">
            <div className="muster-day-column-head">{WEEKDAY_SHORT_DE[wd]}</div>
            <div className="grid-wrap muster-mini-grid-wrap">
              <div
                className="plan-grid day-grid muster-mini-day-grid"
                style={{
                  gridTemplateColumns: `minmax(2.25rem, 2.75rem) repeat(${ROOMS.length}, minmax(2.75rem, 1fr))`,
                }}
              >
                <div className="corner" style={{ gridColumn: 1, gridRow: 1 }} />
                {ROOMS.map((r, ri) => (
                  <div
                    key={r}
                    className="col-head muster-mini-col-head"
                    style={{ gridColumn: ri + 2, gridRow: 1 }}
                  >
                    {r}
                  </div>
                ))}
                {Array.from({ length: slotsN }, (_, slotIndex) => {
                  const rowMergeNext = ROOMS.some((room) => {
                    const d = draftCells[makeSlotKey(dayDk, room, slotIndex)]
                    if (!isCellBooked(d)) return false
                    const seg = daySlotBlockSegment(
                      draftCells,
                      dayDk,
                      room,
                      slotIndex,
                      slotsN,
                    )
                    return seg === 'start' || seg === 'middle'
                  })
                  return (
                    <div
                      key={slotIndex}
                      className="day-slot-row"
                      style={{ display: 'contents' }}
                    >
                      <div
                        className={`time-label ${rowMergeNext ? 'time-label--merge-next' : ''}`}
                        style={{ gridColumn: 1, gridRow: slotIndex + 2 }}
                      >
                        {slotIndexToLabel(slotIndex)}
                      </div>
                      {ROOMS.map((room, roomIdx) => {
                        const gridCol = roomIdx + 2
                        const kHere = makeSlotKey(dayDk, room, slotIndex)
                        const dataHere = draftCells[kHere]
                        const booked = isCellBooked(dataHere)
                        const bounds = booked
                          ? findBlockBounds(
                              draftCells,
                              dayDk,
                              room,
                              slotIndex,
                            )
                          : null
                        const spanLen = bounds
                          ? bounds.end - bounds.start + 1
                          : 1
                        const skipBecauseSpanned =
                          booked &&
                          bounds !== null &&
                          spanLen > 1 &&
                          slotIndex !== bounds.start
                        if (skipBecauseSpanned) {
                          return null
                        }
                        const slotIndicesForShell =
                          booked && bounds
                            ? Array.from(
                                { length: spanLen },
                                (_, i) => bounds.start + i,
                              )
                            : [slotIndex]
                        const gridRow =
                          booked && bounds
                            ? `${bounds.start + 2} / ${bounds.end + 3}`
                            : slotIndex + 2
                        const anchorSl = slotIndicesForShell[0]
                        const anchorKey = makeSlotKey(dayDk, room, anchorSl)
                        const anchorData = draftCells[anchorKey]
                        const artOnlyLabel =
                          anchorData?.art?.trim() ||
                          cellTerminLabelParts(anchorData).art ||
                          '—'
                        const accent = cellAccentColor(anchorData)
                        const blockSegFirst = daySlotBlockSegment(
                          draftCells,
                          dayDk,
                          room,
                          anchorSl,
                          slotsN,
                        )
                        const lastSl =
                          slotIndicesForShell[slotIndicesForShell.length - 1]
                        const blockSegLast = daySlotBlockSegment(
                          draftCells,
                          dayDk,
                          room,
                          lastSl,
                          slotsN,
                        )
                        const showBlockLabel =
                          booked &&
                          blockSegFirst !== null &&
                          (blockSegFirst === 'single' ||
                            blockSegFirst === 'start')
                        const edgeStyle = booked
                          ? ({
                              '--block-edge': accent ?? 'var(--booked-edge)',
                            } as CSSProperties)
                          : undefined
                        const pauseBlock = isMusterPauseCell(anchorData)
                        const showResizeTop =
                          booked &&
                          !pauseBlock &&
                          blockSegFirst !== null &&
                          (blockSegFirst === 'start' ||
                            blockSegFirst === 'single')
                        const showResizeBottom =
                          booked &&
                          !pauseBlock &&
                          blockSegLast !== null &&
                          (blockSegLast === 'end' ||
                            blockSegLast === 'single')
                        const shellBookedStyle = booked
                          ? ({
                              ...edgeStyle,
                              gridColumn: gridCol,
                              gridRow,
                              ...(accent
                                ? {
                                    background: `color-mix(in srgb, ${accent} 35%, var(--slot-free))`,
                                  }
                                : { background: 'var(--booked)' }),
                            } as CSSProperties)
                          : ({
                              gridColumn: gridCol,
                              gridRow,
                            } as CSSProperties)
                        const shellDragActive = slotIndicesForShell.some(
                          (sl) =>
                            dragOverKey === makeSlotKey(dayDk, room, sl),
                        )
                        const mergeNextClass =
                          booked &&
                          spanLen === 1 &&
                          blockSegFirst &&
                          (blockSegFirst === 'start' ||
                            blockSegFirst === 'middle')
                        return (
                          <div
                            key={anchorKey}
                            className={[
                              'slot-cell-shell',
                              spanLen > 1 ? 'slot-cell-shell--span-block' : '',
                              shellDragActive ? 'drag-over' : '',
                              mergeNextClass ? 'slot-shell--merge-next' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            style={shellBookedStyle}
                          >
                            {showResizeTop ? (
                              <div
                                className="slot-resize-handle slot-resize-handle--top"
                                draggable
                                onDragStart={(e) => {
                                  e.stopPropagation()
                                  startResizeDrag(
                                    e,
                                    dayDk,
                                    room,
                                    'top',
                                    anchorSl,
                                  )
                                }}
                                onDragEnd={endPanelOrCellDrag}
                                title="Am oberen Rand verlängern oder verkürzen"
                                aria-label="Oberen Rand ziehen"
                              />
                            ) : null}
                            <div className="slot-cell-span-body">
                              {slotIndicesForShell.map((sl) => {
                                const k = makeSlotKey(dayDk, room, sl)
                                const data = draftCells[k]
                                const subBooked = isCellBooked(data)
                                const subSeg = daySlotBlockSegment(
                                  draftCells,
                                  dayDk,
                                  room,
                                  sl,
                                  slotsN,
                                )
                                const staffAvailShade =
                                  Boolean(availabilityHighlightKeys?.has(k)) &&
                                  !isMusterPauseCell(data) &&
                                  !slotIndexInCalendarLunchPause(sl)
                                return (
                                  <button
                                    key={k}
                                    type="button"
                                    className={`slot-cell slot-cell-main ${subBooked ? 'booked' : ''} ${subBooked && subSeg ? `slot-block--${subSeg}` : ''} ${staffAvailShade ? 'slot-cell--muster-staff-avail' : ''}`}
                                    style={
                                      subBooked
                                        ? {
                                            ...edgeStyle,
                                            ...(accent
                                              ? {
                                                  background: `color-mix(in srgb, ${accent} 35%, var(--slot-free))`,
                                                }
                                              : {
                                                  background: 'var(--booked)',
                                                }),
                                            ...(staffAvailShade && availabilityHighlightColor
                                              ? ({
                                                  '--art-drop-tint':
                                                    availabilityHighlightColor,
                                                } as CSSProperties)
                                              : {}),
                                          }
                                        : staffAvailShade && availabilityHighlightColor
                                          ? ({
                                              '--art-drop-tint':
                                                availabilityHighlightColor,
                                            } as CSSProperties)
                                          : undefined
                                    }
                                    draggable={subBooked && !isMusterPauseCell(data)}
                                    onClick={() => {
                                      if (
                                        Date.now() - suppressClickAfterDrag.current <
                                        450
                                      ) {
                                        return
                                      }
                                      if (isMusterPauseCell(data)) return
                                      onCellPickRequest(dayDk, room, sl)
                                    }}
                                    onDragStart={(e) => {
                                      if (!subBooked || isMusterPauseCell(data))
                                        return
                                      e.stopPropagation()
                                      startCellMoveDrag(e, dayDk, room, sl)
                                    }}
                                    onDragEnd={() => {
                                      endPanelOrCellDrag()
                                      suppressClickAfterDrag.current =
                                        Date.now()
                                    }}
                                    onDragOver={(e) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      e.dataTransfer.dropEffect =
                                        dragSourceRef.current === 'cell'
                                          ? 'move'
                                          : 'copy'
                                      setDragOverKey(k)
                                    }}
                                    onDragLeave={() =>
                                      setDragOverKey((key) =>
                                        key === k ? null : key,
                                      )
                                    }
                                    onDrop={(e) =>
                                      onEditorDrop(e, dayDk, room, sl)
                                    }
                                    aria-label={
                                      isMusterPauseCell(data)
                                        ? `${room} ${slotIndexToLabel(sl)} Pause, nicht bearbeitbar`
                                        : subBooked
                                          ? `${room} ${slotIndexToLabel(sl)} ${artOnlyLabel}, Klick zur Belegungsart`
                                          : `${room} ${slotIndexToLabel(sl)} frei, Klick zur Belegungsart`
                                    }
                                  />
                                )
                              })}
                            </div>
                            {showResizeBottom ? (
                              <div
                                className="slot-resize-handle slot-resize-handle--bottom"
                                draggable
                                onDragStart={(e) => {
                                  e.stopPropagation()
                                  startResizeDrag(
                                    e,
                                    dayDk,
                                    room,
                                    'bottom',
                                    lastSl,
                                  )
                                }}
                                onDragEnd={endPanelOrCellDrag}
                                title="Am unteren Rand verlängern oder verkürzen"
                                aria-label="Unteren Rand ziehen"
                              />
                            ) : null}
                            {showBlockLabel ? (
                              <div
                                className="slot-cell-label slot-cell-termin-span-overlay muster-template-block-label"
                                title={artOnlyLabel}
                              >
                                <span className="muster-template-art-text">
                                  {artOnlyLabel}
                                </span>
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function cloneSlotMap(c: Record<string, CellData>): Record<string, CellData> {
  try {
    return structuredClone(c)
  } catch {
    return JSON.parse(JSON.stringify(c)) as Record<string, CellData>
  }
}

export type AppProps = { cloudSyncEnabled?: boolean }

export default function App({ cloudSyncEnabled = false }: AppProps = {}) {
  const { profile, signOut, session } = useAuth()
  const accountLabel =
    profile?.display_name?.trim() ||
    session?.user?.email ||
    ''
  const appRole = cloudSyncEnabled ? (profile?.role ?? null) : null
  const organizationId =
    cloudSyncEnabled && profile?.organization_id
      ? profile.organization_id
      : null
  const mayPatientWrite = can(appRole, 'patients:write')
  const mayArtenWrite = can(appRole, 'arten:write')
  const mayMusterWrite = can(appRole, 'muster:write')
  const mayStaffWrite = can(appRole, 'staff:write')
  const mayStaffAbsences = can(appRole, 'staff:absences')
  const mayExport = can(appRole, 'export:run')
  const isViewer = cloudSyncEnabled && appRole === 'viewer'

  const initialPanels = useMemo(
    () => (cloudSyncEnabled ? null : loadPanels()),
    [cloudSyncEnabled],
  )
  const initialUi = useMemo(
    () => (cloudSyncEnabled ? null : loadUiState()),
    [cloudSyncEnabled],
  )
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => initialUi?.viewMode ?? 'week',
  )
  const [anchorDate, setAnchorDate] = useState(
    () =>
      initialUi?.anchorDateKey
        ? parseDateKey(initialUi.anchorDateKey)
        : calendarDate(new Date()),
  )
  const [slotCells, setSlotCellsBase] = useState<Record<string, CellData>>(() =>
    cloudSyncEnabled ? {} : loadSlotCells(),
  )
  const slotCellsRef = useRef(slotCells)
  slotCellsRef.current = slotCells
  const slotUndoStackRef = useRef<Record<string, CellData>[]>([])
  const [canUndoSlots, setCanUndoSlots] = useState(false)

  const setSlotCells = useCallback(
    (updater: SetStateAction<Record<string, CellData>>) => {
      setSlotCellsBase((prev) => {
        slotUndoStackRef.current.push(cloneSlotMap(prev))
        if (slotUndoStackRef.current.length > SLOT_UNDO_MAX) {
          slotUndoStackRef.current.shift()
        }
        const next =
          typeof updater === 'function'
            ? (updater as (p: Record<string, CellData>) => Record<string, CellData>)(
                prev,
              )
            : updater
        return next
      })
    },
    [],
  )

  const undoSlotCells = useCallback(() => {
    const snap = slotUndoStackRef.current.pop()
    if (!snap) return
    setSlotCellsBase(cloneSlotMap(snap))
  }, [])
  const [patients, setPatients] = useState<PatientItem[]>(
    () => initialPanels?.patients ?? DEFAULT_PATIENTS,
  )
  const [arten, setArten] = useState<BelegungsartItem[]>(
    () => initialPanels?.arten ?? DEFAULT_ARTEN,
  )
  const [newArtLabel, setNewArtLabel] = useState('')
  const [newArtMinutes, setNewArtMinutes] = useState(60)
  const [newArtColor, setNewArtColor] = useState('#0d9488')
  const [newArtModalOpen, setNewArtModalOpen] = useState(false)
  const [editingArtId, setEditingArtId] = useState<string | null>(null)
  const [editArtLabel, setEditArtLabel] = useState('')
  const [editArtMinutes, setEditArtMinutes] = useState(60)
  const [editArtColor, setEditArtColor] = useState('#0d9488')
  const [muster, setMuster] = useState<BelegungsmusterItem[]>(
    () => initialPanels?.muster ?? DEFAULT_MUSTER,
  )
  const [musterUsageCountById, setMusterUsageCountById] = useState<
    Record<string, number>
  >(() => initialPanels?.musterUsageCountById ?? {})
  const [musterModal, setMusterModal] = useState<
    | null
    | { mode: 'create'; templateWeekCount: 1 | 3 }
    | { mode: 'edit'; id: string; templateWeekCount: 1 | 3 }
  >(null)
  const [musterDraftLabel, setMusterDraftLabel] = useState('')
  const [musterDraftCells, setMusterDraftCells] = useState<Record<string, CellData>>(
    {},
  )
  const [musterEditorDragOverKey, setMusterEditorDragOverKey] = useState<
    string | null
  >(null)
  /** Muster-Editor: genau eine Belegungsart — Zellen schattieren, in denen alle freigeschalteten MA verfügbar sind */
  const [musterHighlightArtId, setMusterHighlightArtId] = useState<
    string | null
  >(null)
  const [musterArtPicker, setMusterArtPicker] = useState<
    null | { dk: string; room: Room; anchorSlot: number }
  >(null)
  const musterEditorSuppressClick = useRef(0)
  const [mitarbeiter, setMitarbeiter] = useState<MitarbeiterItem[]>(
    () => initialPanels?.mitarbeiter ?? DEFAULT_MITARBEITER,
  )
  // Katalog-Migration auch nach Hot-Reload / bestehendem State erzwingen
  useEffect(() => {
    const has = arten.some((a) => a.id === TEAM_MEETING_ART_ID)
    if (!has) {
      const tm = DEFAULT_ARTEN.find((a) => a.id === TEAM_MEETING_ART_ID)
      if (tm) setArten((prev) => (prev.some((a) => a.id === tm.id) ? prev : [...prev, tm]))
    }
    setMitarbeiter((prev) =>
      prev.map((s) =>
        s.allowedArtIds.includes(TEAM_MEETING_ART_ID)
          ? s
          : { ...s, allowedArtIds: [...s.allowedArtIds, TEAM_MEETING_ART_ID] },
      ),
    )
  }, [arten])
  const [staffModal, setStaffModal] = useState<
    null | { mode: 'create' } | { mode: 'edit'; id: string }
  >(null)
  const [staffDraftName, setStaffDraftName] = useState('')
  const [staffDraftAvail, setStaffDraftAvail] = useState<Record<string, boolean>>(
    () => emptyStaffAvailability(slotCount()),
  )
  const [staffDraftAvailOdd, setStaffDraftAvailOdd] = useState<
    Record<string, boolean>
  >(() => emptyStaffAvailability(slotCount()))
  const [staffDraftAlternating, setStaffDraftAlternating] = useState(false)
  const [staffDraftArtIds, setStaffDraftArtIds] = useState<string[]>([])
  const [terminPickerModal, setTerminPickerModal] = useState<
    | null
    | { kind: 'art'; dk: string; room: Room; anchorSlot: number }
    | { kind: 'staff'; dk: string; room: Room; anchorSlot: number }
    | { kind: 'teamMeeting'; dk: string; room: Room; anchorSlot: number }
  >(null)
  const [teamMeetingSelectedIds, setTeamMeetingSelectedIds] = useState<
    string[]
  >([])
  const [teamMeetingRepeatWeeks, setTeamMeetingRepeatWeeks] = useState(1)
  const [terminNotizDraft, setTerminNotizDraft] = useState('')
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  /** Belegungsart vom Panel ziehen: Vorschau-Färbung gültiger Zielzellen */
  const [artDragHighlight, setArtDragHighlight] = useState<{
    artId: string
    color: string
  } | null>(null)
  const [newPatientName, setNewPatientName] = useState('')
  const [newPatientCode, setNewPatientCode] = useState('')
  const [editingPatientId, setEditingPatientId] = useState<string | null>(null)
  const [editPatientName, setEditPatientName] = useState('')
  const [editPatientCode, setEditPatientCode] = useState('')
  const [patientSearchQuery, setPatientSearchQuery] = useState('')
  const [patientExportOpen, setPatientExportOpen] = useState(false)
  const [patientExportStep, setPatientExportStep] = useState<1 | 2>(1)
  const [patientExportQuery, setPatientExportQuery] = useState('')
  const [patientExportSelectedId, setPatientExportSelectedId] = useState<
    string | null
  >(null)
  const [patientExportFrom, setPatientExportFrom] = useState('')
  const [patientExportTo, setPatientExportTo] = useState('')
  const [staffExportOpen, setStaffExportOpen] = useState(false)
  const [staffExportStep, setStaffExportStep] = useState<1 | 2>(1)
  const [staffExportQuery, setStaffExportQuery] = useState('')
  const [staffExportSelectedId, setStaffExportSelectedId] = useState<string | null>(
    null,
  )
  const [staffExportFrom, setStaffExportFrom] = useState('')
  const [staffExportTo, setStaffExportTo] = useState('')
  const [roomExportOpen, setRoomExportOpen] = useState(false)
  const [roomExportStep, setRoomExportStep] = useState<1 | 2>(1)
  const [roomExportRoom, setRoomExportRoom] = useState<Room | null>(null)
  const [roomExportFrom, setRoomExportFrom] = useState('')
  const [roomExportTo, setRoomExportTo] = useState('')
  const dayGridRef = useRef<HTMLDivElement>(null)
  const pendingScrollToNow = useRef(false)
  /** Nach Klick im Kollisions-Panel: Tagesansicht auf diesen Slot scrollen */
  const pendingScrollToTerminSlotRef = useRef<number | null>(null)
  const dragSourceRef = useRef<'panel' | 'cell' | 'resize' | null>(null)
  const suppressSlotClickAfterDrag = useRef(0)
  /** Hauptkalender-Tab oder Mitarbeiter-ID — MA-Ansicht ist schreibgeschützte gefilterte Kopie */
  const [calendarTabId, setCalendarTabId] = useState<'main' | string>('main')
  /** Mitarbeiter-Verfügbarkeit: Klick+Ziehen zum Markieren/Demarkieren */
  const staffAvailPaintRef = useRef<{
    active: boolean
    targetOn: boolean
    weekParity: 'even' | 'odd'
  } | null>(null)
  const [cloudHydrated, setCloudHydrated] = useState(!cloudSyncEnabled)

  useEffect(() => {
    if (!cloudSyncEnabled) return
    const onSaveErr = (e: Event) => {
      const msg = (e as CustomEvent<{ message?: string }>).detail?.message ?? ''
      alertOnce(
        `Speichern in der Cloud ist fehlgeschlagen.${msg ? ` (${msg})` : ''} Prüfen Sie Ihre Rolle (admin/planung/therapie — nicht „viewer“), ob die Tabellen-Migration in Supabase läuft und die Netzwerkverbindung.`,
      )
    }
    window.addEventListener('physio-workspace-save-error', onSaveErr)
    return () =>
      window.removeEventListener('physio-workspace-save-error', onSaveErr)
  }, [cloudSyncEnabled])

  useEffect(() => {
    if (!cloudSyncEnabled) return
    const flush = () => {
      void flushPendingWorkspaceWrites()
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [cloudSyncEnabled])

  useEffect(() => {
    if (!cloudSyncEnabled) {
      setCloudHydrated(true)
      return
    }
    if (!organizationId) {
      setCloudHydrated(false)
      return
    }
    let cancelled = false
    setCloudHydrated(false)
    void (async () => {
      try {
        const byType = await fetchWorkspaceDocuments(organizationId)
        if (cancelled) return
        if (byType.slots !== undefined) {
          setSlotCellsBase(parseSlotCellsFromUnknown(byType.slots))
          slotUndoStackRef.current = []
          setCanUndoSlots(false)
        }
        if (byType.panels !== undefined) {
          const parsed = parsePanelsFromJsonObject(byType.panels)
          if (parsed) {
            setPatients(parsed.patients)
            setArten(parsed.arten)
            setMuster(parsed.muster)
            setMitarbeiter(parsed.mitarbeiter)
            setMusterUsageCountById(parsed.musterUsageCountById)
          }
        }
        if (byType.ui !== undefined) {
          const ui = parseUiFromUnknown(byType.ui)
          if (ui) {
            setViewMode(ui.viewMode)
            setAnchorDate(parseDateKey(ui.anchorDateKey))
          }
        }
      } catch (e) {
        console.error('Cloud-Hydration', e)
      } finally {
        if (!cancelled) setCloudHydrated(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cloudSyncEnabled, organizationId])

  /* Automatisches Speichern: Kalender, Stammdaten, Ansicht — bei jeder Änderung */
  useEffect(() => {
    if (cloudSyncEnabled) {
      if (!cloudHydrated || !organizationId || appRole === 'viewer') return
      scheduleWorkspaceUpsert(organizationId, 'slots', slotCells)
      return
    }
    saveSlotCells(slotCells)
  }, [slotCells, cloudSyncEnabled, cloudHydrated, organizationId, appRole])

  useEffect(() => {
    setCanUndoSlots(slotUndoStackRef.current.length > 0)
  }, [slotCells])

  useEffect(() => {
    if (cloudSyncEnabled) {
      if (!cloudHydrated || !organizationId || appRole === 'viewer') return
      scheduleWorkspaceUpsert(organizationId, 'panels', {
        patients,
        arten,
        muster,
        mitarbeiter,
        musterUsageCountById,
        artenCatalogVersion: ARTEN_CATALOG_VERSION,
      })
      return
    }
    savePanelsState({
      patients,
      arten,
      muster,
      mitarbeiter,
      musterUsageCountById,
    })
  }, [
    patients,
    arten,
    muster,
    mitarbeiter,
    musterUsageCountById,
    cloudSyncEnabled,
    cloudHydrated,
    organizationId,
    appRole,
  ])

  useEffect(() => {
    if (cloudSyncEnabled) {
      if (!cloudHydrated || !organizationId || appRole === 'viewer') return
      scheduleWorkspaceUpsert(organizationId, 'ui', {
        viewMode,
        anchorDateKey: dateKey(anchorDate),
      })
      return
    }
    saveUiState(viewMode, anchorDate)
  }, [viewMode, anchorDate, cloudSyncEnabled, cloudHydrated, organizationId, appRole])

  useEffect(() => {
    if (cloudSyncEnabled) return undefined
    return startWeeklyBackupScheduler()
  }, [cloudSyncEnabled])

  useEffect(() => {
    if (calendarTabId !== 'main' || viewMode !== 'day') return
    const terminSlot = pendingScrollToTerminSlotRef.current
    if (terminSlot !== null && Number.isFinite(terminSlot)) {
      pendingScrollToTerminSlotRef.current = null
      const scrollToTerminRow = (attempt: number) => {
        const el = dayGridRef.current?.querySelector(
          `[data-slot-row="${terminSlot}"]`,
        )
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        } else if (attempt < 12) {
          window.setTimeout(() => scrollToTerminRow(attempt + 1), 32)
        }
      }
      requestAnimationFrame(() => scrollToTerminRow(0))
      return
    }
    if (!pendingScrollToNow.current) return
    pendingScrollToNow.current = false
    const now = new Date()
    if (dateKey(anchorDate) !== dateKey(now)) return
    const mins =
      now.getHours() * 60 + now.getMinutes() - DAY_START_HOUR * 60
    if (mins < 0 || mins >= (DAY_END_HOUR - DAY_START_HOUR) * 60) return
    const slot = Math.floor(mins / SLOT_MINUTES)
    requestAnimationFrame(() => {
      dayGridRef.current
        ?.querySelector(`[data-slot-row="${slot}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [calendarTabId, viewMode, anchorDate])

  const filteredPatients = useMemo(() => {
    const q = patientSearchQuery.trim().toLowerCase()
    let list =
      q === ''
        ? patients
        : patients.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.patientCode.toLowerCase().includes(q),
          )
    if (editingPatientId) {
      const ed = patients.find((p) => p.id === editingPatientId)
      if (ed && !list.some((p) => p.id === editingPatientId)) {
        list = [ed, ...list]
      }
    }
    return list
  }, [patients, patientSearchQuery, editingPatientId])

  const kollisionPanelItems = useMemo(
    () => listKollisionPanelItems(slotCells, arten, mitarbeiter),
    [slotCells, arten, mitarbeiter],
  )

  /** Panel: nach Häufigkeit im Hauptkalender (Slot-Zellen), bei Gleichstand Katalogreihenfolge */
  const artenSortedForPanel = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of arten) counts.set(a.id, 0)
    for (const d of Object.values(slotCells)) {
      if (!isCellBooked(d)) continue
      const id = findArtIdForCell(d, arten)
      if (!id) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const indexById = new Map(arten.map((a, i) => [a.id, i] as const))
    return [...arten].sort((a, b) => {
      const ca = counts.get(a.id) ?? 0
      const cb = counts.get(b.id) ?? 0
      if (cb !== ca) return cb - ca
      return (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0)
    })
  }, [arten, slotCells])

  /** Panel: nach Häufigkeit der Benutzung (je erfolgreichem Auftragen), bei Gleichstand Katalogreihenfolge */
  const musterSortedForPanel = useMemo(() => {
    const indexById = new Map(muster.map((m, i) => [m.id, i] as const))
    return [...muster].sort((a, b) => {
      const ca = musterUsageCountById[a.id] ?? 0
      const cb = musterUsageCountById[b.id] ?? 0
      if (cb !== ca) return cb - ca
      return (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0)
    })
  }, [muster, musterUsageCountById])

  const weekStart = useMemo(() => startOfWeekMonday(anchorDate), [anchorDate])
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }, [weekStart])

  const activeDayKey = dateKey(anchorDate)

  useEffect(() => {
    if (calendarTabId === 'main') return
    if (!mitarbeiter.some((s) => s.id === calendarTabId)) {
      setCalendarTabId('main')
    }
  }, [mitarbeiter, calendarTabId])

  const cellsForActiveCalendarView = useMemo(
    () => projectCellsForCalendarTab(slotCells, calendarTabId, mitarbeiter),
    [slotCells, calendarTabId, mitarbeiter],
  )

  const isStaffCalendarReadOnly = calendarTabId !== 'main'

  const [staffAbsenceModalId, setStaffAbsenceModalId] = useState<string | null>(
    null,
  )
  const [staffTerminDetailModal, setStaffTerminDetailModal] =
    useState<StaffTerminDetailModalState | null>(null)
  const [staffTerminNoteDrafts, setStaffTerminNoteDrafts] = useState<string[]>(
    [],
  )
  const [staffAbsenceFormFrom, setStaffAbsenceFormFrom] = useState('')
  const [staffAbsenceFormTo, setStaffAbsenceFormTo] = useState('')
  const [staffAbsenceFormKind, setStaffAbsenceFormKind] =
    useState<StaffAbsenceKind>('urlaub')
  const [staffAbsenceFormAllDay, setStaffAbsenceFormAllDay] = useState(true)
  const [staffAbsenceFormStartSlot, setStaffAbsenceFormStartSlot] = useState(0)
  const [staffAbsenceFormEndSlot, setStaffAbsenceFormEndSlot] = useState(() =>
    Math.max(0, slotCount() - 1),
  )

  const calendarTabStaffMember = useMemo(() => {
    if (calendarTabId === 'main') return null
    return mitarbeiter.find((s) => s.id === calendarTabId) ?? null
  }, [calendarTabId, mitarbeiter])

  const openStaffAbsenceModal = useCallback(
    (prefs?: {
      fromDk?: string
      toDk?: string
      allDay?: boolean
      startSlot?: number
      endSlot?: number
    }) => {
      if (calendarTabId === 'main') return
      const from = prefs?.fromDk ?? activeDayKey
      setStaffAbsenceFormFrom(from)
      setStaffAbsenceFormTo(prefs?.toDk ?? from)
      setStaffAbsenceFormKind('urlaub')
      const maxSl = Math.max(0, slotCount() - 1)
      const allDay = prefs?.allDay !== false
      setStaffAbsenceFormAllDay(allDay)
      if (!allDay) {
        const a =
          typeof prefs?.startSlot === 'number'
            ? Math.max(0, Math.min(maxSl, prefs.startSlot))
            : 0
        const b =
          typeof prefs?.endSlot === 'number'
            ? Math.max(0, Math.min(maxSl, prefs.endSlot))
            : maxSl
        setStaffAbsenceFormStartSlot(a)
        setStaffAbsenceFormEndSlot(Math.max(a, b))
      } else {
        setStaffAbsenceFormStartSlot(0)
        setStaffAbsenceFormEndSlot(maxSl)
      }
      setStaffAbsenceModalId(calendarTabId)
    },
    [calendarTabId, activeDayKey],
  )

  const closeStaffAbsenceModal = useCallback(() => {
    setStaffAbsenceModalId(null)
  }, [])

  const saveStaffAbsence = useCallback(() => {
    if (!staffAbsenceModalId) return
    const from = staffAbsenceFormFrom.trim()
    const to = staffAbsenceFormTo.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      alertOnce('Bitte gültige Daten wählen.')
      return
    }
    if (from > to) {
      alertOnce('Das Enddatum muss am oder nach dem Startdatum liegen.')
      return
    }
    const id = newStaffAbsenceId()
    const maxSl = Math.max(0, slotCount() - 1)
    let period: StaffAbsencePeriod
    if (staffAbsenceFormAllDay) {
      period = {
        id,
        fromDk: from,
        toDk: to,
        kind: staffAbsenceFormKind,
        allDay: true,
      }
    } else {
      let a = Math.max(0, Math.min(maxSl, staffAbsenceFormStartSlot))
      let b = Math.max(0, Math.min(maxSl, staffAbsenceFormEndSlot))
      if (a > b) [a, b] = [b, a]
      period = {
        id,
        fromDk: from,
        toDk: to,
        kind: staffAbsenceFormKind,
        allDay: false,
        startSlot: a,
        endSlot: b,
      }
    }
    setMitarbeiter((prev) =>
      prev.map((s) => {
        if (s.id !== staffAbsenceModalId) return s
        const nextAbs = [...(s.absences ?? []), period]
        return { ...s, absences: nextAbs }
      }),
    )
    setStaffAbsenceFormFrom(activeDayKey)
    setStaffAbsenceFormTo(activeDayKey)
    setStaffAbsenceFormAllDay(true)
    setStaffAbsenceFormStartSlot(0)
    setStaffAbsenceFormEndSlot(maxSl)
  }, [
    staffAbsenceModalId,
    staffAbsenceFormFrom,
    staffAbsenceFormTo,
    staffAbsenceFormKind,
    staffAbsenceFormAllDay,
    staffAbsenceFormStartSlot,
    staffAbsenceFormEndSlot,
    activeDayKey,
  ])

  const removeStaffAbsence = useCallback(
    (absenceId: string) => {
      if (!staffAbsenceModalId) return
      setMitarbeiter((prev) =>
        prev.map((s) => {
          if (s.id !== staffAbsenceModalId) return s
          return {
            ...s,
            absences: (s.absences ?? []).filter((a) => a.id !== absenceId),
          }
        }),
      )
    },
    [staffAbsenceModalId],
  )

  const staffAbsenceModalStaffView = useMemo(() => {
    if (!staffAbsenceModalId) return null
    return mitarbeiter.find((s) => s.id === staffAbsenceModalId) ?? null
  }, [staffAbsenceModalId, mitarbeiter])

  useEffect(() => {
    if (!staffAbsenceModalId) return
    if (!mitarbeiter.some((s) => s.id === staffAbsenceModalId)) {
      setStaffAbsenceModalId(null)
    }
  }, [mitarbeiter, staffAbsenceModalId])

  useEffect(() => {
    if (calendarTabId !== 'main') setViewMode('week')
  }, [calendarTabId])

  const goToday = useCallback(() => {
    const today = calendarDate(new Date())
    setAnchorDate(today)
    if (calendarTabId === 'main') {
      setViewMode('day')
      pendingScrollToNow.current = true
    } else {
      setViewMode('week')
    }
  }, [calendarTabId])

  const applyMoveBlock = useCallback(
    (
      fromDk: string,
      fromRoom: Room,
      fromSlot: number,
      toDk: string,
      toRoom: Room,
      toStartSlot: number,
    ) => {
      setSlotCells((prev) =>
        cellMapApplyMove(
          prev,
          fromDk,
          fromRoom,
          fromSlot,
          toDk,
          toRoom,
          toStartSlot,
          arten,
          mitarbeiter,
        ) ?? prev,
      )
    },
    [arten, mitarbeiter, setSlotCells],
  )

  const applyResizeBlock = useCallback(
    (
      dropDk: string,
      dropRoom: Room,
      targetSlot: number,
      payload: {
        fromDk: string
        fromRoom: Room
        edge: 'top' | 'bottom'
        anchorSlot: number
      },
    ) => {
      setSlotCells((prev) =>
        cellMapApplyResize(
          prev,
          dropDk,
          dropRoom,
          targetSlot,
          payload,
          arten,
          mitarbeiter,
        ) ?? prev,
      )
    },
    [arten, mitarbeiter, setSlotCells],
  )

  const applyDrop = useCallback(
    (
      dk: string,
      room: Room,
      startSlot: number,
      payload: PanelDragPayload,
    ) => {
      const patientById = (id: string) => patients.find((p) => p.id === id)
      const artById = (id: string) => arten.find((a) => a.id === id)
      const musterById = (id: string) => muster.find((m) => m.id === id)
      const staffById = (id: string) => mitarbeiter.find((s) => s.id === id)
      const wd = weekdayMon0FromDate(parseDateKey(dk))

      if (payload.kind === 'art') {
        const a = artById(payload.id)
        if (!a) return
        const blocked = isTeamMeetingArt(a)
          ? teamMeetingFromPanelBlockedReason(
              slotCellsRef.current,
              dk,
              room,
              startSlot,
              a,
            )
          : artFromPanelBlockedReason(
              slotCellsRef.current,
              dk,
              room,
              startSlot,
              a,
              mitarbeiter,
            )
        if (blocked) {
          alertOnce(blocked)
          return
        }
      }

      setSlotCells((prev) => {
        const max = slotCount()

        if (payload.kind === 'patient') {
          const p = patientById(payload.id)
          if (!p) return prev
          const k = makeSlotKey(dk, room, startSlot)
          const { start, end } = findBlockBounds(prev, dk, room, startSlot)
          const anchorK = makeSlotKey(dk, room, start)
          const anchorCell = prev[anchorK]
          if (findArtIdForCell(anchorCell, arten) === TEAM_MEETING_ART_ID) {
            alertOnce(
              'Patienten können nicht auf ein Teammeeting gezogen werden.',
            )
            return prev
          }

          if (!isCellBooked(prev[k])) {
            const cur = { ...(prev[k] ?? {}) }
            return {
              ...prev,
              [k]: { ...cur, patient: p.name, patientCode: p.patientCode },
            }
          }

          if (!anchorCell?.patient?.trim()) {
            for (let sl = start; sl <= end; sl++) {
              const kk = makeSlotKey(dk, room, sl)
              const c = prev[kk]
              if (c?.patient?.trim() && c.patient !== p.name) {
                alertOnce(
                  'Im gewählten Zeitraum ist bereits ein anderer Patient eingetragen.',
                )
                return prev
              }
            }
            const next = { ...prev }
            for (let sl = start; sl <= end; sl++) {
              const kk = makeSlotKey(dk, room, sl)
              const cur = { ...(next[kk] ?? {}) }
              next[kk] = {
                ...cur,
                patient: p.name,
                patientCode: p.patientCode,
              }
            }
            return next
          }

          alertOnce(
            'Bitte ein freies Feld oder einen Termin ohne Patient wählen.',
          )
          return prev
        }

        if (payload.kind === 'art') {
          const a = artById(payload.id)
          if (!a) return prev
          const startK = makeSlotKey(dk, room, startSlot)
          const startCur = prev[startK]
          const pname =
            !isTeamMeetingArt(a) && startCur?.patient?.trim()
              ? startCur.patient
              : undefined
          const pcode =
            !isTeamMeetingArt(a) && startCur?.patient?.trim()
              ? startCur.patientCode
              : undefined

          const blockedAgain = isTeamMeetingArt(a)
            ? teamMeetingFromPanelBlockedReason(
                prev,
                dk,
                room,
                startSlot,
                a,
              )
            : artFromPanelBlockedReason(
                prev,
                dk,
                room,
                startSlot,
                a,
                mitarbeiter,
              )
          if (blockedAgain) {
            return prev
          }
          const span = Math.min(Math.max(1, a.slots), max - startSlot)
          const next = { ...prev }
          for (let i = 0; i < span; i++) {
            const k = makeSlotKey(dk, room, startSlot + i)
            const cur = { ...(next[k] ?? {}) }
            const base: CellData = {
              ...cur,
              ...(pname
                ? { patient: pname, patientCode: pcode }
                : {}),
              art: a.label,
              artId: a.id,
              artColor: a.color,
            }
            if (isTeamMeetingArt(a)) {
              delete base.patient
              delete base.patientCode
              delete base.staff
              delete base.staffId
              delete base.teamStaffIds
            }
            next[k] = base
          }
          if (isTeamMeetingArt(a)) {
            queueMicrotask(() =>
              setTerminPickerModal({
                kind: 'teamMeeting',
                dk,
                room,
                anchorSlot: startSlot,
              }),
            )
          }
          return next
        }

        if (payload.kind === 'muster') {
          const m = musterById(payload.id)
          if (!m) return prev
          const musterStamp: MusterApplyStamp = { label: m.label }
          const weekStart = startOfWeekMonday(parseDateKey(dk))
          const { start: blockStart } = findBlockBounds(prev, dk, room, startSlot)
          const anchorK = makeSlotKey(dk, room, blockStart)
          const anchor = prev[anchorK]
          if (anchor?.patient?.trim()) {
            queueMicrotask(() =>
              setMusterUsageCountById((c) => ({
                ...c,
                [m.id]: (c[m.id] ?? 0) + 1,
              })),
            )
            return applyMusterWithPatientWeek(
              prev,
              weekStart,
              m.templateCells,
              anchor.patient,
              anchor.patientCode,
              arten,
              mitarbeiter,
              { dk, room, slotIndex: blockStart },
              effectiveMusterTemplateWeekCount(m),
              musterStamp,
            )
          }
          queueMicrotask(() =>
            setMusterUsageCountById((c) => ({
              ...c,
              [m.id]: (c[m.id] ?? 0) + 1,
            })),
          )
          return applyMusterWithPatientWeek(
            prev,
            weekStart,
            m.templateCells,
            '',
            undefined,
            arten,
            mitarbeiter,
            { dk, room, slotIndex: blockStart },
            effectiveMusterTemplateWeekCount(m),
            musterStamp,
          )
        }

        if (payload.kind === 'staff') {
          const s = staffById(payload.id)
          if (!s) return prev
          const { start, end } = findTerminBlockBoundsIgnoringStaff(
            prev,
            dk,
            room,
            startSlot,
          )
          const startK = makeSlotKey(dk, room, start)
          if (!isCellBooked(prev[startK])) return prev
          const anchorCell = prev[startK]
          if (findArtIdForCell(anchorCell, arten) === TEAM_MEETING_ART_ID) {
            alertOnce(
              'Teammeetings: Teilnehmer bitte im Termin-Dialog (Klick auf den Termin) auswählen.',
            )
            return prev
          }
          for (let sl = start; sl <= end; sl++) {
            if (isStaffAbsentAtSlot(s, dk, sl)) {
              alertOnce(
                'Der Mitarbeiter ist in diesem Zeitraum als abwesend (Urlaub/Abwesenheit) eingetragen.',
              )
              return prev
            }
            if (!isStaffSlotAvailable(s, wd, sl, dk)) {
              alertOnce(
                'Dieser Mitarbeiter ist zu dieser Zeit in seinem Wochenplan nicht als verfügbar markiert.',
              )
              return prev
            }
            const kk = makeSlotKey(dk, room, sl)
            const curSl = prev[kk]
            const artId = findArtIdForCell(curSl, arten)
            if (artId && !staffHasArtAllowed(s, artId)) {
              alertOnce(
                'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.',
              )
              return prev
            }
          }
          const next = { ...prev }
          for (let sl = start; sl <= end; sl++) {
            const k = makeSlotKey(dk, room, sl)
            const cur = { ...(next[k] ?? {}) }
            next[k] = { ...cur, staff: s.name, staffId: s.id }
          }
          return next
        }

        return prev
      })
    },
    [patients, arten, muster, mitarbeiter, setTerminPickerModal, setSlotCells],
  )

  useEffect(() => {
    if (terminPickerModal?.kind !== 'teamMeeting') return
    const { dk, room, anchorSlot } = terminPickerModal
    const { start } = findBlockBounds(slotCells, dk, room, anchorSlot)
    const anchor = slotCells[makeSlotKey(dk, room, start)]
    setTeamMeetingSelectedIds(
      anchor?.teamStaffIds?.length ? [...anchor.teamStaffIds] : [],
    )
    setTeamMeetingRepeatWeeks(1)
  }, [terminPickerModal, slotCells])

  const handleDropOnSlot = useCallback(
    (e: React.DragEvent, dk: string, room: Room, slotIndex: number) => {
      e.preventDefault()
      setDragOverKey(null)
      setArtDragHighlight(null)
      if (calendarTabId !== 'main') return
      const payload = parseDragPayload(e.dataTransfer)
      if (!payload) return
      if (payload.kind === 'moveBlock') {
        applyMoveBlock(
          payload.fromDk,
          payload.fromRoom,
          payload.fromSlot,
          dk,
          room,
          slotIndex,
        )
        return
      }
      if (payload.kind === 'resizeBlock') {
        applyResizeBlock(dk, room, slotIndex, payload)
        return
      }
      applyDrop(dk, room, slotIndex, payload)
    },
    [applyDrop, applyMoveBlock, applyResizeBlock, calendarTabId],
  )

  const handleDropOnWeekCell = useCallback(
    (e: React.DragEvent, dk: string, room: Room) => {
      e.preventDefault()
      setDragOverKey(null)
      setArtDragHighlight(null)
      if (calendarTabId !== 'main') return
      const payload = parseDragPayload(e.dataTransfer)
      if (!payload) return
      if (payload.kind === 'moveBlock') {
        applyMoveBlock(
          payload.fromDk,
          payload.fromRoom,
          payload.fromSlot,
          dk,
          room,
          0,
        )
        return
      }
      if (payload.kind === 'resizeBlock') {
        return
      }
      if (payload.kind === 'muster') {
        const m = muster.find((x) => x.id === payload.id)
        if (!m) return
        const musterStamp: MusterApplyStamp = { label: m.label }
        const weekStart = startOfWeekMonday(parseDateKey(dk))
        const max = slotCount()
        setSlotCells((prev) => {
          let anchorPatient: {
            name: string
            code: string | undefined
            anchorSlot: number
          } | null = null
          for (let sl = 0; sl < max; sl++) {
            const c = prev[makeSlotKey(dk, room, sl)]
            if (!c?.patient?.trim()) continue
            const { start } = findBlockBounds(prev, dk, room, sl)
            const ak = makeSlotKey(dk, room, start)
            const a = prev[ak]
            if (a?.patient?.trim()) {
              anchorPatient = {
                name: a.patient,
                code: a.patientCode,
                anchorSlot: start,
              }
              break
            }
          }
          if (anchorPatient) {
            queueMicrotask(() =>
              setMusterUsageCountById((c) => ({
                ...c,
                [m.id]: (c[m.id] ?? 0) + 1,
              })),
            )
            return applyMusterWithPatientWeek(
              prev,
              weekStart,
              m.templateCells,
              anchorPatient.name,
              anchorPatient.code,
              arten,
              mitarbeiter,
              { dk, room, slotIndex: anchorPatient.anchorSlot },
              effectiveMusterTemplateWeekCount(m),
              musterStamp,
            )
          }
          const res = tryApplyMusterWeekToSlots(
            prev,
            weekStart,
            m.templateCells,
            arten,
            effectiveMusterTemplateWeekCount(m),
            musterStamp,
          )
          if ('error' in res) {
            alertOnce(res.error)
            return prev
          }
          queueMicrotask(() =>
            setMusterUsageCountById((c) => ({
              ...c,
              [m.id]: (c[m.id] ?? 0) + 1,
            })),
          )
          return res.next
        })
        return
      }
      applyDrop(dk, room, 0, payload)
    },
    [
      applyDrop,
      applyMoveBlock,
      muster,
      arten,
      mitarbeiter,
      calendarTabId,
      setSlotCells,
    ],
  )

  const toggleSlot = useCallback((dk: string, room: Room, slotIndex: number) => {
    const k = makeSlotKey(dk, room, slotIndex)
    setSlotCells((prev) => {
      const next = { ...prev }
      if (isCellBooked(next[k])) {
        delete next[k]
      } else {
        next[k] = { art: 'Belegung' }
      }
      return next
    })
  }, [setSlotCells])

  const closeTerminPickerModal = useCallback(() => {
    setTerminPickerModal(null)
  }, [])

  const exportTerminToIcs = useCallback(() => {
    if (!terminPickerModal) return
    const { dk, room, anchorSlot } = terminPickerModal
    const pair = cellDataToPatientExportPair(
      slotCells,
      dk,
      room,
      anchorSlot,
      mitarbeiter,
    )
    if (!pair) {
      alertOnce('Kein gültiger Termin für den Export.')
      return
    }
    const fileBase = safeIcsZipPathSegment(
      `termin-${pair.row.dk}-${pair.row.room}-s${pair.row.startSlot}`,
      90,
    )
    downloadSingleTerminIcsFile(pair.patient, pair.row, fileBase)
  }, [terminPickerModal, slotCells, mitarbeiter])

  const assignArtToTerminFromModal = useCallback(
    (artId: string) => {
      if (!terminPickerModal || terminPickerModal.kind !== 'art') return
      const { dk, room, anchorSlot } = terminPickerModal
      const { start } = findTerminBlockBoundsIgnoringStaff(
        slotCells,
        dk,
        room,
        anchorSlot,
      )
      applyDrop(dk, room, start, { kind: 'art', id: artId })
      setTerminPickerModal(null)
    },
    [terminPickerModal, slotCells, applyDrop],
  )

  const assignStaffToTerminBlock = useCallback(
    (staffId: string) => {
      if (!terminPickerModal || terminPickerModal.kind !== 'staff') return
      const { dk, room, anchorSlot } = terminPickerModal
      const s = mitarbeiter.find((x) => x.id === staffId)
      if (!s) return
      setSlotCells((prev) => {
        const { start, end } = findTerminBlockBoundsIgnoringStaff(
          prev,
          dk,
          room,
          anchorSlot,
        )
        const startK = makeSlotKey(dk, room, start)
        if (!isCellBooked(prev[startK])) return prev
        const wd = weekdayMon0FromDate(parseDateKey(dk))
        for (let sl = start; sl <= end; sl++) {
          if (isStaffAbsentAtSlot(s, dk, sl)) {
            alertOnce(
              'Der Mitarbeiter ist in diesem Zeitraum als abwesend (Urlaub/Abwesenheit) eingetragen.',
            )
            return prev
          }
          if (!isStaffSlotAvailable(s, wd, sl, dk)) {
            alertOnce(
              'Dieser Mitarbeiter ist zu dieser Zeit in seinem Wochenplan nicht als verfügbar markiert.',
            )
            return prev
          }
          const k = makeSlotKey(dk, room, sl)
          const cur = prev[k]
          const artId = findArtIdForCell(cur, arten)
          if (artId && !staffHasArtAllowed(s, artId)) {
            alertOnce(
              'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.',
            )
            return prev
          }
        }
        const next = { ...prev }
        for (let sl = start; sl <= end; sl++) {
          const k = makeSlotKey(dk, room, sl)
          const cur = { ...(next[k] ?? {}) }
          next[k] = { ...cur, staff: s.name, staffId: s.id }
        }
        return next
      })
      setTerminPickerModal(null)
    },
    [terminPickerModal, mitarbeiter, arten, setSlotCells, setTerminPickerModal],
  )

  const removeStaffFromTerminBlock = useCallback(() => {
    if (!terminPickerModal || terminPickerModal.kind !== 'staff') return
    const { dk, room, anchorSlot } = terminPickerModal
    setSlotCells((prev) => {
      const { start, end } = findBlockBounds(prev, dk, room, anchorSlot)
      const next = { ...prev }
      for (let sl = start; sl <= end; sl++) {
        const k = makeSlotKey(dk, room, sl)
        const cur = next[k]
        if (!cur) continue
        const { staff: _st, staffId: _sid, ...rest } = cur
        if (!isCellBooked(rest)) delete next[k]
        else next[k] = rest
      }
      return next
    })
    setTerminPickerModal(null)
  }, [terminPickerModal, setSlotCells, setTerminPickerModal])

  const removeTeamParticipantsFromModal = useCallback(() => {
    if (!terminPickerModal || terminPickerModal.kind !== 'teamMeeting') return
    const { dk, room, anchorSlot } = terminPickerModal
    setSlotCells((prev) => {
      const { start, end } = findBlockBounds(prev, dk, room, anchorSlot)
      const next = { ...prev }
      for (let sl = start; sl <= end; sl++) {
        const k = makeSlotKey(dk, room, sl)
        const cur = next[k]
        if (!cur) continue
        const { teamStaffIds: _t, ...rest } = cur
        next[k] = rest
      }
      return next
    })
    setTerminPickerModal(null)
  }, [terminPickerModal, setSlotCells, setTerminPickerModal])

  const applyTeamMeetingParticipantsToSingleOccurrence = useCallback(
    (dk: string, room: Room, anchorSlot: number, selectedIds: string[]) => {
      const art = arten.find((a) => a.id === TEAM_MEETING_ART_ID)
      if (!art) return
      setSlotCells((prev) => {
        const { start, end } = findBlockBounds(prev, dk, room, anchorSlot)
        const wd = weekdayMon0FromDate(parseDateKey(dk))
        const eligible = selectedIds.filter((id) => {
          const s = mitarbeiter.find((m) => m.id === id)
          if (!s) return false
          if (!staffHasArtAllowed(s, TEAM_MEETING_ART_ID)) return false
          for (let sl = start; sl <= end; sl++) {
            if (isStaffAbsentAtSlot(s, dk, sl)) return false
            if (!isStaffSlotAvailableForDate(s, dk, wd, sl)) return false
          }
          return true
        })
        const next = { ...prev }
        for (let sl = start; sl <= end; sl++) {
          const k = makeSlotKey(dk, room, sl)
          const cur = { ...(next[k] ?? {}) }
          const out: CellData = {
            ...cur,
            art: art.label,
            artId: art.id,
            artColor: art.color,
          }
          if (eligible.length) out.teamStaffIds = [...eligible]
          else delete out.teamStaffIds
          next[k] = out
        }
        return next
      })
    },
    [arten, mitarbeiter, setSlotCells],
  )

  const saveTeamMeetingFromModal = useCallback(() => {
    if (!terminPickerModal || terminPickerModal.kind !== 'teamMeeting') return
    const { dk, room, anchorSlot } = terminPickerModal
    const art = arten.find((a) => a.id === TEAM_MEETING_ART_ID)
    if (!art) return
    const repeatWeeks = Math.max(1, Math.min(52, teamMeetingRepeatWeeks))
    const selected = teamMeetingSelectedIds

    setSlotCells((prev) => {
      const next = { ...prev }
      const { start, end } = findBlockBounds(prev, dk, room, anchorSlot)
      const span = end - start + 1

      for (let w = 0; w < repeatWeeks; w++) {
        const d = addDays(parseDateKey(dk), w * 7)
        const dkW = dateKey(d)
        const wd = weekdayMon0FromDate(parseDateKey(dkW))

        const eligibleForWeek = selected.filter((id) => {
          const s = mitarbeiter.find((m) => m.id === id)
          if (!s) return false
          if (!staffHasArtAllowed(s, TEAM_MEETING_ART_ID)) return false
          for (let sl = start; sl <= end; sl++) {
            if (isStaffAbsentAtSlot(s, dkW, sl)) return false
            if (!isStaffSlotAvailableForDate(s, dkW, wd, sl)) return false
          }
          return true
        })

        if (w > 0) {
          const blocked = teamMeetingFromPanelBlockedReason(
            next,
            dkW,
            room,
            start,
            art,
          )
          if (blocked) continue
        }

        for (let i = 0; i < span; i++) {
          const k = makeSlotKey(dkW, room, start + i)
          const cur = { ...(next[k] ?? {}) }
          const teamStaffIds =
            eligibleForWeek.length > 0 ? [...eligibleForWeek] : undefined
          const nk: CellData = {
            ...cur,
            art: art.label,
            artId: art.id,
            artColor: art.color,
            patient: undefined,
            patientCode: undefined,
            staff: undefined,
            staffId: undefined,
          }
          if (teamStaffIds) nk.teamStaffIds = teamStaffIds
          else delete nk.teamStaffIds
          next[k] = nk
        }
      }
      return next
    })
    setTerminPickerModal(null)
  }, [
    terminPickerModal,
    arten,
    teamMeetingRepeatWeeks,
    teamMeetingSelectedIds,
    mitarbeiter,
    setSlotCells,
    setTerminPickerModal,
  ])

  const clearTerminBlockFromModal = useCallback(() => {
    if (!terminPickerModal) return
    if (!window.confirm('Den gesamten Termin in diesem Zeitraum leeren?')) return
    const { dk, room, anchorSlot } = terminPickerModal
    setSlotCells((prev) => {
      const { start, end } = findBlockBounds(prev, dk, room, anchorSlot)
      const next = { ...prev }
      for (let sl = start; sl <= end; sl++) {
        delete next[makeSlotKey(dk, room, sl)]
      }
      return next
    })
    setTerminPickerModal(null)
  }, [terminPickerModal, setSlotCells, setTerminPickerModal])

  const openDayForCell = useCallback((d: Date) => {
    setAnchorDate(calendarDate(d))
    setViewMode('day')
  }, [])

  const goToKollisionTermin = useCallback(
    (anchorKey: string) => {
      const pos = parseKollisionAnchorKey(anchorKey)
      if (!pos) return
      setCalendarTabId('main')
      pendingScrollToTerminSlotRef.current = pos.slot
      openDayForCell(parseDateKey(pos.dk))
    },
    [openDayForCell],
  )

  const closeStaffTerminDetailModal = useCallback(() => {
    setStaffTerminDetailModal(null)
  }, [])

  const openStaffTerminDetailInMainCalendar = useCallback(() => {
    if (!staffTerminDetailModal) return
    const { dk, blocks } = staffTerminDetailModal
    if (blocks.length === 0) return
    const { room, anchorSlot } = blocks[0]!
    const { start } = findBlockBounds(slotCells, dk, room, anchorSlot)
    setStaffTerminDetailModal(null)
    goToKollisionTermin(makeSlotKey(dk, room, start))
  }, [staffTerminDetailModal, slotCells, goToKollisionTermin])

  useEffect(() => {
    if (!terminPickerModal) {
      setTerminNotizDraft('')
      return
    }
    const { kind, dk, room, anchorSlot } = terminPickerModal
    const { start } =
      kind === 'teamMeeting'
        ? findBlockBounds(slotCells, dk, room, anchorSlot)
        : findTerminBlockBoundsIgnoringStaff(slotCells, dk, room, anchorSlot)
    const sample = slotCells[makeSlotKey(dk, room, start)]
    setTerminNotizDraft(sample?.notiz?.trim() ?? '')
  }, [terminPickerModal, slotCells])

  useEffect(() => {
    if (!staffTerminDetailModal) {
      setStaffTerminNoteDrafts([])
      return
    }
    const { dk, blocks } = staffTerminDetailModal
    setStaffTerminNoteDrafts(
      blocks.map((block) => {
        const { start } = findBlockBounds(
          slotCells,
          dk,
          block.room,
          block.anchorSlot,
        )
        return slotCells[makeSlotKey(dk, block.room, start)]?.notiz?.trim() ?? ''
      }),
    )
  }, [staffTerminDetailModal, slotCells])

  const saveTerminNotizFromModal = useCallback(() => {
    if (!terminPickerModal) return
    const { kind, dk, room, anchorSlot } = terminPickerModal
    const trimmed = terminNotizDraft.trim()
    setSlotCells((prev) => {
      const { start, end } =
        kind === 'teamMeeting'
          ? findBlockBounds(prev, dk, room, anchorSlot)
          : findTerminBlockBoundsIgnoringStaff(prev, dk, room, anchorSlot)
      const next = { ...prev }
      for (let sl = start; sl <= end; sl++) {
        const k = makeSlotKey(dk, room, sl)
        const cur = next[k]
        if (!cur || !isCellBooked(cur)) continue
        next[k] = { ...cur, notiz: trimmed || undefined }
      }
      return next
    })
  }, [terminPickerModal, terminNotizDraft, setSlotCells])

  const saveStaffTerminNotizAt = useCallback(
    (blockIndex: number, text: string) => {
      if (!staffTerminDetailModal) return
      const block = staffTerminDetailModal.blocks[blockIndex]
      if (!block) return
      const trimmed = text.trim()
      const { dk } = staffTerminDetailModal
      setSlotCells((prev) => {
        const { start, end } = findBlockBounds(
          prev,
          dk,
          block.room,
          block.anchorSlot,
        )
        const next = { ...prev }
        for (let sl = start; sl <= end; sl++) {
          const k = makeSlotKey(dk, block.room, sl)
          const cur = next[k]
          if (!cur || !isCellBooked(cur)) continue
          next[k] = { ...cur, notiz: trimmed || undefined }
        }
        return next
      })
    },
    [staffTerminDetailModal, setSlotCells],
  )

  const navPrev = () => {
    if (viewMode === 'day') setAnchorDate((d) => addDays(d, -1))
    else setAnchorDate((d) => addDays(d, -7))
  }

  const navNext = () => {
    if (viewMode === 'day') setAnchorDate((d) => addDays(d, 1))
    else setAnchorDate((d) => addDays(d, 7))
  }

  const headerLabel =
    viewMode === 'day'
      ? anchorDate.toLocaleDateString('de-DE', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : `KW ${getWeekNumber(weekStart)} · ${formatWeekRange(weekStart)}`

  const slots = slotCount()

  const draggedArtForPreview = useMemo(
    () =>
      artDragHighlight
        ? arten.find((x) => x.id === artDragHighlight.artId)
        : undefined,
    [artDragHighlight, arten],
  )

  const artDropPreview = useMemo(() => {
    if (!artDragHighlight || viewMode !== 'day' || calendarTabId !== 'main')
      return null
    const a = arten.find((x) => x.id === artDragHighlight.artId)
    if (!a) return null
    const fullKeys = new Set<string>()
    const partialKeys = new Set<string>()
    const dk = activeDayKey
    const wd = weekdayMon0FromDate(parseDateKey(dk))
    const artSpanSlots = Math.max(1, a.slots)
    for (const room of ROOMS) {
      for (let sl = 0; sl < slots; sl++) {
        const k = makeSlotKey(dk, room, sl)
        if (
          cellIsValidArtPanelDropPreview(
            slotCells,
            dk,
            room,
            sl,
            a,
            mitarbeiter,
          )
        ) {
          fullKeys.add(k)
        } else if (
          artSpanSlots > 1 &&
          !slotIndexInCalendarLunchPause(sl) &&
          (isTeamMeetingArt(a)
            ? someStaffEligibleForTeamMeetingSlot(
                mitarbeiter,
                a.id,
                dk,
                wd,
                sl,
              )
            : someStaffCanTreatArtAtSingleSlot(
                mitarbeiter,
                a.id,
                dk,
                wd,
                sl,
              ))
        ) {
          partialKeys.add(k)
        }
      }
    }
    return { color: artDragHighlight.color, fullKeys, partialKeys }
  }, [
    artDragHighlight,
    viewMode,
    calendarTabId,
    slotCells,
    arten,
    mitarbeiter,
    activeDayKey,
    slots,
  ])

  const now = new Date()
  const isToday = dateKey(anchorDate) === dateKey(now)
  const currentSlot =
    isToday && viewMode === 'day'
      ? Math.floor(
          (now.getHours() * 60 + now.getMinutes() - DAY_START_HOUR * 60) /
            SLOT_MINUTES,
        )
      : -1

  const weekHasToday = weekDays.some((d) => dateKey(d) === dateKey(now))
  const minsNowClamped =
    now.getHours() * 60 + now.getMinutes() - DAY_START_HOUR * 60
  const slotNowInDay =
    minsNowClamped >= 0 &&
    minsNowClamped < (DAY_END_HOUR - DAY_START_HOUR) * 60
      ? Math.floor(minsNowClamped / SLOT_MINUTES)
      : -1

  const terminModalDetail = useMemo(() => {
    if (!terminPickerModal) return null
    const { kind, dk, room, anchorSlot } = terminPickerModal
    const { start, end } =
      kind === 'teamMeeting'
        ? findBlockBounds(slotCells, dk, room, anchorSlot)
        : findTerminBlockBoundsIgnoringStaff(slotCells, dk, room, anchorSlot)
    const startK = makeSlotKey(dk, room, start)
    const sample = slotCells[startK]
    if (!sample || !isCellBooked(sample)) return null
    const line = cellDisplayLine(sample, mitarbeiter)
    const timeRange =
      start === end
        ? slotIndexToLabel(start)
        : `${slotIndexToLabel(start)}–${slotIndexToLabel(end)}`
    return {
      kind,
      room,
      line,
      timeRange,
      currentStaff: sample.staff,
      currentStaffId: sample.staffId,
      blockArtId: findArtIdForCell(sample, arten),
    }
  }, [terminPickerModal, slotCells, arten, mitarbeiter])

  const teamMeetingEligibleStaffForModal = useMemo(() => {
    if (!terminPickerModal || terminPickerModal.kind !== 'teamMeeting') return null
    const { dk, room, anchorSlot } = terminPickerModal
    const { start, end } = findBlockBounds(slotCells, dk, room, anchorSlot)
    const wd = weekdayMon0FromDate(parseDateKey(dk))
    return mitarbeiter
      .filter((st) => staffHasArtAllowed(st, TEAM_MEETING_ART_ID))
      .filter((st) => {
        for (let sl = start; sl <= end; sl++) {
          if (isStaffAbsentAtSlot(st, dk, sl)) return false
          if (!isStaffSlotAvailableForDate(st, dk, wd, sl)) return false
        }
        return true
      })
  }, [terminPickerModal, slotCells, mitarbeiter])

  /** Hauptkalender · Mitarbeiter-Zuordnung: nur MA mit Freigabe für die Art und Verfügbarkeit auf jedem Slot des Blocks */
  const staffPickListForTerminModal = useMemo(() => {
    if (!terminPickerModal || terminPickerModal.kind !== 'staff') return null
    const { dk, room, anchorSlot } = terminPickerModal
    const { start, end } = findTerminBlockBoundsIgnoringStaff(
      slotCells,
      dk,
      room,
      anchorSlot,
    )
    const startK = makeSlotKey(dk, room, start)
    const sample = slotCells[startK]
    if (!sample || !isCellBooked(sample)) return null
    const wd = weekdayMon0FromDate(parseDateKey(dk))
    const artId = findArtIdForCell(sample, arten)
    const span = end - start + 1
    if (artId) {
      return staffWhoCanPerformArtOnWholeSpan(
        mitarbeiter,
        artId,
        dk,
        wd,
        start,
        span,
      )
    }
    return mitarbeiter.filter((s) => {
      for (let sl = start; sl <= end; sl++) {
        if (!isStaffSlotAvailableForDate(s, dk, wd, sl)) return false
      }
      return true
    })
  }, [terminPickerModal, slotCells, mitarbeiter, arten])

  const endPanelOrCellDrag = useCallback(() => {
    dragSourceRef.current = null
    setMusterEditorDragOverKey(null)
    setArtDragHighlight(null)
  }, [])

  const onDragStart = (e: React.DragEvent, payload: PanelDragPayload) => {
    dragSourceRef.current = 'panel'
    if (payload.kind === 'art') {
      const a = arten.find((x) => x.id === payload.id)
      setArtDragHighlight({
        artId: payload.id,
        color: a?.color ?? '#64748b',
      })
    } else {
      setArtDragHighlight(null)
    }
    const s = JSON.stringify(payload)
    e.dataTransfer.setData(MIME_PHYSIO, s)
    e.dataTransfer.setData('text/plain', s)
    e.dataTransfer.effectAllowed = 'copy'
  }

  const startCellMoveDrag = (
    e: React.DragEvent,
    fromDk: string,
    fromRoom: Room,
    fromSlot: number,
  ) => {
    dragSourceRef.current = 'cell'
    const payload: DragPayload = {
      kind: 'moveBlock',
      fromDk,
      fromRoom,
      fromSlot,
    }
    const s = JSON.stringify(payload)
    e.dataTransfer.setData(MIME_PHYSIO, s)
    e.dataTransfer.setData('text/plain', s)
    e.dataTransfer.effectAllowed = 'move'
  }

  const startResizeDrag = (
    e: React.DragEvent,
    fromDk: string,
    fromRoom: Room,
    edge: 'top' | 'bottom',
    anchorSlot: number,
  ) => {
    dragSourceRef.current = 'resize'
    const payload: DragPayload = {
      kind: 'resizeBlock',
      fromDk,
      fromRoom,
      edge,
      anchorSlot,
    }
    const s = JSON.stringify(payload)
    e.dataTransfer.setData(MIME_PHYSIO, s)
    e.dataTransfer.setData('text/plain', s)
    e.dataTransfer.effectAllowed = 'copy'
  }

  const addPatient = () => {
    if (cloudSyncEnabled && !mayPatientWrite) {
      alertOnce('Keine Berechtigung zum Anlegen von Patienten.')
      return
    }
    const name = newPatientName.trim()
    const patientCode = newPatientCode.trim()
    if (!name || !patientCode) return
    setPatients((p) => [
      ...p,
      { id: `p-${Date.now()}`, name, patientCode },
    ])
    setNewPatientName('')
    setNewPatientCode('')
  }

  const cancelEditPatient = useCallback(() => {
    setEditingPatientId(null)
    setEditPatientName('')
    setEditPatientCode('')
  }, [])

  const startEditPatient = (p: PatientItem) => {
    if (cloudSyncEnabled && !mayPatientWrite) {
      alertOnce('Keine Berechtigung zum Bearbeiten von Patienten.')
      return
    }
    setEditingPatientId(p.id)
    setEditPatientName(p.name)
    setEditPatientCode(p.patientCode)
  }

  const saveEditPatient = () => {
    if (cloudSyncEnabled && !mayPatientWrite) return
    const name = editPatientName.trim()
    const patientCode = editPatientCode.trim()
    if (!editingPatientId || !name || !patientCode) return
    setPatients((list) =>
      list.map((x) =>
        x.id === editingPatientId ? { ...x, name, patientCode } : x,
      ),
    )
    cancelEditPatient()
  }

  const deletePatient = (p: PatientItem) => {
    if (cloudSyncEnabled && !mayPatientWrite) {
      alertOnce('Keine Berechtigung zum Löschen von Patienten.')
      return
    }
    if (
      !window.confirm(
        `Patient „${p.name}“ (${p.patientCode}) wirklich löschen?`,
      )
    ) {
      return
    }
    setPatients((list) => list.filter((x) => x.id !== p.id))
    if (editingPatientId === p.id) cancelEditPatient()
  }

  const openPatientExportModal = useCallback(() => {
    const { from, to } = defaultPatientExportDateRange()
    setPatientExportFrom(from)
    setPatientExportTo(to)
    setPatientExportQuery('')
    setPatientExportSelectedId(null)
    setPatientExportStep(1)
    setPatientExportOpen(true)
  }, [])

  const closePatientExportModal = useCallback(() => {
    setPatientExportOpen(false)
  }, [])

  const openStaffExportModal = useCallback(() => {
    const { from, to } = defaultPatientExportDateRange()
    setStaffExportFrom(from)
    setStaffExportTo(to)
    setStaffExportQuery('')
    setStaffExportSelectedId(null)
    setStaffExportStep(1)
    setStaffExportOpen(true)
  }, [])

  const closeStaffExportModal = useCallback(() => {
    setStaffExportOpen(false)
  }, [])

  const openRoomExportModal = useCallback(() => {
    const { from, to } = defaultPatientExportDateRange()
    setRoomExportFrom(from)
    setRoomExportTo(to)
    setRoomExportRoom(null)
    setRoomExportStep(1)
    setRoomExportOpen(true)
  }, [])

  const closeRoomExportModal = useCallback(() => {
    setRoomExportOpen(false)
  }, [])

  const patientsFilteredForExport = useMemo(() => {
    const q = patientExportQuery.trim().toLowerCase()
    if (q === '') return patients
    return patients.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.patientCode.toLowerCase().includes(q),
    )
  }, [patients, patientExportQuery])

  const staffFilteredForExport = useMemo(() => {
    const q = staffExportQuery.trim().toLowerCase()
    if (q === '') return mitarbeiter
    return mitarbeiter.filter((s) => s.name.toLowerCase().includes(q))
  }, [mitarbeiter, staffExportQuery])

  const runPatientExportDownloads = useCallback(async () => {
    const p = patients.find((x) => x.id === patientExportSelectedId)
    if (!p) {
      alertOnce('Bitte einen Patienten auswählen.')
      return
    }
    let from = patientExportFrom
    let to = patientExportTo
    if (!from || !to) {
      alertOnce('Bitte Von- und Bis-Datum wählen.')
      return
    }
    if (from > to) {
      const t = from
      from = to
      to = t
    }
    const rows = collectPatientAppointmentsInRange(slotCells, p, from, to)
    if (rows.length === 0) {
      alertOnce(
        'Im gewählten Zeitraum wurden keine Termine für diesen Patienten gefunden.',
      )
      return
    }
    const safeName = p.name.replace(/[^\wäöüÄÖÜß-]+/gi, '_').slice(0, 40)
    const stamp = dateKey(calendarDate(new Date()))
    const base = `termine-${safeName}-${stamp}`
    await downloadPatientAppointmentsPdf(p, rows, base)
    await downloadPatientAppointmentsIcsZipFolder(p, rows, base)
    setPatientExportOpen(false)
  }, [
    patients,
    patientExportSelectedId,
    patientExportFrom,
    patientExportTo,
    slotCells,
  ])

  const runStaffExportPdf = useCallback(async () => {
    const s = mitarbeiter.find((x) => x.id === staffExportSelectedId)
    if (!s) {
      alertOnce('Bitte einen Mitarbeiter auswählen.')
      return
    }
    let from = staffExportFrom
    let to = staffExportTo
    if (!from || !to) {
      alertOnce('Bitte Von- und Bis-Datum wählen.')
      return
    }
    if (from > to) {
      const t = from
      from = to
      to = t
    }
    const rows = collectStaffAppointmentsInRange(slotCells, s, from, to)
    if (rows.length === 0) {
      alertOnce(
        'Im gewählten Zeitraum wurden keine Termine für diesen Mitarbeiter gefunden.',
      )
      return
    }
    const safeName = s.name.replace(/[^\wäöüÄÖÜß-]+/gi, '_').slice(0, 40)
    const stamp = dateKey(calendarDate(new Date()))
    const base = `mitarbeiter-termine-${safeName}-${stamp}`
    await downloadStaffAppointmentsPdf(s, rows, base)
    setStaffExportOpen(false)
  }, [
    mitarbeiter,
    staffExportSelectedId,
    staffExportFrom,
    staffExportTo,
    slotCells,
  ])

  const runRoomExportPdf = useCallback(async () => {
    if (!roomExportRoom) {
      alertOnce('Bitte einen Raum auswählen.')
      return
    }
    let from = roomExportFrom
    let to = roomExportTo
    if (!from || !to) {
      alertOnce('Bitte Von- und Bis-Datum wählen.')
      return
    }
    if (from > to) {
      const t = from
      from = to
      to = t
    }
    const safeRoom = roomExportRoom.replace(/[^\wäöüÄÖÜß-]+/gi, '_').slice(0, 32)
    const stamp = dateKey(calendarDate(new Date()))
    const base = `raum-${safeRoom}-${stamp}`
    await downloadRoomWeekLandscapePdf(slotCells, roomExportRoom, from, to, base)
    setRoomExportOpen(false)
  }, [roomExportRoom, roomExportFrom, roomExportTo, slotCells])

  const openStaffModalCreate = () => {
    if (cloudSyncEnabled && !mayStaffWrite) {
      alertOnce('Keine Berechtigung zum Anlegen von Mitarbeitenden.')
      return
    }
    setStaffDraftName('')
    setStaffDraftAvail(emptyStaffAvailability(slotCount()))
    setStaffDraftAvailOdd(emptyStaffAvailability(slotCount()))
    setStaffDraftAlternating(false)
    setStaffDraftArtIds([])
    setStaffModal({ mode: 'create' })
  }

  const openStaffModalEdit = (id: string) => {
    if (cloudSyncEnabled && !mayStaffWrite) {
      alertOnce('Keine Berechtigung zum Bearbeiten von Mitarbeitenden.')
      return
    }
    const s = mitarbeiter.find((x) => x.id === id)
    if (!s) return
    setStaffDraftName(s.name)
    setStaffDraftAvail({ ...s.availability })
    setStaffDraftAlternating(s.alternatingWeeklyAvailability === true)
    setStaffDraftAvailOdd(
      s.alternatingWeeklyAvailability && s.availabilityOddWeek
        ? { ...s.availabilityOddWeek }
        : emptyStaffAvailability(slotCount()),
    )
    setStaffDraftArtIds([...s.allowedArtIds])
    setStaffModal({ mode: 'edit', id })
  }

  const closeStaffModal = () => setStaffModal(null)

  const saveStaffModal = () => {
    if (!staffModal) return
    if (cloudSyncEnabled && !mayStaffWrite) {
      alertOnce('Keine Berechtigung zum Bearbeiten von Mitarbeitenden.')
      return
    }
    const name = staffDraftName.trim()
    if (!name) {
      alertOnce('Bitte einen Namen eingeben.')
      return
    }
    const slotsN = slotCount()
    const availability: Record<string, boolean> = {}
    for (let w = 0; w < 7; w++) {
      for (let sl = 0; sl < slotsN; sl++) {
        const k = staffAvailKey(w, sl)
        availability[k] = staffDraftAvail[k] === true
      }
    }
    let availabilityOddWeek: Record<string, boolean> | undefined
    if (staffDraftAlternating) {
      availabilityOddWeek = {}
      for (let w = 0; w < 7; w++) {
        for (let sl = 0; sl < slotsN; sl++) {
          const k = staffAvailKey(w, sl)
          availabilityOddWeek[k] = staffDraftAvailOdd[k] === true
        }
      }
    }
    const validArtIds = staffDraftArtIds.filter((id) =>
      arten.some((a) => a.id === id),
    )
    const existing =
      staffModal.mode === 'edit'
        ? mitarbeiter.find((x) => x.id === staffModal.id)
        : undefined
    const item: MitarbeiterItem = {
      id: staffModal.mode === 'create' ? `st-${Date.now()}` : staffModal.id,
      name,
      availability,
      alternatingWeeklyAvailability: staffDraftAlternating ? true : undefined,
      availabilityOddWeek,
      allowedArtIds: validArtIds,
      absences: existing?.absences,
    }
    if (staffModal.mode === 'create') {
      setMitarbeiter((list) => [...list, item])
    } else {
      setMitarbeiter((list) =>
        list.map((x) => (x.id === staffModal.id ? item : x)),
      )
    }
    setStaffModal(null)
  }

  const beginStaffAvailPaint = useCallback(
    (weekParity: 'even' | 'odd', w: number, sl: number) => {
      const k = staffAvailKey(w, sl)
      if (weekParity === 'odd') {
        setStaffDraftAvailOdd((a) => {
          const cur = a[k] === true
          const targetOn = !cur
          staffAvailPaintRef.current = {
            active: true,
            targetOn,
            weekParity: 'odd',
          }
          return { ...a, [k]: targetOn }
        })
      } else {
        setStaffDraftAvail((a) => {
          const cur = a[k] === true
          const targetOn = !cur
          staffAvailPaintRef.current = {
            active: true,
            targetOn,
            weekParity: 'even',
          }
          return { ...a, [k]: targetOn }
        })
      }
    },
    [],
  )

  const extendStaffAvailPaint = useCallback((w: number, sl: number) => {
    const p = staffAvailPaintRef.current
    if (!p?.active) return
    const k = staffAvailKey(w, sl)
    if (p.weekParity === 'odd') {
      setStaffDraftAvailOdd((a) => ({ ...a, [k]: p.targetOn }))
    } else {
      setStaffDraftAvail((a) => ({ ...a, [k]: p.targetOn }))
    }
  }, [])

  const endStaffAvailPaint = useCallback(() => {
    staffAvailPaintRef.current = null
  }, [])

  const toggleStaffDraftSlotKeyboard = useCallback(
    (weekParity: 'even' | 'odd', w: number, sl: number) => {
      const k = staffAvailKey(w, sl)
      if (weekParity === 'odd') {
        setStaffDraftAvailOdd((a) => ({ ...a, [k]: !a[k] }))
      } else {
        setStaffDraftAvail((a) => ({ ...a, [k]: !a[k] }))
      }
    },
    [],
  )

  useEffect(() => {
    if (!staffModal) {
      staffAvailPaintRef.current = null
      return
    }
    const end = () => endStaffAvailPaint()
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      staffAvailPaintRef.current = null
    }
  }, [staffModal, endStaffAvailPaint])

  const toggleStaffDraftArt = (artId: string) => {
    setStaffDraftArtIds((ids) =>
      ids.includes(artId) ? ids.filter((x) => x !== artId) : [...ids, artId],
    )
  }

  const selectAllStaffDraftArts = () => {
    setStaffDraftArtIds(arten.map((a) => a.id))
  }

  const clearAllStaffDraftArts = () => {
    setStaffDraftArtIds([])
  }

  const allStaffDraftArtsSelected =
    arten.length > 0 && arten.every((a) => staffDraftArtIds.includes(a.id))
  const noStaffDraftArtsSelected = staffDraftArtIds.length === 0

  const addBelegungsart = (): boolean => {
    if (cloudSyncEnabled && !mayArtenWrite) {
      alertOnce('Keine Berechtigung zum Bearbeiten der Belegungsarten.')
      return false
    }
    const label = newArtLabel.trim()
    if (!label) {
      alertOnce('Bitte eine Bezeichnung für die Belegungsart eingeben.')
      return false
    }
    const slots = Math.min(
      Math.max(1, Math.round(newArtMinutes / SLOT_MINUTES)),
      slotCount(),
    )
    const newId = `art-${Date.now()}`
    const item: BelegungsartItem = {
      id: newId,
      label,
      color: newArtColor,
      slots,
    }
    setArten((prev) => [...prev, item])
    setMitarbeiter((prev) =>
      prev.map((s) => ({
        ...s,
        allowedArtIds: s.allowedArtIds.includes(newId)
          ? s.allowedArtIds
          : [...s.allowedArtIds, newId],
      })),
    )
    if (staffModal) {
      setStaffDraftArtIds((prev) =>
        prev.includes(newId) ? prev : [...prev, newId],
      )
    }
    setNewArtLabel('')
    setNewArtMinutes(60)
    setNewArtColor('#0d9488')
    return true
  }

  const openNewArtModal = useCallback(() => {
    if (cloudSyncEnabled && !mayArtenWrite) {
      alertOnce('Keine Berechtigung zum Bearbeiten der Belegungsarten.')
      return
    }
    setNewArtLabel('')
    setNewArtMinutes(60)
    setNewArtColor('#0d9488')
    setNewArtModalOpen(true)
  }, [cloudSyncEnabled, mayArtenWrite])

  const closeNewArtModal = useCallback(() => {
    setNewArtModalOpen(false)
    setNewArtLabel('')
    setNewArtMinutes(60)
    setNewArtColor('#0d9488')
  }, [])

  const saveNewArtFromModal = () => {
    if (addBelegungsart()) setNewArtModalOpen(false)
  }

  const cancelEditArt = useCallback(() => {
    setEditingArtId(null)
    setEditArtLabel('')
    setEditArtMinutes(60)
    setEditArtColor('#0d9488')
  }, [])

  const startEditArt = (a: BelegungsartItem) => {
    if (cloudSyncEnabled && !mayArtenWrite) {
      alertOnce('Keine Berechtigung zum Bearbeiten der Belegungsarten.')
      return
    }
    setEditingArtId(a.id)
    setEditArtLabel(a.label)
    setEditArtMinutes(a.slots * SLOT_MINUTES)
    setEditArtColor(a.color)
  }

  const saveEditArt = () => {
    if (cloudSyncEnabled && !mayArtenWrite) return
    if (!editingArtId) return
    const label = editArtLabel.trim()
    if (!label) {
      alertOnce('Bitte eine Bezeichnung eingeben.')
      return
    }
    const slots = Math.min(
      Math.max(1, Math.round(editArtMinutes / SLOT_MINUTES)),
      slotCount(),
    )
    setArten((prev) =>
      prev.map((x) =>
        x.id === editingArtId
          ? { ...x, label, slots, color: editArtColor }
          : x,
      ),
    )
    setSlotCells((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(next)) {
        const c = next[k]
        if (c?.artId === editingArtId) {
          next[k] = { ...c, art: label, artColor: editArtColor }
        }
      }
      return next
    })
    cancelEditArt()
  }

  const removeBelegungsart = (a: BelegungsartItem) => {
    if (cloudSyncEnabled && !mayArtenWrite) {
      alertOnce('Keine Berechtigung zum Bearbeiten der Belegungsarten.')
      return
    }
    if (arten.length <= 1) {
      alertOnce('Es muss mindestens eine Belegungsart bestehen bleiben.')
      return
    }
    if (
      !window.confirm(
        `Belegungsart „${a.label}“ wirklich entfernen? Sie wird bei allen Mitarbeitern aus den Freigaben gelöscht und aus betroffenen Terminzellen entfernt.`,
      )
    ) {
      return
    }
    if (editingArtId === a.id) cancelEditArt()
    setArten((prev) => prev.filter((x) => x.id !== a.id))
    setMitarbeiter((prev) =>
      prev.map((s) => ({
        ...s,
        allowedArtIds: s.allowedArtIds.filter((id) => id !== a.id),
      })),
    )
    setStaffDraftArtIds((prev) => prev.filter((id) => id !== a.id))
    setSlotCells((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(next)) {
        const c = next[k]
        if (c?.artId === a.id) {
          const { art: _a, artId: _aid, artColor: _ac, ...rest } = c
          const merged = rest as CellData
          if (!isCellBooked(merged)) delete next[k]
          else next[k] = merged
        }
      }
      return next
    })
  }

  const closeMusterModal = useCallback(() => {
    setMusterModal(null)
    setMusterEditorDragOverKey(null)
    setMusterArtPicker(null)
    setMusterHighlightArtId(null)
  }, [])

  const closeMusterArtPicker = useCallback(() => {
    setMusterArtPicker(null)
  }, [])

  const openMusterArtPickerForCell = useCallback(
    (dk: string, room: Room, anchorSlot: number) => {
      setMusterArtPicker({ dk, room, anchorSlot })
    },
    [],
  )

  const assignArtFromMusterPicker = useCallback(
    (artId: string) => {
      setMusterArtPicker((pick) => {
        if (!pick) return null
        const a = arten.find((x) => x.id === artId)
        if (a) {
          setMusterDraftCells((prev) => {
            const k = makeSlotKey(pick.dk, pick.room, pick.anchorSlot)
            const startSlot = isCellBooked(prev[k])
              ? findBlockBounds(prev, pick.dk, pick.room, pick.anchorSlot).start
              : pick.anchorSlot
            return (
              applyArtDropNoPatient(
                prev,
                pick.dk,
                pick.room,
                startSlot,
                a,
              ) ?? prev
            )
          })
        }
        return null
      })
    },
    [arten],
  )

  const openMusterModalCreate = useCallback(() => {
    if (cloudSyncEnabled && !mayMusterWrite) {
      alertOnce('Keine Berechtigung für Belegungsmuster.')
      return
    }
    setMusterDraftLabel('')
    setMusterDraftCells(injectMusterPauseSlots({}, 3))
    setMusterHighlightArtId(null)
    setMusterModal({ mode: 'create', templateWeekCount: 3 })
  }, [cloudSyncEnabled, mayMusterWrite])

  const openMusterModalEdit = useCallback((m: BelegungsmusterItem) => {
    if (cloudSyncEnabled && !mayMusterWrite) {
      alertOnce('Keine Berechtigung für Belegungsmuster.')
      return
    }
    setMusterDraftLabel(m.label)
    const tw = m.templateWeekCount === 1 ? 1 : 3
    setMusterHighlightArtId(null)
    setMusterDraftCells(
      injectMusterPauseSlots(musterTemplateToVirtual(m.templateCells), tw),
    )
    setMusterModal({ mode: 'edit', id: m.id, templateWeekCount: tw })
  }, [cloudSyncEnabled, mayMusterWrite])

  const saveMusterModal = useCallback(() => {
    if (cloudSyncEnabled && !mayMusterWrite) return
    const label = musterDraftLabel.trim()
    if (!label) {
      alertOnce('Bitte eine Bezeichnung eingeben.')
      return
    }
    if (!musterModal) return
    const tpl = virtualToMusterTemplate(musterDraftCells)
    const tw = musterModal.templateWeekCount
    if (musterModal.mode === 'create') {
      setMuster((prev) => [
        ...prev,
        {
          id: `muster-${Date.now()}`,
          label,
          templateCells: tpl,
          ...(tw === 1 ? { templateWeekCount: 1 as const } : {}),
        },
      ])
    } else {
      const id = musterModal.id
      setMuster((prev) =>
        prev.map((x) => {
          if (x.id !== id) return x
          const { templateWeekCount: _drop, ...rest } = x
          return {
            ...rest,
            label,
            templateCells: tpl,
            ...(tw === 1 ? { templateWeekCount: 1 as const } : {}),
          }
        }),
      )
    }
    closeMusterModal()
  }, [
    musterDraftLabel,
    musterDraftCells,
    musterModal,
    closeMusterModal,
    cloudSyncEnabled,
    mayMusterWrite,
  ])

  const removeMuster = (m: BelegungsmusterItem) => {
    if (cloudSyncEnabled && !mayMusterWrite) {
      alertOnce('Keine Berechtigung für Belegungsmuster.')
      return
    }
    if (!window.confirm(`Belegungsmuster „${m.label}“ wirklich entfernen?`)) {
      return
    }
    if (musterModal?.mode === 'edit' && musterModal.id === m.id) {
      closeMusterModal()
    }
    setMuster((list) => list.filter((x) => x.id !== m.id))
    setMusterUsageCountById((c) => {
      const next = { ...c }
      delete next[m.id]
      return next
    })
    setSlotCells((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(next)) {
        const c = next[k]
        if (c?.muster === m.label) {
          const { muster: _mu, musterColor: _mc, ...rest } = c
          const merged = rest as CellData
          if (!isCellBooked(merged)) delete next[k]
          else next[k] = merged
        }
      }
      return next
    })
  }

  const handleMusterEditorDrop = useCallback(
    (e: React.DragEvent, dk: string, room: Room, sl: number) => {
      e.preventDefault()
      setMusterEditorDragOverKey(null)
      const payload = parseDragPayload(e.dataTransfer)
      if (!payload) return
      if (payload.kind === 'moveBlock') {
        setMusterDraftCells((prev) =>
          cellMapApplyMove(
            prev,
            payload.fromDk,
            payload.fromRoom,
            payload.fromSlot,
            dk,
            room,
            sl,
            arten,
            mitarbeiter,
            { blockLunchPauseAsMoveTarget: true },
          ) ?? prev,
        )
        return
      }
      if (payload.kind === 'resizeBlock') {
        setMusterDraftCells((prev) =>
          cellMapApplyResize(
            prev,
            dk,
            room,
            sl,
            payload,
            arten,
            mitarbeiter,
          ) ?? prev,
        )
        return
      }
      if (payload.kind === 'art') {
        const a = arten.find((x) => x.id === payload.id)
        if (!a) return
        setMusterDraftCells((prev) =>
          applyArtDropNoPatient(prev, dk, room, sl, a) ?? prev,
        )
      }
    },
    [arten, mitarbeiter],
  )

  const clearMusterDraftBlock = useCallback((dk: string, room: Room, sl: number) => {
    setMusterDraftCells((prev) => {
      const k = makeSlotKey(dk, room, sl)
      if (!isCellBooked(prev[k])) return prev
      const { start, end } = findBlockBounds(prev, dk, room, sl)
      const fk = makeSlotKey(dk, room, start)
      if (isMusterPauseCell(prev[fk])) return prev
      const next = { ...prev }
      for (let s = start; s <= end; s++) {
        delete next[makeSlotKey(dk, room, s)]
      }
      return next
    })
  }, [])

  const clearMusterSlotFromPicker = useCallback(() => {
    setMusterArtPicker((pick) => {
      if (pick) {
        clearMusterDraftBlock(pick.dk, pick.room, pick.anchorSlot)
      }
      return null
    })
  }, [clearMusterDraftBlock])

  const deleteStaffMember = (s: MitarbeiterItem) => {
    if (cloudSyncEnabled && !mayStaffWrite) {
      alertOnce('Keine Berechtigung zum Löschen von Mitarbeitenden.')
      return
    }
    if (!window.confirm(`Mitarbeiter „${s.name}“ wirklich löschen?`)) return
    setMitarbeiter((list) => list.filter((x) => x.id !== s.id))
    setSlotCells((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(next)) {
        const c = next[k]
        if (c?.staffId === s.id) {
          const { staff: _st, staffId: _sid, ...rest } = c
          const merged = rest as CellData
          if (!isCellBooked(merged)) delete next[k]
          else next[k] = merged
        }
      }
      return next
    })
    if (staffModal?.mode === 'edit' && staffModal.id === s.id) setStaffModal(null)
  }

  /** Heute und drei Monate zurück: Verhältnis belegte zu verfügbaren Zellen (Wochenplan). */
  const staffUtilizationById = useMemo(() => {
    const today = calendarDate(new Date())
    const fromDk = dateKey(addCalendarMonths(today, -3))
    const toDk = dateKey(today)
    const map = new Map<
      string,
      { pct: number | null; booked: number; available: number }
    >()
    for (const s of mitarbeiter) {
      const available = countStaffAvailableSlotsInRange(s, fromDk, toDk)
      const booked = countStaffBookedSlotsInRange(slotCells, s, fromDk, toDk)
      const pct =
        available > 0
          ? Math.min(100, Math.round((booked / available) * 1000) / 10)
          : null
      map.set(s.id, { pct, booked, available })
    }
    return map
  }, [mitarbeiter, slotCells])

  const belowCalendarPanels = (
    <div className="calendar-below-panels">
      <section
        className="panel panel-below-calendar panel-kollision"
        aria-label="Kollision und offene Termine"
      >
        <h2 className="panel-title">Kollision</h2>
        <ul className="panel-list panel-list-compact kollision-panel-list">
          {kollisionPanelItems.length === 0 ? (
            <li className="kollision-panel-empty muted">
              Keine Terminkollisionen, keine Termine ohne Patient und keine
              Patiententermine ohne Mitarbeiter (ohne Belegungsart oder mit Hinweis
              „Mitarbeiter zuteilen“).
            </li>
          ) : (
            kollisionPanelItems.map((item) => (
              <li key={item.anchorKey} className="kollision-panel-row">
                <button
                  type="button"
                  className={
                    item.kind === 'termin-kollision'
                      ? 'kollision-entry kollision-entry--kollision'
                      : item.kind === 'termin-ohne-patient'
                        ? 'kollision-entry kollision-entry--ohne-patient'
                        : 'kollision-entry kollision-entry--unvollständig'
                  }
                  title={item.summary}
                  aria-label={`Tagesansicht öffnen: ${item.summary}`}
                  onClick={() => goToKollisionTermin(item.anchorKey)}
                >
                  {item.summary}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="panel-kollision-bottom" aria-hidden="true" />
      </section>

      <section className="panel panel-below-calendar" aria-label="Belegungsarten">
        <h2 className="panel-title">Belegungsarten</h2>
        <ul className="panel-list panel-list-compact arten-panel-list">
          {artenSortedForPanel.map((a) => (
            <li key={a.id} className="arten-panel-row">
              <div className="arten-entry">
                {editingArtId === a.id ? (
                  <div className="arten-edit">
                    <input
                      type="text"
                      value={editArtLabel}
                      onChange={(e) => setEditArtLabel(e.target.value)}
                      placeholder="Bezeichnung"
                      aria-label="Belegungsart Bezeichnung bearbeiten"
                    />
                    <label className="arten-edit-field">
                      Dauer (Min.)
                      <select
                        value={editArtMinutes}
                        onChange={(e) =>
                          setEditArtMinutes(Number(e.target.value))
                        }
                        aria-label="Dauer bearbeiten"
                      >
                        <option value={30}>30</option>
                        <option value={60}>60</option>
                        <option value={90}>90</option>
                        <option value={120}>120</option>
                        <option value={150}>150</option>
                        <option value={180}>180</option>
                      </select>
                    </label>
                    <label className="arten-edit-field">
                      Farbe
                      <input
                        type="color"
                        value={editArtColor}
                        onChange={(e) => setEditArtColor(e.target.value)}
                        aria-label="Farbe bearbeiten"
                      />
                    </label>
                    <div className="arten-edit-actions">
                      <button
                        type="button"
                        className="btn-edit-save"
                        onClick={saveEditArt}
                      >
                        Speichern
                      </button>
                      <button
                        type="button"
                        className="btn-edit-cancel"
                        onClick={cancelEditArt}
                      >
                        Abbrechen
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="arten-entry-body arten-entry-inline">
                    <button
                      type="button"
                      className="drag-chip art-chip arten-inline-drag"
                      style={{ borderLeftColor: a.color }}
                      draggable
                      onDragStart={(e) =>
                        onDragStart(e, { kind: 'art', id: a.id })
                      }
                      onDragEnd={endPanelOrCellDrag}
                      aria-label={`${a.label}, ${a.slots * SLOT_MINUTES} Min — in die Planung ziehen`}
                    >
                      <span className="chip-dot" style={{ background: a.color }} />
                      <span className="arten-inline-text">
                        <span className="arten-inline-name">{a.label}</span>
                        <span className="arten-inline-time">
                          {a.slots * SLOT_MINUTES} Min
                        </span>
                      </span>
                    </button>
                    <div
                      className="arten-entry-actions arten-entry-actions-inline"
                      role="group"
                      aria-label={`Aktionen für ${a.label}`}
                    >
                      <button
                        type="button"
                        className="btn-patient-action"
                        disabled={!mayArtenWrite}
                        onClick={() => startEditArt(a)}
                      >
                        Bearbeiten
                      </button>
                      <button
                        type="button"
                        className="btn-patient-action btn-patient-delete"
                        disabled={!mayArtenWrite}
                        onClick={() => removeBelegungsart(a)}
                      >
                        Löschen
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="panel-add panel-add-arten panel-add-arten--modal-trigger">
          <button
            type="button"
            className="btn-add"
            disabled={!mayArtenWrite}
            onClick={openNewArtModal}
          >
            Belegungsart hinzufügen
          </button>
        </div>
      </section>

      <section className="panel panel-below-calendar" aria-label="Belegungsmuster">
        <h2 className="panel-title">Belegungsmuster</h2>
        <ul className="panel-list panel-list-compact arten-panel-list">
          {musterSortedForPanel.map((m) => (
            <li key={m.id} className="arten-panel-row">
              <div className="arten-entry">
                <div className="arten-entry-body arten-entry-inline">
                  <div className="muster-panel-drag-block">
                    <button
                      type="button"
                      className="drag-chip muster-chip arten-inline-drag"
                      draggable
                      onDragStart={(e) =>
                        onDragStart(e, { kind: 'muster', id: m.id })
                      }
                      onDragEnd={endPanelOrCellDrag}
                      aria-label={`Muster „${m.label}“ in den Kalender ziehen`}
                    >
                      <span className="chip-label">{m.label}</span>
                    </button>
                  </div>
                  <div
                    className="arten-entry-actions arten-entry-actions-inline"
                    role="group"
                    aria-label={`Aktionen für ${m.label}`}
                  >
                    <button
                      type="button"
                      className="btn-patient-action"
                      disabled={!mayMusterWrite}
                      onClick={() => openMusterModalEdit(m)}
                    >
                      Bearbeiten
                    </button>
                    <button
                      type="button"
                      className="btn-patient-action btn-patient-delete"
                      disabled={!mayMusterWrite}
                      onClick={() => removeMuster(m)}
                    >
                      Löschen
                    </button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn-add"
          disabled={!mayMusterWrite}
          onClick={openMusterModalCreate}
        >
          Neues Belegungsmuster anlegen
        </button>
      </section>

      <section className="panel panel-below-calendar" aria-label="Mitarbeiter">
        <h2 className="panel-title">Mitarbeiter</h2>
        <ul className="panel-list panel-list-compact staff-panel-list">
          {mitarbeiter.map((s) => {
            const u = staffUtilizationById.get(s.id)
            const utilTitle = u
              ? u.available > 0
                ? `Auslastung: ${u.booked.toLocaleString('de-DE')} von ${u.available.toLocaleString('de-DE')} im Wochenplan verfügbaren Zellen mit Buchung belegt (heute und die letzten 3 Monate).`
                : 'Keine als verfügbar markierten Zellen im Wochenplan im Zeitraum heute und die letzten 3 Monate.'
              : ''
            const utilLabel =
              u && u.available > 0 && u.pct !== null
                ? `${u.pct.toLocaleString('de-DE', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 1,
                  })} %`
                : '—'
            return (
              <li key={s.id} className="staff-panel-row">
                <button
                  type="button"
                  className="drag-chip staff-chip"
                  draggable
                  onDragStart={(e) => onDragStart(e, { kind: 'staff', id: s.id })}
                  onDragEnd={endPanelOrCellDrag}
                  aria-label={`${s.name} in die Planung ziehen`}
                >
                  <span className="chip-label">{s.name}</span>
                </button>
                <div className="staff-panel-row-actions">
                  <span
                    className="staff-panel-util"
                    title={utilTitle}
                    aria-label={utilTitle || 'Auslastung'}
                  >
                    {utilLabel}
                  </span>
                  <button
                    type="button"
                    className="btn-patient-action"
                    disabled={!mayStaffWrite}
                    onClick={() => openStaffModalEdit(s.id)}
                  >
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    className="btn-patient-action btn-patient-delete"
                    disabled={!mayStaffWrite}
                    onClick={() => deleteStaffMember(s)}
                  >
                    Löschen
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
        <button
          type="button"
          className="btn-add btn-staff-create"
          disabled={!mayStaffWrite}
          onClick={openStaffModalCreate}
        >
          Mitarbeiter anlegen
        </button>
      </section>
    </div>
  )

  const musterArtPickerSummary = useMemo(() => {
    if (!musterArtPicker) return null
    const { dk, room, anchorSlot } = musterArtPicker
    const k = makeSlotKey(dk, room, anchorSlot)
    const d = musterDraftCells[k]
    const hasBlock = isCellBooked(d)
    return {
      room,
      time: slotIndexToLabel(anchorSlot),
      hasBlock,
      artLabel: d?.art?.trim() || null,
    }
  }, [musterArtPicker, musterDraftCells])

  const musterModalArtCounts = useMemo(() => {
    if (musterModal === null) return []
    return musterTemplateArtSlotCountsFullCatalog(
      virtualToMusterTemplate(musterDraftCells),
      arten,
    )
  }, [musterModal, musterDraftCells, arten])

  const musterEditorAvailabilityKeys = useMemo(() => {
    if (!musterModal || !musterHighlightArtId) return null
    const artId = musterHighlightArtId
    if (artId === OP_BELEGUNGSART_ID || artId === MUSTER_PAUSE_ART_ID) {
      return new Set<string>()
    }
    const eligible = mitarbeiter.filter((s) => staffHasArtAllowed(s, artId))
    if (eligible.length === 0) return new Set<string>()
    const keys = new Set<string>()
    const slotsN = slotCount()
    const dayCount = musterModal.templateWeekCount * 7
    for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
      const dayDk = templateDkForDayIndex(dayIndex)
      const wd = weekdayMon0FromDate(parseDateKey(dayDk))
      for (const room of ROOMS) {
        for (let sl = 0; sl < slotsN; sl++) {
          if (slotIndexInCalendarLunchPause(sl)) continue
          if (
            eligible.every((s) =>
              isStaffSlotAvailableForDate(s, dayDk, wd, sl),
            )
          ) {
            keys.add(makeSlotKey(dayDk, room, sl))
          }
        }
      }
    }
    return keys
  }, [musterModal, musterHighlightArtId, mitarbeiter])

  const musterHighlightColor = useMemo(() => {
    if (!musterHighlightArtId) return undefined
    return arten.find((a) => a.id === musterHighlightArtId)?.color
  }, [musterHighlightArtId, arten])

  const musterModalOverlay =
    musterModal === null ? null : (
      <div
        className="staff-modal-overlay muster-modal-overlay"
        onClick={closeMusterModal}
        role="presentation"
      >
        <div
          className="staff-modal muster-modal-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="muster-modal-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="muster-modal-title" className="staff-modal-title">
            {musterModal.mode === 'create'
              ? 'Neues Belegungsmuster'
              : 'Belegungsmuster bearbeiten'}
          </h2>
          <div className="muster-modal-label-row">
            <label className="muster-modal-label muster-modal-label--field">
              Bezeichnung
              <input
                type="text"
                value={musterDraftLabel}
                onChange={(e) => setMusterDraftLabel(e.target.value)}
                placeholder="z. B. Standardwoche Team A"
                aria-label="Bezeichnung des Musters"
              />
            </label>
            {musterModalArtCounts.length > 0 ? (
              <ul
                className="muster-art-summary muster-art-summary--modal-beside muster-art-summary--modal-3-rows"
                aria-label="Belegungsarten im Muster: Anzahl 30-Minuten-Slots je Art (ohne OP und Pause)"
              >
                {musterModalArtCounts.map((row) => {
                  const showAvailSwitch =
                    row.id !== OP_BELEGUNGSART_ID &&
                    row.id !== MUSTER_PAUSE_ART_ID
                  return (
                    <li
                      key={`modal-${row.id}`}
                      className="muster-art-summary-item muster-art-summary-item--with-switch"
                    >
                      <span
                        className="muster-art-summary-dot"
                        style={{ background: row.color }}
                        aria-hidden
                      />
                      <span className="muster-art-summary-label">{row.label}</span>
                      {showAvailSwitch ? (
                        <button
                          type="button"
                          role="switch"
                          className="muster-art-avail-switch"
                          aria-checked={musterHighlightArtId === row.id}
                          aria-label={`Verfügbarkeit für ${row.label} im Raster`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setMusterHighlightArtId((prev) =>
                              prev === row.id ? null : row.id,
                            )
                          }}
                        />
                      ) : (
                        <span
                          className="muster-art-avail-switch-placeholder"
                          aria-hidden
                        />
                      )}
                      <span className="muster-art-summary-count">{row.count}×</span>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="muster-art-summary-empty muster-art-summary-empty--modal-beside">
                Keine Belegungsarten konfiguriert
              </p>
            )}
          </div>
          <p className="staff-modal-hint">
            {musterModal.templateWeekCount === 1
              ? 'Eine Woche (Mo–So nebeneinander). '
              : 'Drei Wochen untereinander (je Mo–So nebeneinander). '}
            <strong>Klick auf eine Zelle</strong> öffnet die Auswahl der Belegungsart;
            Belegungsarten lassen sich weiter per Drag & Drop platzieren. Blöcke wie
            im Kalender verschieben und am Rand kürzen oder verlängern. Anzeige nur der
            Art-Bezeichnung. Pro Belegungsart kann der Schalter die Zellen schattieren,
            in denen alle Mitarbeiter mit Freigabe für diese Art an dem Slot verfügbar
            sind (nur eine Art gleichzeitig). Täglich 12:00–13:30 ist fest als „Pause“
            reserviert (keine Belegungsart, wird nicht in den Hauptkalender übernommen).
          </p>
          <div className="muster-modal-grid-scroll">
            <MusterWeekEditorGrid
              weekCount={musterModal.templateWeekCount}
              draftCells={musterDraftCells}
              dragOverKey={musterEditorDragOverKey}
              setDragOverKey={setMusterEditorDragOverKey}
              onEditorDrop={handleMusterEditorDrop}
              onCellPickRequest={openMusterArtPickerForCell}
              endPanelOrCellDrag={endPanelOrCellDrag}
              startCellMoveDrag={startCellMoveDrag}
              startResizeDrag={startResizeDrag}
              suppressClickAfterDrag={musterEditorSuppressClick}
              dragSourceRef={dragSourceRef}
              availabilityHighlightKeys={musterEditorAvailabilityKeys}
              availabilityHighlightColor={musterHighlightColor}
            />
          </div>
          <div className="staff-modal-footer">
            <button
              type="button"
              className="btn-edit-save"
              onClick={saveMusterModal}
            >
              Speichern
            </button>
            <button
              type="button"
              className="btn-edit-cancel"
              onClick={closeMusterModal}
            >
              Abbrechen
            </button>
          </div>
          {musterArtPicker ? (
            <div
              className="muster-art-picker-overlay"
              role="presentation"
              onClick={closeMusterArtPicker}
            >
              <div
                className="staff-modal termin-staff-dialog muster-art-picker-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="muster-art-picker-title"
                onClick={(e) => e.stopPropagation()}
              >
                <h2
                  id="muster-art-picker-title"
                  className="staff-modal-title"
                >
                  Belegungsart wählen
                </h2>
                {musterArtPickerSummary ? (
                  <p className="staff-modal-hint termin-staff-summary">
                    {musterArtPickerSummary.room} · {musterArtPickerSummary.time}
                    <br />
                    <span className="termin-staff-line">
                      {musterArtPickerSummary.hasBlock
                        ? musterArtPickerSummary.artLabel
                          ? `Aktuell: ${musterArtPickerSummary.artLabel}`
                          : 'Belegt'
                        : 'Zelle frei'}
                    </span>
                  </p>
                ) : null}
                <p className="staff-modal-hint">
                  Wählen Sie die Belegungsart für diese Zelle (Dauer wie in den
                  Belegungsarten). Überlappende Termine im Muster werden dabei
                  ersetzt.
                </p>
                <ul className="termin-staff-pick-list">
                  {arten.length === 0 ? (
                    <li className="muted">Keine Belegungsarten angelegt.</li>
                  ) : (
                    arten.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          className="termin-art-pick-btn"
                          onClick={() => assignArtFromMusterPicker(a.id)}
                        >
                          <span
                            className="termin-art-pick-dot"
                            style={{ background: a.color }}
                            aria-hidden
                          />
                          <span className="termin-art-pick-label">
                            {a.label}
                          </span>
                          <span className="termin-art-pick-meta">
                            {a.slots * SLOT_MINUTES} Min
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                <div className="staff-modal-footer termin-staff-footer">
                  <button
                    type="button"
                    className="btn-termin-clear"
                    onClick={clearMusterSlotFromPicker}
                  >
                    Termin leeren
                  </button>
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={closeMusterArtPicker}
                  >
                    Schließen
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )

  if (cloudSyncEnabled && !cloudHydrated) {
    return (
      <div className="app cloud-loading">
        <p className="cloud-loading-text">Arbeitsbereich wird geladen …</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-row">
          <div className="app-title-brand">
            <Image
              src="/logo-bbi.png"
              alt="BBI"
              className="app-logo"
              width={240}
              height={96}
              priority
            />
            <h1 className="app-title">Physio PlanungsApp</h1>
          </div>
          {cloudSyncEnabled ? (
            <div className="toolbar-account" role="group" aria-label="Konto">
              {appRole ? (
                <span className="toolbar-account-role" title="Ihre Rolle">
                  {appRole}
                </span>
              ) : null}
              {accountLabel ? (
                <span className="toolbar-account-name" title={accountLabel}>
                  {accountLabel}
                </span>
              ) : null}
              <button
                type="button"
                className="btn-today btn-toolbar-export"
                onClick={() => void signOut()}
              >
                Abmelden
              </button>
            </div>
          ) : null}
        </div>
        <div className="toolbar">
          {isViewer ? (
            <p className="toolbar-viewer-hint" role="status">
              Nur Leseberechtigung — nur Kalenderansicht, ohne Stammdaten-Panels.
              Abmelden oben rechts neben dem Kontonamen.
            </p>
          ) : null}
          <div className="segmented" role="group" aria-label="Ansicht">
            <button
              type="button"
              className={viewMode === 'day' ? 'active' : ''}
              aria-pressed={viewMode === 'day'}
              disabled={calendarTabId !== 'main' || isViewer}
              title={
                calendarTabId !== 'main'
                  ? 'Im Mitarbeiter-Kalender nur Wochenansicht Mo–So'
                  : undefined
              }
              onClick={() => setViewMode('day')}
            >
              Tagesansicht
            </button>
            <button
              type="button"
              className={viewMode === 'week' ? 'active' : ''}
              aria-pressed={viewMode === 'week'}
              disabled={isViewer}
              onClick={() => setViewMode('week')}
            >
              Wochenansicht
            </button>
          </div>
          <div className="toolbar-today-group">
            <button
              type="button"
              className="btn-undo"
              disabled={!canUndoSlots || isViewer}
              onClick={undoSlotCells}
              title="Letzte Änderung am Terminplan rückgängig machen"
              aria-label="Letzte Änderung am Terminplan rückgängig machen"
            >
              Rückgängig
            </button>
          </div>
          <div
            className="toolbar-export-group"
            role="group"
            aria-label="Daten exportieren"
          >
            <button
              type="button"
              className="btn-today btn-toolbar-export"
              disabled={!mayExport || isViewer}
              title={
                isViewer
                  ? 'Nur Leseberechtigung'
                  : !mayExport
                    ? 'Keine Berechtigung für Exporte'
                    : undefined
              }
              onClick={openPatientExportModal}
            >
              Export Patient
            </button>
            <button
              type="button"
              className="btn-today btn-toolbar-export"
              disabled={!mayExport || isViewer}
              title={
                isViewer
                  ? 'Nur Leseberechtigung'
                  : !mayExport
                    ? 'Keine Berechtigung für Exporte'
                    : undefined
              }
              onClick={openStaffExportModal}
            >
              Export Mitarbeiter
            </button>
            <button
              type="button"
              className="btn-today btn-toolbar-export"
              disabled={!mayExport || isViewer}
              title={
                isViewer
                  ? 'Nur Leseberechtigung'
                  : !mayExport
                    ? 'Keine Berechtigung für Exporte'
                    : undefined
              }
              onClick={openRoomExportModal}
            >
              Export Raum
            </button>
          </div>
          <div className="nav-arrows">
            <button type="button" className="btn-today" onClick={goToday}>
              Heute
            </button>
            <button type="button" className="btn-icon" onClick={navPrev} aria-label="Zurück">
              ‹
            </button>
            <span className="nav-label">{headerLabel}</span>
            <button type="button" className="btn-icon" onClick={navNext} aria-label="Weiter">
              ›
            </button>
          </div>
        </div>
      </header>

      <div className="app-body" inert={isViewer ? true : undefined}>
        <div
          className={`calendar-main-row${isViewer ? ' calendar-main-row--viewer' : ''}`}
        >
          {!isViewer ? (
          <aside
            className="side-panels side-panels--calendar"
            aria-label="Patienten"
          >
            <section className="panel panel-patients" aria-label="Patienten-Panel">
              <h2 className="panel-title">Patienten</h2>
              <div className="patient-search-wrap" role="search">
              <input
                id="patient-search"
                type="search"
                className="patient-search-input"
                value={patientSearchQuery}
                onChange={(e) => setPatientSearchQuery(e.target.value)}
                placeholder="Name oder Patienten-ID suchen …"
                aria-label="Patienten suchen nach Name oder Patienten-ID"
                autoComplete="off"
              />
              </div>
              <ul className="panel-list patient-panel-list">
              {filteredPatients.length === 0 ? (
                <li className="patient-search-empty">
                  {patients.length === 0
                    ? 'Noch keine Patienten angelegt.'
                    : 'Keine Treffer für diese Suche.'}
                </li>
              ) : (
                filteredPatients.map((p) => (
                <li key={p.id} className="patient-row">
                  <div className="patient-entry">
                    {editingPatientId === p.id ? (
                      <div className="patient-edit">
                        <input
                          type="text"
                          value={editPatientName}
                          onChange={(e) => setEditPatientName(e.target.value)}
                          placeholder="Name"
                          aria-label="Patientenname bearbeiten"
                        />
                        <input
                          type="text"
                          value={editPatientCode}
                          onChange={(e) => setEditPatientCode(e.target.value)}
                          placeholder="Patienten-ID"
                          aria-label="Patienten-ID bearbeiten"
                        />
                        <div className="patient-edit-actions">
                          <button
                            type="button"
                            className="btn-edit-save"
                            onClick={saveEditPatient}
                          >
                            Speichern
                          </button>
                          <button
                            type="button"
                            className="btn-edit-cancel"
                            onClick={cancelEditPatient}
                          >
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="patient-entry-body">
                        <button
                          type="button"
                          className="patient-entry-drag"
                          draggable
                          onDragStart={(e) =>
                            onDragStart(e, { kind: 'patient', id: p.id })
                          }
                          onDragEnd={endPanelOrCellDrag}
                          aria-label={`${p.name} (${p.patientCode}) in die Planung ziehen`}
                        >
                          <span className="patient-entry-name">{p.name}</span>
                          <span className="patient-entry-id">{p.patientCode}</span>
                        </button>
                        <div
                          className="patient-entry-actions"
                          role="group"
                          aria-label={`Aktionen für ${p.name}`}
                        >
                          <button
                            type="button"
                            className="btn-patient-action"
                            disabled={!mayPatientWrite}
                            onClick={() => startEditPatient(p)}
                          >
                            Bearbeiten
                          </button>
                          <button
                            type="button"
                            className="btn-patient-action btn-patient-delete"
                            disabled={!mayPatientWrite}
                            onClick={() => deletePatient(p)}
                          >
                            Löschen
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </li>
                ))
              )}
              </ul>
              <div className="panel-add">
              <input
                type="text"
                value={newPatientName}
                onChange={(e) => setNewPatientName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPatient()}
                placeholder="Name"
                autoComplete="name"
                aria-label="Patientenname"
                disabled={!mayPatientWrite}
              />
              <input
                type="text"
                value={newPatientCode}
                onChange={(e) => setNewPatientCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPatient()}
                placeholder="Patienten-ID"
                autoComplete="off"
                aria-label="Patienten-ID"
                disabled={!mayPatientWrite}
              />
              <button
                type="button"
                className="btn-add"
                onClick={addPatient}
                disabled={!mayPatientWrite}
              >
                Hinzufügen
              </button>
              </div>
            </section>
        </aside>
          ) : null}

        <div className="main-column main-column--calendar" aria-label="Hauptkalender">
          <div
            className="calendar-view-tabs"
            role="tablist"
            aria-label="Kalender wechseln"
          >
            <button
              type="button"
              role="tab"
              className={`calendar-view-tab ${calendarTabId === 'main' ? 'calendar-view-tab--active' : ''}`}
              aria-selected={calendarTabId === 'main'}
              id="calendar-tab-main"
              onClick={() => setCalendarTabId('main')}
            >
              Hauptkalender
            </button>
            {mitarbeiter.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                className={`calendar-view-tab ${calendarTabId === s.id ? 'calendar-view-tab--active' : ''}`}
                aria-selected={calendarTabId === s.id}
                id={`calendar-tab-${s.id}`}
                title={`Termine von ${s.name} (Ansicht)`}
                onClick={() => setCalendarTabId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
          {isStaffCalendarReadOnly && calendarTabStaffMember ? (
            <div className="grid-wrap grid-wrap--staff-readonly staff-week-grid-wrap">
                <div
                  className="plan-grid staff-week-grid"
                  style={{
                    gridTemplateColumns: `minmax(3.25rem, 4rem) repeat(7, minmax(0, 1fr))`,
                    gridTemplateRows: `auto repeat(${slots}, minmax(0, 1fr))`,
                  }}
                >
                  <div
                    className="corner staff-week-corner"
                    style={{ gridColumn: 1, gridRow: 1 }}
                  />
                  {weekDays.map((d, di) => {
                    const dk = dateKey(d)
                    const isDToday = dk === dateKey(new Date())
                    return (
                      <button
                        key={dk}
                        type="button"
                        className={`staff-week-col-head ${isDToday ? 'is-today' : ''}`}
                        style={{ gridColumn: di + 2, gridRow: 1 }}
                        disabled={!mayStaffAbsences}
                        onClick={() => {
                          if (!mayStaffAbsences) return
                          openStaffAbsenceModal({
                            fromDk: dk,
                            toDk: dk,
                            allDay: true,
                          })
                        }}
                        title={
                          !mayStaffAbsences
                            ? 'Keine Berechtigung für Abwesenheiten'
                            : 'Ganztägige Abwesenheit für diesen Tag eintragen'
                        }
                      >
                        <span className="staff-week-col-wd">
                          {d.toLocaleDateString('de-DE', { weekday: 'short' })}
                        </span>
                        <span className="staff-week-col-dm">
                          {d.toLocaleDateString('de-DE', {
                            day: 'numeric',
                            month: 'short',
                          })}
                        </span>
                      </button>
                    )
                  })}
                  {Array.from({ length: slots }, (_, slotIndex) => (
                    <Fragment key={slotIndex}>
                      <div
                        className={`time-label ${weekHasToday && slotIndex === slotNowInDay ? 'now-line' : ''} ${slotIndexInCalendarLunchPause(slotIndex) ? 'time-label--lunch-pause' : ''}`}
                        style={{ gridColumn: 1, gridRow: slotIndex + 2 }}
                      >
                        {slotIndexToLabel(slotIndex)}
                      </div>
                      {weekDays.map((d, di) => {
                        const dk = dateKey(d)
                        const bookingsHere = staffBookingsAtSlot(
                          cellsForActiveCalendarView,
                          dk,
                          slotIndex,
                          calendarTabStaffMember,
                        )
                        const hasBooking = bookingsHere.length > 0
                        const absentHere = isStaffAbsentAtSlot(
                          calendarTabStaffMember,
                          dk,
                          slotIndex,
                        )

                        // Terminblöcke zusammenfassen: nur wenn genau 1 Buchung am Slot
                        // (bei Mehrfachbelegung bleibt die Zelle „einzeln“)
                        if (hasBooking && bookingsHere.length === 1) {
                          const only = bookingsHere[0]!
                          const { start, end } = findBlockBounds(
                            cellsForActiveCalendarView,
                            dk,
                            only.room,
                            slotIndex,
                          )
                          if (slotIndex !== start) {
                            return null
                          }
                          const anyAbsentInSpan = Array.from(
                            { length: end - start + 1 },
                            (_, i) =>
                              isStaffAbsentAtSlot(
                                calendarTabStaffMember,
                                dk,
                                start + i,
                              ),
                          ).some(Boolean)
                          const isNowHere =
                            dk === dateKey(now) &&
                            slotNowInDay >= start &&
                            slotNowInDay <= end &&
                            slotNowInDay >= 0
                          const anchorData =
                            cellsForActiveCalendarView[
                              makeSlotKey(dk, only.room, start)
                            ]
                          return (
                            <button
                              key={`${dk}-${start}-span`}
                              type="button"
                              className={[
                                'staff-week-cell',
                                'staff-week-cell--booked',
                                anyAbsentInSpan
                                  ? 'staff-week-cell--absent-conflict'
                                  : '',
                                slotIndexInCalendarLunchPause(slotIndex)
                                  ? 'staff-week-cell--lunch-pause'
                                  : '',
                                isNowHere ? 'staff-week-cell--now' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              style={{
                                gridColumn: di + 2,
                                gridRow: `${start + 2} / ${end + 3}`,
                              }}
                              title={`${only.room} · ${slotIndexToLabel(start)}–${slotEndTimeLabelExclusive(end)} · ${cellDisplayLine(anchorData, mitarbeiter)}`}
                              onClick={() => {
                                setStaffTerminDetailModal({
                                  dk,
                                  blocks: [
                                    {
                                      room: only.room,
                                      anchorSlot: start,
                                    },
                                  ],
                                })
                              }}
                            >
                              <span className="staff-week-cell-inner staff-week-cell-termin-stack">
                                <StaffWeekTerminLabels
                                  data={anchorData}
                                  room={only.room}
                                  mitarbeiter={mitarbeiter}
                                />
                              </span>
                            </button>
                          )
                        }
                        const cellLabel = absentHere
                          ? 'Abwesend'
                          : '—'
                        const isNowHere =
                          dk === dateKey(now) &&
                          slotIndex === slotNowInDay &&
                          slotNowInDay >= 0
                        return (
                          <button
                            key={`${dk}-${slotIndex}`}
                            type="button"
                            className={[
                              'staff-week-cell',
                              hasBooking ? 'staff-week-cell--booked' : '',
                              absentHere && !hasBooking
                                ? 'staff-week-cell--absent'
                                : '',
                              absentHere && hasBooking
                                ? 'staff-week-cell--absent-conflict'
                                : '',
                              slotIndexInCalendarLunchPause(slotIndex)
                                ? 'staff-week-cell--lunch-pause'
                                : '',
                              isNowHere ? 'staff-week-cell--now' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            style={{ gridColumn: di + 2, gridRow: slotIndex + 2 }}
                            title={
                              hasBooking
                                ? bookingsHere
                                    .map(
                                      (b) =>
                                        `${b.room}: ${cellDisplayLine(b.data, mitarbeiter)}`,
                                    )
                                    .join(' · ')
                                : absentHere
                                  ? 'Abwesend — Klick für Abwesenheit'
                                  : 'Klick: Abwesenheit (Zeitfenster)'
                            }
                            onClick={() => {
                              if (hasBooking) {
                                setStaffTerminDetailModal({
                                  dk,
                                  blocks: bookingsHere.map((b) => {
                                    const { start: blockStart } =
                                      findBlockBounds(
                                        cellsForActiveCalendarView,
                                        dk,
                                        b.room,
                                        slotIndex,
                                      )
                                    return {
                                      room: b.room,
                                      anchorSlot: blockStart,
                                    }
                                  }),
                                })
                                return
                              }
                              if (!mayStaffAbsences) return
                              openStaffAbsenceModal({
                                fromDk: dk,
                                toDk: dk,
                                allDay: false,
                                startSlot: slotIndex,
                                endSlot: slotIndex,
                              })
                            }}
                          >
                            <span
                              className={
                                hasBooking
                                  ? 'staff-week-cell-inner staff-week-cell-termin-stack'
                                  : 'staff-week-cell-inner'
                              }
                            >
                              {hasBooking ? (
                                bookingsHere.map((b) => (
                                  <span
                                    key={b.room}
                                    className="staff-week-cell-termin-bundle"
                                  >
                                    <StaffWeekTerminLabels
                                      data={b.data}
                                      room={b.room}
                                      mitarbeiter={mitarbeiter}
                                    />
                                  </span>
                                ))
                              ) : (
                                cellLabel
                              )}
                            </span>
                          </button>
                        )
                      })}
                    </Fragment>
                  ))}
                </div>
              </div>
          ) : viewMode === 'week' ? (
            <div className="grid-wrap">
              <div
                className="plan-grid week-grid"
                style={{
                  gridTemplateColumns: `minmax(7.5rem, 9rem) repeat(${ROOMS.length}, minmax(5rem, 1fr))`,
                  gridTemplateRows: `auto repeat(7, minmax(0, 1fr))`,
                }}
              >
                <div className="corner" />
                {ROOMS.map((r) => (
                  <div key={r} className="col-head">
                    {r}
                  </div>
                ))}
                {weekDays.map((d) => {
                  const dk = dateKey(d)
                  const isDToday = dk === dateKey(new Date())
                  return (
                    <Fragment key={dk}>
                      <div className={`row-head ${isDToday ? 'is-today' : ''}`}>
                        <span className="wd">
                          {d.toLocaleDateString('de-DE', { weekday: 'short' })}
                        </span>
                        <span className="dm">
                          {d.toLocaleDateString('de-DE', {
                            day: 'numeric',
                            month: 'short',
                          })}
                        </span>
                      </div>
                      {ROOMS.map((room) => {
                        const booked = bookingsForDayRoom(
                          cellsForActiveCalendarView,
                          dk,
                          room,
                        )
                        const summary = summarizeSlots(booked)
                        const wk = `w|${dk}|${room}`
                        return (
                          <div key={`${dk}-${room}`} className="week-cell-wrap">
                            <button
                              type="button"
                              className={`week-cell ${booked.length ? 'has-booking' : ''} ${dragOverKey === wk ? 'drag-over' : ''}`}
                              draggable={booked.length > 0}
                              onClick={() => openDayForCell(d)}
                              onDragStart={(e) => {
                                if (booked.length === 0) return
                                e.stopPropagation()
                                startCellMoveDrag(e, dk, room, Math.min(...booked))
                              }}
                              onDragEnd={endPanelOrCellDrag}
                              onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect =
                                  dragSourceRef.current === 'cell' ? 'move' : 'copy'
                                setDragOverKey(wk)
                              }}
                              onDragLeave={() => setDragOverKey((k) => (k === wk ? null : k))}
                              onDrop={(e) => handleDropOnWeekCell(e, dk, room)}
                            >
                              {booked.length === 0 ? (
                                <span className="muted">—</span>
                              ) : (
                                <span className="week-cell-summary">
                                  {booked.length}× · {summary.slice(0, 2).join(', ')}
                                  {summary.length > 2 ? '…' : ''}
                                </span>
                              )}
                            </button>
                          </div>
                        )
                      })}
                    </Fragment>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="grid-wrap" ref={dayGridRef}>
              <div
                className="plan-grid day-grid"
                style={{
                  gridTemplateColumns: `minmax(3.25rem, 4rem) repeat(${ROOMS.length}, minmax(5rem, 1fr))`,
                  gridTemplateRows: `auto repeat(${slots}, minmax(0, 1fr))`,
                }}
              >
                <div className="corner" style={{ gridColumn: 1, gridRow: 1 }} />
                {ROOMS.map((r, ri) => (
                  <div
                    key={r}
                    className="col-head"
                    style={{ gridColumn: ri + 2, gridRow: 1 }}
                  >
                    {r}
                  </div>
                ))}
                {Array.from({ length: slots }, (_, slotIndex) => {
                  const lunchPauseRow = slotIndexInCalendarLunchPause(slotIndex)
                  const rowMergeNext = ROOMS.some((room) => {
                    const d =
                      cellsForActiveCalendarView[
                        makeSlotKey(activeDayKey, room, slotIndex)
                      ]
                    if (!isCellBooked(d)) return false
                    const seg = daySlotBlockSegment(
                      cellsForActiveCalendarView,
                      activeDayKey,
                      room,
                      slotIndex,
                      slots,
                    )
                    return seg === 'start' || seg === 'middle'
                  })
                  return (
                  <div
                    key={slotIndex}
                    className="day-slot-row"
                    data-slot-row={slotIndex}
                    style={{
                      display: 'contents',
                    }}
                  >
                    <div
                      className={`time-label ${slotIndex === currentSlot ? 'now-line' : ''} ${rowMergeNext ? 'time-label--merge-next' : ''} ${lunchPauseRow ? 'time-label--lunch-pause' : ''}`}
                      style={{ gridColumn: 1, gridRow: slotIndex + 2 }}
                    >
                      {slotIndexToLabel(slotIndex)}
                    </div>
                    {ROOMS.map((room, roomIdx) => {
                      const gridCol = roomIdx + 2
                      const kHere = makeSlotKey(activeDayKey, room, slotIndex)
                      const dataHere = cellsForActiveCalendarView[kHere]
                      const booked = isCellBooked(dataHere)
                      const bounds = booked
                        ? findBlockBounds(
                            cellsForActiveCalendarView,
                            activeDayKey,
                            room,
                            slotIndex,
                          )
                        : null
                      const spanLen = bounds
                        ? bounds.end - bounds.start + 1
                        : 1
                      const skipBecauseSpanned =
                        booked &&
                        bounds !== null &&
                        spanLen > 1 &&
                        slotIndex !== bounds.start
                      if (skipBecauseSpanned) {
                        return null
                      }
                      const slotIndicesForShell =
                        booked && bounds
                          ? Array.from(
                              { length: spanLen },
                              (_, i) => bounds.start + i,
                            )
                          : [slotIndex]
                      const gridRow =
                        booked && bounds
                          ? `${bounds.start + 2} / ${bounds.end + 3}`
                          : slotIndex + 2
                      const anchorSl = slotIndicesForShell[0]
                      const anchorKey = makeSlotKey(
                        activeDayKey,
                        room,
                        anchorSl,
                      )
                      const anchorData = cellsForActiveCalendarView[anchorKey]
                      const line = cellDisplayLine(anchorData, mitarbeiter)
                      const terminParts = cellTerminLabelParts(
                        anchorData,
                        mitarbeiter,
                      )
                      const accent = cellAccentColor(anchorData)
                      const blockSegFirst = daySlotBlockSegment(
                        cellsForActiveCalendarView,
                        activeDayKey,
                        room,
                        anchorSl,
                        slots,
                      )
                      const lastSl =
                        slotIndicesForShell[slotIndicesForShell.length - 1]
                      const blockSegLast = daySlotBlockSegment(
                        cellsForActiveCalendarView,
                        activeDayKey,
                        room,
                        lastSl,
                        slots,
                      )
                      const showBlockLabel =
                        booked &&
                        blockSegFirst !== null &&
                        (blockSegFirst === 'single' ||
                          blockSegFirst === 'start')
                      const edgeStyle =
                        booked
                          ? ({
                              '--block-edge': accent ?? 'var(--booked-edge)',
                            } as CSSProperties)
                          : undefined
                      const showResizeTop =
                        booked &&
                        blockSegFirst !== null &&
                        (blockSegFirst === 'start' ||
                          blockSegFirst === 'single')
                      const showResizeBottom =
                        booked &&
                        blockSegLast !== null &&
                        (blockSegLast === 'end' || blockSegLast === 'single')
                      const shellBookedStyle =
                        booked
                          ? ({
                              ...edgeStyle,
                              gridColumn: gridCol,
                              gridRow,
                              ...(accent
                                ? {
                                    background: `color-mix(in srgb, ${accent} 35%, var(--slot-free))`,
                                  }
                                : { background: 'var(--booked)' }),
                            } as CSSProperties)
                          : ({
                              gridColumn: gridCol,
                              gridRow,
                            } as CSSProperties)
                      const shellDragActive = slotIndicesForShell.some(
                        (sl) =>
                          dragOverKey ===
                          makeSlotKey(activeDayKey, room, sl),
                      )
                      const mergeNextClass =
                        booked &&
                        spanLen === 1 &&
                        blockSegFirst &&
                        (blockSegFirst === 'start' ||
                          blockSegFirst === 'middle')
                      const terminKollisionClass = anchorData?.terminKollision
                        ? 'slot-cell-shell--termin-kollision'
                        : ''
                      const lunchShell =
                        slotIndicesForShell.some((ssi) =>
                          slotIndexInCalendarLunchPause(ssi),
                        )
                      return (
                        <div
                          key={anchorKey}
                          className={[
                            'slot-cell-shell',
                            spanLen > 1 ? 'slot-cell-shell--span-block' : '',
                            shellDragActive ? 'drag-over' : '',
                            mergeNextClass ? 'slot-shell--merge-next' : '',
                            terminKollisionClass,
                            lunchShell ? 'slot-cell-shell--lunch-pause' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          style={shellBookedStyle}
                        >
                          {showResizeTop ? (
                            <div
                              className="slot-resize-handle slot-resize-handle--top"
                              draggable
                              onDragStart={(e) => {
                                e.stopPropagation()
                                startResizeDrag(
                                  e,
                                  activeDayKey,
                                  room,
                                  'top',
                                  anchorSl,
                                )
                              }}
                              onDragEnd={endPanelOrCellDrag}
                              title="Termin am oberen Rand verlängern oder verkürzen"
                              aria-label="Oberen Terminrand ziehen zum Verlängern oder Verkürzen"
                            />
                          ) : null}
                          <div className="slot-cell-span-body">
                            {slotIndicesForShell.map((sl) => {
                              const k = makeSlotKey(activeDayKey, room, sl)
                              const data = cellsForActiveCalendarView[k]
                              const subBooked = isCellBooked(data)
                              const subLine = cellDisplayLine(data, mitarbeiter)
                              const subSeg = daySlotBlockSegment(
                                cellsForActiveCalendarView,
                                activeDayKey,
                                room,
                                sl,
                                slots,
                              )
                              const artPreviewFull =
                                artDropPreview?.fullKeys.has(k) ?? false
                              const artPreviewPartial =
                                !artPreviewFull &&
                                (artDropPreview?.partialKeys.has(k) ?? false)
                              const artPreviewHere =
                                artPreviewFull || artPreviewPartial
                              const artTintStyle =
                                artPreviewHere && artDropPreview
                                  ? ({
                                      '--art-drop-tint': artDropPreview.color,
                                      '--art-drop-inset': `inset 0 0 0 999px color-mix(in srgb, ${artDropPreview.color} ${artPreviewFull ? 22 : 10}%, transparent)`,
                                    } as CSSProperties)
                                  : undefined
                              return (
                                <button
                                  key={k}
                                  type="button"
                                  className={`slot-cell slot-cell-main ${subBooked ? 'booked' : ''} ${subBooked && subSeg ? `slot-block--${subSeg}` : ''} ${sl === currentSlot ? 'now-line' : ''} ${data?.terminKollision ? 'slot-cell--termin-kollision' : ''} ${slotIndexInCalendarLunchPause(sl) ? 'slot-cell--lunch-pause' : ''} ${artPreviewHere ? 'slot-cell--art-drop-preview' : ''}`}
                                  style={
                                    subBooked
                                      ? {
                                          ...edgeStyle,
                                          ...(accent
                                            ? {
                                                background: `color-mix(in srgb, ${accent} 35%, var(--slot-free))`,
                                              }
                                            : {
                                                background: 'var(--booked)',
                                              }),
                                          ...artTintStyle,
                                        }
                                      : artTintStyle
                                  }
                                  draggable={subBooked}
                                  title={
                                    data?.terminKollision
                                      ? 'Terminkollision'
                                      : artPreviewPartial && draggedArtForPreview
                                        ? `Nur dieses ${SLOT_MINUTES}-Minuten-Fenster: keine volle Dauer (${draggedArtForPreview.slots * SLOT_MINUTES} Min.) mit einem Mitarbeiter möglich.`
                                        : undefined
                                  }
                                  onClick={() => {
                                    if (
                                      Date.now() -
                                        suppressSlotClickAfterDrag.current <
                                      450
                                    ) {
                                      return
                                    }
                                    if (subBooked) {
                                      const { start: blockStart } =
                                        findBlockBounds(
                                          slotCells,
                                          activeDayKey,
                                          room,
                                          sl,
                                        )
                                      const blockStartData =
                                        slotCells[
                                          makeSlotKey(
                                            activeDayKey,
                                            room,
                                            blockStart,
                                          )
                                        ]
                                      if (
                                        findArtIdForCell(
                                          blockStartData,
                                          arten,
                                        ) === TEAM_MEETING_ART_ID
                                      ) {
                                        setTerminPickerModal({
                                          kind: 'teamMeeting',
                                          dk: activeDayKey,
                                          room,
                                          anchorSlot: sl,
                                        })
                                      } else if (
                                        patientTerminNeedsArtChoice(
                                          blockStartData,
                                          arten,
                                        )
                                      ) {
                                        setTerminPickerModal({
                                          kind: 'art',
                                          dk: activeDayKey,
                                          room,
                                          anchorSlot: sl,
                                        })
                                      } else {
                                        setTerminPickerModal({
                                          kind: 'staff',
                                          dk: activeDayKey,
                                          room,
                                          anchorSlot: sl,
                                        })
                                      }
                                    } else {
                                      toggleSlot(activeDayKey, room, sl)
                                    }
                                  }}
                                  onDragStart={(e) => {
                                    if (!subBooked) return
                                    e.stopPropagation()
                                    startCellMoveDrag(
                                      e,
                                      activeDayKey,
                                      room,
                                      sl,
                                    )
                                  }}
                                  onDragEnd={() => {
                                    endPanelOrCellDrag()
                                    suppressSlotClickAfterDrag.current =
                                      Date.now()
                                  }}
                                  onDragOver={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    e.dataTransfer.dropEffect =
                                      dragSourceRef.current === 'cell'
                                        ? 'move'
                                        : 'copy'
                                    setDragOverKey(k)
                                  }}
                                  onDragLeave={() =>
                                    setDragOverKey((key) =>
                                      key === k ? null : key,
                                    )
                                  }
                                  onDrop={(e) =>
                                    handleDropOnSlot(
                                      e,
                                      activeDayKey,
                                      room,
                                      sl,
                                    )
                                  }
                                  aria-label={
                                    subBooked
                                      ? `${room} ${slotIndexToLabel(sl)} ${subLine}, Klick für Belegungsart oder Mitarbeiter, oder ziehen`
                                      : `${room} ${slotIndexToLabel(sl)} frei`
                                  }
                                />
                              )
                            })}
                          </div>
                          {showResizeBottom ? (
                            <div
                              className="slot-resize-handle slot-resize-handle--bottom"
                              draggable
                              onDragStart={(e) => {
                                e.stopPropagation()
                                startResizeDrag(
                                  e,
                                  activeDayKey,
                                  room,
                                  'bottom',
                                  lastSl,
                                )
                              }}
                              onDragEnd={endPanelOrCellDrag}
                              title="Termin am unteren Rand verlängern oder verkürzen"
                              aria-label="Unteren Terminrand ziehen zum Verlängern oder Verkürzen"
                            />
                          ) : null}
                          {showBlockLabel ? (
                            <div
                              className="slot-cell-label slot-cell-termin-stack slot-cell-termin-span-overlay"
                              title={line}
                            >
                              <span
                                className={`slot-cell-termin-line slot-cell-termin-patient ${terminParts.patient ? '' : 'slot-cell-termin-placeholder'}`}
                              >
                                {terminParts.patient ?? '—'}
                              </span>
                              <span
                                className={`slot-cell-termin-line slot-cell-termin-art ${terminParts.art ? '' : 'slot-cell-termin-placeholder'}`}
                              >
                                {terminParts.art ?? '—'}
                              </span>
                              <span
                                className={`slot-cell-termin-line ${terminParts.staffName ? 'slot-cell-termin-staff' : 'slot-cell-termin-assign'}`}
                              >
                                {terminParts.staffName ??
                                  (anchorData?.artId === TEAM_MEETING_ART_ID
                                    ? 'Teilnehmer wählen'
                                    : 'Mitarbeiter zuteilen')}
                              </span>
                              {terminParts.notiz ? (
                                <span className="slot-cell-termin-line slot-cell-termin-notiz">
                                  {terminParts.notiz}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        </div>
        {!isViewer ? belowCalendarPanels : null}
      </div>

      {patientExportOpen ? (
        <div
          className="staff-modal-overlay patient-export-overlay"
          onClick={closePatientExportModal}
          role="presentation"
        >
          <div
            className="staff-modal patient-export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="patient-export-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="patient-export-title" className="staff-modal-title">
              {patientExportStep === 1
                ? 'Patient für Export wählen'
                : 'Zeitraum wählen'}
            </h2>
            {patientExportStep === 1 ? (
              <>
                <p className="staff-modal-hint">
                  Suche nach Name und/oder Patienten-ID. Wählen Sie einen
                  Patienten und gehen Sie weiter.
                </p>
                <div className="patient-export-search-wrap">
                  <input
                    type="search"
                    className="staff-modal-name-input"
                    value={patientExportQuery}
                    onChange={(e) => setPatientExportQuery(e.target.value)}
                    placeholder="Name oder Patienten-ID …"
                    aria-label="Patienten für Export suchen"
                  />
                </div>
                <ul className="patient-export-list" role="listbox">
                  {patientsFilteredForExport.length === 0 ? (
                    <li className="muted patient-export-empty">Keine Treffer.</li>
                  ) : (
                    patientsFilteredForExport.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={patientExportSelectedId === p.id}
                          className={`patient-export-pick ${patientExportSelectedId === p.id ? 'is-selected' : ''}`}
                          onClick={() => setPatientExportSelectedId(p.id)}
                        >
                          <span className="patient-export-pick-name">
                            {p.name}
                          </span>
                          <span className="patient-export-pick-id">
                            {p.patientCode}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                <div className="staff-modal-footer">
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={() => {
                      if (!patientExportSelectedId) {
                        alertOnce('Bitte einen Patienten auswählen.')
                        return
                      }
                      setPatientExportStep(2)
                    }}
                  >
                    Weiter
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={closePatientExportModal}
                  >
                    Abbrechen
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="staff-modal-hint">
                  Als PDF erscheint die Übersicht auf der Vorlage. Zusätzlich
                  laden Sie ein ZIP-Archiv: darin ein Ordner mit je einer
                  ICS-Datei pro Termin (nach Entpacken in den Kalender
                  importieren).
                </p>
                <div className="patient-export-date-grid">
                  <label className="patient-export-date-label">
                    Von
                    <input
                      type="date"
                      value={patientExportFrom}
                      onChange={(e) => setPatientExportFrom(e.target.value)}
                      aria-label="Export Zeitraum von"
                    />
                  </label>
                  <label className="patient-export-date-label">
                    Bis
                    <input
                      type="date"
                      value={patientExportTo}
                      onChange={(e) => setPatientExportTo(e.target.value)}
                      aria-label="Export Zeitraum bis"
                    />
                  </label>
                </div>
                <div className="staff-modal-footer patient-export-footer-step2">
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={runPatientExportDownloads}
                  >
                    PDF &amp; Termine (.ics als ZIP) exportieren
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={() => setPatientExportStep(1)}
                  >
                    Zurück
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={closePatientExportModal}
                  >
                    Abbrechen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {staffExportOpen ? (
        <div
          className="staff-modal-overlay patient-export-overlay"
          onClick={closeStaffExportModal}
          role="presentation"
        >
          <div
            className="staff-modal patient-export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-export-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="staff-export-title" className="staff-modal-title">
              {staffExportStep === 1
                ? 'Mitarbeiter für Export wählen'
                : 'Zeitraum wählen'}
            </h2>
            {staffExportStep === 1 ? (
              <>
                <p className="staff-modal-hint">
                  Wählen Sie einen Mitarbeiter. Anschließend legen Sie den Zeitraum
                  fest (Standard: aktuelle Kalenderwoche).
                </p>
                <div className="patient-export-search-wrap">
                  <input
                    type="search"
                    className="staff-modal-name-input"
                    value={staffExportQuery}
                    onChange={(e) => setStaffExportQuery(e.target.value)}
                    placeholder="Name …"
                    aria-label="Mitarbeiter für Export suchen"
                  />
                </div>
                <ul className="patient-export-list" role="listbox">
                  {staffFilteredForExport.length === 0 ? (
                    <li className="muted patient-export-empty">Keine Treffer.</li>
                  ) : (
                    staffFilteredForExport.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={staffExportSelectedId === s.id}
                          className={`patient-export-pick ${staffExportSelectedId === s.id ? 'is-selected' : ''}`}
                          onClick={() => setStaffExportSelectedId(s.id)}
                        >
                          <span className="patient-export-pick-name">{s.name}</span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                <div className="staff-modal-footer">
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={() => {
                      if (!staffExportSelectedId) {
                        alertOnce('Bitte einen Mitarbeiter auswählen.')
                        return
                      }
                      setStaffExportStep(2)
                    }}
                  >
                    Weiter
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={closeStaffExportModal}
                  >
                    Abbrechen
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="staff-modal-hint">
                  Es wird eine PDF-Übersicht erzeugt: Datum, Uhrzeit, Raum und
                  Spalte „Termin“ (Patient, Belegungsart, Mitarbeiter jeweils
                  untereinander) für alle Termine im gewählten Zeitraum.
                </p>
                <div className="patient-export-date-grid">
                  <label className="patient-export-date-label">
                    Von
                    <input
                      type="date"
                      value={staffExportFrom}
                      onChange={(e) => setStaffExportFrom(e.target.value)}
                      aria-label="Mitarbeiter-Export Zeitraum von"
                    />
                  </label>
                  <label className="patient-export-date-label">
                    Bis
                    <input
                      type="date"
                      value={staffExportTo}
                      onChange={(e) => setStaffExportTo(e.target.value)}
                      aria-label="Mitarbeiter-Export Zeitraum bis"
                    />
                  </label>
                </div>
                <div className="staff-modal-footer patient-export-footer-step2">
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={runStaffExportPdf}
                  >
                    PDF exportieren
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={() => setStaffExportStep(1)}
                  >
                    Zurück
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={closeStaffExportModal}
                  >
                    Abbrechen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {roomExportOpen ? (
        <div
          className="staff-modal-overlay patient-export-overlay"
          onClick={closeRoomExportModal}
          role="presentation"
        >
          <div
            className="staff-modal patient-export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-export-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="room-export-title" className="staff-modal-title">
              {roomExportStep === 1 ? 'Raum für Export wählen' : 'Zeitraum wählen'}
            </h2>
            {roomExportStep === 1 ? (
              <>
                <p className="staff-modal-hint">
                  Wählen Sie einen Raum. Anschließend legen Sie den Zeitraum fest
                  (Standard: aktuelle Kalenderwoche). Die PDF-Ansicht ist A4
                  Querformat mit den sieben Wochentagen und Zeiten 08:00–20:00
                  Uhr.
                </p>
                <ul className="patient-export-list" role="listbox">
                  {ROOMS.map((r) => (
                    <li key={r}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={roomExportRoom === r}
                        className={`patient-export-pick ${roomExportRoom === r ? 'is-selected' : ''}`}
                        onClick={() => setRoomExportRoom(r)}
                      >
                        <span className="patient-export-pick-name">{r}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="staff-modal-footer">
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={() => {
                      if (!roomExportRoom) {
                        alertOnce('Bitte einen Raum auswählen.')
                        return
                      }
                      setRoomExportStep(2)
                    }}
                  >
                    Weiter
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={closeRoomExportModal}
                  >
                    Abbrechen
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="staff-modal-hint">
                  Es wird eine PDF-Übersicht im Querformat erzeugt. Bei mehreren
                  Kalenderwochen im Zeitraum erhält jede Woche eine eigene Seite.
                </p>
                <div className="patient-export-date-grid">
                  <label className="patient-export-date-label">
                    Von
                    <input
                      type="date"
                      value={roomExportFrom}
                      onChange={(e) => setRoomExportFrom(e.target.value)}
                      aria-label="Raum-Export Zeitraum von"
                    />
                  </label>
                  <label className="patient-export-date-label">
                    Bis
                    <input
                      type="date"
                      value={roomExportTo}
                      onChange={(e) => setRoomExportTo(e.target.value)}
                      aria-label="Raum-Export Zeitraum bis"
                    />
                  </label>
                </div>
                <div className="staff-modal-footer patient-export-footer-step2">
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={runRoomExportPdf}
                  >
                    PDF exportieren
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={() => setRoomExportStep(1)}
                  >
                    Zurück
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    onClick={closeRoomExportModal}
                  >
                    Abbrechen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {musterModalOverlay}

      {newArtModalOpen ? (
        <div
          className="staff-modal-overlay"
          onClick={closeNewArtModal}
          role="presentation"
        >
          <div
            className="staff-modal art-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="art-create-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="art-create-modal-title" className="staff-modal-title">
              Neue Belegungsart
            </h2>
            <label className="staff-modal-label">
              Bezeichnung
              <input
                type="text"
                className="staff-modal-name-input"
                value={newArtLabel}
                onChange={(e) => setNewArtLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveNewArtFromModal()}
                placeholder="z. B. Physiotherapy"
                aria-label="Bezeichnung der neuen Belegungsart"
                autoComplete="off"
                autoFocus
              />
            </label>
            <label className="staff-modal-label">
              Dauer (Min.)
              <select
                className="staff-modal-name-input"
                value={newArtMinutes}
                onChange={(e) => setNewArtMinutes(Number(e.target.value))}
                aria-label="Dauer in Minuten"
              >
                <option value={30}>30</option>
                <option value={60}>60</option>
                <option value={90}>90</option>
                <option value={120}>120</option>
                <option value={150}>150</option>
                <option value={180}>180</option>
              </select>
            </label>
            <label className="staff-modal-label">
              Farbe
              <input
                type="color"
                className="art-create-modal-color-input"
                value={newArtColor}
                onChange={(e) => setNewArtColor(e.target.value)}
                aria-label="Farbe der Belegungsart"
              />
            </label>
            <div className="staff-modal-footer">
              <button
                type="button"
                className="btn-edit-save"
                onClick={saveNewArtFromModal}
              >
                Hinzufügen
              </button>
              <button
                type="button"
                className="btn-edit-cancel"
                onClick={closeNewArtModal}
              >
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {staffAbsenceModalId && staffAbsenceModalStaffView ? (
        <div
          className="staff-modal-overlay"
          onClick={closeStaffAbsenceModal}
          role="presentation"
        >
          <div
            className="staff-modal staff-absence-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-absence-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="staff-absence-modal-title" className="staff-modal-title">
              Urlaub & Abwesenheit
            </h2>
            <p className="staff-modal-hint">
              <strong>{staffAbsenceModalStaffView.name}</strong> — in den
              gewählten Zeiträumen ist der Mitarbeiter für Termine nicht
              verfügbar (Hauptkalender).
            </p>
            <div className="staff-absence-modal-list-wrap">
              <div className="staff-absence-modal-list-head">
                Eingetragene Zeiträume
              </div>
              {(
                [...(staffAbsenceModalStaffView.absences ?? [])].sort((a, b) =>
                  a.fromDk.localeCompare(b.fromDk),
                )
              ).length === 0 ? (
                <p className="staff-absence-modal-empty muted">
                  Noch keine Einträge.
                </p>
              ) : (
                <ul className="staff-absence-modal-list">
                  {[
                    ...(staffAbsenceModalStaffView.absences ?? []),
                  ]
                    .sort((a, b) => a.fromDk.localeCompare(b.fromDk))
                    .map((a) => (
                      <li key={a.id} className="staff-absence-modal-row">
                        <span className="staff-absence-modal-range">
                          {formatAbsencePeriodSummary(a)}
                        </span>
                        <span className="staff-absence-modal-kind">
                          {a.kind === 'urlaub' ? 'Urlaub' : 'Abwesenheit'}
                        </span>
                        <button
                          type="button"
                          className="btn-edit-cancel staff-absence-remove"
                          onClick={() => removeStaffAbsence(a.id)}
                        >
                          Entfernen
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <div className="staff-absence-modal-new">
              <div className="staff-absence-modal-new-head">Neuer Zeitraum</div>
              <label className="staff-modal-label staff-absence-inline">
                Von
                <input
                  type="date"
                  value={staffAbsenceFormFrom}
                  onChange={(e) => setStaffAbsenceFormFrom(e.target.value)}
                  aria-label="Abwesenheit von"
                />
              </label>
              <label className="staff-modal-label staff-absence-inline">
                Bis
                <input
                  type="date"
                  value={staffAbsenceFormTo}
                  onChange={(e) => setStaffAbsenceFormTo(e.target.value)}
                  aria-label="Abwesenheit bis"
                />
              </label>
              <fieldset className="staff-absence-kind-fieldset">
                <legend className="sr-only">Art der Abwesenheit</legend>
                <label className="staff-absence-radio">
                  <input
                    type="radio"
                    name="staff-absence-kind"
                    checked={staffAbsenceFormKind === 'urlaub'}
                    onChange={() => setStaffAbsenceFormKind('urlaub')}
                  />
                  Urlaub
                </label>
                <label className="staff-absence-radio">
                  <input
                    type="radio"
                    name="staff-absence-kind"
                    checked={staffAbsenceFormKind === 'abwesend'}
                    onChange={() => setStaffAbsenceFormKind('abwesend')}
                  />
                  Sonstige Abwesenheit
                </label>
              </fieldset>
              <fieldset className="staff-absence-scope-fieldset">
                <legend className="staff-absence-scope-legend">Umfang (alle Räume)</legend>
                <label className="staff-absence-radio">
                  <input
                    type="radio"
                    name="staff-absence-scope"
                    checked={staffAbsenceFormAllDay}
                    onChange={() => setStaffAbsenceFormAllDay(true)}
                  />
                  Ganztägig (alle Zeitslots des Tages)
                </label>
                <label className="staff-absence-radio">
                  <input
                    type="radio"
                    name="staff-absence-scope"
                    checked={!staffAbsenceFormAllDay}
                    onChange={() => setStaffAbsenceFormAllDay(false)}
                  />
                  Stundenweise (Zeitfenster pro Kalendertag)
                </label>
              </fieldset>
              {!staffAbsenceFormAllDay ? (
                <div className="staff-absence-slot-range">
                  <label className="staff-modal-label staff-absence-inline">
                    Von (Uhrzeit)
                    <select
                      className="staff-modal-name-input"
                      value={staffAbsenceFormStartSlot}
                      onChange={(e) =>
                        setStaffAbsenceFormStartSlot(Number(e.target.value))
                      }
                      aria-label="Abwesenheit ab Slot"
                    >
                      {Array.from({ length: slots }, (_, i) => (
                        <option key={i} value={i}>
                          {slotIndexToLabel(i)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="staff-modal-label staff-absence-inline">
                    Bis (Uhrzeit)
                    <select
                      className="staff-modal-name-input"
                      value={staffAbsenceFormEndSlot}
                      onChange={(e) =>
                        setStaffAbsenceFormEndSlot(Number(e.target.value))
                      }
                      aria-label="Abwesenheit bis Slot"
                    >
                      {Array.from({ length: slots }, (_, i) => (
                        <option key={i} value={i}>
                          {slotIndexToLabel(i)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
            </div>
            <div className="staff-modal-footer">
              <button
                type="button"
                className="btn-edit-save"
                onClick={saveStaffAbsence}
              >
                Zeitraum speichern
              </button>
              <button
                type="button"
                className="btn-edit-cancel"
                onClick={closeStaffAbsenceModal}
              >
                Schließen
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {staffTerminDetailModal ? (
        <div
          className="staff-modal-overlay"
          onClick={closeStaffTerminDetailModal}
          role="presentation"
        >
          <div
            className="staff-modal termin-staff-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-termin-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="staff-termin-detail-title" className="staff-modal-title">
              Termin
            </h2>
            <p className="staff-modal-hint">
              {calendarTabStaffMember ? (
                <strong>{calendarTabStaffMember.name}</strong>
              ) : null}
              {calendarTabStaffMember ? ' · ' : null}
              {parseDateKey(staffTerminDetailModal.dk).toLocaleDateString(
                'de-DE',
                {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                },
              )}
            </p>
            <div className="staff-termin-detail-blocks">
              {staffTerminDetailModal.blocks.map((block, bi) => {
                const { start, end } = findBlockBounds(
                  cellsForActiveCalendarView,
                  staffTerminDetailModal.dk,
                  block.room,
                  block.anchorSlot,
                )
                const anchorKey = makeSlotKey(
                  staffTerminDetailModal.dk,
                  block.room,
                  start,
                )
                const data = cellsForActiveCalendarView[anchorKey]
                const line = cellDisplayLine(data, mitarbeiter)
                return (
                  <div
                    key={`${block.room}-${block.anchorSlot}-${bi}`}
                    className="staff-termin-detail-block"
                  >
                    <p className="staff-modal-hint termin-staff-summary">
                      <strong>{block.room}</strong> ·{' '}
                      {slotIndexToLabel(start)}–{slotEndTimeLabelExclusive(end)}
                    </p>
                    <p className="staff-modal-hint termin-staff-summary">
                      <span className="termin-staff-line">{line}</span>
                    </p>
                    <label className="staff-modal-label staff-termin-notiz-label">
                      Notiz
                      <textarea
                        className="staff-modal-name-input termin-notiz-textarea"
                        rows={3}
                        value={staffTerminNoteDrafts[bi] ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setStaffTerminNoteDrafts((prev) => {
                            const n = [...prev]
                            n[bi] = v
                            return n
                          })
                        }}
                        placeholder="Nur intern sichtbar; wird bei Terminexport nicht mitgesendet."
                        aria-label={`Notiz (${block.room})`}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-edit-save termin-notiz-save staff-termin-notiz-save"
                      onClick={() =>
                        saveStaffTerminNotizAt(bi, staffTerminNoteDrafts[bi] ?? '')
                      }
                    >
                      Notiz speichern
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="staff-modal-footer">
              <button
                type="button"
                className="btn-edit-save"
                onClick={openStaffTerminDetailInMainCalendar}
              >
                Im Hauptkalender anzeigen
              </button>
              <button
                type="button"
                className="btn-edit-cancel"
                onClick={closeStaffTerminDetailModal}
              >
                Schließen
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {terminPickerModal ? (
        <div
          className="staff-modal-overlay"
          onClick={closeTerminPickerModal}
          role="presentation"
        >
          <div
            className="staff-modal termin-staff-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="termin-picker-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="termin-picker-title" className="staff-modal-title">
              {terminPickerModal.kind === 'art'
                ? 'Belegungsart wählen'
                : terminPickerModal.kind === 'teamMeeting'
                  ? 'Teammeeting · Teilnehmer'
                  : 'Mitarbeiter zuordnen'}
            </h2>
            {terminModalDetail ? (
              terminPickerModal.kind === 'art' ? (
                <>
                  <p className="staff-modal-hint termin-staff-summary">
                    {terminModalDetail.room} · {terminModalDetail.timeRange}
                    {terminModalDetail.line ? (
                      <>
                        <br />
                        <span className="termin-staff-line">
                          {terminModalDetail.line}
                        </span>
                      </>
                    ) : null}
                  </p>
                  <p className="staff-modal-hint">
                    Wählen Sie die Art für diesen Patiententermin (Dauer und
                    Farbe wie in den Belegungsarten unten).
                  </p>
                  <ul className="termin-staff-pick-list">
                    {arten.length === 0 ? (
                      <li className="muted">Keine Belegungsarten angelegt.</li>
                    ) : (
                      arten.map((a) => (
                        <li key={a.id}>
                          <button
                            type="button"
                            className="termin-art-pick-btn"
                            onClick={() => assignArtToTerminFromModal(a.id)}
                          >
                            <span
                              className="termin-art-pick-dot"
                              style={{ background: a.color }}
                              aria-hidden
                            />
                            <span className="termin-art-pick-label">
                              {a.label}
                            </span>
                            <span className="termin-art-pick-meta">
                              {a.slots * SLOT_MINUTES} Min
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                  <TerminModalNotizFields
                    draft={terminNotizDraft}
                    onDraftChange={setTerminNotizDraft}
                    onSave={saveTerminNotizFromModal}
                  />
                  <div className="staff-modal-footer termin-staff-footer">
                    <button
                      type="button"
                      className="btn-edit-cancel"
                      onClick={exportTerminToIcs}
                    >
                      Als .ics exportieren
                    </button>
                    <button
                      type="button"
                      className="btn-termin-clear"
                      onClick={clearTerminBlockFromModal}
                    >
                      Termin leeren
                    </button>
                    <button
                      type="button"
                      className="btn-edit-save"
                      onClick={closeTerminPickerModal}
                    >
                      Schließen
                    </button>
                  </div>
                </>
              ) : terminPickerModal.kind === 'teamMeeting' ? (
                <>
                  <p className="staff-modal-hint termin-staff-summary">
                    {terminModalDetail.room} · {terminModalDetail.timeRange}
                    {terminModalDetail.line ? (
                      <>
                        <br />
                        <span className="termin-staff-line">
                          {terminModalDetail.line}
                        </span>
                      </>
                    ) : null}
                  </p>
                  <p className="staff-modal-hint">
                    Teilnehmer auswählen (Mehrfachauswahl). Bei
                    Wiederholungen erscheint der Termin nur bei Mitarbeitern,
                    die nicht abwesend sind und im Wochenplan frei sind —
                    fehlen für eine Woche alle Teilnehmer, wird diese
                    Wiederholung übersprungen.
                  </p>
                  <label className="staff-modal-label">
                    Reihentermin (Anzahl Wochen)
                    <input
                      type="number"
                      className="staff-modal-name-input"
                      min={1}
                      max={52}
                      value={teamMeetingRepeatWeeks}
                      onChange={(e) =>
                        setTeamMeetingRepeatWeeks(
                          Math.max(
                            1,
                            Math.min(52, Number(e.target.value) || 1),
                          ),
                        )
                      }
                      aria-label="Reihentermin Wochenanzahl"
                    />
                  </label>
                  <ul className="termin-staff-pick-list">
                    {teamMeetingEligibleStaffForModal === null ? (
                      <li className="muted">Termin nicht gefunden.</li>
                    ) : teamMeetingEligibleStaffForModal.length === 0 ? (
                      <li className="muted">
                        In diesem Zeitraum ist kein Mitarbeiter verfügbar.
                      </li>
                    ) : (
                      teamMeetingEligibleStaffForModal.map((st) => (
                          <li key={st.id}>
                            <label className="termin-team-pick-row">
                              <input
                                type="checkbox"
                                checked={teamMeetingSelectedIds.includes(st.id)}
                                onChange={() => {
                                  if (
                                    !terminPickerModal ||
                                    terminPickerModal.kind !== 'teamMeeting'
                                  ) {
                                    return
                                  }
                                  const nextSelected = teamMeetingSelectedIds.includes(
                                    st.id,
                                  )
                                    ? teamMeetingSelectedIds.filter((x) => x !== st.id)
                                    : [...teamMeetingSelectedIds, st.id]
                                  setTeamMeetingSelectedIds(nextSelected)
                                  applyTeamMeetingParticipantsToSingleOccurrence(
                                    terminPickerModal.dk,
                                    terminPickerModal.room,
                                    terminPickerModal.anchorSlot,
                                    nextSelected,
                                  )
                                }}
                              />
                              <span>{st.name}</span>
                            </label>
                          </li>
                        ))
                    )}
                  </ul>
                  <TerminModalNotizFields
                    draft={terminNotizDraft}
                    onDraftChange={setTerminNotizDraft}
                    onSave={saveTerminNotizFromModal}
                  />
                  <div className="staff-modal-footer termin-staff-footer">
                    {teamMeetingSelectedIds.length > 0 ? (
                      <button
                        type="button"
                        className="btn-edit-cancel"
                        onClick={removeTeamParticipantsFromModal}
                      >
                        Teilnehmer leeren
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-edit-cancel"
                      onClick={exportTerminToIcs}
                    >
                      Als .ics exportieren
                    </button>
                    <button
                      type="button"
                      className="btn-termin-clear"
                      onClick={clearTerminBlockFromModal}
                    >
                      Termin leeren
                    </button>
                    <button
                      type="button"
                      className="btn-edit-save"
                      onClick={saveTeamMeetingFromModal}
                    >
                      Speichern
                    </button>
                    <button
                      type="button"
                      className="btn-edit-save"
                      onClick={closeTerminPickerModal}
                    >
                      Schließen
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="staff-modal-hint termin-staff-summary">
                    {terminModalDetail.room} · {terminModalDetail.timeRange}
                    {terminModalDetail.line ? (
                      <>
                        <br />
                        <span className="termin-staff-line">
                          {terminModalDetail.line}
                        </span>
                      </>
                    ) : null}
                  </p>
                  {terminModalDetail.currentStaff ? (
                    <p className="termin-staff-current">
                      Aktuell: {terminModalDetail.currentStaff}
                    </p>
                  ) : null}
                  <p className="staff-modal-hint">
                    Es erscheinen nur Mitarbeiter, die im gesamten Termin
                    verfügbar sind
                    {terminModalDetail.blockArtId
                      ? ' und für die gewählte Belegungsart freigeschaltet sind.'
                      : '.'}
                  </p>
                  <ul className="termin-staff-pick-list">
                    {mitarbeiter.length === 0 ? (
                      <li className="muted">Keine Mitarbeiter angelegt.</li>
                    ) : staffPickListForTerminModal === null ? (
                      <li className="muted">Termin nicht gefunden.</li>
                    ) : staffPickListForTerminModal.length === 0 ? (
                      <li className="muted">
                        {terminModalDetail.blockArtId
                          ? 'Kein Mitarbeiter erfüllt Verfügbarkeit und Freigabe für diese Belegungsart im gesamten Zeitraum.'
                          : 'Kein Mitarbeiter ist im gesamten Zeitraum verfügbar.'}
                      </li>
                    ) : (
                      staffPickListForTerminModal.map((st) => (
                        <li key={st.id}>
                          <button
                            type="button"
                            className="termin-staff-pick-btn"
                            onClick={() => assignStaffToTerminBlock(st.id)}
                          >
                            {st.name}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                  <TerminModalNotizFields
                    draft={terminNotizDraft}
                    onDraftChange={setTerminNotizDraft}
                    onSave={saveTerminNotizFromModal}
                  />
                  <div className="staff-modal-footer termin-staff-footer">
                    {terminModalDetail.currentStaffId ? (
                      <button
                        type="button"
                        className="btn-edit-cancel"
                        onClick={removeStaffFromTerminBlock}
                      >
                        Zuordnung entfernen
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-edit-cancel"
                      onClick={exportTerminToIcs}
                    >
                      Als .ics exportieren
                    </button>
                    <button
                      type="button"
                      className="btn-termin-clear"
                      onClick={clearTerminBlockFromModal}
                    >
                      Termin leeren
                    </button>
                    <button
                      type="button"
                      className="btn-edit-save"
                      onClick={closeTerminPickerModal}
                    >
                      Schließen
                    </button>
                  </div>
                </>
              )
            ) : (
              <>
                <p className="staff-modal-hint">
                  Dieser Slot ist nicht mehr belegt.
                </p>
                <div className="staff-modal-footer termin-staff-footer">
                  <button
                    type="button"
                    className="btn-edit-save"
                    onClick={closeTerminPickerModal}
                  >
                    Schließen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {staffModal ? (
        <div
          className="staff-modal-overlay"
          onClick={closeStaffModal}
          role="presentation"
        >
          <div
            className={`staff-modal${staffDraftAlternating ? ' staff-modal--two-week-avail' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="staff-modal-title" className="staff-modal-title">
              {staffModal.mode === 'create'
                ? 'Mitarbeiter anlegen'
                : 'Mitarbeiter bearbeiten'}
            </h2>
            <label className="staff-modal-label">
              Name
              <input
                type="text"
                value={staffDraftName}
                onChange={(e) => setStaffDraftName(e.target.value)}
                className="staff-modal-name-input"
                autoComplete="name"
              />
            </label>
            <div className="staff-two-week-toggle-row">
              <span className="staff-two-week-toggle-label" id="staff-two-week-desc">
                Zwei Wochen wechselnd (ISO-KW)
              </span>
              <button
                type="button"
                role="switch"
                className="muster-art-avail-switch staff-two-week-switch"
                aria-checked={staffDraftAlternating}
                aria-describedby="staff-two-week-desc"
                onClick={() => {
                  if (!staffDraftAlternating) {
                    setStaffDraftAvailOdd({ ...staffDraftAvail })
                    setStaffDraftAlternating(true)
                  } else {
                    setStaffDraftAlternating(false)
                  }
                }}
              />
            </div>
            <p className="staff-modal-hint staff-two-week-hint">
              {staffDraftAlternating
                ? 'Erstes Raster: gerade Kalenderwochen (KW 2, 4, 6 …). Zweites Raster: ungerade KW (1, 3, 5 …).'
                : 'Ein Raster für alle Wochen. Schalter aktivieren für abwechselnde Wochenpläne.'}
            </p>
            <div className="staff-modal-columns">
              <div className="staff-modal-col staff-modal-col--avail">
                <h3 className="staff-modal-subtitle">Verfügbarkeit</h3>
                <p className="staff-modal-hint">
                  Spalten: Wochentage · Zeilen: Uhrzeiten. Klick markiert oder
                  demarkiert; mit gedrückter Maustaste ziehen, um denselben
                  Zustand zu übernehmen.
                </p>
                <div
                  className={
                    staffDraftAlternating
                      ? 'staff-avail-week-stack staff-avail-week-stack--side-by-side'
                      : 'staff-avail-week-stack'
                  }
                >
                  <div className="staff-avail-week-block">
                    <h4 className="staff-avail-week-title">
                      {staffDraftAlternating
                        ? 'Gerade Kalenderwoche (ISO)'
                        : 'Jede Woche'}
                    </h4>
                    <div className="staff-avail-scroll">
                      <table className="staff-avail-table">
                        <thead>
                          <tr>
                            <th className="staff-avail-corner" scope="col" />
                            {WEEKDAY_SHORT_DE.map((dayLabel) => (
                              <th
                                key={dayLabel}
                                className="staff-avail-day-header"
                                scope="col"
                              >
                                {dayLabel}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from({ length: slotCount() }, (_, sl) => (
                            <tr key={sl}>
                              <th
                                className="staff-avail-time-rowhead"
                                scope="row"
                              >
                                {slotIndexToLabel(sl)}
                              </th>
                              {WEEKDAY_SHORT_DE.map((dayLabel, w) => {
                                const k = staffAvailKey(w, sl)
                                const on = staffDraftAvail[k] === true
                                return (
                                  <td key={w} className="staff-avail-cell">
                                    <button
                                      type="button"
                                      className={`staff-avail-slot ${on ? 'is-on' : ''}`}
                                      aria-pressed={on}
                                      aria-label={`${staffDraftAlternating ? 'Gerade KW: ' : ''}${dayLabel} ${slotIndexToLabel(sl)}`}
                                      onPointerDown={(e) => {
                                        if (e.button !== 0) return
                                        e.preventDefault()
                                        beginStaffAvailPaint('even', w, sl)
                                      }}
                                      onPointerEnter={(e) => {
                                        if ((e.buttons & 1) === 0) return
                                        extendStaffAvailPaint(w, sl)
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === ' ' || e.key === 'Enter') {
                                          e.preventDefault()
                                          toggleStaffDraftSlotKeyboard(
                                            'even',
                                            w,
                                            sl,
                                          )
                                        }
                                      }}
                                    />
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {staffDraftAlternating ? (
                    <div className="staff-avail-week-block">
                      <h4 className="staff-avail-week-title">
                        Ungerade Kalenderwoche (ISO)
                      </h4>
                      <div className="staff-avail-scroll">
                        <table className="staff-avail-table">
                          <thead>
                            <tr>
                              <th className="staff-avail-corner" scope="col" />
                              {WEEKDAY_SHORT_DE.map((dayLabel) => (
                                <th
                                  key={`odd-${dayLabel}`}
                                  className="staff-avail-day-header"
                                  scope="col"
                                >
                                  {dayLabel}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Array.from({ length: slotCount() }, (_, sl) => (
                              <tr key={`odd-${sl}`}>
                                <th
                                  className="staff-avail-time-rowhead"
                                  scope="row"
                                >
                                  {slotIndexToLabel(sl)}
                                </th>
                                {WEEKDAY_SHORT_DE.map((dayLabel, w) => {
                                  const k = staffAvailKey(w, sl)
                                  const on = staffDraftAvailOdd[k] === true
                                  return (
                                    <td key={w} className="staff-avail-cell">
                                      <button
                                        type="button"
                                        className={`staff-avail-slot ${on ? 'is-on' : ''}`}
                                        aria-pressed={on}
                                        aria-label={`Ungerade KW: ${dayLabel} ${slotIndexToLabel(sl)}`}
                                        onPointerDown={(e) => {
                                          if (e.button !== 0) return
                                          e.preventDefault()
                                          beginStaffAvailPaint('odd', w, sl)
                                        }}
                                        onPointerEnter={(e) => {
                                          if ((e.buttons & 1) === 0) return
                                          extendStaffAvailPaint(w, sl)
                                        }}
                                        onKeyDown={(e) => {
                                          if (
                                            e.key === ' ' ||
                                            e.key === 'Enter'
                                          ) {
                                            e.preventDefault()
                                            toggleStaffDraftSlotKeyboard(
                                              'odd',
                                              w,
                                              sl,
                                            )
                                          }
                                        }}
                                      />
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="staff-modal-col">
                <h3 className="staff-modal-subtitle">
                  Freigegebene Belegungsarten
                </h3>
                <p className="staff-modal-hint">
                  Nur diese Arten können zugewiesen werden, wenn dieser
                  Mitarbeiter im Termin-Slot steht. Unten können alle Arten auf
                  einmal aus- oder abgewählt werden.
                </p>
                <div className="staff-art-bulk">
                  <button
                    type="button"
                    className="btn-edit-save"
                    disabled={arten.length === 0 || allStaffDraftArtsSelected}
                    onClick={selectAllStaffDraftArts}
                  >
                    Alle auswählen
                  </button>
                  <button
                    type="button"
                    className="btn-edit-cancel"
                    disabled={noStaffDraftArtsSelected}
                    onClick={clearAllStaffDraftArts}
                  >
                    Alle abwählen
                  </button>
                </div>
                <ul className="staff-art-checklist">
                  {arten.map((a) => (
                    <li key={a.id}>
                      <label className="staff-art-label">
                        <input
                          type="checkbox"
                          checked={staffDraftArtIds.includes(a.id)}
                          onChange={() => toggleStaffDraftArt(a.id)}
                        />
                        <span
                          className="staff-art-dot"
                          style={{ background: a.color }}
                        />
                        <span>{a.label}</span>
                        <span className="staff-art-min">
                          {a.slots * SLOT_MINUTES} Min
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="staff-modal-footer">
              <button
                type="button"
                className="btn-edit-save"
                onClick={saveStaffModal}
              >
                Speichern
              </button>
              <button
                type="button"
                className="btn-edit-cancel"
                onClick={closeStaffModal}
              >
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function summarizeSlots(indices: number[]): string[] {
  if (!indices.length) return []
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  const ranges: { start: number; end: number }[] = []
  let cur = { start: sorted[0], end: sorted[0] }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === cur.end + 1) cur.end = sorted[i]
    else {
      ranges.push(cur)
      cur = { start: sorted[i], end: sorted[i] }
    }
  }
  ranges.push(cur)
  return ranges.map((r) => {
    const a = slotIndexToLabel(r.start)
    const b = slotIndexToLabel(r.end)
    return r.start === r.end ? a : `${a}–${b}`
  })
}
