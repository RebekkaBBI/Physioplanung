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
import './App.css'

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
}
/** Pro Slot im Muster-Editor; Schlüssel `wd|Raum|slot` mit wd 0=Mo … 6=So */
type MusterTemplateCell = {
  art?: string
  artId?: string
  artColor?: string
}

type BelegungsmusterItem = {
  id: string
  label: string
  templateCells: Record<string, MusterTemplateCell>
}

type MitarbeiterItem = {
  id: string
  name: string
  /** Mo=0 … So=6, Slot 0 = 08:00 — Schlüssel `${w}|${slot}` */
  availability: Record<string, boolean>
  /** Freigegebene Belegungsarten (IDs) */
  allowedArtIds: string[]
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

/** Montag = 0 … Sonntag = 6 */
function weekdayMon0FromDate(d: Date): number {
  const day = d.getDay()
  return day === 0 ? 6 : day - 1
}

function staffAvailKey(weekdayMon0: number, slotIndex: number): string {
  return `${weekdayMon0}|${slotIndex}`
}

function isStaffSlotAvailable(
  s: MitarbeiterItem,
  weekdayMon0: number,
  slotIndex: number,
): boolean {
  return s.availability[staffAvailKey(weekdayMon0, slotIndex)] === true
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
  const st = findStaffForCell(template, staffList)
  if (st) {
    if (!isStaffSlotAvailable(st, wd, slot)) {
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
  return [
    c.patient ?? '',
    c.patientCode ?? '',
    c.artId ?? '',
    c.art ?? '',
    c.staffId ?? '',
    c.staff ?? '',
    c.muster ?? '',
  ].join('\x1f')
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
  const allowedArtIds =
    Array.isArray(raw.allowedArtIds) && raw.allowedArtIds.length > 0
      ? [...raw.allowedArtIds]
      : [...allArtIds]
  return {
    id: raw.id,
    name: raw.name,
    availability,
    allowedArtIds,
  }
}

function isCellBooked(data: CellData | undefined): boolean {
  if (!data) return false
  return !!(data.patient || data.art || data.muster || data.staff)
}

const STORAGE_KEY_V1 = 'physio-planung-bookings-v1'
const STORAGE_KEY_V2 = 'physio-planung-slots-v2'
const STORAGE_PANELS = 'physio-planung-panels-v1'
/** Erhöhen, wenn sich die feste Belegungsarten-Liste ändert (Migration aus localStorage). */
const ARTEN_CATALOG_VERSION = 2

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
  { id: 'art-hbot', label: 'HBOT', color: '#0891b2', slots: 2 },
  { id: 'art-clicking', label: 'Clicking', color: '#a855f7', slots: 4 },
  { id: 'art-stretching-1', label: 'Stretching 1', color: '#ea580c', slots: 2 },
  { id: 'art-stretching-2', label: 'Stretching 2', color: '#059669', slots: 2 },
  { id: 'art-stretching-3', label: 'Stretching 3', color: '#c026d3', slots: 2 },
]

const DEFAULT_MUSTER: BelegungsmusterItem[] = [
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

function loadPanels(): {
  patients: PatientItem[]
  arten: BelegungsartItem[]
  muster: BelegungsmusterItem[]
  mitarbeiter: MitarbeiterItem[]
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_PANELS)
    if (!raw) return null
    const o = JSON.parse(raw) as {
      patients?: PatientItem[]
      arten?: BelegungsartItem[]
      muster?: BelegungsmusterItem[]
      mitarbeiter?: MitarbeiterItem[]
      artenCatalogVersion?: number
    }
    const catalogOk =
      (o.artenCatalogVersion ?? 0) >= ARTEN_CATALOG_VERSION &&
      Array.isArray(o.arten) &&
      o.arten.length > 0
    const resolvedArten = catalogOk ? o.arten! : DEFAULT_ARTEN
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
      muster: Array.isArray(o.muster)
        ? o.muster.map(normalizeMusterItem)
        : DEFAULT_MUSTER,
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
    }
  } catch {
    return null
  }
}

