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

type PatientItem = { id: string; name: string }
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

type DragPayload =
  | { kind: 'patient'; id: string }
  | { kind: 'art'; id: string }
  | { kind: 'muster'; id: string }

type CellData = {
  patient?: string
  art?: string
  artColor?: string
  muster?: string
  musterColor?: string
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

function isCellBooked(data: CellData | undefined): boolean {
  if (!data) return false
  return !!(data.patient || data.art || data.muster)
}

const STORAGE_KEY_V1 = 'physio-planung-bookings-v1'
const STORAGE_KEY_V2 = 'physio-planung-slots-v2'
const STORAGE_PANELS = 'physio-planung-panels-v1'

const DEFAULT_PATIENTS: PatientItem[] = [
  { id: 'p1', name: 'Max Mustermann' },
  { id: 'p2', name: 'Anna Schmidt' },
  { id: 'p3', name: 'Thomas Weber' },
]

const DEFAULT_ARTEN: BelegungsartItem[] = [
  { id: 'a1', label: 'Einzelbehandlung', color: '#0d9488', slots: 1 },
  { id: 'a2', label: 'Gruppentraining', color: '#7c3aed', slots: 2 },
  { id: 'a3', label: 'Assessment', color: '#ea580c', slots: 1 },
  { id: 'a4', label: 'Manuelle Therapie', color: '#0284c7', slots: 2 },
]

const DEFAULT_MUSTER: BelegungsmusterItem[] = [
  { id: 'm1', label: 'Kurzblock 30 Min', slotCount: 1, color: '#0f766e' },
  { id: 'm2', label: 'Standard 60 Min', slotCount: 2, color: '#4f46e5' },
  { id: 'm3', label: 'Intensiv 90 Min', slotCount: 3, color: '#b45309' },
  { id: 'm4', label: 'Doppelstunde', slotCount: 4, color: '#be185d' },
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
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_PANELS)
    if (!raw) return null
    const o = JSON.parse(raw) as {
      patients?: PatientItem[]
      arten?: BelegungsartItem[]
      muster?: BelegungsmusterItem[]
    }
    return {
      patients: Array.isArray(o.patients) ? o.patients : DEFAULT_PATIENTS,
      arten: Array.isArray(o.arten) ? o.arten : DEFAULT_ARTEN,
      muster: Array.isArray(o.muster) ? o.muster : DEFAULT_MUSTER,
    }
  } catch {
    return null
  }
}

function savePanelsState(p: {
  patients: PatientItem[]
  arten: BelegungsartItem[]
  muster: BelegungsmusterItem[]
}) {
  localStorage.setItem(STORAGE_PANELS, JSON.stringify(p))
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
  if (data.patient) return data.patient
  if (data.art) return data.art
  if (data.muster) return data.muster
  return ''
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
  const [arten] = useState<BelegungsartItem[]>(
    () => initialPanels?.arten ?? DEFAULT_ARTEN,
  )
  const [muster] = useState<BelegungsmusterItem[]>(
    () => initialPanels?.muster ?? DEFAULT_MUSTER,
  )
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [newPatientName, setNewPatientName] = useState('')
  const dayGridRef = useRef<HTMLDivElement>(null)
  const pendingScrollToNow = useRef(false)

  useEffect(() => {
    saveSlotCells(slotCells)
  }, [slotCells])

  useEffect(() => {
    savePanelsState({ patients, arten, muster })
  }, [patients, arten, muster])

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

      setSlotCells((prev) => {
        const next = { ...prev }
        const max = slotCount()

        if (payload.kind === 'patient') {
          const p = patientById(payload.id)
          if (!p) return prev
          const k = makeSlotKey(dk, room, startSlot)
          const cur = { ...next[k] }
          next[k] = { ...cur, patient: p.name }
          return next
        }

        if (payload.kind === 'art') {
          const a = artById(payload.id)
          if (!a) return prev
          const span = Math.min(Math.max(1, a.slots), max - startSlot)
          for (let i = 0; i < span; i++) {
            const k = makeSlotKey(dk, room, startSlot + i)
            const cur = { ...next[k] }
            next[k] = {
              ...cur,
              art: a.label,
              artColor: a.color,
            }
          }
          return next
        }

        if (payload.kind === 'muster') {
          const m = musterById(payload.id)
          if (!m) return prev
          const span = Math.min(Math.max(1, m.slotCount), max - startSlot)
          for (let i = 0; i < span; i++) {
            const k = makeSlotKey(dk, room, startSlot + i)
            const cur = { ...next[k] }
            next[k] = {
              ...cur,
              muster: m.label,
              musterColor: m.color,
            }
          }
          return next
        }

        return prev
      })
    },
    [patients, arten, muster],
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
    if (!name) return
    setPatients((p) => [
      ...p,
      { id: `p-${Date.now()}`, name },
    ])
    setNewPatientName('')
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Physio PlanungsApp</h1>
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
        <aside className="side-panels" aria-label="Planungsbausteine">
          <section className="panel">
            <h2 className="panel-title">Patienten</h2>
            <p className="panel-desc">In die Tages- oder Wochenzelle ziehen.</p>
            <ul className="panel-list">
              {patients.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="drag-chip patient-chip"
                    draggable
                    onDragStart={(e) => onDragStart(e, { kind: 'patient', id: p.id })}
                  >
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
            <div className="panel-add">
              <input
                type="text"
                value={newPatientName}
                onChange={(e) => setNewPatientName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPatient()}
                placeholder="Neuer Patient"
                aria-label="Neuer Patient"
              />
              <button type="button" className="btn-add" onClick={addPatient}>
                Hinzufügen
              </button>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Belegungsarten</h2>
            <p className="panel-desc">Legt Art und Dauer (Slots) auf dem Raster.</p>
            <ul className="panel-list">
              {arten.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="drag-chip art-chip"
                    style={{ borderLeftColor: a.color }}
                    draggable
                    onDragStart={(e) => onDragStart(e, { kind: 'art', id: a.id })}
                  >
                    <span className="chip-dot" style={{ background: a.color }} />
                    <span className="chip-label">{a.label}</span>
                    <span className="chip-meta">{a.slots}× 30 Min</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <h2 className="panel-title">Belegungsmuster</h2>
            <p className="panel-desc">Vordefinierte Blocklängen hintereinander.</p>
            <ul className="panel-list">
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
        </aside>

        <div className="main-column">
          <p className="hint">
            {viewMode === 'day'
              ? `Zeilen 08:00–20:00: Klick leert eine Zelle. Ziehen Sie Patienten, Belegungsarten oder Muster aus dem linken Bereich auf eine Zelle.`
              : 'Wochenzelle: Drop ab erstem Slot (08:00) des Tages im jeweiligen Raum. Klick öffnet den Tag in der Tagesansicht.'}
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
        </div>
      </div>
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
