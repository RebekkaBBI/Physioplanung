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
