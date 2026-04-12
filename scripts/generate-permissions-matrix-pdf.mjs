/**
 * Erzeugt Berechtigungen-Matrix.pdf (sync mit src/cloud/permissions.ts).
 * Ausführen: node scripts/generate-permissions-matrix-pdf.mjs
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const adminAll = [
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

const planung = [...adminAll]
const therapie = [
  'calendar:read',
  'calendar:write',
  'patients:read',
  'staff:read',
  'staff:absences',
  'export:run',
]
const viewer = ['calendar:read', 'patients:read', 'staff:read']

const byRole = {
  admin: new Set(adminAll),
  planung: new Set(planung),
  therapie: new Set(therapie),
  viewer: new Set(viewer),
}

const rows = [
  ['calendar:read', 'Kalender lesen'],
  ['calendar:write', 'Kalender schreiben (Termine)'],
  ['patients:read', 'Patienten lesen'],
  ['patients:write', 'Patienten schreiben'],
  ['staff:read', 'Mitarbeiter / Listen lesen'],
  ['staff:write', 'Mitarbeiter-Stammdaten schreiben'],
  ['staff:absences', 'Abwesenheiten (Mitarbeiter)'],
  ['arten:write', 'Belegungsarten pflegen'],
  ['muster:write', 'Belegungsmuster pflegen'],
  ['export:run', 'Export (Patient / MA / Raum)'],
]

const roles = ['admin', 'planung', 'therapie', 'viewer']

function has(role, cap) {
  return byRole[role]?.has(cap) ?? false
}

async function main() {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595, 842])
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const draw = (text, x, y, opts = {}) => {
    const {
      size = 9,
      bold = false,
      col = rgb(0, 0, 0),
    } = opts
    page.drawText(text, {
      x,
      y,
      size,
      font: bold ? fontBold : font,
      color: col,
    })
  }

  let y = 800
  draw('Physioplanung — Berechtigungen (Rollen)', 50, y, { size: 14, bold: true })
  y -= 22
  draw('Stand: Matrix entspricht src/cloud/permissions.ts', 50, y, { size: 8 })
  y -= 28

  const xCap = 50
  const xCols = [320, 370, 430, 490]
  const rowH = 16

  draw('Bereich / Aktion', xCap, y, { size: 9, bold: true })
  roles.forEach((r, i) => {
    draw(r, xCols[i], y, { size: 9, bold: true })
  })
  y -= rowH + 4

  for (const [cap, label] of rows) {
    if (y < 72) break
    const short =
      label.length > 42 ? `${label.slice(0, 39)}...` : label
    draw(short, xCap, y, { size: 9 })
    roles.forEach((role, i) => {
      const ok = has(role, cap)
      draw(ok ? 'ja' : '–', xCols[i], y, {
        size: 9,
        bold: ok,
        col: ok ? rgb(0.05, 0.45, 0.4) : rgb(0.45, 0.45, 0.45),
      })
    })
    y -= rowH
  }

  y -= 10
  draw('Hinweise:', 50, y, { size: 9, bold: true })
  y -= 14
  const notes = [
    '• admin und planung sind in der App identisch abgebildet.',
    '• viewer: Kalender nur lesen (inert), Stammdaten-Panels ausgeblendet, kein Export.',
    '• Zusätzlich schützt Row Level Security (Supabase) workspace_documents.',
  ]
  for (const line of notes) {
    draw(line, 50, y, { size: 8 })
    y -= 12
  }

  const bytes = await pdfDoc.save()
  const out = path.join(root, 'Berechtigungen-Matrix.pdf')
  fs.writeFileSync(out, bytes)
  console.log('Geschrieben:', out)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