function savePanelsState(p: {
  patients: PatientItem[]
  arten: BelegungsartItem[]
  muster: BelegungsmusterItem[]
  mitarbeiter: MitarbeiterItem[]
}) {
  localStorage.setItem(
    STORAGE_PANELS,
    JSON.stringify({
      ...p,
      artenCatalogVersion: ARTEN_CATALOG_VERSION,
    }),
  )
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

/** Fiktive Woche (1970) für Muster-Editor: Mo–So als echte Datums-Keys wie im Plan */
const MUSTER_TEMPLATE_MONDAY = calendarDate(new Date(1970, 0, 5))

function templateDkForWeekday(wd: number): string {
  return dateKey(addDays(MUSTER_TEMPLATE_MONDAY, wd))
}

function templateWeekdayFromDk(dk: string): number | null {
  for (let w = 0; w < 7; w++) {
    if (templateDkForWeekday(w) === dk) return w
  }
  return null
}

function parseMusterTemplateKey(
  key: string,
): { wd: number; room: Room; slot: number } | null {
  const parts = key.split('|')
  if (parts.length !== 3) return null
  const wd = Number(parts[0])
  const slot = Number(parts[2])
  const room = parts[1] as Room
  const n = slotCount()
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null
  if (!isRoomString(room) || !Number.isInteger(slot) || slot < 0 || slot >= n) {
    return null
  }
  return { wd, room, slot }
}

function musterTemplateToVirtual(
  tpl: Record<string, MusterTemplateCell>,
): Record<string, CellData> {
  const out: Record<string, CellData> = {}
  for (const [key, cell] of Object.entries(tpl)) {
    const p = parseMusterTemplateKey(key)
    if (!p) continue
    const dk = templateDkForWeekday(p.wd)
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
    const wd = templateWeekdayFromDk(dk)
    if (wd === null || !isRoomString(room)) continue
    if (!data.art && !data.artId) continue
    out[`${wd}|${room}|${slot}`] = {
      art: data.art,
      artId: data.artId,
      artColor: data.artColor,
    }
  }
  return out
}

function tryApplyMusterWeekToSlots(
  prev: Record<string, CellData>,
  weekStart: Date,
  templateCells: Record<string, MusterTemplateCell>,
): { next: Record<string, CellData> } | { error: string } {
  const virt = musterTemplateToVirtual(templateCells)
  const seen = new Set<string>()
  type Op = { targetKeys: string[]; cells: CellData[] }
  const ops: Op[] = []
  const max = slotCount()

  for (let wd = 0; wd < 7; wd++) {
    const vdk = templateDkForWeekday(wd)
    for (const room of ROOMS) {
      for (let sl = 0; sl < max; sl++) {
        const k = makeSlotKey(vdk, room, sl)
        const d = virt[k]
        if (!isCellBooked(d)) continue
        if (seen.has(k)) continue
        const { start, end } = findBlockBounds(virt, vdk, room, sl)
        const tDk = dateKey(addDays(weekStart, wd))
        const cells: CellData[] = []
        const targetKeys: string[] = []
        for (let s = start; s <= end; s++) {
          const vk = makeSlotKey(vdk, room, s)
          seen.add(vk)
          cells.push({ ...virt[vk]! })
          targetKeys.push(makeSlotKey(tDk, room, s))
        }
        ops.push({ targetKeys, cells })
      }
    }
  }

  const next = { ...prev }
  for (const op of ops) {
    for (const tk of op.targetKeys) {
      if (isCellBooked(next[tk])) {
        return {
          error:
            'In dieser Woche sind Zielzellen bereits belegt. Bitte freie Bereiche wählen oder Zellen leeren.',
        }
      }
    }
  }
  for (const op of ops) {
    for (let i = 0; i < op.targetKeys.length; i++) {
      next[op.targetKeys[i]] = { ...op.cells[i] }
    }
  }
  return { next }
}

function applyArtDropNoPatient(
  prev: Record<string, CellData>,
  dk: string,
  room: Room,
  startSlot: number,
  a: BelegungsartItem,
): Record<string, CellData> | null {
  const max = slotCount()
  const span = Math.min(Math.max(1, a.slots), max - startSlot)
  for (let i = 0; i < span; i++) {
    const k = makeSlotKey(dk, room, startSlot + i)
    if (isCellBooked(prev[k])) {
      window.alert('Dieser Bereich im Muster ist bereits belegt.')
      return null
    }
  }
  const next = { ...prev }
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
): Record<string, CellData> | null {
  const max = slotCount()
  const { start, end } = findBlockBounds(prev, fromDk, fromRoom, fromSlot)
  const startK = makeSlotKey(fromDk, fromRoom, start)
  if (!isCellBooked(prev[startK])) return prev

  const len = end - start + 1
  if (toStartSlot < 0 || toStartSlot + len > max) {
    window.alert('Termin passt an diese Position nicht (Tagesende).')
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
      window.alert('Zielbereich ist belegt.')
      return null
    }
    const cell = snapshot[i]
    const st = findStaffForCell(cell, mitarbeiter)
    if (st) {
      if (!isStaffSlotAvailable(st, wdTo, toStartSlot + i)) {
        window.alert(
          'Zu dieser Zeit ist der Mitarbeiter in seinem Wochenplan nicht verfügbar.',
        )
        return null
      }
      const artId = findArtIdForCell(cell, arten)
      if (artId && !st.allowedArtIds.includes(artId)) {
        window.alert(
          'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.',
        )
        return null
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

  if (dropDk !== payload.fromDk || dropRoom !== payload.fromRoom) {
    window.alert(
      'Die Dauer kann nur am selben Tag und im selben Raum geändert werden.',
    )
    return null
  }

  const wd = weekdayMon0FromDate(parseDateKey(payload.fromDk))
  const template = { ...prev[startK] }

  if (payload.edge === 'bottom') {
    if (targetSlot < start) {
      window.alert('Ungültige Position.')
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
          window.alert(err)
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
      window.alert('Ungültige Position.')
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
          window.alert(err)
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
  }
  if (!r || typeof r.id !== 'string' || typeof r.label !== 'string') {
    return {
      id: `muster-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      label: 'Muster',
      templateCells: {},
    }
  }
  if (r.templateCells && typeof r.templateCells === 'object') {
    return {
      id: r.id,
      label: r.label,
      templateCells: { ...r.templateCells },
    }
  }
  return { id: r.id, label: r.label, templateCells: {} }
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

function cellTerminLabelParts(data: CellData | undefined): {
  patient: string | null
  art: string | null
  staffName: string | null
} {
  if (!data) return { patient: null, art: null, staffName: null }
  const patient = data.patient
    ? data.patientCode
      ? `${data.patient} (${data.patientCode})`
      : data.patient
    : null
  const art = data.art ?? data.muster ?? null
  const staffName = data.staff?.trim() ? data.staff : null
  return { patient, art, staffName }
}

function cellDisplayLine(data: CellData | undefined): string {
  const { patient, art, staffName } = cellTerminLabelParts(data)
  return [
    patient ?? '—',
    art ?? '—',
    staffName ?? 'Mitarbeiter zuteilen',
  ].join(' · ')
}

function cellAccentColor(data: CellData | undefined): string | undefined {
  if (!data) return undefined
  return data.musterColor || data.artColor
}

const SLOT_UNDO_MAX = 50

type MusterWeekEditorGridProps = {
  draftCells: Record<string, CellData>
  dragOverKey: string | null
  setDragOverKey: Dispatch<SetStateAction<string | null>>
  onEditorDrop: (e: DragEvent, dk: string, room: Room, sl: number) => void
  onClearBlock: (dk: string, room: Room, sl: number) => void
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
}

function MusterWeekEditorGrid({
  draftCells,
  dragOverKey,
  setDragOverKey,
  onEditorDrop,
  onClearBlock,
  endPanelOrCellDrag,
  startCellMoveDrag,
  startResizeDrag,
  suppressClickAfterDrag,
  dragSourceRef,
}: MusterWeekEditorGridProps) {
  const slotsN = slotCount()
  return (
    <div className="muster-week-editor-row">
      {Array.from({ length: 7 }, (_, wd) => {
        const dayDk = templateDkForWeekday(wd)
        return (
          <div key={wd} className="muster-day-column">
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
                        const line = cellDisplayLine(anchorData)
                        const terminParts = cellTerminLabelParts(anchorData)
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
                        const showResizeTop =
                          booked &&
                          blockSegFirst !== null &&
                          (blockSegFirst === 'start' ||
                            blockSegFirst === 'single')
                        const showResizeBottom =
                          booked &&
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
                                return (
                                  <button
                                    key={k}
                                    type="button"
                                    className={`slot-cell slot-cell-main ${subBooked ? 'booked' : ''} ${subBooked && subSeg ? `slot-block--${subSeg}` : ''}`}
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
                                          }
                                        : undefined
                                    }
                                    draggable={subBooked}
                                    onClick={() => {
                                      if (
                                        Date.now() - suppressClickAfterDrag.current <
                                        450
                                      ) {
                                        return
                                      }
                                      if (subBooked) {
                                        onClearBlock(dayDk, room, sl)
                                      }
                                    }}
                                    onDragStart={(e) => {
                                      if (!subBooked) return
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
                                      subBooked
                                        ? `${room} ${slotIndexToLabel(sl)} ${line}, Klick zum Entfernen`
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
                                <span className="slot-cell-termin-line slot-cell-termin-placeholder">
                                  —
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
  )
}

function cloneSlotMap(c: Record<string, CellData>): Record<string, CellData> {
  try {
    return structuredClone(c)
  } catch {
    return JSON.parse(JSON.stringify(c)) as Record<string, CellData>
  }
}

export default function App() {
  const initialPanels = useMemo(() => loadPanels(), [])
  const [viewMode, setViewMode] = useState<ViewMode>('week')
  const [anchorDate, setAnchorDate] = useState(() => calendarDate(new Date()))
  const [slotCells, setSlotCellsBase] = useState<Record<string, CellData>>(
    loadSlotCells,
  )
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
  const [editingArtId, setEditingArtId] = useState<string | null>(null)
  const [editArtLabel, setEditArtLabel] = useState('')
  const [editArtMinutes, setEditArtMinutes] = useState(60)
  const [editArtColor, setEditArtColor] = useState('#0d9488')
  const [muster, setMuster] = useState<BelegungsmusterItem[]>(
    () => initialPanels?.muster ?? DEFAULT_MUSTER,
  )
  const [musterModal, setMusterModal] = useState<
    null | { mode: 'create' } | { mode: 'edit'; id: string }
  >(null)
  const [musterDraftLabel, setMusterDraftLabel] = useState('')
  const [musterDraftCells, setMusterDraftCells] = useState<Record<string, CellData>>(
    {},
  )
  const [musterEditorDragOverKey, setMusterEditorDragOverKey] = useState<
    string | null
  >(null)
  const musterEditorSuppressClick = useRef(0)
  const [mitarbeiter, setMitarbeiter] = useState<MitarbeiterItem[]>(
    () => initialPanels?.mitarbeiter ?? DEFAULT_MITARBEITER,
  )
  const [staffModal, setStaffModal] = useState<
    null | { mode: 'create' } | { mode: 'edit'; id: string }
  >(null)
  const [staffDraftName, setStaffDraftName] = useState('')
  const [staffDraftAvail, setStaffDraftAvail] = useState<Record<string, boolean>>(
    () => emptyStaffAvailability(slotCount()),
  )
  const [staffDraftArtIds, setStaffDraftArtIds] = useState<string[]>([])
  const [terminPickerModal, setTerminPickerModal] = useState<
    | null
    | { kind: 'art'; dk: string; room: Room; anchorSlot: number }
    | { kind: 'staff'; dk: string; room: Room; anchorSlot: number }
  >(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [newPatientName, setNewPatientName] = useState('')
  const [newPatientCode, setNewPatientCode] = useState('')
  const [editingPatientId, setEditingPatientId] = useState<string | null>(null)
  const [editPatientName, setEditPatientName] = useState('')
  const [editPatientCode, setEditPatientCode] = useState('')
  const [patientSearchQuery, setPatientSearchQuery] = useState('')
  const dayGridRef = useRef<HTMLDivElement>(null)
  const pendingScrollToNow = useRef(false)
  const dragSourceRef = useRef<'panel' | 'cell' | 'resize' | null>(null)
  const suppressSlotClickAfterDrag = useRef(0)

  useEffect(() => {
    saveSlotCells(slotCells)
  }, [slotCells])

  useEffect(() => {
    setCanUndoSlots(slotUndoStackRef.current.length > 0)
  }, [slotCells])

  useEffect(() => {
    savePanelsState({ patients, arten, muster, mitarbeiter })
  }, [patients, arten, muster, mitarbeiter])

  useEffect(() => {
    if (!pendingScrollToNow.current || viewMode !== 'day') return
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
  }, [viewMode, anchorDate])

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

  const weekStart = useMemo(() => startOfWeekMonday(anchorDate), [anchorDate])
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }, [weekStart])

  const activeDayKey = dateKey(anchorDate)

  const goToday = useCallback(() => {
    setAnchorDate(calendarDate(new Date()))
    setViewMode('day')
    pendingScrollToNow.current = true
  }, [])

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
    [arten, mitarbeiter],
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
    [arten, mitarbeiter],
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

      setSlotCells((prev) => {
        const max = slotCount()

        if (payload.kind === 'patient') {
          const p = patientById(payload.id)
          if (!p) return prev
          const k = makeSlotKey(dk, room, startSlot)
          if (isCellBooked(prev[k])) {
            window.alert(
              'Bitte ein freies Feld wählen. Patienten können nur in leere Zellen gezogen werden.',
            )
            return prev
          }
          const cur = { ...(prev[k] ?? {}) }
          return {
            ...prev,
            [k]: { ...cur, patient: p.name, patientCode: p.patientCode },
          }
        }

        if (payload.kind === 'art') {
          const a = artById(payload.id)
          if (!a) return prev
          const span = Math.min(Math.max(1, a.slots), max - startSlot)
          const startK = makeSlotKey(dk, room, startSlot)
          const startCur = prev[startK]
          if (!startCur?.patient) {
            window.alert(
              'Bitte zuerst einen Patienten in dieses Feld ziehen. Danach die Belegungsart – die Zelle erhält dann die Farbe der Art.',
            )
            return prev
          }
          const pname = startCur.patient
          const pcode = startCur.patientCode

          for (let i = 0; i < span; i++) {
            const k = makeSlotKey(dk, room, startSlot + i)
            const cur = prev[k]
            if (cur?.patient && cur.patient !== pname) {
              window.alert(
                'Im gewählten Zeitraum ist bereits ein anderer Patient eingetragen.',
              )
              return prev
            }
            const st = findStaffForCell(cur, mitarbeiter)
            if (st) {
              if (!isStaffSlotAvailable(st, wd, startSlot + i)) {
                window.alert(
                  'Zu dieser Zeit ist der Mitarbeiter in seinem Wochenplan nicht verfügbar.',
                )
                return prev
              }
              if (!st.allowedArtIds.includes(a.id)) {
                window.alert(
                  'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.',
                )
                return prev
              }
            }
          }
          const next = { ...prev }
          for (let i = 0; i < span; i++) {
            const k = makeSlotKey(dk, room, startSlot + i)
            const cur = { ...(next[k] ?? {}) }
            next[k] = {
              ...cur,
              patient: pname,
              patientCode: pcode,
              art: a.label,
              artId: a.id,
              artColor: a.color,
            }
          }
          return next
        }

        if (payload.kind === 'muster') {
          const m = musterById(payload.id)
          if (!m) return prev
          const weekStart = startOfWeekMonday(parseDateKey(dk))
          const res = tryApplyMusterWeekToSlots(prev, weekStart, m.templateCells)
          if ('error' in res) {
            window.alert(res.error)
            return prev
          }
          return res.next
        }

        if (payload.kind === 'staff') {
          const s = staffById(payload.id)
          if (!s) return prev
          if (!isStaffSlotAvailable(s, wd, startSlot)) {
            window.alert(
              'Dieser Mitarbeiter ist zu dieser Zeit in seinem Wochenplan nicht als verfügbar markiert.',
            )
            return prev
          }
          const k = makeSlotKey(dk, room, startSlot)
          const cur = { ...(prev[k] ?? {}) }
          const artId = findArtIdForCell(cur, arten)
          if (artId && !s.allowedArtIds.includes(artId)) {
            window.alert(
              'Diese Belegungsart ist für den Mitarbeiter in seinem Profil nicht freigegeben.',
            )
            return prev
          }
          return {
            ...prev,
            [k]: { ...cur, staff: s.name, staffId: s.id },
          }
        }

        return prev
      })
    },
    [patients, arten, muster, mitarbeiter],
  )

  const handleDropOnSlot = useCallback(
    (e: React.DragEvent, dk: string, room: Room, slotIndex: number) => {
      e.preventDefault()
      setDragOverKey(null)
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
    [applyDrop, applyMoveBlock, applyResizeBlock],
  )

  const handleDropOnWeekCell = useCallback(
    (e: React.DragEvent, dk: string, room: Room) => {
      e.preventDefault()
      setDragOverKey(null)
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
        const weekStart = startOfWeekMonday(parseDateKey(dk))
        setSlotCells((prev) => {
          const res = tryApplyMusterWeekToSlots(prev, weekStart, m.templateCells)
          if ('error' in res) {
            window.alert(res.error)
            return prev
          }
          return res.next
        })
        return
      }
      applyDrop(dk, room, 0, payload)
    },
    [applyDrop, applyMoveBlock, muster],
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
  }, [])

  const closeTerminPickerModal = useCallback(() => {
    setTerminPickerModal(null)
  }, [])

  const assignArtToTerminFromModal = useCallback(
    (artId: string) => {
      if (!terminPickerModal || terminPickerModal.kind !== 'art') return
      const { dk, room, anchorSlot } = terminPickerModal
      const { start } = findBlockBounds(slotCells, dk, room, anchorSlot)
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
        const { start, end } = findBlockBounds(prev, dk, room, anchorSlot)
        const startK = makeSlotKey(dk, room, start)
        if (!isCellBooked(prev[startK])) return prev
        const wd = weekdayMon0FromDate(parseDateKey(dk))
        for (let sl = start; sl <= end; sl++) {
          if (!isStaffSlotAvailable(s, wd, sl)) {
            window.alert(
              'Dieser Mitarbeiter ist zu dieser Zeit in seinem Wochenplan nicht als verfügbar markiert.',
            )
            return prev
          }
          const k = makeSlotKey(dk, room, sl)
          const cur = prev[k]
          const artId = findArtIdForCell(cur, arten)
          if (artId && !s.allowedArtIds.includes(artId)) {
            window.alert(
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
    [terminPickerModal, mitarbeiter, arten],
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
  }, [terminPickerModal])

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
  }, [terminPickerModal])

  const openDayForCell = useCallback((d: Date) => {
    setAnchorDate(calendarDate(d))
    setViewMode('day')
  }, [])

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
  const now = new Date()
  const isToday = dateKey(anchorDate) === dateKey(now)
  const currentSlot =
    isToday && viewMode === 'day'
      ? Math.floor(
          (now.getHours() * 60 + now.getMinutes() - DAY_START_HOUR * 60) /
            SLOT_MINUTES,
        )
      : -1

  const terminModalDetail = useMemo(() => {
    if (!terminPickerModal) return null
    const { kind, dk, room, anchorSlot } = terminPickerModal
    const { start, end } = findBlockBounds(slotCells, dk, room, anchorSlot)
    const startK = makeSlotKey(dk, room, start)
    const sample = slotCells[startK]
    if (!sample || !isCellBooked(sample)) return null
    const line = cellDisplayLine(sample)
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
    }
  }, [terminPickerModal, slotCells])

  const endPanelOrCellDrag = useCallback(() => {
    dragSourceRef.current = null
    setMusterEditorDragOverKey(null)
  }, [])

  const onDragStart = (e: React.DragEvent, payload: PanelDragPayload) => {
    dragSourceRef.current = 'panel'
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
    setEditingPatientId(p.id)
    setEditPatientName(p.name)
    setEditPatientCode(p.patientCode)
  }

  const saveEditPatient = () => {
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

  const openStaffModalCreate = () => {
    setStaffDraftName('')
    setStaffDraftAvail(emptyStaffAvailability(slotCount()))
    setStaffDraftArtIds([])
    setStaffModal({ mode: 'create' })
  }

  const openStaffModalEdit = (id: string) => {
    const s = mitarbeiter.find((x) => x.id === id)
    if (!s) return
    setStaffDraftName(s.name)
    setStaffDraftAvail({ ...s.availability })
    setStaffDraftArtIds([...s.allowedArtIds])
    setStaffModal({ mode: 'edit', id })
  }

  const closeStaffModal = () => setStaffModal(null)

  const saveStaffModal = () => {
    if (!staffModal) return
    const name = staffDraftName.trim()
    if (!name) {
      window.alert('Bitte einen Namen eingeben.')
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
    const validArtIds = staffDraftArtIds.filter((id) =>
      arten.some((a) => a.id === id),
    )
    const item: MitarbeiterItem = {
      id: staffModal.mode === 'create' ? `st-${Date.now()}` : staffModal.id,
      name,
      availability,
      allowedArtIds: validArtIds,
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

  const toggleStaffDraftSlot = (w: number, sl: number) => {
    const k = staffAvailKey(w, sl)
    setStaffDraftAvail((a) => ({ ...a, [k]: !a[k] }))
  }

  const toggleStaffDraftArt = (artId: string) => {
    setStaffDraftArtIds((ids) =>
      ids.includes(artId) ? ids.filter((x) => x !== artId) : [...ids, artId],
    )
  }

  const addBelegungsart = () => {
    const label = newArtLabel.trim()
    if (!label) {
      window.alert('Bitte eine Bezeichnung für die Belegungsart eingeben.')
      return
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
  }

  const cancelEditArt = useCallback(() => {
    setEditingArtId(null)
    setEditArtLabel('')
    setEditArtMinutes(60)
    setEditArtColor('#0d9488')
  }, [])

  const startEditArt = (a: BelegungsartItem) => {
    setEditingArtId(a.id)
    setEditArtLabel(a.label)
    setEditArtMinutes(a.slots * SLOT_MINUTES)
    setEditArtColor(a.color)
  }

  const saveEditArt = () => {
    if (!editingArtId) return
    const label = editArtLabel.trim()
    if (!label) {
      window.alert('Bitte eine Bezeichnung eingeben.')
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
    if (arten.length <= 1) {
      window.alert('Es muss mindestens eine Belegungsart bestehen bleiben.')
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
  }, [])

  const openMusterModalCreate = useCallback(() => {
    setMusterDraftLabel('')
    setMusterDraftCells({})
    setMusterModal({ mode: 'create' })
  }, [])

  const openMusterModalEdit = useCallback((m: BelegungsmusterItem) => {
    setMusterDraftLabel(m.label)
    setMusterDraftCells(musterTemplateToVirtual(m.templateCells))
    setMusterModal({ mode: 'edit', id: m.id })
  }, [])

  const saveMusterModal = useCallback(() => {
    const label = musterDraftLabel.trim()
    if (!label) {
      window.alert('Bitte eine Bezeichnung eingeben.')
      return
    }
    if (!musterModal) return
    const tpl = virtualToMusterTemplate(musterDraftCells)
    if (musterModal.mode === 'create') {
      setMuster((prev) => [
        ...prev,
        { id: `muster-${Date.now()}`, label, templateCells: tpl },
      ])
    } else {
      const id = musterModal.id
      setMuster((prev) =>
        prev.map((x) =>
          x.id === id ? { ...x, label, templateCells: tpl } : x,
        ),
      )
    }
    closeMusterModal()
  }, [
    musterDraftLabel,
    musterDraftCells,
    musterModal,
    closeMusterModal,
  ])

  const removeMuster = (m: BelegungsmusterItem) => {
    if (!window.confirm(`Belegungsmuster „${m.label}“ wirklich entfernen?`)) {
      return
    }
    if (musterModal?.mode === 'edit' && musterModal.id === m.id) {
      closeMusterModal()
    }
    setMuster((list) => list.filter((x) => x.id !== m.id))
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
      const next = { ...prev }
      for (let s = start; s <= end; s++) {
        delete next[makeSlotKey(dk, room, s)]
      }
      return next
    })
  }, [])

  const deleteStaffMember = (s: MitarbeiterItem) => {
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

  const belowCalendarPanels = (
    <div className="calendar-below-panels">
      <section className="panel panel-below-calendar" aria-label="Belegungsarten">
        <h2 className="panel-title">Belegungsarten</h2>
        <p className="panel-desc">
          Ziehen auf das Raster. Neue Arten werden allen Mitarbeitern freigeschaltet;
          beim Entfernen nur diese Art überall gelöscht.
        </p>
        <ul className="panel-list panel-list-compact arten-panel-list">
          {arten.map((a) => (
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
                        onClick={() => startEditArt(a)}
                      >
                        Bearbeiten
                      </button>
                      <button
                        type="button"
                        className="btn-patient-action btn-patient-delete"
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
        <div className="panel-add panel-add-arten">
          <input
            type="text"
            value={newArtLabel}
            onChange={(e) => setNewArtLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addBelegungsart()}
            placeholder="Bezeichnung"
            aria-label="Neue Belegungsart Bezeichnung"
          />
          <label className="arten-add-duration">
            Dauer (Min.)
            <select
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
          <label className="arten-add-color">
            Farbe
            <input
              type="color"
              value={newArtColor}
              onChange={(e) => setNewArtColor(e.target.value)}
              aria-label="Farbe der Belegungsart"
            />
          </label>
          <button type="button" className="btn-add" onClick={addBelegungsart}>
            Belegungsart hinzufügen
          </button>
        </div>
      </section>

      <section className="panel panel-below-calendar" aria-label="Belegungsmuster">
        <h2 className="panel-title">Belegungsmuster</h2>
        <p className="panel-desc">
          Wochenraster Mo–So mit Belegungsarten füllen (Editor wie im Kalender).
          Muster auf einen Tag oder ein Wochenfeld ziehen: nur freie Zellen der
          Kalenderwoche werden belegt.
        </p>
        <ul className="panel-list panel-list-compact arten-panel-list">
          {muster.map((m) => (
            <li key={m.id} className="arten-panel-row">
              <div className="arten-entry">
                <div className="arten-entry-body arten-entry-inline">
                  <button
                    type="button"
                    className="drag-chip muster-chip arten-inline-drag"
                    draggable
                    onDragStart={(e) =>
                      onDragStart(e, { kind: 'muster', id: m.id })
                    }
                    onDragEnd={endPanelOrCellDrag}
                    aria-label={`Muster „${m.label}“ auf eine Kalenderwoche ziehen`}
                  >
                    <span className="chip-label">{m.label}</span>
                  </button>
                  <div
                    className="arten-entry-actions arten-entry-actions-inline"
                    role="group"
                    aria-label={`Aktionen für ${m.label}`}
                  >
                    <button
                      type="button"
                      className="btn-patient-action"
                      onClick={() => openMusterModalEdit(m)}
                    >
                      Bearbeiten
                    </button>
                    <button
                      type="button"
                      className="btn-patient-action btn-patient-delete"
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
        <button type="button" className="btn-add" onClick={openMusterModalCreate}>
          Neues Belegungsmuster anlegen
        </button>
      </section>

      <section className="panel panel-below-calendar" aria-label="Mitarbeiter">
        <h2 className="panel-title">Mitarbeiter</h2>
        <p className="panel-desc">
          Anlegen öffnet Wochenzeiten (Mo–So, 08:00–20:00) und freigegebene
          Belegungsarten. Nur dort ist der Mitarbeiter im Plan einsetzbar.
        </p>
        <ul className="panel-list panel-list-compact staff-panel-list">
          {mitarbeiter.map((s) => (
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
                <button
                  type="button"
                  className="btn-patient-action"
                  onClick={() => openStaffModalEdit(s.id)}
                >
                  Bearbeiten
                </button>
                <button
                  type="button"
                  className="btn-patient-action btn-patient-delete"
                  onClick={() => deleteStaffMember(s)}
                >
                  Löschen
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-add btn-staff-create" onClick={openStaffModalCreate}>
          Mitarbeiter anlegen
        </button>
      </section>
    </div>
  )

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
          <label className="muster-modal-label">
            Bezeichnung
            <input
              type="text"
              value={musterDraftLabel}
              onChange={(e) => setMusterDraftLabel(e.target.value)}
              placeholder="z. B. Standardwoche Team A"
              aria-label="Bezeichnung des Musters"
            />
          </label>
          <p className="staff-modal-hint">
            Sieben Tage nebeneinander (Mo–So). Belegungsarten aus dem Panel links
            auf freie Felder ziehen; Blöcke verschieben und am Rand in der Dauer
            ändern wie im Terminkalender. Klick auf einen Block entfernt ihn.
          </p>
          <div className="muster-modal-grid-scroll">
            <MusterWeekEditorGrid
              draftCells={musterDraftCells}
              dragOverKey={musterEditorDragOverKey}
              setDragOverKey={setMusterEditorDragOverKey}
              onEditorDrop={handleMusterEditorDrop}
              onClearBlock={clearMusterDraftBlock}
              endPanelOrCellDrag={endPanelOrCellDrag}
              startCellMoveDrag={startCellMoveDrag}
              startResizeDrag={startResizeDrag}
              suppressClickAfterDrag={musterEditorSuppressClick}
              dragSourceRef={dragSourceRef}
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
        </div>
      </div>
    )

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-row">
          <img
            src="/logo-bbi.png"
            alt="BBI"
            className="app-logo"
            width={240}
            height={96}
            decoding="async"
          />
          <h1 className="app-title">Physio PlanungsApp</h1>
        </div>
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Ansicht">
            <button
              type="button"
              className={viewMode === 'day' ? 'active' : ''}
              aria-pressed={viewMode === 'day'}
              onClick={() => setViewMode('day')}
            >
              Tagesansicht
            </button>
            <button
              type="button"
              className={viewMode === 'week' ? 'active' : ''}
              aria-pressed={viewMode === 'week'}
              onClick={() => setViewMode('week')}
            >
              Wochenansicht
            </button>
          </div>
          <div className="toolbar-today-group">
            <button type="button" className="btn-today" onClick={goToday}>
              Heute
            </button>
            <button
              type="button"
              className="btn-undo"
              disabled={!canUndoSlots}
              onClick={undoSlotCells}
              title="Letzte Änderung am Terminplan rückgängig machen"
              aria-label="Letzte Änderung am Terminplan rückgängig machen"
            >
              Rückgängig
            </button>
          </div>
          <div className="nav-arrows">
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

      <div className="app-body">
        <aside className="side-panels" aria-label="Patienten">
          <section className="panel panel-patients" aria-label="Patienten-Panel">
            <h2 className="panel-title">Patienten</h2>
            <p className="panel-desc">
              Zuerst in eine <strong>leere</strong> Zelle ziehen; danach die
              Belegungsart auf dieselbe Zelle – diese erhält die Farbe der Art.
            </p>
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
                            onClick={() => startEditPatient(p)}
                          >
                            Bearbeiten
                          </button>
                          <button
                            type="button"
                            className="btn-patient-action btn-patient-delete"
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
              />
              <input
                type="text"
                value={newPatientCode}
                onChange={(e) => setNewPatientCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPatient()}
                placeholder="Patienten-ID"
                autoComplete="off"
                aria-label="Patienten-ID"
              />
              <button type="button" className="btn-add" onClick={addPatient}>
                Hinzufügen
              </button>
            </div>
          </section>
        </aside>

        <div className="main-column">
          <p className="hint">
            {viewMode === 'day'
              ? 'Ablauf: Patient in freie Zelle ziehen, dann per Klick Belegungsart wählen (ohne Art zuerst), danach Mitarbeiter. Oder Art/Mitarbeiter aus dem Panel ziehen. Termin ziehen zum Verschieben; Rand für die Dauer. Freie Zelle: Klick markiert Belegung.'
              : 'Patient zuerst in leeres Feld, dann Belegungsart (ab 08:00). Termin aus der Zelle oder Wochenfeld ziehen zum Verschieben. Klick öffnet den Tag in der Tagesansicht. Belegungsmuster auf ein Wochenfeld ziehen: Vorlage Mo–So nur auf freie Zellen dieser Woche.'}
          </p>

          {viewMode === 'week' ? (
            <div className="grid-wrap">
              <div
                className="plan-grid week-grid"
                style={{
                  gridTemplateColumns: `minmax(7.5rem, 9rem) repeat(${ROOMS.length}, minmax(5rem, 1fr))`,
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
                        const booked = bookingsForDayRoom(slotCells, dk, room)
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
                  const rowMergeNext = ROOMS.some((room) => {
                    const d =
                      slotCells[makeSlotKey(activeDayKey, room, slotIndex)]
                    if (!isCellBooked(d)) return false
                    const seg = daySlotBlockSegment(
                      slotCells,
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
                      className={`time-label ${slotIndex === currentSlot ? 'now-line' : ''} ${rowMergeNext ? 'time-label--merge-next' : ''}`}
                      style={{ gridColumn: 1, gridRow: slotIndex + 2 }}
                    >
                      {slotIndexToLabel(slotIndex)}
                    </div>
                    {ROOMS.map((room, roomIdx) => {
                      const gridCol = roomIdx + 2
                      const kHere = makeSlotKey(activeDayKey, room, slotIndex)
                      const dataHere = slotCells[kHere]
                      const booked = isCellBooked(dataHere)
                      const bounds = booked
                        ? findBlockBounds(
                            slotCells,
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
                      const anchorData = slotCells[anchorKey]
                      const line = cellDisplayLine(anchorData)
                      const terminParts = cellTerminLabelParts(anchorData)
                      const accent = cellAccentColor(anchorData)
                      const blockSegFirst = daySlotBlockSegment(
                        slotCells,
                        activeDayKey,
                        room,
                        anchorSl,
                        slots,
                      )
                      const lastSl =
                        slotIndicesForShell[slotIndicesForShell.length - 1]
                      const blockSegLast = daySlotBlockSegment(
                        slotCells,
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
                              const data = slotCells[k]
                              const subBooked = isCellBooked(data)
                              const subLine = cellDisplayLine(data)
                              const subSeg = daySlotBlockSegment(
                                slotCells,
                                activeDayKey,
                                room,
                                sl,
                                slots,
                              )
                              return (
                                <button
                                  key={k}
                                  type="button"
                                  className={`slot-cell slot-cell-main ${subBooked ? 'booked' : ''} ${subBooked && subSeg ? `slot-block--${subSeg}` : ''} ${sl === currentSlot ? 'now-line' : ''}`}
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
                                        }
                                      : undefined
                                  }
                                  draggable={subBooked}
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
                                {terminParts.staffName ?? 'Mitarbeiter zuteilen'}
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
          )}
          {belowCalendarPanels}
        </div>
      </div>

      {musterModalOverlay}

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
                  <div className="staff-modal-footer termin-staff-footer">
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
                  <ul className="termin-staff-pick-list">
                    {mitarbeiter.length === 0 ? (
                      <li className="muted">Keine Mitarbeiter angelegt.</li>
                    ) : (
                      mitarbeiter.map((st) => (
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
            className="staff-modal"
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
            <div className="staff-modal-columns">
              <div className="staff-modal-col">
                <h3 className="staff-modal-subtitle">Verfügbarkeit (Woche)</h3>
                <p className="staff-modal-hint">
                  Spalten: Wochentage · Zeilen: Uhrzeiten (08:00–20:00) — Klick
                  markiert Arbeitszeit.
                </p>
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
                                  aria-label={`${dayLabel} ${slotIndexToLabel(sl)}`}
                                  onClick={() => toggleStaffDraftSlot(w, sl)}
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
              <div className="staff-modal-col">
                <h3 className="staff-modal-subtitle">
                  Freigegebene Belegungsarten
                </h3>
                <p className="staff-modal-hint">
                  Nur diese Arten können zugewiesen werden, wenn dieser
                  Mitarbeiter im Termin-Slot steht.
                </p>
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
