import type { AppRole } from './types'

export type Capability =
  | 'calendar:read'
  | 'calendar:write'
  | 'patients:read'
  | 'patients:write'
  | 'staff:read'
  | 'staff:write'
  | 'staff:absences'
  | 'arten:write'
  | 'muster:write'
  | 'export:run'

const adminAll: Capability[] = [
  'calendar:read',
  'calendar:write',
  'patients:read',
  'patients:write',
  'staff:read',
  'staff:write',
  'staff:absences',
  'arten:write',
  'muster:write',
  'export:run',
]

const planung: Capability[] = [
  'calendar:read',
  'calendar:write',
  'patients:read',
  'patients:write',
  'staff:read',
  'staff:write',
  'staff:absences',
  'arten:write',
  'muster:write',
  'export:run',
]

const therapie: Capability[] = [
  'calendar:read',
  'calendar:write',
  'patients:read',
  'staff:read',
  'staff:absences',
  'export:run',
]

/** Nur Ansehen: kein Kalender-Schreiben, keine Stammdaten, kein Export. */
const viewer: Capability[] = [
  'calendar:read',
  'patients:read',
  'staff:read',
]

const byRole: Record<AppRole, Set<Capability>> = {
  admin: new Set(adminAll),
  planung: new Set(planung),
  therapie: new Set(therapie),
  viewer: new Set(viewer),
}

/** Reihenfolge für UI und gespeicherte Matrix. */
export const ALL_CAPABILITIES: Capability[] = [
  'calendar:read',
  'calendar:write',
  'patients:read',
  'patients:write',
  'staff:read',
  'staff:write',
  'staff:absences',
  'arten:write',
  'muster:write',
  'export:run',
]

export const CAPABILITY_LABEL_DE: Record<Capability, string> = {
  'calendar:read': 'Kalender lesen',
  'calendar:write': 'Kalender bearbeiten',
  'patients:read': 'Patienten lesen',
  'patients:write': 'Patienten bearbeiten',
  'staff:read': 'Mitarbeiter lesen',
  'staff:write': 'Mitarbeiter bearbeiten',
  'staff:absences': 'Abwesenheiten / Verfügbarkeit',
  'arten:write': 'Belegungsarten bearbeiten',
  'muster:write': 'Belegungsmuster bearbeiten',
  'export:run': 'Export (PDF / ICS)',
}

export type RoleCapabilityMatrix = Partial<
  Record<AppRole, Partial<Record<Capability, boolean>>>
>

const APP_ROLES: AppRole[] = ['admin', 'planung', 'therapie', 'viewer']

export function defaultHasCapability(
  role: AppRole,
  capability: Capability,
): boolean {
  return byRole[role]?.has(capability) ?? false
}

export function parseRoleCapabilityDocument(
  raw: unknown,
): RoleCapabilityMatrix | null {
  if (raw == null || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  const rawMatrix =
    root.matrix !== undefined && root.matrix !== null
      ? root.matrix
      : root
  if (rawMatrix == null || typeof rawMatrix !== 'object') return null
  const src = rawMatrix as Record<string, unknown>
  const out: RoleCapabilityMatrix = {}
  for (const r of APP_ROLES) {
    const row = src[r]
    if (row == null || typeof row !== 'object') continue
    const capRow: Partial<Record<Capability, boolean>> = {}
    const rowObj = row as Record<string, unknown>
    for (const cap of ALL_CAPABILITIES) {
      const val = rowObj[cap]
      if (val === true) capRow[cap] = true
      else if (val === false) capRow[cap] = false
    }
    if (Object.keys(capRow).length) out[r] = capRow
  }
  return Object.keys(out).length ? out : null
}

/** Volle Matrix (alle Rollen × Rechte) für Speichern / UI-Zustand. */
export function buildFullRoleCapabilityMatrix(
  prev: RoleCapabilityMatrix | null,
): Record<AppRole, Record<Capability, boolean>> {
  const out = {} as Record<AppRole, Record<Capability, boolean>>
  for (const role of APP_ROLES) {
    const row = {} as Record<Capability, boolean>
    for (const cap of ALL_CAPABILITIES) {
      const o = prev?.[role]?.[cap]
      row[cap] = o === true || o === false ? o : defaultHasCapability(role, cap)
    }
    out[role] = row
  }
  return out
}

export function roleCapabilityDocumentBody(
  matrix: Record<AppRole, Record<Capability, boolean>>,
): { v: number; matrix: Record<AppRole, Record<Capability, boolean>> } {
  return { v: 1, matrix }
}

/** Ohne Rolle (nur lokaler Modus): alles erlaubt. */
export function can(
  role: AppRole | null | undefined,
  capability: Capability,
  orgMatrix?: RoleCapabilityMatrix | null,
): boolean {
  if (role == null) return true
  const override = orgMatrix?.[role]?.[capability]
  if (override === true) return true
  if (override === false) return false
  return byRole[role]?.has(capability) ?? false
}
