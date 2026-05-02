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

Vercel erkennt Next.js automatisch. Die frühere `vercel.json`-SPA-Rewrite wurde entfernt.
