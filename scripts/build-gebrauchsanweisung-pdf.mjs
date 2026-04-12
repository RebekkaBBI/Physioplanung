/**
 * Erzeugt Gebrauchsanweisung/Physioplanung-Gebrauchsanweisung-Planung.pdf
 * aus Abbildungen in Gebrauchsanweisung/bilder/ (PNG).
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const bilderDir = path.join(root, 'Gebrauchsanweisung', 'bilder')
const outFile = path.join(
  root,
  'Gebrauchsanweisung',
  'Physioplanung-Gebrauchsanweisung-Planung.pdf',
)

const PAGE_W = 595
const PAGE_H = 842
const M = 50
const TEXT_W = PAGE_W - 2 * M

function wrapLines(text, font, size, maxW) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (font.widthOfTextAtSize(test, size) <= maxW) line = test
    else {
      if (line) lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines
}

/** y = baseline from bottom */
function drawWrapped(page, font, text, x, yStart, size, maxW, lineGap) {
  let y = yStart
  const lines = wrapLines(text, font, size, maxW)
  for (const ln of lines) {
    page.drawText(ln, { x, y, size, font, color: rgb(0.1, 0.1, 0.12) })
    y -= size * lineGap
  }
  return y
}

async function embedFig(pdf, name) {
  const p = path.join(bilderDir, name)
  if (!fs.existsSync(p)) {
    throw new Error(`Abbildung fehlt: ${p}`)
  }
  const buf = fs.readFileSync(p)
  return pdf.embedPng(buf)
}

