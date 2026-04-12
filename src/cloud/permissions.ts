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

/** Ohne Rolle (nur lokaler Modus): alles erlaubt. */
export function can(
  role: AppRole | null | undefined,
  capability: Capability,
): boolean {
  if (role == null) return true
  return byRole[role]?.has(capability) ?? false
}
