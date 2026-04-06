/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** YELLOW_AI: Basis-URL der KI-API (z. B. https://api.openai.com/v1) */
  readonly VITE_AI_BASE_URL?: string
  /** YELLOW_AI: Bearer-Token — niemals in öffentliche Repos committen */
  readonly VITE_AI_API_KEY?: string
  /** YELLOW_AI: Standard-Modellname */
  readonly VITE_AI_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
