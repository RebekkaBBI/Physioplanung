# Physio PlanungsApp

Web-App mit **Next.js 15** (App Router) und React. Kalender/Planung; optional **Supabase** (Auth + `workspace_documents`).

## Entwicklung

```bash
npm install
npm run dev
```

Standard: **http://localhost:3000** (Next.js; nicht mehr Port 5173).

## Build

```bash
npm run build
npm start
```

## Umgebungsvariablen

Siehe `.env.example`. Für Supabase im Browser:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**Vercel:** dieselben Namen setzen (nicht mehr `VITE_*`). Bestehende Werte aus den alten Variablen kopieren.

## Supabase Redirects

Unter **Authentication → URL Configuration** u. a.:

- Produktion: `https://<deine-domain>/**`
- Lokal: `http://localhost:3000/**`

## Deployment

Vercel nutzt **Next.js** (Ausgabe unter `.next`, **nicht** `dist`).

### Wenn der Build fehlschlägt: „No Output Directory named dist“

Das Projekt war früher **Vite** (`dist`). In Vercel die Einstellung zurücksetzen:

1. **Project → Settings → General**
2. Abschnitt **Build & Development Settings**
3. **Framework Preset:** `Next.js` (oder „Override“ aus, damit Auto-Erkennung greift)
4. **Output Directory:** leer lassen bzw. **Override deaktivieren** — dort darf **nicht** `dist` stehen
5. **Build Command:** leer lassen (Standard: `next build`) oder explizit `next build`
6. Speichern und **Redeploy**

Im Repo liegt `vercel.json` nur mit `"framework": "nextjs"` zur Orientierung — ohne `outputDirectory`.

Die frühere SPA-`vercel.json` mit Rewrite auf `index.html` ist entfernt (würde Next.js stören).

## Architektur (Supabase + Next.js)

- **`@supabase/ssr`**: Browser-Client (`createBrowserClient`) und Server-Client (`createServerClient`) mit Cookies.
- **`middleware.ts`**: Aktualisiert die Auth-Session (Refresh), bevor App/API laufen.
- **Server Actions** (`src/actions/workspace.ts`): Lesen/Schreiben von `workspace_documents` mit `getUser()` + Prüfung `profiles.organization_id` (zusätzlich zu RLS).
- **API (optional)**:
  - `GET /api/auth/session` — nur mit gültiger Session: `{ authenticated, userId, email }`, sonst 401.
  - `GET /api/workspace?organization_id=<uuid>` — JSON mit `slots` / `panels` / `ui` (wie in der DB), sonst 401/403.
  - `POST /api/workspace` — JSON `{ "organization_id", "doc_type": "slots"|"panels"|"ui", "body" }`, sonst 401/403. **Rate-Limit:** grob pro IP und pro User (In-Memory, auf Serverless nur pro Instanz).

Es wird **kein** `service_role`-Key im Browser oder in diesen Routen verwendet; Schutz über Session + RLS + Organisations-Check.

## Supabase CLI & Migrationen (lokal)

Optional für reproduzierbare DB-Änderungen und Typen:

1. [Supabase CLI installieren](https://supabase.com/docs/guides/cli)
2. Im Projektroot: `npx supabase login` und `npx supabase link --project-ref <dein-project-ref>` (Ref aus Dashboard → Project Settings)
3. SQL aus `supabase/migrations/` auf die Remote-DB anwenden, z. B. `npx supabase db push` (oder Migrations im Dashboard / SQL Editor einzeln ausführen — für Teams ist **push** oder CI mit denselben Dateien besser)

**Wichtig:** Ohne CLI bleiben die `.sql`-Dateien die „Source of truth“; sie müssen auf jeder Umgebung (Staging/Prod) ausgeführt werden.

## TypeScript-Typen aus dem Schema (`supabase gen types`)

Nach `npx supabase link`:

```bash
npm run db:types
```

Erzeugt `src/database.types.ts` (Datei bei Bedarf in `.gitignore`, wenn ihr sie nicht versionieren wollt).

Ohne Link, nur mit Project Ref:

```bash
export SUPABASE_PROJECT_REF=abcd1234
npm run db:types:remote
```

Die generierte Datei ist noch **nicht** überall in der App eingebunden — ihr könnt Typen schrittweise für `from('…')`-Aufrufe nutzen.

## RLS-Kurzüberblick (public)

Vollständige Definition: `supabase/migrations/*.sql`.

| Tabelle | RLS | Kurz |
|--------|-----|------|
| `organizations` | ja | Lesen nur für Zeilen der eigenen Org (über `profiles.organization_id`). |
| `profiles` | ja | Lesen nur eigene Zeile (`id = auth.uid()`). |
| `workspace_documents` | ja | Lesen für Nutzer derselben Org; Schreiben je nach Rolle **admin/planung** (alle doc_types) bzw. **therapie** (nur slots/panels/ui); **viewer** ohne Schreib-Policies. |

## Betrieb: Backups & Notfall (kurz)

**Backups / PITR:** Hängen vom **Supabase-Tarif** ab (kostenloser Plan eingeschränkt; bezahlte Projekte u. a. mit längerer Aufbewahrung und ggf. Point-in-Time Recovery). Konkrete Aufbewahrung und Wiederherstellung: **Supabase Dashboard → Database → Backups** bzw. Dokumentation zum jeweiligen Plan.

**Notfall (3–5 Sätze):** Zuerst in Supabase prüfen, ob ein **automatisches Backup** zur gewünschten Zeit existiert und dort **Restore** bzw. Support-Anfrage starten. Ist die Instanz nicht wiederherstellbar, ein neues Projekt anlegen, **dieselben Migrationen** aus `supabase/migrations/` der Reihe nach anwenden, **Auth-Nutzer** ggf. exportieren/importieren oder neu einladen, in **Vercel** die `NEXT_PUBLIC_*`-Variablen setzen und die App neu deployen. Daten in `workspace_documents` sind erst wieder da, wenn ihr sie aus einem Backup der **Datenbank** zurückspielt — die App speichert keinen Ersatz für Postgres-Backups. Dokumentiert intern, wer Zugriff auf Dashboard und Vercel hat, damit im Ernstfall nicht an fehlenden Rechten gescheitert wird.

## Checkliste (Local / Staging / Prod)

- [ ] `NEXT_PUBLIC_SUPABASE_URL` und `NEXT_PUBLIC_SUPABASE_ANON_KEY` gesetzt (lokal `.env.local`, Vercel **Production** + ggf. **Preview**)
- [ ] Alle Migrationen auf der jeweiligen Supabase-Instanz ausgeführt
- [ ] **Authentication → URL Configuration:** Site URL + Redirect URLs (Prod + `http://localhost:3000/**` für lokal)
- [ ] Rollen in `profiles` für Testnutzer gesetzt (admin/planung/therapie/viewer)
- [ ] Optional: Staging-Projekt in Supabase + eigenes Vercel-Preview-Environment mit eigenen Env-Vars
- [ ] Optional: `npm run db:types` nach Schema-Änderungen