async function main() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)

  // Titelseite
  {
    const page = pdf.addPage([PAGE_W, PAGE_H])
    let y = PAGE_H - M
    page.drawText('Physio PlanungsApp', {
      x: M,
      y: y - 28,
      size: 22,
      font: fontBold,
      color: rgb(0.05, 0.35, 0.38),
    })
    y -= 70
    page.drawText('Gebrauchsanweisung für das Planungsteam', {
      x: M,
      y,
      size: 14,
      font: fontBold,
    })
    y -= 28
    y = drawWrapped(
      page,
      font,
      'Diese Anleitung richtet sich an Anwenderinnen und Anwender mit der Rolle „planung“ in der Cloud-Version. Sie beschreibt die wichtigsten Arbeitsbereiche: Anmeldung, Kalender, Patienten- und Stammdaten, Muster, Mitarbeiter sowie Exporte. Die Abbildungen sind schematische Darstellungen der Oberfläche.',
      M,
      y,
      11,
      TEXT_W,
      1.35,
    )
    y -= 20
    page.drawText('Hinweis zu den Abbildungen', {
      x: M,
      y,
      size: 12,
      font: fontBold,
    })
    y -= 18
    drawWrapped(
      page,
      font,
      'Die Bilder in diesem Dokument sind vereinfachte Illustrationen und können in Farbe, Text und Layout leicht von Ihrer aktuellen Softwareversion abweichen.',
      M,
      y,
      10,
      TEXT_W,
      1.35,
    )
  }

  const sections = [
    {
      title: '1. Anmeldung (Cloud)',
      fig: 'fig01-anmeldung.png',
      body: [
        'Öffnen Sie die Webadresse Ihrer Organisation. Es erscheint die Anmeldemaske „Physio PlanungsApp“ mit den Feldern E-Mail und Passwort.',
        'Geben Sie Ihre Zugangsdaten ein und klicken Sie auf „Anmelden“. Nach erfolgreicher Anmeldung lädt der Arbeitsbereich. Bei Fehlermeldungen prüfen Sie Schreibweise und ggf. den Zugang mit Ihrer IT oder Administration.',
        'Mit der Rolle „planung“ dürfen Sie den Kalender bearbeiten, Patienten und Stammdaten pflegen sowie Exporte ausführen (siehe Rechte in der App).',
      ],
    },
    {
      title: '2. Kopfzeile und Werkzeugleiste',
      fig: 'fig02-werkzeugleiste.png',
      body: [
        'Oben sehen Sie den App-Titel, Ihre Rolle, den Kontonamen und die Schaltfläche „Abmelden“.',
        'Tagesansicht / Wochenansicht: Umschalten zwischen Tagesraster (Uhrzeiten und Räume) und Wochenübersicht (eine Zelle pro Tag und Raum). In der reinen Mitarbeiter-Kalenderansicht ist die Tagesansicht ausgeblendet.',
        'Rückgängig: Macht die letzte Änderung am Terminplan rückgängig (Stapel begrenzt).',
        'Export Patient / Export Mitarbeiter / Export Raum: Öffnen geführte Dialoge für PDF- oder Datenauszüge im gewählten Zeitraum.',
        'Heute und Pfeile ‹ ›: Springen zum aktuellen Zeitraum bzw. eine Woche vor oder zurück; dazwischen steht die Datumsangabe des sichtbaren Zeitraums.',
      ],
    },
    {
      title: '3. Hauptansicht: Patienten und Kalender',
      fig: 'fig03-hauptansicht.png',
      body: [
        'Links (nur mit Planungsrechten): Panel „Patienten“. Oben können Sie nach Name oder Patienten-ID suchen. Jeder Patient kann per Drag & Drop in den Kalender gezogen werden. Über „Bearbeiten“ und „Löschen“ pflegen Sie Einträge; unten legen Sie mit Name, Patienten-ID und „Hinzufügen“ neue Patienten an.',
        'Rechts: Register „Hauptkalender“ zeigt alle Räume und Termine. Zusätzliche Register mit Mitarbeiternamen öffnen die jeweilige Personenansicht (Wochenraster; dort u. a. Abwesenheiten eintragen, sofern berechtigt).',
        'In der Wochenansicht fasst jede Zelle die Termine des Tages im jeweiligen Raum zusammen (Anzahl und Kurztext). Ein Klick auf die Zelle öffnet die Tagesansicht für genau diesen Tag.',
      ],
    },
    {
      title: '4. Untere Panels: Kollision, Arten, Muster, Mitarbeiter',
      fig: 'fig04-stammdaten-panels.png',
      body: [
        'Kollision: Listet Termine auf, die Aufmerksamkeit brauchen – z. B. Kollisionen mit Mustern, Termine ohne Patient oder ohne zugeordneten Mitarbeiter. Ein Klick auf einen Eintrag springt in die Tagesansicht zur betreffenden Zeit.',
        'Belegungsarten: Katalog der Behandlungstypen mit Dauer (in 30-Minuten-Schritten) und Farbe. Chips können in den Kalender gezogen werden. „Bearbeiten“ / „Löschen“ und „Belegungsart hinzufügen“ pflegen den Katalog.',
        'Belegungsmuster: Wiederkehrende Abläufe (ein- oder dreiwöchige Vorlagen). Muster per Drag & Drop auf den Kalender anwenden; „Bearbeiten“ öffnet den Muster-Editor, „Neues Belegungsmuster anlegen“ erstellt eine Vorlage.',
        'Mitarbeiter: Liste aller Therapeuten mit Auslastungshinweis. Chips zum Ziehen in den Kalender; „Bearbeiten“ öffnet Verfügbarkeit, freigegebene Belegungsarten und Abwesenheiten; „Mitarbeiter anlegen“ legt neue Profile an.',
      ],
    },
    {
      title: '5. Belegungsmuster-Editor',
      fig: 'fig05-muster-editor.png',
      body: [
        'Im Dialog legen Sie die Bezeichnung fest und bearbeiten das Raster analog zum Kalender: Klick auf eine Zelle wählt die Belegungsart, Drag & Drop und Ziehen an den Rändern verschieben oder ändern die Dauer von Blöcken.',
        'Die Mittagszeit 12:00–13:30 ist als Pause reserviert und wird nicht in den Hauptkalender übernommen.',
        'Pro Belegungsart kann eine Hervorhebung aktiviert werden: Zellen, in denen alle freigeschalteten Mitarbeitenden verfügbar sind, werden schattiert – hilfreich bei der Mustergestaltung.',
        '„Speichern“ übernimmt das Muster; „Abbrechen“ verwirft ungesicherte Änderungen im Dialog.',
      ],
    },
    {
      title: '6. Mitarbeiterdaten und Abwesenheiten',
      fig: 'fig06-mitarbeiter-dialog.png',
      body: [
        'Unter „Mitarbeiter bearbeiten“ pflegen Sie den Namen, die wöchentliche Verfügbarkeit (Mo–So, Raster in 30-Minuten-Slots) und optional abwechselnde gerade/ungerade Kalenderwochen.',
        '„Freigegebene Belegungsarten“ legt fest, welche Behandlungstypen dieser Person zugewiesen werden dürfen – die Planungslogik prüft das bei Terminen.',
        'Urlaub und Abwesenheit können in der Mitarbeiter-Wochenansicht über die Kalenderzellen eingetragen werden (ganztägig oder zeitfensterbezogen), sofern Ihre Rolle das erlaubt.',
      ],
    },
    {
      title: '7. Tagesansicht im Detail',
      fig: 'fig08-tagesansicht.png',
      body: [
        'Die Tagesansicht zeigt pro Raum eine Spalte und pro Zeile einen 30-Minuten-Slot von morgens bis abends. Gebuchte Termine erscheinen als zusammenhängende farbige Blöcke mit Patient, Belegungsart und Mitarbeiter.',
        'Patienten, Belegungsarten, Muster und Mitarbeiter-Chips aus den Seitenleisten können auf freie oder passende Zellen gezogen werden. Bestehende Blöcke lassen sich verschieben; an Ober- und Unterkante können Sie die Dauer ziehen, sofern die Regeln der App das zulassen.',
        'Ein Klick auf einen belegten Slot öffnet bei Bedarf Dialoge zur Auswahl von Belegungsart, Mitarbeiter oder Team-Terminen. Interne Notizen am Termin werden nicht in Exporte übernommen.',
        'Zwischen 12:00 und 13:30 ist keine Belegungsart vorgesehen (Pause).',
      ],
    },
    {
      title: '8. Exporte',
      fig: 'fig07-export-dialog.png',
      body: [
        'Export Patient: Wählen Sie einen Patienten und einen Zeitraum; es wird eine übersichtliche PDF-Terminliste erzeugt.',
        'Export Mitarbeiter: Analog für einen Mitarbeiter – sinnvoll für individuelle Wochenpläne.',
        'Export Raum: Termine eines ausgewählten Raums im Zeitraum – z. B. für Raumbelegung oder Übergabe.',
        'Folgen Sie den Schritten im jeweiligen Dialog; mit „Abbrechen“ schließen Sie ohne Download.',
      ],
    },
  ]

  for (const sec of sections) {
    const page = pdf.addPage([PAGE_W, PAGE_H])
    let y = PAGE_H - M

    page.drawText(sec.title, {
      x: M,
      y: y - 16,
      size: 13,
      font: fontBold,
      color: rgb(0.05, 0.35, 0.38),
    })
    y -= 36

    const img = await embedFig(pdf, sec.fig)
    const iw = img.width
    const ih = img.height
    const maxImgW = TEXT_W
    const maxImgH = 220
    const scale = Math.min(maxImgW / iw, maxImgH / ih, 1)
    const dw = iw * scale
    const dh = ih * scale
    page.drawImage(img, { x: M, y: y - dh, width: dw, height: dh })
    y = y - dh - 20

    const lineH = 10 * 1.35
    let curPage = page
    for (const para of sec.body) {
      const lines = wrapLines(para, font, 10, TEXT_W)
      for (const ln of lines) {
        if (y - lineH < M) {
          curPage = pdf.addPage([PAGE_W, PAGE_H])
          y = PAGE_H - M
        }
        curPage.drawText(ln, {
          x: M,
          y,
          size: 10,
          font,
          color: rgb(0.1, 0.1, 0.12),
        })
        y -= lineH
      }
      y -= 8
    }
  }

  // Abschluss: Speichern, Logout
  {
    const page = pdf.addPage([PAGE_W, PAGE_H])
    let y = PAGE_H - M
    page.drawText('9. Speichern, Abmeldung, Sitzungsdauer', {
      x: M,
      y: y - 16,
      size: 13,
      font: fontBold,
      color: rgb(0.05, 0.35, 0.38),
    })
    y -= 40
    const closing = [
      'In der Cloud-Version werden Kalender, Stammdaten und Ansicht automatisch gespeichert, sobald Sie etwas ändern (nach dem ersten Laden der Daten).',
      '„Abmelden“ beendet die Sitzung auf diesem Gerät. Aus Sicherheitsgründen kann die Anwendung Sie nach längerer Nutzung erneut zur Anmeldung auffordern.',
      'Bitte schließen Sie den Browser-Tab in gemeinsam genutzten Räumen nach der Arbeit.',
    ]
    for (const para of closing) {
      y = drawWrapped(page, font, para, M, y, 10, TEXT_W, 1.35)
      y -= 10
    }
  }

  const bytes = await pdf.save()
  fs.writeFileSync(outFile, bytes)
  console.log('Geschrieben:', outFile)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
