import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
type BelegungsmusterItem = {
  id: string
  label: string
  /** Länge des Musters in aufeinanderfolgenden Slots */
  slotCount: number
  color: string
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

function findStaffForCell(
  cur: CellData | undefined,
  staffList: MitarbeiterItem[],
): MitarbeiterItem | undefined {
  if (!cur) return undefined
  if (cur.staffId) return staffList.find((x) => x.id === cur.staffId)
  if (cur.staff) return staffList.find((x) => x.name === cur.staff)
  return undefined
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
  { id: 'm1', label: 'Kurzblock 30 Min', slotCount: 1, color: '#0f766e' },
  { id: 'm2', label: 'Standard 60 Min', slotCount: 2, color: '#4f46e5' },
  { id: 'm3', label: 'Intensiv 90 Min', slotCount: 3, color: '#b45309' },
  { id: 'm4', label: 'Doppelstunde', slotCount: 4, color: '#be185d' },
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
      muster: Array.isArray(o.muster) ? o.muster : DEFAULT_MUSTER,
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

function parseDragPayload(dt: DataTransfer): DragPayload | null {
  try {
    const raw = dt.getData(MIME_PHYSIO) || dt.getData('text/plain')
    if (!raw) return null
    const o = JSON.parse(raw) as DragPayload
    if (!o || typeof o !== 'object' || !('kind' in o)) return null
    return o as DragPayload
  } catch {
    return null
  }
}

function cellDisplayLine(data: CellData | undefined): string {
  if (!data) return ''
  let main = ''
  if (data.patient) {
    main = data.patientCode
      ? `${data.patient} (${data.patientCode})`
      : data.patient
  } else if (data.art) main = data.art
  else if (data.muster) main = data.muster
  else if (data.staff) return data.staff

  if (data.staff && main) return `${main} · ${data.staff}`
  return main
}

function cellAccentColor(data: CellData | undefined): string | undefined {
  if (!data) return undefined
  return data.musterColor || data.artColor
}

export default function App() {
  const initialPanels = useMemo(() => loadPanels(), [])
  const [viewMode, setViewMode] = useState<ViewMode>('week')
  const [anchorDate, setAnchorDate] = useState(() => calendarDate(new Date()))
  const [slotCells, setSlotCells] = useState<Record<string, CellData>>(loadSlotCells)
  const [patients, setPatients] = useState<PatientItem[]>(
    () => initialPanels?.patients ?? DEFAULT_PATIENTS,
  )
  const [arten, setArten] = useState<BelegungsartItem[]>(
    () => initialPanels?.arten ?? DEFAULT_ARTEN,
  )
  const [newArtLabel, setNewArtLabel] = useState('')
  const [newArtMinutes, setNewArtMinutes] = useState(60)
  const [newArtColor, setNewArtColor] = useState('#0d9488')
  const [muster] = useState<BelegungsmusterItem[]>(
    () => initialPanels?.muster ?? DEFAULT_MUSTER,
  )
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
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [newPatientName, setNewPatientName] = useState('')
  const [newPatientCode, setNewPatientCode] = useState('')
  const [editingPatientId, setEditingPatientId] = useState<string | null>(null)
  const [editPatientName, setEditPatientName] = useState('')
  const [editPatientCode, setEditPatientCode] = useState('')
  const [patientSearchQuery, setPatientSearchQuery] = useState('')
  const dayGridRef = useRef<HTMLDivElement>(null)
  const pendingScrollToNow = useRef(false)

  useEffect(() => {
    saveSlotCells(slotCells)
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

  const applyDrop = useCallback(
    (
      dk: string,
      room: Room,
      startSlot: number,
      payload: DragPayload,
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
          const cur = { ...(prev[k] ?? {}) }
          return { ...prev, [k]: { ...cur, patient: p.name, patientCode: p.patientCode } }
        }

        if (payload.kind === 'art') {
          const a = artById(payload.id)
          if (!a) return prev
          const span = Math.min(Math.max(1, a.slots), max - startSlot)
          for (let i = 0; i < span; i++) {
            const k = makeSlotKey(dk, room, startSlot + i)
            const cur = prev[k]
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
          const span = Math.min(Math.max(1, m.slotCount), max - startSlot)
          const next = { ...prev }
          for (let i = 0; i < span; i++) {
            const k = makeSlotKey(dk, room, startSlot + i)
            const cur = { ...(next[k] ?? {}) }
            next[k] = {
              ...cur,
              muster: m.label,
              musterColor: m.color,
            }
          }
          return next
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
      applyDrop(dk, room, slotIndex, payload)
    },
    [applyDrop],
  )

  const handleDropOnWeekCell = useCallback(
    (e: React.DragEvent, dk: string, room: Room) => {
      e.preventDefault()
      setDragOverKey(null)
      const payload = parseDragPayload(e.dataTransfer)
      if (!payload) return
      applyDrop(dk, room, 0, payload)
    },
    [applyDrop],
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

  const onDragStart = (e: React.DragEvent, payload: DragPayload) => {
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
              <button
                type="button"
                className="drag-chip art-chip"
                style={{ borderLeftColor: a.color }}
                draggable
                onDragStart={(e) => onDragStart(e, { kind: 'art', id: a.id })}
              >
                <span className="chip-dot" style={{ background: a.color }} />
                <span className="chip-label">{a.label}</span>
                <span className="chip-meta">{a.slots * SLOT_MINUTES} Min</span>
              </button>
              <button
                type="button"
                className="btn-patient-action btn-patient-delete"
                onClick={() => removeBelegungsart(a)}
              >
                Entfernen
              </button>
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
        <p className="panel-desc">Blocklängen hintereinander auf den Plan ziehen.</p>
        <ul className="panel-list panel-list-compact">
          {muster.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="drag-chip muster-chip"
                style={{ borderLeftColor: m.color }}
                draggable
                onDragStart={(e) => onDragStart(e, { kind: 'muster', id: m.id })}
              >
                <span className="chip-dot" style={{ background: m.color }} />
                <span className="chip-label">{m.label}</span>
                <span className="chip-meta">{m.slotCount} Slots</span>
              </button>
            </li>
          ))}
        </ul>
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
          <button type="button" className="btn-today" onClick={goToday}>
            Heute
          </button>
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
            <p className="panel-desc">In die Tages- oder Wochenzelle ziehen.</p>
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
              ? 'Zeilen 08:00–20:00: Klick leert eine Zelle. Patienten links; Belegungsarten, Muster und Mitarbeiter unten. Mitarbeiter nur in markierten Wochenzeiten und nur mit freigegebenen Belegungsarten (siehe Profil).'
              : 'Wochenzelle: Drop ab 08:00. Mitarbeiter-Regeln wie in der Tagesansicht. Bausteine unter dem Kalender.'}
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
                              onClick={() => openDayForCell(d)}
                              onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'copy'
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
                <div className="corner" />
                {ROOMS.map((r) => (
                  <div key={r} className="col-head">
                    {r}
                  </div>
                ))}
                {Array.from({ length: slots }, (_, slotIndex) => (
                  <div
                    key={slotIndex}
                    className="day-slot-row"
                    data-slot-row={slotIndex}
                    style={{
                      display: 'contents',
                    }}
                  >
                    <div
                      className={`time-label ${slotIndex === currentSlot ? 'now-line' : ''}`}
                    >
                      {slotIndexToLabel(slotIndex)}
                    </div>
                    {ROOMS.map((room) => {
                      const k = makeSlotKey(activeDayKey, room, slotIndex)
                      const data = slotCells[k]
                      const booked = isCellBooked(data)
                      const line = cellDisplayLine(data)
                      const accent = cellAccentColor(data)
                      return (
                        <button
                          key={k}
                          type="button"
                          className={`slot-cell ${booked ? 'booked' : ''} ${slotIndex === currentSlot ? 'now-line' : ''} ${dragOverKey === k ? 'drag-over' : ''}`}
                          style={
                            booked && accent
                              ? {
                                  background: `color-mix(in srgb, ${accent} 35%, var(--slot-free))`,
                                  boxShadow: `inset 0 0 0 1px ${accent}`,
                                }
                              : undefined
                          }
                          onClick={() => toggleSlot(activeDayKey, room, slotIndex)}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            e.dataTransfer.dropEffect = 'copy'
                            setDragOverKey(k)
                          }}
                          onDragLeave={() => setDragOverKey((key) => (key === k ? null : key))}
                          onDrop={(e) => handleDropOnSlot(e, activeDayKey, room, slotIndex)}
                          aria-label={`${room} ${slotIndexToLabel(slotIndex)} ${booked ? `${line}, leeren` : 'frei'}`}
                        >
                          {line ? (
                            <span className="slot-cell-label" title={line}>
                              {line}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
          {belowCalendarPanels}
        </div>
      </div>

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
